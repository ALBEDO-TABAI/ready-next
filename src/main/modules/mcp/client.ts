/**
 * Stage T PR-T5 骨架 → Phase M（2026-07-05）stdio 实装。
 *
 * Plan v18 §6.2 — supports two transports:
 *   - `stdio`: local subprocess MCP server, newline-delimited JSON-RPC 2.0
 *     over stdin/stdout（MCP 规范 stdio 帧）——本阶段真实装。
 *   - `websocket`: remote MCP server over WS——仍未实装，callTool 返回诚实的
 *     `transport_not_implemented` 失败（不再返回 stub ok 假成功）。
 *
 * OAuth fence 合同不变：requiresAuthorization !== false 的 server 每次
 * tool call 先过 `ensureAuthorized`（check-mcp-oauth-authorization-flow.cjs）。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { ensureAuthorized, type McpOAuthToken } from './oauth'
import { getMcpToolCatalogEntry, type McpToolAnnotations } from './registry'

export type McpTransport = 'stdio' | 'websocket'

export interface McpClientConfig {
  serverId: string
  transport: McpTransport
  /** stdio: command (spawned, args via `args`). websocket: ws:// or wss:// URL. */
  endpoint: string
  /** stdio 附加参数（Phase M）。 */
  args?: string[]
  /** stdio 子进程附加环境变量（Phase M；与 process.env 合并）。 */
  env?: Record<string, string>
  /** Required scopes for OAuth (`ensureAuthorized` will request these). */
  scopes?: string[]
  /** Whether this server requires OAuth before any tool call. */
  requiresAuthorization?: boolean
}

export interface McpToolCallRequest {
  toolName: string
  /** Tool input — passed through to the MCP server. */
  arguments: Record<string, unknown>
  /** Per-call abort signal. */
  signal?: AbortSignal
}

export interface McpToolCallResult {
  ok: boolean
  /** Structured tool output from the MCP server. */
  output?: unknown
  /** Present when `ok === false`. */
  error?: { kind: string; message: string }
}

/** Phase M —— listTools 归一结果（canonical 名 + server 原始名 + schema/annotations）。 */
export interface McpListedTool {
  name: string
  remoteName: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: McpToolAnnotations
}

/** canonical `mcp_<server>_<action>`：serverId 与工具名统一小写下划线化。 */
export function canonicalMcpToolName(serverId: string, remoteName: string): string {
  const sanitize = (value: string): string =>
    String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return `mcp_${sanitize(serverId)}_${sanitize(remoteName)}`
}

const MCP_PROTOCOL_VERSION = '2024-11-05'
const HANDSHAKE_TIMEOUT_MS = 15_000
const TOOL_CALL_TIMEOUT_MS = 60_000

interface JsonRpcPending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Phase M —— stdio 连接：换行分隔 JSON-RPC 2.0。惰性建立（首次
 * listTools/callTool 才 spawn），initialize 握手 + initialized 通知后可用；
 * close() 杀子进程并拒绝所有在途请求。
 */
class McpStdioConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, JsonRpcPending>()
  private stdoutBuffer = ''
  private initialized: Promise<void> | null = null

  constructor(private readonly config: McpClientConfig) {}

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const child = spawn(this.config.endpoint, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.config.env ?? {}) },
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.on('exit', () => this.rejectAllPending(new Error(`MCP stdio server ${this.config.serverId} exited`)))
    child.on('error', (error) => this.rejectAllPending(error instanceof Error ? error : new Error(String(error))))
    this.child = child
    this.initialized = null
    return child
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIndex = this.stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line) this.onMessageLine(line)
      newlineIndex = this.stdoutBuffer.indexOf('\n')
    }
  }

  private onMessageLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      // silent-catch: 非 JSON 行（server 侧噪声输出）按帧噪声丢弃，不炸连接
      return
    }
    const id = Number(message.id)
    if (!Number.isFinite(id)) return // notification from server — none consumed yet
    const waiter = this.pending.get(id)
    if (!waiter) return
    this.pending.delete(id)
    clearTimeout(waiter.timer)
    const rpcError = message.error as { code?: number; message?: string } | undefined
    if (rpcError) {
      waiter.reject(new Error(`MCP rpc error ${rpcError.code ?? ''}: ${rpcError.message ?? 'unknown'}`.trim()))
      return
    }
    waiter.resolve((message.result ?? {}) as Record<string, unknown>)
  }

  private rejectAllPending(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const child = this.ensureChild()
    const id = this.nextRequestId
    this.nextRequestId += 1
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP request ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`MCP request ${method} aborted`))
      }
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, {
        resolve: (value) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer,
      })
      child.stdin.write(`${payload}\n`, (writeError) => {
        if (!writeError) return
        const waiter = this.pending.get(id)
        if (!waiter) return
        this.pending.delete(id)
        clearTimeout(waiter.timer)
        waiter.reject(writeError)
      })
    })
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    const child = this.ensureChild()
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private async ensureInitialized(): Promise<void> {
    this.ensureChild()
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.sendRequest('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ready-cowork', version: '0.1.0' },
        }, HANDSHAKE_TIMEOUT_MS)
        this.sendNotification('notifications/initialized', {})
      })().catch((error) => {
        this.initialized = null
        throw error
      })
    }
    return this.initialized
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    await this.ensureInitialized()
    const result = await this.sendRequest('tools/list', {}, HANDSHAKE_TIMEOUT_MS)
    const tools = (result as { tools?: unknown }).tools
    return Array.isArray(tools) ? tools as Array<Record<string, unknown>> : []
  }

  async callTool(
    remoteName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.ensureInitialized()
    return this.sendRequest('tools/call', { name: remoteName, arguments: args }, TOOL_CALL_TIMEOUT_MS, signal)
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    this.initialized = null
    this.rejectAllPending(new Error(`MCP stdio connection ${this.config.serverId} closed`))
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        resolve()
      }, 1_500)
      child.once('exit', () => {
        clearTimeout(forceKill)
        resolve()
      })
      try { child.stdin.end() } catch { /* already closed */ }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    })
  }
}

export class McpClient {
  private readonly config: McpClientConfig
  private cachedToken: McpOAuthToken | null = null
  private stdioConnection: McpStdioConnection | null = null
  /** canonical 名 → server 原始名（tools/call 必须用原始名）。 */
  private readonly remoteNameByCanonical = new Map<string, string>()

  constructor(config: McpClientConfig) {
    this.config = config
  }

  get serverId(): string {
    return this.config.serverId
  }

  private ensureStdioConnection(): McpStdioConnection {
    if (!this.stdioConnection) {
      this.stdioConnection = new McpStdioConnection(this.config)
    }
    return this.stdioConnection
  }

  /**
   * Phase M —— tools/list 发现（stdio 实装）。返回 canonical 名 + 原始名 +
   * schema/annotations；同时在客户端内建立 canonical→remote 映射供 callTool 用。
   */
  async listTools(): Promise<McpListedTool[]> {
    if (this.config.transport !== 'stdio') {
      throw new Error(`MCP transport ${this.config.transport} not implemented (stdio only in Phase M)`)
    }
    const rawTools = await this.ensureStdioConnection().listTools()
    const listed: McpListedTool[] = []
    for (const raw of rawTools) {
      const remoteName = String((raw as { name?: unknown }).name || '').trim()
      if (!remoteName) continue
      const canonical = canonicalMcpToolName(this.config.serverId, remoteName)
      this.remoteNameByCanonical.set(canonical, remoteName)
      const rawAnnotations = (raw as { annotations?: Record<string, unknown> }).annotations
      listed.push({
        name: canonical,
        remoteName,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        inputSchema: raw.inputSchema && typeof raw.inputSchema === 'object'
          ? raw.inputSchema as Record<string, unknown>
          : undefined,
        ...(rawAnnotations && typeof rawAnnotations === 'object'
          ? {
            annotations: {
              ...(typeof rawAnnotations.readOnlyHint === 'boolean' ? { readOnlyHint: rawAnnotations.readOnlyHint } : {}),
              ...(typeof rawAnnotations.destructiveHint === 'boolean' ? { destructiveHint: rawAnnotations.destructiveHint } : {}),
              ...(typeof rawAnnotations.idempotentHint === 'boolean' ? { idempotentHint: rawAnnotations.idempotentHint } : {}),
              ...(typeof rawAnnotations.openWorldHint === 'boolean' ? { openWorldHint: rawAnnotations.openWorldHint } : {}),
            },
          }
          : {}),
      })
    }
    return listed
  }

  /**
   * Send a tool call. Routes through `ensureAuthorized` first so the
   * MCP client never bypasses OAuth — this is the contract enforced
   * by `check-mcp-oauth-authorization-flow.cjs`.
   */
  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    if (this.config.requiresAuthorization !== false) {
      try {
        // Authorization fence: every MCP tool call passes through
        // `ensureAuthorized`. The token is held on the client for the
        // duration of the connection; ensureAuthorized handles refresh.
        this.cachedToken = await ensureAuthorized(
          this.config.serverId,
          this.config.scopes,
        )
      } catch (error) {
        return {
          ok: false,
          error: {
            kind: 'authorization_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }
    if (this.config.transport !== 'stdio') {
      // Phase M —— 诚实失败：websocket 帧未实装，不再返回 stub ok 假成功。
      return {
        ok: false,
        error: {
          kind: 'transport_not_implemented',
          message: `MCP transport ${this.config.transport} is not implemented yet (stdio only)`,
        },
      }
    }
    try {
      // canonical → server 原始名：优先本连接 listTools 建的映射，其次
      // registry 目录（进程重启后 bootstrap 会重建，两者一般一致），最后
      // 裸名兜底（server 若不识别会返回 rpc error，诚实冒回）。
      const remoteName = this.remoteNameByCanonical.get(request.toolName)
        || getMcpToolCatalogEntry(request.toolName)?.remoteName
        || request.toolName
      const result = await this.ensureStdioConnection().callTool(
        remoteName,
        request.arguments,
        request.signal,
      )
      const isError = (result as { isError?: unknown }).isError === true
      const structured = (result as { structuredContent?: unknown }).structuredContent
      const content = (result as { content?: unknown }).content
      const textParts: string[] = []
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'text') {
            const text = (item as { text?: unknown }).text
            if (typeof text === 'string') textParts.push(text)
          }
        }
      }
      if (isError) {
        return {
          ok: false,
          error: {
            kind: 'mcp_tool_failed',
            message: textParts.join('\n').slice(0, 500) || `MCP tool ${request.toolName} reported isError`,
          },
        }
      }
      return {
        ok: true,
        output: structured ?? (textParts.length > 0 ? { text: textParts.join('\n') } : { content: content ?? null }),
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: 'mcp_tool_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  /**
   * Tear down the underlying transport (stdio subprocess or WS conn).
   */
  async close(): Promise<void> {
    this.cachedToken = null
    const connection = this.stdioConnection
    this.stdioConnection = null
    if (connection) await connection.close()
  }
}

const clientRegistry = new Map<string, McpClient>()

export function registerMcpClient(client: McpClient): void {
  clientRegistry.set(client.serverId, client)
}

export function getMcpClient(serverId: string): McpClient | null {
  return clientRegistry.get(serverId) || null
}

export function listMcpClients(): McpClient[] {
  return Array.from(clientRegistry.values())
}

export const __breaksInvariants = [
  'singleton.mcp-client-registry.never-reset-mid-session',
] as const

/** Test helper. */
export function __resetMcpClientsForTests(): void {
  clientRegistry.clear()
}
