import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * openai-oauth sends each Codex request upstream with only its own headers. The Codex session identity and the
 * backend's per-turn routing token decide which backend holds the conversation's prompt cache, so the proxy
 * carries exactly those from the gateway's request onto the request it makes to the Codex responses endpoint.
 */
const CODEX_ROUTING_HEADERS = [
  'session-id', 'thread-id', 'x-client-request-id', 'x-codex-window-id', 'x-codex-turn-state',
] as const

export function createCodexRoutingRelay(baseFetch: typeof fetch = fetch): {
  run<T>(incoming: Headers, handle: () => Promise<T>): Promise<T>
  fetch: typeof fetch
} {
  const current = new AsyncLocalStorage<ReadonlyArray<readonly [string, string]>>()
  const relayFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const routing = current.getStore()
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!routing?.length || !url.pathname.endsWith('/responses')) return baseFetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    for (const [name, value] of routing) if (!headers.has(name)) headers.set(name, value)
    return baseFetch(input, { ...init, headers })
  }
  return {
    run(incoming, handle) {
      return current.run(CODEX_ROUTING_HEADERS.flatMap((name) => {
        const value = incoming.get(name)
        return value ? [[name, value] as const] : []
      }), handle)
    },
    fetch: relayFetch as typeof fetch,
  }
}
