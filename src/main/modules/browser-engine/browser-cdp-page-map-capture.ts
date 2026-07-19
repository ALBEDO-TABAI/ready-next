import type { BrowserController } from './ipc-handler'
import {
  isBrowserPageMapTargetRole,
  type RawAxNode,
} from './agent-browser-page-map'

interface CdpAxValue { value?: unknown }
interface CdpAxProperty { name?: unknown; value?: CdpAxValue }
interface CdpAxNode {
  nodeId?: unknown
  frameId?: unknown
  ignored?: unknown
  role?: CdpAxValue
  name?: CdpAxValue
  value?: CdpAxValue
  properties?: CdpAxProperty[]
  parentId?: unknown
  childIds?: unknown[]
  backendDOMNodeId?: unknown
}

interface CdpDomDocument {
  frameId?: unknown
  nodes?: unknown
}

interface BackendTargetRecord {
  role?: unknown
  name?: unknown
  value?: unknown
  states?: unknown
  box?: unknown
  rendered?: unknown
  visible?: unknown
  enabled?: unknown
  editable?: unknown
  href?: unknown
  inputType?: unknown
  autocomplete?: unknown
  formAction?: unknown
  ancestorContext?: unknown
}

export interface BrowserCdpPageMapCapture {
  rawRoots: RawAxNode[]
  targetSource: 'cdp_accessibility_dom'
  backendTargetCount: number
  unstableAxTargetCount: number
}

type EnrichBackendNode = (
  backendDOMNodeId: number,
  roleHint: string,
) => Promise<BackendTargetRecord | null>

function valueOf(value: CdpAxValue | undefined): string {
  return typeof value?.value === 'string' || typeof value?.value === 'number'
    ? String(value.value)
    : ''
}

function finiteBackendId(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function axProperties(node: CdpAxNode): Record<string, boolean | string | undefined> {
  const out: Record<string, boolean | string | undefined> = {}
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    const name = String(property.name || '')
    const value = property.value?.value
    if (!name || (typeof value !== 'boolean' && typeof value !== 'string')) continue
    out[name] = value
  }
  return out
}

function targetishAxNode(node: CdpAxNode, clickableBackendIds: ReadonlySet<number>): boolean {
  const role = valueOf(node.role)
  const backendId = finiteBackendId(node.backendDOMNodeId)
  if (isBrowserPageMapTargetRole(role)) return true
  if (backendId && clickableBackendIds.has(backendId)) return true
  const properties = axProperties(node)
  return properties.focusable === true || properties.editable === true
}

function sparseIndexes(value: unknown): number[] {
  if (!value || typeof value !== 'object') return []
  const indexes = (value as { index?: unknown }).index
  return Array.isArray(indexes)
    ? indexes.map(Number).filter((item) => Number.isInteger(item) && item >= 0)
    : []
}

function domDocumentForFrame(value: unknown, frameId: string): CdpDomDocument | null {
  const documents = value && typeof value === 'object'
    ? (value as { documents?: unknown }).documents
    : null
  if (!Array.isArray(documents) || documents.length === 0) return null
  const parsed = documents.filter((document): document is CdpDomDocument => Boolean(document && typeof document === 'object'))
  return parsed.find((document) => String(document.frameId || '') === frameId) || parsed[0] || null
}

function backendIdsFromDomDocument(document: CdpDomDocument | null): Set<number> {
  const nodes = document?.nodes
  const values = nodes && typeof nodes === 'object'
    ? (nodes as { backendNodeId?: unknown }).backendNodeId
    : null
  return new Set(Array.isArray(values)
    ? values.map(finiteBackendId).filter((id): id is number => id !== null)
    : [])
}

function clickableBackendIdsFromDomDocument(document: CdpDomDocument | null): Set<number> {
  const out = new Set<number>()
  const nodes = document?.nodes
  if (!nodes || typeof nodes !== 'object') return out
  const backendIds = (nodes as { backendNodeId?: unknown }).backendNodeId
  const clickable = (nodes as { isClickable?: unknown }).isClickable
  if (!Array.isArray(backendIds)) return out
  for (const index of sparseIndexes(clickable)) {
    const backendId = finiteBackendId(backendIds[index])
    if (backendId) out.add(backendId)
  }
  return out
}

async function mapInBatches<T, R>(
  items: T[],
  size: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(...await Promise.all(items.slice(index, index + size).map(mapper)))
  }
  return out
}

function rawFromAx(
  node: CdpAxNode,
  enriched: BackendTargetRecord | null,
  clickableBackendIds: ReadonlySet<number>,
  children: RawAxNode[],
): RawAxNode {
  const backendDOMNodeId = finiteBackendId(node.backendDOMNodeId) || undefined
  const axRole = valueOf(node.role) || 'generic'
  const role = String(enriched?.role || (
    backendDOMNodeId && clickableBackendIds.has(backendDOMNodeId) && !isBrowserPageMapTargetRole(axRole)
      ? 'clickable'
      : axRole
  ))
  const properties = axProperties(node)
  const states = enriched?.states && typeof enriched.states === 'object'
    ? enriched.states as Record<string, boolean | string | undefined>
    : properties
  return {
    role,
    name: String(enriched?.name || valueOf(node.name) || ''),
    value: String(enriched?.value || valueOf(node.value) || ''),
    states,
    ...(backendDOMNodeId ? { backendDOMNodeId } : {}),
    ...(enriched?.box && typeof enriched.box === 'object'
      ? { box: enriched.box as { x: number; y: number; width: number; height: number } }
      : {}),
    rendered: typeof enriched?.rendered === 'boolean' ? enriched.rendered : undefined,
    visible: typeof enriched?.visible === 'boolean' ? enriched.visible : undefined,
    enabled: typeof enriched?.enabled === 'boolean' ? enriched.enabled : properties.disabled !== true,
    editable: typeof enriched?.editable === 'boolean' ? enriched.editable : properties.editable === true,
    href: String(enriched?.href || ''),
    inputType: String(enriched?.inputType || ''),
    autocomplete: String(enriched?.autocomplete || ''),
    formAction: String(enriched?.formAction || ''),
    ancestorContext: String(enriched?.ancestorContext || ''),
    // Ignored AX wrappers are lifted by the generic role instead of dropping
    // their children, preserving reachable descendants in the same tree.
    ignored: false,
    children,
  }
}

/**
 * Capture one complete CDP Accessibility tree and merge Chromium's structural
 * clickability set. There is no site selector and no head/tail sampling: the
 * snapshot service pages the resulting complete target set for model output.
 */
export async function captureBrowserCdpPageMap(
  controller: BrowserController,
  tabId: string | null,
  enrichBackendNode: EnrichBackendNode,
): Promise<BrowserCdpPageMapCapture | null> {
  let mainFrameId = ''
  let axResponse: unknown
  let domSnapshot: unknown
  try {
    const frameTree = await controller.sendCdpCommand(tabId, 'Page.getFrameTree') as {
      frameTree?: { frame?: { id?: unknown } }
    } | null
    mainFrameId = String(frameTree?.frameTree?.frame?.id || '')
    if (!mainFrameId) return null
    ;[axResponse, domSnapshot] = await Promise.all([
      controller.sendCdpCommand(tabId, 'Accessibility.getFullAXTree', { frameId: mainFrameId }),
      controller.sendCdpCommand(tabId, 'DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity'],
        includeDOMRects: true,
        includePaintOrder: false,
      }),
    ])
  } catch {
    return null
  }
  const nodes = axResponse && typeof axResponse === 'object'
    ? (axResponse as { nodes?: unknown }).nodes
    : null
  if (!Array.isArray(nodes) || nodes.length === 0) return null
  const domDocument = domDocumentForFrame(domSnapshot, mainFrameId)
  const mainBackendIds = backendIdsFromDomDocument(domDocument)
  const axNodes = nodes
    .filter((node): node is CdpAxNode => Boolean(node && typeof node === 'object'))
    .filter((node) => {
      const nodeFrameId = String(node.frameId || '')
      if (nodeFrameId && nodeFrameId !== mainFrameId) return false
      const backendId = finiteBackendId(node.backendDOMNodeId)
      return backendId === null || mainBackendIds.size === 0 || mainBackendIds.has(backendId)
    })
  const clickableBackendIds = clickableBackendIdsFromDomDocument(domDocument)
  const axById = new Map(axNodes.map((node) => [String(node.nodeId || ''), node]))
  const axBackendIds = new Set(axNodes.map((node) => finiteBackendId(node.backendDOMNodeId)).filter((id): id is number => Boolean(id)))
  const candidateNodes = axNodes.filter((node) => targetishAxNode(node, clickableBackendIds))
  const enrichedPairs = await mapInBatches(candidateNodes, 16, async (node) => {
    const backendId = finiteBackendId(node.backendDOMNodeId)
    if (!backendId) return [String(node.nodeId || ''), null] as const
    try {
      const result = await enrichBackendNode(backendId, valueOf(node.role))
      return [String(node.nodeId || ''), result] as const
    } catch {
      return [String(node.nodeId || ''), null] as const
    }
  })
  const enrichedByAxId = new Map(enrichedPairs)
  const rootNodes = axNodes.filter((node) => {
    const parentId = String(node.parentId || '')
    return !parentId || !axById.has(parentId)
  })
  const seen = new Set<string>()
  const build = (node: CdpAxNode): RawAxNode => {
    const nodeId = String(node.nodeId || '')
    seen.add(nodeId)
    const children = (Array.isArray(node.childIds) ? node.childIds : [])
      .map((id) => axById.get(String(id || '')))
      .filter((child): child is CdpAxNode => Boolean(child))
      .map(build)
    return rawFromAx(node, enrichedByAxId.get(nodeId) || null, clickableBackendIds, children)
  }
  const rawRoots = rootNodes.map(build)
  // DOMSnapshot may know about delegated click listeners that AX omits. Add
  // those exact backend nodes as ordinary root targets after mechanical
  // enrichment; DOM order is retained by the snapshot's backend id arrays.
  const domOnlyIds = Array.from(clickableBackendIds).filter((id) => !axBackendIds.has(id))
  const domOnly = await mapInBatches(domOnlyIds, 16, async (backendDOMNodeId) => {
    try {
      const target = await enrichBackendNode(backendDOMNodeId, 'clickable')
      if (!target) return null
      return rawFromAx(
        { role: { value: 'clickable' }, backendDOMNodeId },
        target,
        clickableBackendIds,
        [],
      )
    } catch {
      return null
    }
  })
  rawRoots.push(...domOnly.filter((node): node is RawAxNode => Boolean(node)))
  return {
    rawRoots,
    targetSource: 'cdp_accessibility_dom',
    backendTargetCount: candidateNodes.filter((node) => finiteBackendId(node.backendDOMNodeId)).length + domOnly.filter(Boolean).length,
    unstableAxTargetCount: candidateNodes.filter((node) => !finiteBackendId(node.backendDOMNodeId)).length,
  }
}
