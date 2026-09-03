/**
 * Ready-owned local stdio MCP client. Remote transports and OAuth are not
 * part of this runtime.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { APP_VERSION } from '../../../shared/app-version'
import { getMcpToolCatalogEntry, type McpToolAnnotations } from './registry'

export type McpTransport = 'stdio'

export interface McpClientConfig {
  serverId: string
  transport: McpTransport
  /** Local executable. Arguments are always passed as an array with shell disabled. */
  endpoint: string
  args?: string[]
  env?: Record<string, string>
  cwd: string
  dataDir: string
  onCatalogChanged?: () => void
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

export interface McpListedResource {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpListedResourceTemplate {
  uriTemplate: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpServerMetadata {
  protocolVersion: string
  serverInfo: Record<string, unknown> | null
  capabilities: Record<string, unknown>
  instructions: string | null
}

export function buildMcpChildEnvironment(
  dataDir: string,
  explicit: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const inheritedKeys = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR', 'LANG', 'LC_ALL']
  const env: NodeJS.ProcessEnv = {}
  for (const key of inheritedKeys) {
    if (process.env[key]) env[key] = process.env[key]
  }
  env.HOME = dataDir
  if (process.platform === 'win32') env.USERPROFILE = dataDir
  return { ...env, ...explicit }
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
  private metadata: McpServerMetadata | null = null
  private stderrTail = ''
  private lastProgress: Record<string, unknown> | null = null

  constructor(private readonly config: McpClientConfig) {}

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const child = spawn(this.config.endpoint, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: this.config.cwd,
      env: buildMcpChildEnvironment(this.config.dataDir, this.config.env),
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16_384)
    })
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
    const method = typeof message.method === 'string' ? message.method : ''
    if (!Number.isFinite(id)) {
      if (method === 'notifications/tools/list_changed'
        || method === 'notifications/resources/list_changed') this.config.onCatalogChanged?.()
      if (method === 'notifications/progress' && message.params && typeof message.params === 'object') {
        this.lastProgress = message.params as Record<string, unknown>
      }
      return
    }
    if (method) {
      this.child?.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Server request ${method} is not supported` },
      })}\n`)
      return
    }
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

  private async listPaginated(
    method: 'tools/list' | 'resources/list' | 'resources/templates/list',
    field: 'tools' | 'resources' | 'resourceTemplates',
  ): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = []
    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < 100; page += 1) {
      const result = await this.sendRequest(
        method,
        cursor ? { cursor } : {},
        HANDSHAKE_TIMEOUT_MS,
      )
      const pageItems = result[field]
      if (Array.isArray(pageItems)) items.push(...pageItems as Array<Record<string, unknown>>)
      const nextCursor = typeof result.nextCursor === 'string' ? result.nextCursor.trim() : ''
      if (!nextCursor) return items
      if (seenCursors.has(nextCursor)) throw new Error(`MCP ${method} repeated cursor ${nextCursor}`)
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }
    throw new Error(`MCP ${method} exceeded 100 pages`)
  }

  private async ensureInitialized(): Promise<void> {
    this.ensureChild()
    if (!this.initialized) {
      this.initialized = (async () => {
        const initialized = await this.sendRequest('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ready-cowork', version: APP_VERSION },
        }, HANDSHAKE_TIMEOUT_MS)
        this.metadata = {
          protocolVersion: typeof initialized.protocolVersion === 'string'
            ? initialized.protocolVersion
            : MCP_PROTOCOL_VERSION,
          serverInfo: initialized.serverInfo && typeof initialized.serverInfo === 'object'
            ? initialized.serverInfo as Record<string, unknown>
            : null,
          capabilities: initialized.capabilities && typeof initialized.capabilities === 'object'
            ? initialized.capabilities as Record<string, unknown>
            : {},
          instructions: typeof initialized.instructions === 'string' ? initialized.instructions : null,
        }
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
    return this.listPaginated('tools/list', 'tools')
  }

  async getMetadata(): Promise<McpServerMetadata> {
    await this.ensureInitialized()
    return this.metadata || {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: null,
      capabilities: {},
      instructions: null,
    }
  }

  async listResources(): Promise<Array<Record<string, unknown>>> {
    await this.ensureInitialized()
    return this.listPaginated('resources/list', 'resources')
  }

  async listResourceTemplates(): Promise<Array<Record<string, unknown>>> {
    await this.ensureInitialized()
    return this.listPaginated('resources/templates/list', 'resourceTemplates')
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.ensureInitialized()
    return this.sendRequest('resources/read', { uri }, TOOL_CALL_TIMEOUT_MS, signal)
  }

  getDiagnostics(): { stderrTail: string; lastProgress: Record<string, unknown> | null } {
    return { stderrTail: this.stderrTail, lastProgress: this.lastProgress }
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
    const rawTools = await this.ensureStdioConnection().listTools()
    const listed: McpListedTool[] = []
    const remoteNames = new Map<string, string>()
    for (const raw of rawTools) {
      const remoteName = String((raw as { name?: unknown }).name || '').trim()
      if (!remoteName) continue
      const canonical = canonicalMcpToolName(this.config.serverId, remoteName)
      const previousRemoteName = remoteNames.get(canonical)
      if (previousRemoteName && previousRemoteName !== remoteName) {
        throw new Error(`MCP canonical tool collision: ${previousRemoteName} and ${remoteName}`)
      }
      remoteNames.set(canonical, remoteName)
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
    this.remoteNameByCanonical.clear()
    for (const [canonical, remoteName] of remoteNames) {
      this.remoteNameByCanonical.set(canonical, remoteName)
    }
    return listed
  }

  async getMetadata(): Promise<McpServerMetadata> {
    return this.ensureStdioConnection().getMetadata()
  }

  async listResources(): Promise<McpListedResource[]> {
    const resources = await this.ensureStdioConnection().listResources()
    return resources.flatMap((resource) => {
      const uri = typeof resource.uri === 'string' ? resource.uri.trim() : ''
      return uri ? [{
        uri,
        ...(typeof resource.name === 'string' ? { name: resource.name } : {}),
        ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
        ...(typeof resource.mimeType === 'string' ? { mimeType: resource.mimeType } : {}),
      }] : []
    })
  }

  async listResourceTemplates(): Promise<McpListedResourceTemplate[]> {
    const templates = await this.ensureStdioConnection().listResourceTemplates()
    return templates.flatMap((template) => {
      const uriTemplate = typeof template.uriTemplate === 'string' ? template.uriTemplate.trim() : ''
      return uriTemplate ? [{
        uriTemplate,
        ...(typeof template.name === 'string' ? { name: template.name } : {}),
        ...(typeof template.description === 'string' ? { description: template.description } : {}),
        ...(typeof template.mimeType === 'string' ? { mimeType: template.mimeType } : {}),
      }] : []
    })
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.ensureStdioConnection().readResource(uri, signal)
  }

  getDiagnostics(): { stderrTail: string; lastProgress: Record<string, unknown> | null } {
    return this.stdioConnection?.getDiagnostics() || { stderrTail: '', lastProgress: null }
  }

  /**
   * Send one exact tool call. Ready action confirmation occurs before this
   * dispatcher is reached.
   */
  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
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

/**
 * Phase M 管理面 —— "never-reset-mid-session" 不变量的唯一受控例外：
 * 用户在设置页显式触发的重载（bootstrap.reloadMcpServersFromSettings），
 * 调用前必须已 close 全部客户端。不得在任何自动路径调用。
 */
export function resetMcpClientRegistryForReload(): void {
  clientRegistry.clear()
}

/** Test helper. */
export function __resetMcpClientsForTests(): void {
  clientRegistry.clear()
}
