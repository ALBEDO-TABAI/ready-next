import type { BrowserController } from './ipc-handler'

export interface BrowserDocumentIdentity {
  key: string
  url: string
  title: string
  mutationRevision: number
}

export interface BrowserSnapshotTarget {
  targetId: string
  role: string
  name: string
  value?: string
  [key: string]: unknown
}

interface BrowserSnapshotState {
  documentKey: string
  documentEpoch: number
  snapshotRevision: number
  mutationRevision: number
  maxBytes: number
  dirty: boolean
  payload: Record<string, unknown> | null
  targets: BrowserSnapshotTarget[]
  refHistory: Map<string, BrowserSnapshotTarget>
}

export type BrowserSnapshotRefResolution =
  | {
      ok: true
      target: BrowserSnapshotTarget
      rawTargetId: string
      documentEpoch: number
      snapshotRevision: number
    }
  | {
      ok: false
      errorCode: 'malformed_ref' | 'wrong_tab' | 'stale_document' | 'stale_snapshot' | 'target_not_found'
      previousTarget?: BrowserSnapshotTarget
      currentDocumentEpoch?: number
      currentSnapshotRevision?: number
    }

const DOCUMENT_IDENTITY_SCRIPT = `(() => {
  const key = '__readyBrowserSnapshotMutationState';
  let state = window[key];
  if (!state || typeof state !== 'object') {
    state = { revision: 0 };
    try {
      const observer = new MutationObserver(() => { state.revision += 1; });
      observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true
      });
      state.observer = observer;
    } catch {}
    window[key] = state;
  }
  return {
    url: String(location.href || ''),
    title: String(document.title || ''),
    timeOrigin: Number(performance.timeOrigin || 0),
    mutationRevision: Number(state.revision || 0)
  };
})()`

function tabKey(controller: BrowserController, tabId: string | null): string {
  return tabId || controller.getActiveTab?.()?.id || '__active__'
}

function encodePart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodePart(value: string): string | null {
  try { return Buffer.from(value, 'base64url').toString('utf8') } catch { return null }
}

export function parseBrowserSnapshotRef(ref: string): {
  tabId: string
  documentEpoch: number
  snapshotRevision: number
  rawTargetId: string
} | null {
  const match = /^br2\.([A-Za-z0-9_-]+)\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(ref || ''))
  if (!match) return null
  const decodedTab = decodePart(match[1])
  const rawTargetId = decodePart(match[4])
  if (decodedTab === null || rawTargetId === null) return null
  return {
    tabId: decodedTab,
    documentEpoch: Number(match[2]),
    snapshotRevision: Number(match[3]),
    rawTargetId,
  }
}

function publicRef(tabId: string, epoch: number, revision: number, rawTargetId: string): string {
  return `br2.${encodePart(tabId)}.${epoch}.${revision}.${encodePart(rawTargetId)}`
}

function payloadTargets(payload: Record<string, unknown> | null): BrowserSnapshotTarget[] {
  const map = payload?.pageMap
  if (!map || typeof map !== 'object') return []
  const targets = (map as { targets?: unknown }).targets
  return Array.isArray(targets)
    ? targets.filter((target): target is BrowserSnapshotTarget => Boolean(target && typeof target === 'object'))
    : []
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncateMiddle(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const marker = '\n… (truncated middle) …\n'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (maxBytes <= markerBytes + 8) return ''
  const headBudget = Math.floor((maxBytes - markerBytes) * 0.75)
  const tailBudget = maxBytes - markerBytes - headBudget
  const fit = (input: string, budget: number, fromEnd: boolean): string => {
    let out = ''
    const units = Array.from(input)
    const ordered = fromEnd ? units.reverse() : units
    for (const unit of ordered) {
      const next = fromEnd ? unit + out : out + unit
      if (Buffer.byteLength(next, 'utf8') > budget) break
      out = next
    }
    return out
  }
  return `${fit(value, headBudget, false)}${marker}${fit(value, tailBudget, true)}`
}

function sampleHeadAndTail<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items
  if (count <= 0) return []
  const head = Math.ceil(count * 0.7)
  return [...items.slice(0, head), ...items.slice(-(count - head))]
}

/**
 * The public snapshot has one hard byte budget for text plus target metadata.
 * Full targets stay private in BrowserSnapshotState so browser_find can search
 * the complete page without forcing another DOM scan.
 */
function fitSnapshotPayload(
  payload: Record<string, unknown>,
  fullTargets: BrowserSnapshotTarget[],
  maxBytes: number,
): Record<string, unknown> {
  const rawPageMap = payload.pageMap && typeof payload.pageMap === 'object'
    ? payload.pageMap as Record<string, unknown>
    : {}
  const rawText = String(rawPageMap.text || '')
  let targetCount = fullTargets.length
  let textBudget = Math.max(512, Math.floor(maxBytes * 0.5))
  let candidate: Record<string, unknown> = payload

  for (let pass = 0; pass < 24; pass += 1) {
    const targets = sampleHeadAndTail(fullTargets, targetCount)
    const text = truncateMiddle(rawText, textBudget)
    candidate = {
      ...payload,
      pageMap: {
        ...rawPageMap,
        text,
        targets,
        totalTargets: fullTargets.length,
        returnedTargets: targets.length,
        nextCursor: targets.length < fullTargets.length ? String(targets.length) : null,
      },
    }
    if (byteLength(candidate) <= maxBytes) return candidate
    if (targetCount > 0) {
      targetCount = Math.max(0, Math.floor(targetCount * 0.72))
      continue
    }
    textBudget = Math.max(0, Math.floor(textBudget * 0.7))
  }

  return candidate
}

export class BrowserSnapshotService {
  private states = new WeakMap<BrowserController, Map<string, BrowserSnapshotState>>()

  private stateMap(controller: BrowserController): Map<string, BrowserSnapshotState> {
    let map = this.states.get(controller)
    if (!map) {
      map = new Map()
      this.states.set(controller, map)
    }
    return map
  }

  async documentIdentity(controller: BrowserController, tabId: string | null): Promise<BrowserDocumentIdentity> {
    const raw = await controller.executeJS(tabId, DOCUMENT_IDENTITY_SCRIPT) as {
      url?: unknown
      title?: unknown
      timeOrigin?: unknown
      mutationRevision?: unknown
    } | null
    const url = String(raw?.url || '')
    const timeOrigin = Number(raw?.timeOrigin || 0)
    return {
      key: `${url}\u0000${Number.isFinite(timeOrigin) ? timeOrigin : 0}`,
      url,
      title: String(raw?.title || ''),
      mutationRevision: Math.max(0, Number(raw?.mutationRevision || 0) || 0),
    }
  }

  markDirty(controller: BrowserController, tabId: string | null): void {
    const state = this.stateMap(controller).get(tabKey(controller, tabId))
    if (state) state.dirty = true
  }

  currentState(controller: BrowserController, tabId: string | null): {
    documentEpoch: number
    snapshotRevision: number
  } | null {
    const state = this.stateMap(controller).get(tabKey(controller, tabId))
    return state ? { documentEpoch: state.documentEpoch, snapshotRevision: state.snapshotRevision } : null
  }

  cachedPayload(controller: BrowserController, tabId: string | null): Record<string, unknown> | null {
    return this.stateMap(controller).get(tabKey(controller, tabId))?.payload || null
  }

  async capture(
    controller: BrowserController,
    tabId: string | null,
    maxBytes: number,
    captureRaw: (snapshotRevision: number) => Promise<Record<string, unknown>>,
    options: { force?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const key = tabKey(controller, tabId)
    const identity = await this.documentIdentity(controller, tabId)
    const map = this.stateMap(controller)
    let state = map.get(key)
    if (!state) {
      state = {
        documentKey: identity.key,
        documentEpoch: 1,
        snapshotRevision: 0,
        mutationRevision: identity.mutationRevision,
        maxBytes,
        dirty: true,
        payload: null,
        targets: [],
        refHistory: new Map(),
      }
      map.set(key, state)
    } else if (state.documentKey !== identity.key) {
      state.documentKey = identity.key
      state.documentEpoch += 1
      state.snapshotRevision = 0
      state.mutationRevision = identity.mutationRevision
      state.dirty = true
      state.payload = null
      state.targets = []
    } else if (state.mutationRevision !== identity.mutationRevision) {
      state.mutationRevision = identity.mutationRevision
      state.dirty = true
    }

    if (!options.force && !state.dirty && state.payload && state.maxBytes === maxBytes) {
      return state.payload
    }

    const nextRevision = state.snapshotRevision + 1
    const raw = await captureRaw(nextRevision)
    const currentTab = key
    const targets = payloadTargets(raw)
    const rewritten = targets.map((target) => {
      const rawTargetId = String(target.targetId || '')
      const targetId = publicRef(currentTab, state!.documentEpoch, nextRevision, rawTargetId)
      const next = { ...target, targetId }
      state!.refHistory.set(targetId, next)
      return next
    })
    while (state.refHistory.size > 2_000) {
      const oldest = state.refHistory.keys().next().value
      if (typeof oldest !== 'string') break
      state.refHistory.delete(oldest)
    }
    const pageMap = raw.pageMap && typeof raw.pageMap === 'object'
      ? { ...(raw.pageMap as Record<string, unknown>), generation: nextRevision, targets: rewritten }
      : { generation: nextRevision, targets: rewritten }
    const pageIdentity = raw.pageIdentity && typeof raw.pageIdentity === 'object'
      ? raw.pageIdentity as Record<string, unknown>
      : {}
    const unboundedPayload = {
      ...raw,
      pageIdentity: {
        ...pageIdentity,
        url: identity.url || pageIdentity.url,
        title: identity.title || pageIdentity.title,
        tabId: currentTab,
        documentEpoch: state.documentEpoch,
        snapshotRevision: nextRevision,
        generation: nextRevision,
      },
      pageMap,
    }
    const payload = fitSnapshotPayload(unboundedPayload, rewritten, maxBytes)
    state.snapshotRevision = nextRevision
    state.maxBytes = maxBytes
    state.dirty = false
    state.targets = rewritten
    state.payload = payload
    return payload
  }

  async resolveRef(
    controller: BrowserController,
    tabId: string | null,
    ref: string,
  ): Promise<BrowserSnapshotRefResolution> {
    const parsed = parseBrowserSnapshotRef(ref)
    if (!parsed) return { ok: false, errorCode: 'malformed_ref' }
    const key = tabKey(controller, tabId)
    if (parsed.tabId !== key) return { ok: false, errorCode: 'wrong_tab' }
    const state = this.stateMap(controller).get(key)
    const previousTarget = state?.refHistory.get(ref)
    if (!state) return { ok: false, errorCode: 'stale_snapshot', previousTarget }
    const identity = await this.documentIdentity(controller, tabId)
    if (identity.key !== state.documentKey || parsed.documentEpoch !== state.documentEpoch) {
      return {
        ok: false,
        errorCode: 'stale_document',
        previousTarget,
        currentDocumentEpoch: identity.key === state.documentKey ? state.documentEpoch : state.documentEpoch + 1,
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    if (parsed.snapshotRevision !== state.snapshotRevision || state.dirty || identity.mutationRevision !== state.mutationRevision) {
      return {
        ok: false,
        errorCode: 'stale_snapshot',
        previousTarget,
        currentDocumentEpoch: state.documentEpoch,
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    const target = state.targets.find((item) => item.targetId === ref)
    if (!target) return { ok: false, errorCode: 'target_not_found', previousTarget }
    return {
      ok: true,
      target,
      rawTargetId: parsed.rawTargetId,
      documentEpoch: parsed.documentEpoch,
      snapshotRevision: parsed.snapshotRevision,
    }
  }

  rebindRef(controller: BrowserController, tabId: string | null, staleRef: string): BrowserSnapshotRefResolution {
    const key = tabKey(controller, tabId)
    const state = this.stateMap(controller).get(key)
    const previous = state?.refHistory.get(staleRef)
    if (!state || !previous) return { ok: false, errorCode: 'target_not_found', previousTarget: previous }
    const matches = state.targets.filter((target) =>
      target.role === previous.role && target.name === previous.name)
    if (matches.length !== 1) {
      return {
        ok: false,
        errorCode: 'target_not_found',
        previousTarget: previous,
        currentDocumentEpoch: state.documentEpoch,
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    const ref = parseBrowserSnapshotRef(matches[0].targetId)
    if (!ref) return { ok: false, errorCode: 'malformed_ref', previousTarget: previous }
    return {
      ok: true,
      target: matches[0],
      rawTargetId: ref.rawTargetId,
      documentEpoch: ref.documentEpoch,
      snapshotRevision: ref.snapshotRevision,
    }
  }

  find(
    controller: BrowserController,
    tabId: string | null,
    options: { query?: string; role?: string; cursor?: number; limit?: number },
  ): {
    matches: BrowserSnapshotTarget[]
    total: number
    cursor: number
    nextCursor: string | null
    documentEpoch: number
    snapshotRevision: number
  } | null {
    const state = this.stateMap(controller).get(tabKey(controller, tabId))
    if (!state?.payload || state.dirty) return null
    const query = String(options.query || '').trim().toLowerCase()
    const role = String(options.role || '').trim().toLowerCase()
    const filtered = state.targets
      .filter((target) => !role || String(target.role || '').toLowerCase() === role)
      .filter((target) => !query || `${target.name || ''} ${target.value || ''}`.toLowerCase().includes(query))
    const cursor = Math.max(0, Math.min(filtered.length, Number(options.cursor || 0)))
    const limit = Math.max(1, Math.min(100, Number(options.limit || 20)))
    const matches = filtered.slice(cursor, cursor + limit)
    const next = cursor + matches.length
    return {
      matches,
      total: filtered.length,
      cursor,
      nextCursor: next < filtered.length ? String(next) : null,
      documentEpoch: state.documentEpoch,
      snapshotRevision: state.snapshotRevision,
    }
  }

  resetForTests(): void {
    this.states = new WeakMap()
  }
}

export const browserSnapshotService = new BrowserSnapshotService()
