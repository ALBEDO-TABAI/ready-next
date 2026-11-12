import type { BrowserController } from './ipc-handler'

export const BROWSER_CONTROLLER_STATE_TARGET = Symbol.for('ready.browserControllerStateTarget')

export interface BrowserDocumentIdentity {
  key: string
  url: string
  title: string
  mutationRevision: number
  physicalTargetToken: string
  frameDocumentToken: string
}

export interface BrowserSnapshotTarget {
  box?: { x: number; y: number; width: number; height: number }
  targetId: string
  role: string
  name: string
  value?: string
  frameId?: string
  parentTargetId?: string
  ancestorTargetIds?: string[]
  visible?: boolean
  enabled?: boolean
  editable?: boolean
  physicalTargetToken?: string
  frameDocumentToken?: string
  stableNodeToken?: string
  backendDOMNodeId?: number
  [key: string]: unknown
}

export type BrowserFindPurpose = 'any' | 'action' | 'input'

interface BrowserSnapshotState {
  documentKey: string
  physicalTargetToken: string
  mainFrameDocumentToken: string
  documentEpoch: number
  snapshotRevision: number
  mutationRevision: number
  maxBytes: number
  dirty: boolean
  payload: Record<string, unknown> | null
  targets: BrowserSnapshotTarget[]
  refHistory: Map<string, BrowserSnapshotTarget>
  consumedUnstableRefs: Set<string>
}

export type BrowserSnapshotRefResolution =
  | {
      ok: true
      target: BrowserSnapshotTarget
      rawTargetId: string
      physicalTargetToken: string
      frameId: string
      frameDocumentToken: string
      documentEpoch: number
      snapshotRevision: number
    }
  | {
      ok: false
      errorCode: 'malformed_ref' | 'wrong_tab' | 'stale_target' | 'stale_document' | 'stale_snapshot' | 'target_not_found'
      previousTarget?: BrowserSnapshotTarget
      currentDocumentEpoch?: number
      currentSnapshotRevision?: number
    }

const DOCUMENT_IDENTITY_SCRIPT = `(() => {
  const targetKey = '__readyBrowserTargetIdentityV3';
  let targetState = globalThis[targetKey];
  if (!targetState || targetState.document !== document || !(targetState.nodesByToken instanceof Map) || !(targetState.tokenByNode instanceof WeakMap)) {
    const bytes = new Uint32Array(4);
    try { globalThis.crypto.getRandomValues(bytes); } catch {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 0xffffffff);
    }
    targetState = {
      document,
      documentToken: Array.from(bytes).map((value) => value.toString(36)).join('-'),
      nextTargetSequence: 1,
      nodesByToken: new Map(),
      tokenByNode: new WeakMap()
    };
    globalThis[targetKey] = targetState;
  }
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
    mutationRevision: Number(state.revision || 0),
    frameDocumentToken: String(targetState.documentToken || '')
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
  physicalTargetToken: string
  frameId: string
  frameDocumentToken: string
  snapshotRevision: number
  rawTargetId: string
} | null {
  const match = /^br3\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(ref || ''))
  if (!match) return null
  const decodedTab = decodePart(match[1])
  const physicalTargetToken = decodePart(match[2])
  const frameId = decodePart(match[3])
  const frameDocumentToken = decodePart(match[4])
  const rawTargetId = decodePart(match[6])
  if (decodedTab === null || physicalTargetToken === null || frameId === null || frameDocumentToken === null || rawTargetId === null) return null
  return {
    tabId: decodedTab,
    physicalTargetToken,
    frameId,
    frameDocumentToken,
    snapshotRevision: Number(match[5]),
    rawTargetId,
  }
}

function publicRef(
  tabId: string,
  physicalTargetToken: string,
  frameId: string,
  frameDocumentToken: string,
  revision: number,
  rawTargetId: string,
): string {
  return `br3.${encodePart(tabId)}.${encodePart(physicalTargetToken)}.${encodePart(frameId)}.${encodePart(frameDocumentToken)}.${revision}.${encodePart(rawTargetId)}`
}

function rawTargetIsUnstable(rawTargetId: string): boolean {
  const match = /^\d+:[^:]+:(.+)$/.exec(rawTargetId)
  return Boolean(match?.[1]?.startsWith('p'))
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

function truncatePage(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const marker = '\n… (continue with browser_find cursor) …'
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (maxBytes <= markerBytes + 8) return ''
  let out = ''
  for (const unit of Array.from(value)) {
    if (Buffer.byteLength(out + unit, 'utf8') > maxBytes - markerBytes) break
    out += unit
  }
  return `${out}${marker}`
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => (
    item !== '' && item !== null && item !== undefined
  ))
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

export function compactBrowserSnapshotTarget(
  target: BrowserSnapshotTarget,
): BrowserSnapshotTarget {
  const fingerprint = nonEmptyRecord(target.fingerprint)
  const states = nonEmptyRecord(target.states)
  const frameId = String(target.frameId || '0')
  return {
    targetId: target.targetId,
    role: target.role,
    name: target.name,
    ...(typeof target.value === 'string' && target.value ? { value: target.value } : {}),
    ...(frameId !== '0' ? { frameId } : {}),
    ...(target.rendered === false ? { rendered: false } : {}),
    ...(target.visible === false ? { visible: false } : {}),
    ...(target.enabled === false ? { enabled: false } : {}),
    ...(target.editable === true ? { editable: true } : {}),
    ...(target.unstable === true ? { unstable: true } : {}),
    ...(states ? { states } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  }
}

function compactPageIdentity(value: unknown): Record<string, unknown> {
  const identity = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  return {
    url: String(identity.url || ''),
    title: String(identity.title || ''),
    tabId: String(identity.tabId || ''),
    documentEpoch: Number(identity.documentEpoch || 0),
    snapshotRevision: Number(identity.snapshotRevision || 0),
    generation: Number(identity.generation || 0),
  }
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
  const publicPayload = {
    ...payload,
    pageIdentity: compactPageIdentity(payload.pageIdentity),
  }
  let targetCount = fullTargets.length
  let textBudget = Math.max(512, Math.floor(maxBytes * 0.5))
  let candidate: Record<string, unknown> = publicPayload

  for (let pass = 0; pass < 24; pass += 1) {
    const targets = fullTargets.slice(0, targetCount).map(compactBrowserSnapshotTarget)
    const text = truncatePage(rawText, textBudget)
    candidate = {
      ...publicPayload,
      pageMap: {
        ...rawPageMap,
        text,
        targets,
        targetDefaults: { rendered: true, visible: true, enabled: true, editable: false },
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
    const canonical = (controller as unknown as {
      [BROWSER_CONTROLLER_STATE_TARGET]?: BrowserController
    })[BROWSER_CONTROLLER_STATE_TARGET] || controller
    let map = this.states.get(canonical)
    if (!map) {
      map = new Map()
      this.states.set(canonical, map)
    }
    return map
  }

  async documentIdentity(controller: BrowserController, tabId: string | null): Promise<BrowserDocumentIdentity> {
    const raw = await controller.executeJS(tabId, DOCUMENT_IDENTITY_SCRIPT) as {
      url?: unknown
      title?: unknown
      timeOrigin?: unknown
      mutationRevision?: unknown
      frameDocumentToken?: unknown
    } | null
    const url = String(raw?.url || '')
    const timeOrigin = Number(raw?.timeOrigin || 0)
    return {
      key: `${url}\u0000${Number.isFinite(timeOrigin) ? timeOrigin : 0}`,
      url,
      title: String(raw?.title || ''),
      mutationRevision: Math.max(0, Number(raw?.mutationRevision || 0) || 0),
      physicalTargetToken: typeof controller.getPhysicalTargetToken === 'function'
        ? controller.getPhysicalTargetToken(tabId)
        : `controller:${tabKey(controller, tabId)}`,
      frameDocumentToken: String(raw?.frameDocumentToken || ''),
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

  currentDocumentIdentity(controller: BrowserController, tabId: string | null): {
    physicalTargetToken: string
    frameDocumentToken: string
  } | null {
    const state = this.stateMap(controller).get(tabKey(controller, tabId))
    return state
      ? {
          physicalTargetToken: state.physicalTargetToken,
          frameDocumentToken: state.mainFrameDocumentToken,
        }
      : null
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
        physicalTargetToken: identity.physicalTargetToken,
        mainFrameDocumentToken: identity.frameDocumentToken,
        documentEpoch: 1,
        snapshotRevision: 0,
        mutationRevision: identity.mutationRevision,
        maxBytes,
        dirty: true,
        payload: null,
        targets: [],
        refHistory: new Map(),
        consumedUnstableRefs: new Set(),
      }
      map.set(key, state)
    } else if (
      state.physicalTargetToken !== identity.physicalTargetToken
      || state.mainFrameDocumentToken !== identity.frameDocumentToken
      || state.documentKey !== identity.key
    ) {
      state.documentKey = identity.key
      state.physicalTargetToken = identity.physicalTargetToken
      state.mainFrameDocumentToken = identity.frameDocumentToken
      state.documentEpoch += 1
      state.snapshotRevision = 0
      state.mutationRevision = identity.mutationRevision
      state.dirty = true
      state.payload = null
      state.targets = []
      state.consumedUnstableRefs.clear()
    } else if (state.mutationRevision !== identity.mutationRevision) {
      state.mutationRevision = identity.mutationRevision
      state.dirty = true
    }

    if (!options.force && !state.dirty && state.payload && state.maxBytes === maxBytes) {
      return { ...state.payload, observationFresh: false }
    }

    const nextRevision = state.snapshotRevision + 1
    const raw = await captureRaw(nextRevision)
    const currentTab = key
    const targets = payloadTargets(raw)
    const refByRawTargetId = new Map(targets.map((target) => {
      const rawTargetId = String(target.targetId || '')
      const frameId = String(target.frameId || '0')
      const frameDocumentToken = String(target.frameDocumentToken || (
        frameId === '0' ? state!.mainFrameDocumentToken : ''
      ))
      const targetId = publicRef(
        currentTab,
        state!.physicalTargetToken,
        frameId,
        frameDocumentToken,
        nextRevision,
        rawTargetId,
      )
      return [rawTargetId, targetId] as const
    }))
    const rewritten = targets.map((target) => {
      const {
        parentTargetId: rawParentTargetId,
        ancestorTargetIds: rawAncestorTargetIds,
        ...targetWithoutRelationships
      } = target
      const rawTargetId = String(target.targetId || '')
      const frameId = String(target.frameId || '0')
      const frameDocumentToken = String(target.frameDocumentToken || (
        frameId === '0' ? state!.mainFrameDocumentToken : ''
      ))
      const targetId = refByRawTargetId.get(rawTargetId) || publicRef(
        currentTab,
        state!.physicalTargetToken,
        frameId,
        frameDocumentToken,
        nextRevision,
        rawTargetId,
      )
      const ancestorTargetIds = Array.isArray(rawAncestorTargetIds)
        ? rawAncestorTargetIds
          .map((rawId) => refByRawTargetId.get(String(rawId || '')))
          .filter((value): value is string => Boolean(value))
        : []
      const parentTargetId = rawParentTargetId
        ? refByRawTargetId.get(String(rawParentTargetId))
        : ancestorTargetIds.at(-1)
      const next = {
        ...targetWithoutRelationships,
        targetId,
        physicalTargetToken: state!.physicalTargetToken,
        frameId,
        frameDocumentToken,
        ...(ancestorTargetIds.length > 0 ? { ancestorTargetIds } : {}),
        ...(parentTargetId ? { parentTargetId } : {}),
      }
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
        physicalTargetToken: state.physicalTargetToken,
        mainFrameId: '0',
        mainFrameDocumentToken: state.mainFrameDocumentToken,
        documentEpoch: state.documentEpoch,
        snapshotRevision: nextRevision,
        generation: nextRevision,
      },
      pageMap,
    }
    const payload = { ...fitSnapshotPayload(unboundedPayload, rewritten, maxBytes), observationFresh: true }
    state.snapshotRevision = nextRevision
    state.consumedUnstableRefs.clear()
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
    const currentPhysicalTargetToken = typeof controller.getPhysicalTargetToken === 'function'
      ? controller.getPhysicalTargetToken(tabId)
      : state.physicalTargetToken
    if (
      parsed.physicalTargetToken !== currentPhysicalTargetToken
      || state.physicalTargetToken !== currentPhysicalTargetToken
    ) {
      return {
        ok: false,
        errorCode: 'stale_document',
        previousTarget,
        currentDocumentEpoch: state.documentEpoch + 1,
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    let frameIdentity: { frameDocumentToken?: unknown; mutationRevision?: unknown } | null = null
    try {
      frameIdentity = (parsed.frameId === '0'
        ? await controller.executeJS(tabId, DOCUMENT_IDENTITY_SCRIPT)
        : typeof controller.executeJSInFrame === 'function'
          ? await controller.executeJSInFrame(tabId, parsed.frameId, DOCUMENT_IDENTITY_SCRIPT)
          : null) as { frameDocumentToken?: unknown; mutationRevision?: unknown } | null
    } catch {
      return { ok: false, errorCode: 'stale_document', previousTarget }
    }
    if (String(frameIdentity?.frameDocumentToken || '') !== parsed.frameDocumentToken) {
      return {
        ok: false,
        errorCode: 'stale_document',
        previousTarget,
        currentDocumentEpoch: state.documentEpoch + (parsed.frameId === '0' ? 1 : 0),
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    const target = previousTarget || state.targets.find((item) => item.targetId === ref)
    if (!target) return { ok: false, errorCode: 'target_not_found', previousTarget }
    const unstable = rawTargetIsUnstable(parsed.rawTargetId) || target.unstable === true
    if (
      unstable
      && (
        parsed.snapshotRevision !== state.snapshotRevision
        || state.dirty
        || (parsed.frameId === '0' && Number(frameIdentity?.mutationRevision || 0) !== state.mutationRevision)
      )
    ) {
      return {
        ok: false,
        errorCode: 'stale_snapshot',
        previousTarget,
        currentDocumentEpoch: state.documentEpoch,
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    if (unstable && state.consumedUnstableRefs.has(ref)) {
      return {
        ok: false,
        errorCode: 'stale_snapshot',
        previousTarget,
        currentDocumentEpoch: state.documentEpoch,
        currentSnapshotRevision: state.snapshotRevision,
      }
    }
    if (unstable) state.consumedUnstableRefs.add(ref)
    return {
      ok: true,
      target,
      rawTargetId: parsed.rawTargetId,
      physicalTargetToken: parsed.physicalTargetToken,
      frameId: parsed.frameId,
      frameDocumentToken: parsed.frameDocumentToken,
      documentEpoch: state.documentEpoch,
      snapshotRevision: parsed.snapshotRevision,
    }
  }

  find(
    controller: BrowserController,
    tabId: string | null,
    options: {
      query?: string
      role?: string
      purpose?: BrowserFindPurpose
      cursor?: number
      limit?: number
      visible?: boolean
      enabled?: boolean
      withinTargetId?: string
      frameId?: string
    },
  ): {
    matches: BrowserSnapshotTarget[]
    total: number
    cursor: number
    nextCursor: string | null
    documentEpoch: number
    snapshotRevision: number
    errorCode?: 'within_target_not_found' | 'within_target_stale'
  } | null {
    const state = this.stateMap(controller).get(tabKey(controller, tabId))
    if (!state?.payload || state.dirty) return null
    const query = String(options.query || '').trim().toLowerCase()
    const role = String(options.role || '').trim().toLowerCase()
    const frameId = String(options.frameId || '').trim()
    const purpose = options.purpose || 'any'
    const withinTargetId = String(options.withinTargetId || '').trim()
    const expectedVisible = options.visible ?? true
    const expectedEnabled = options.enabled ?? true
    if (withinTargetId) {
      const parsed = parseBrowserSnapshotRef(withinTargetId)
      const key = tabKey(controller, tabId)
      if (!parsed || parsed.tabId !== key || !state.targets.some((target) => target.targetId === withinTargetId)) {
        return {
          matches: [],
          total: 0,
          cursor: 0,
          nextCursor: null,
          documentEpoch: state.documentEpoch,
          snapshotRevision: state.snapshotRevision,
          errorCode: parsed && parsed.physicalTargetToken === state.physicalTargetToken
            ? 'within_target_stale'
            : 'within_target_not_found',
        }
      }
    }
    const actionRoles = new Set([
      'button',
      'clickable',
      'link',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'option',
      'tab',
      'combobox',
      'checkbox',
      'radio',
      'switch',
      'slider',
    ])
    const isAvailable = (target: BrowserSnapshotTarget): boolean =>
      target.visible !== false && target.enabled !== false
    const hasPurpose = (target: BrowserSnapshotTarget): boolean => {
      const targetRole = String(target.role || '').toLowerCase()
      if (purpose === 'input') return target.editable === true && isAvailable(target)
      if (purpose === 'action') return actionRoles.has(targetRole) && isAvailable(target)
      return true
    }
    const filtered = state.targets
      .filter((target) => !role || String(target.role || '').toLowerCase() === role)
      .filter((target) => !query || `${target.name || ''} ${target.value || ''}`.toLowerCase().includes(query))
      .filter((target) => !frameId || String(target.frameId || '') === frameId)
      .filter((target) => (target.visible !== false) === expectedVisible)
      .filter((target) => (target.enabled !== false) === expectedEnabled)
      .filter((target) => !withinTargetId || target.ancestorTargetIds?.includes(withinTargetId) === true)
      .filter(hasPurpose)
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

  disposeTab(controller: BrowserController, tabId: string): void {
    this.stateMap(controller).delete(tabId)
  }

  resetForTests(): void {
    this.states = new WeakMap()
  }
}

export const browserSnapshotService = new BrowserSnapshotService()
