/**
 * Stage T PR-T5 — MCP client (minimal skeleton).
 *
 * Plan v18 §6.2 — supports two transports:
 *   - `stdio`: local subprocess MCP server, framed JSON over stdin/stdout
 *   - `websocket`: remote MCP server over WS
 *
 * For PR-T5 the gate only verifies the client routes through
 * `ensureAuthorized` before sending tool calls. Real wire framing
 * lands in a follow-up; the contract surface is what's enforced here.
 */

import { ensureAuthorized, type McpOAuthToken } from './oauth'

export type McpTransport = 'stdio' | 'websocket'

export interface McpClientConfig {
  serverId: string
  transport: McpTransport
  /** stdio: command + args (spawned). websocket: ws:// or wss:// URL. */
  endpoint: string
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

export class McpClient {
  private readonly config: McpClientConfig
  private cachedToken: McpOAuthToken | null = null

  constructor(config: McpClientConfig) {
    this.config = config
  }

  get serverId(): string {
    return this.config.serverId
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
    // Skeleton: real wire framing lands in a follow-up. The PR-T5
    // gate only checks the call graph (ensureAuthorized → callTool).
    return {
      ok: false,
      error: {
        kind: 'not_implemented',
        message: `mcp.callTool ${this.config.transport}://${this.config.serverId}/${request.toolName} (skeleton)`,
      },
    }
  }

  /**
   * Tear down the underlying transport (stdio subprocess or WS conn).
   * Skeleton: no-op.
   */
  async close(): Promise<void> {
    this.cachedToken = null
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

/** Test helper. */
export function __resetMcpClientsForTests(): void {
  clientRegistry.clear()
}
