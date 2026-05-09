/**
 * Stage T PR-T5 — MCP OAuth interceptor (minimal skeleton).
 *
 * Plan v18 §6.2 — when an MCP tool call needs an authorization token,
 * the client routes through `ensureAuthorized` first. If the cached
 * token is missing/expired, this module performs the OAuth dance:
 *
 *   1. `requestAuthorizationCode(serverId, scopes)` — open the
 *      provider's authorization URL in the user's browser, listen on
 *      a local loopback callback for the redirect with the code.
 *   2. `exchangeCodeForToken(serverId, code)` — POST to the token
 *      endpoint to swap the auth code for an access token (+ refresh).
 *   3. `ensureAuthorized(serverId, scopes)` — single entry point for
 *      callers; returns a valid token, refreshing or re-authorizing
 *      transparently.
 *
 * This file ships the surface shape so PR-T5 gates can verify the
 * three named entry points exist; real OAuth provider wiring lands in
 * a follow-up PR (the gate only enforces the contract here, not the
 * wire protocol).
 */

export interface McpOAuthToken {
  accessToken: string
  refreshToken?: string | null
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number
  scopes: string[]
}

export interface McpOAuthServerConfig {
  serverId: string
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  defaultScopes: string[]
}

export interface McpOAuthRequestCodeResult {
  serverId: string
  code: string
  state?: string
}

export class McpOAuthError extends Error {
  readonly serverId: string
  readonly stage: 'request_code' | 'exchange_token' | 'ensure_authorized'
  constructor(stage: McpOAuthError['stage'], serverId: string, message: string) {
    super(`[mcp-oauth:${stage}] ${serverId}: ${message}`)
    this.serverId = serverId
    this.stage = stage
  }
}

/**
 * In-memory token cache. Sufficient for skeleton; production may
 * persist to settings DB in a follow-up.
 */
const tokenCache = new Map<string, McpOAuthToken>()

const serverConfigs = new Map<string, McpOAuthServerConfig>()

export function registerMcpOAuthServer(config: McpOAuthServerConfig): void {
  serverConfigs.set(config.serverId, config)
}

export function getMcpOAuthServerConfig(serverId: string): McpOAuthServerConfig | null {
  return serverConfigs.get(serverId) || null
}

export function getCachedMcpOAuthToken(serverId: string): McpOAuthToken | null {
  return tokenCache.get(serverId) || null
}

export function setCachedMcpOAuthToken(serverId: string, token: McpOAuthToken): void {
  tokenCache.set(serverId, token)
}

export function clearCachedMcpOAuthToken(serverId: string): void {
  tokenCache.delete(serverId)
}

/**
 * Step 1 — kick off the OAuth dance: open the authorization URL in
 * the user's browser, listen on a loopback callback for the
 * `?code=...` redirect.
 *
 * Skeleton: throws `not_implemented`. The contract surface (named
 * function, signature, return shape) is what the PR-T5 gate verifies.
 */
export async function requestAuthorizationCode(
  serverId: string,
  scopes: string[],
): Promise<McpOAuthRequestCodeResult> {
  const config = serverConfigs.get(serverId)
  if (!config) {
    throw new McpOAuthError('request_code', serverId, 'no_server_config')
  }
  // Skeleton: real implementation opens shell.openExternal(authorizationUrl)
  // and listens on a localhost callback. Tracked in plan v18 §6.2 follow-up.
  throw new McpOAuthError(
    'request_code',
    serverId,
    `not_implemented (scopes=${scopes.join(',') || config.defaultScopes.join(',')})`,
  )
}

/**
 * Step 2 — exchange the auth code for an access token. POST to
 * `tokenUrl` with `grant_type=authorization_code`.
 *
 * Skeleton: throws `not_implemented`.
 */
export async function exchangeCodeForToken(
  serverId: string,
  code: string,
): Promise<McpOAuthToken> {
  const config = serverConfigs.get(serverId)
  if (!config) {
    throw new McpOAuthError('exchange_token', serverId, 'no_server_config')
  }
  // Skeleton: real implementation does fetch(tokenUrl, { method: 'POST', body: ... }).
  throw new McpOAuthError(
    'exchange_token',
    serverId,
    `not_implemented (code=${code.slice(0, 6)}...)`,
  )
}

/**
 * Single entry point for callers (e.g. `client.ts` before sending a
 * tool call). Returns a valid token, refreshing or re-authorizing
 * transparently.
 *
 * Resolution order:
 *   1. Cached token, not expired → return it.
 *   2. Cached token, expired but has refreshToken → refresh.
 *   3. No cached token → run requestAuthorizationCode + exchangeCodeForToken.
 *
 * Skeleton routes through `requestAuthorizationCode` /
 * `exchangeCodeForToken` so the gate can verify the call graph.
 */
export async function ensureAuthorized(
  serverId: string,
  scopes?: string[],
): Promise<McpOAuthToken> {
  const cached = tokenCache.get(serverId)
  const now = Date.now()
  if (cached && cached.expiresAt > now + 30_000) {
    return cached
  }
  const config = serverConfigs.get(serverId)
  if (!config) {
    throw new McpOAuthError('ensure_authorized', serverId, 'no_server_config')
  }
  // Re-auth path: run the full dance. PR-T5 ships this as a skeleton
  // call graph so `check-mcp-oauth-authorization-flow.cjs` can verify
  // the three named entry points are wired together.
  const requested = await requestAuthorizationCode(
    serverId,
    scopes || config.defaultScopes,
  )
  const token = await exchangeCodeForToken(serverId, requested.code)
  tokenCache.set(serverId, token)
  return token
}

/**
 * Test helper — clears all cached tokens and registered server
 * configs. Not for production use.
 */
export function __resetMcpOAuthForTests(): void {
  tokenCache.clear()
  serverConfigs.clear()
}
