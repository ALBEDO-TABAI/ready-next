export interface ActiveWidgetEditLease {
  widgetId: string | null
  tabId: string | null
  documentPath: string | null
  widgetTitle: string
  acquiredAt: number
  expireAt: number
  origin: 'pipeline_write' | 'pipeline_locate' | 'envelope_widget_target'
  widgetFingerprint?: string | null
  widgetTextSample?: string | null
}

export interface AcquireWidgetEditLeaseInput {
  widgetId?: string | null
  tabId?: string | null
  documentPath?: string | null
  widgetTitle?: string | null
  origin: ActiveWidgetEditLease['origin']
  ttlMs?: number
  widgetFingerprint?: string | null
  widgetTextSample?: string | null
}

export interface RefreshWidgetEditLeaseInput {
  ttlMs?: number
  widgetFingerprint?: string | null
  widgetTextSample?: string | null
}

const DEFAULT_TTL_MS = 120_000

export class WidgetEditLeaseStore {
  private readonly leases = new Map<string, ActiveWidgetEditLease>()

  private static buildKey(agent: string, sessionId: string | null | undefined): string {
    return `${agent}::${sessionId || '_'}`
  }

  acquire(agent: string, sessionId: string | null | undefined, input: AcquireWidgetEditLeaseInput): ActiveWidgetEditLease {
    const now = Date.now()
    const ttl = Math.max(10_000, input.ttlMs ?? DEFAULT_TTL_MS)
    const lease: ActiveWidgetEditLease = {
      widgetId: input.widgetId ? String(input.widgetId) : null,
      tabId: input.tabId ? String(input.tabId) : null,
      documentPath: input.documentPath ? String(input.documentPath) : null,
      widgetTitle: String(input.widgetTitle || '').trim() || '当前 widget',
      acquiredAt: now,
      expireAt: now + ttl,
      origin: input.origin,
      widgetFingerprint: input.widgetFingerprint ?? null,
      widgetTextSample: input.widgetTextSample ?? null,
    }
    this.leases.set(WidgetEditLeaseStore.buildKey(agent, sessionId), lease)
    return lease
  }

  refresh(
    agent: string,
    sessionId: string | null | undefined,
    input?: RefreshWidgetEditLeaseInput,
  ): ActiveWidgetEditLease | null {
    const key = WidgetEditLeaseStore.buildKey(agent, sessionId)
    const existing = this.leases.get(key)
    if (!existing) return null
    const now = Date.now()
    if (existing.expireAt <= now) {
      this.leases.delete(key)
      return null
    }
    const ttl = Math.max(10_000, input?.ttlMs ?? DEFAULT_TTL_MS)
    const next: ActiveWidgetEditLease = {
      ...existing,
      expireAt: now + ttl,
      widgetFingerprint: input && 'widgetFingerprint' in input
        ? input.widgetFingerprint ?? null
        : existing.widgetFingerprint ?? null,
      widgetTextSample: input && 'widgetTextSample' in input
        ? input.widgetTextSample ?? null
        : existing.widgetTextSample ?? null,
    }
    this.leases.set(key, next)
    return next
  }

  resolve(agent: string, sessionId: string | null | undefined): ActiveWidgetEditLease | null {
    const key = WidgetEditLeaseStore.buildKey(agent, sessionId)
    const lease = this.leases.get(key)
    if (!lease) return null
    if (lease.expireAt <= Date.now()) {
      this.leases.delete(key)
      return null
    }
    return lease
  }

  release(agent: string, sessionId?: string | null): void {
    if (typeof sessionId === 'undefined') {
      for (const key of Array.from(this.leases.keys())) {
        if (key.startsWith(`${agent}::`)) this.leases.delete(key)
      }
      return
    }
    this.leases.delete(WidgetEditLeaseStore.buildKey(agent, sessionId))
  }

  clear(): void {
    this.leases.clear()
  }

  snapshotAll(): ActiveWidgetEditLease[] {
    const now = Date.now()
    return Array.from(this.leases.values()).filter((lease) => lease.expireAt > now)
  }
}
