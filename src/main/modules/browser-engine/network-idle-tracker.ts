import type { BrowserCdpEvent } from './cdp-session-service'

/** One tracker per physical page, attached before its first navigation. */
export class NetworkIdleTracker {
  private readonly pending = new Map<string, { type: string; key: string; started: number }>()
  private readonly seen = new Map<string, number>()
  constructor(private readonly now = Date.now) {}

  record(event: BrowserCdpEvent): void {
    const p = event.params
    const id = typeof p.requestId === 'string' ? p.requestId : ''
    if (!id) return
    if (event.method === 'Network.loadingFinished' || event.method === 'Network.loadingFailed') {
      this.pending.delete(id)
    } else if (event.method === 'Network.requestWillBeSent') {
      const request = p.request as { url?: string; method?: string } | undefined
      const type = String(p.type || '')
      if (type === 'Document') this.seen.clear()
      const key = `${request?.method}:${request?.url}`
      if (type === 'Fetch' || type === 'XHR') {
        this.seen.set(key, (this.seen.get(key) || 0) + 1)
        if (this.seen.size > 512) this.seen.delete(this.seen.keys().next().value!)
      }
      this.pending.set(id, { type, key, started: this.now() })
    } else if (event.method === 'Network.responseReceived') {
      const response = p.response as { mimeType?: string } | undefined
      if (p.type === 'EventSource' || response?.mimeType === 'text/event-stream') this.pending.delete(id)
    }
  }

  inFlight(): number {
    return [...this.pending.values()].filter(request => {
      if (request.type === 'WebSocket' || request.type === 'EventSource') return false
      if (request.type === 'Fetch' || request.type === 'XHR') {
        if ((this.seen.get(request.key) || 0) > 1 || this.now() - request.started >= 10_000) return false
      }
      return true
    }).length
  }
}
