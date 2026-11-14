/**
 * Page-map builder (counterplan §5.3, WP2 core).
 *
 * Ports Matrix's `formatDomSnapshot` denoising (Matrix.app browser-v2/main.js
 * :148880-148906) into a pure transform over a normalized accessibility tree:
 *
 *   - drop unnamed `img` nodes,
 *   - lift `generic | listitem | group` wrapper nodes (replace with children),
 *   - keep actionable/semantic roles + visible text + states.
 *
 * The CDP `Accessibility.getFullAXTree` capture lives in the Electron host
 * (see agent-browser-page-map-capture). This module is the part that is pure
 * and fully unit-testable: denoise → assign stable target ids → render a
 * length-bounded indented map. It NEVER emits raw HTML.
 *
 * targetId = `${generation}:${frameId}:${backendDOMNodeId}`. Nodes lacking a
 * backendDOMNodeId fall back to a structural path id and are marked `unstable`
 * (the caller must re-read and confirm before acting on them).
 *
 * Pure module — no Electron, no IO.
 */

export interface RawAxNode {
  role: string
  name?: string
  value?: string
  /** e.g. { checked: true, expanded: false, disabled: true, selected: true } */
  states?: Record<string, boolean | string | undefined>
  backendDOMNodeId?: number
  parentBackendDOMNodeId?: number
  ancestorBackendDOMNodeIds?: number[]
  stableNodeToken?: string
  parentStableNodeToken?: string
  ancestorStableNodeTokens?: string[]
  frameId?: string
  frameDocumentToken?: string
  /** viewport-space box, when the node is laid out and visible */
  box?: { x: number; y: number; width: number; height: number }
  rendered?: boolean
  visible?: boolean
  enabled?: boolean
  editable?: boolean
  href?: string
  inputType?: string
  autocomplete?: string
  formAction?: string
  ancestorContext?: string
  ignored?: boolean
  children?: RawAxNode[]
}

export interface PageMapTarget {
  targetId: string
  role: string
  name: string
  value?: string
  states?: Record<string, boolean | string>
  frameId: string
  frameDocumentToken?: string
  stableNodeToken?: string
  backendDOMNodeId?: number
  parentTargetId?: string
  ancestorTargetIds?: string[]
  box?: { x: number; y: number; width: number; height: number }
  rendered: boolean
  visible: boolean
  enabled: boolean
  editable: boolean
  fingerprint: BrowserTargetFingerprint
  unstable?: boolean
}

export interface BrowserTargetFingerprint {
  role: string
  name: string
  href: string
  inputType: string
  autocomplete: string
  formAction: string
  ancestorContext: string
}

export interface PageMap {
  generation: number
  viewport: { width: number; height: number }
  /** Length-bounded indented rendering (NEVER raw HTML). */
  text: string
  /** Flat list of actionable/semantic targets with stable ids. */
  targets: PageMapTarget[]
  truncated: boolean
}

const WRAPPER_ROLES = new Set(['generic', 'listitem', 'group', 'none', 'presentation', 'GenericContainer'])

/** Roles worth surfacing as actionable / semantic targets. */
const TARGET_ROLES = new Set([
  'canvas',
  'Canvas',
  'button',
  'clickable',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'listbox',
  'dialog',
  'form',
  'menu',
  'region',
  'heading',
  'disclosure-triangle',
  'DisclosureTriangle',
])

export function isBrowserPageMapTargetRole(role: string): boolean {
  return TARGET_ROLES.has(String(role || '').trim())
}

interface CleanNode {
  role: string
  name: string
  value?: string
  states?: Record<string, boolean | string>
  backendDOMNodeId?: number
  parentBackendDOMNodeId?: number
  ancestorBackendDOMNodeIds?: number[]
  stableNodeToken?: string
  parentStableNodeToken?: string
  ancestorStableNodeTokens?: string[]
  frameId?: string
  frameDocumentToken?: string
  box?: { x: number; y: number; width: number; height: number }
  rendered?: boolean
  visible?: boolean
  enabled?: boolean
  editable?: boolean
  href?: string
  inputType?: string
  autocomplete?: string
  formAction?: string
  ancestorContext?: string
  children: CleanNode[]
}

function cleanName(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeStates(
  states: Record<string, boolean | string | undefined> | undefined,
): Record<string, boolean | string> | undefined {
  if (!states) return undefined
  const out: Record<string, boolean | string> = {}
  for (const [key, val] of Object.entries(states)) {
    if (val === undefined || (val === false && key !== 'checked') || val === '') continue
    out[key] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Denoise one node, returning the cleaned nodes it contributes (0..n). Mirrors
 * Matrix `normalizeNode`: unnamed img → dropped; wrapper roles → lifted to
 * children; everything else → kept with denoised children.
 */
function denoise(node: RawAxNode): CleanNode[] {
  if (node.ignored) return []
  const role = String(node.role || '').trim()
  const name = cleanName(node.name)
  const children = (node.children ?? []).flatMap(denoise)

  // Drop unnamed image nodes (Matrix: `- img …` with no useful name).
  if (role === 'img' && !name) return []

  // Lift wrapper nodes: replace the wrapper with its children.
  if (WRAPPER_ROLES.has(role)) return children

  const cleaned: CleanNode = {
    role,
    name,
    value: cleanName(node.value) || undefined,
    states: normalizeStates(node.states),
    backendDOMNodeId: node.backendDOMNodeId,
    parentBackendDOMNodeId: node.parentBackendDOMNodeId,
    ancestorBackendDOMNodeIds: node.ancestorBackendDOMNodeIds,
    stableNodeToken: node.stableNodeToken,
    parentStableNodeToken: node.parentStableNodeToken,
    ancestorStableNodeTokens: node.ancestorStableNodeTokens,
    frameId: node.frameId,
    frameDocumentToken: node.frameDocumentToken,
    box: node.box,
    rendered: node.rendered,
    visible: node.visible,
    enabled: node.enabled,
    editable: node.editable,
    href: cleanName(node.href),
    inputType: cleanName(node.inputType).toLowerCase(),
    autocomplete: cleanName(node.autocomplete).toLowerCase(),
    formAction: cleanName(node.formAction),
    ancestorContext: cleanName(node.ancestorContext),
    children,
  }
  return [cleaned]
}

function assignTargets(
  nodes: CleanNode[],
  generation: number,
  targets: PageMapTarget[],
  structuralPath: number[],
  ancestorTargetIds: string[] = [],
  inheritedFrameId = '0',
): void {
  nodes.forEach((node, index) => {
    const path = [...structuralPath, index]
    const frameId = node.frameId ?? inheritedFrameId
    let currentTargetId: string | null = null
    if (
      isBrowserPageMapTargetRole(node.role)
      && (node.name || node.value || node.backendDOMNodeId !== undefined || node.stableNodeToken)
    ) {
      const stableNodeToken = node.backendDOMNodeId !== undefined
        ? `b${node.backendDOMNodeId}`
        : String(node.stableNodeToken || '')
      const stable = stableNodeToken.length > 0
      const targetId = stable
        ? `${generation}:${frameId}:${stableNodeToken}`
        : `${generation}:${frameId}:p${path.join('.')}`
      currentTargetId = targetId
      const declaredAncestorIds = Array.isArray(node.ancestorBackendDOMNodeIds)
        ? node.ancestorBackendDOMNodeIds.map((id) => `${generation}:${frameId}:b${id}`)
        : Array.isArray(node.ancestorStableNodeTokens)
          ? node.ancestorStableNodeTokens.map((token) => `${generation}:${frameId}:${token}`)
        : ancestorTargetIds
      const declaredParentId = node.parentBackendDOMNodeId !== undefined
        ? `${generation}:${frameId}:b${node.parentBackendDOMNodeId}`
        : node.parentStableNodeToken
          ? `${generation}:${frameId}:${node.parentStableNodeToken}`
          : declaredAncestorIds.at(-1)
      const target: PageMapTarget = {
        targetId,
        role: node.role,
        name: node.name,
        frameId,
        ...(node.frameDocumentToken ? { frameDocumentToken: node.frameDocumentToken } : {}),
        ...(node.stableNodeToken ? { stableNodeToken: node.stableNodeToken } : {}),
        ...(node.backendDOMNodeId !== undefined ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
        rendered: node.rendered ?? (node.box ? node.box.width > 0 && node.box.height > 0 : true),
        visible: node.visible ?? (node.box ? node.box.width > 0 && node.box.height > 0 : true),
        enabled: node.enabled ?? node.states?.disabled !== true,
        editable: node.editable ?? (node.role === 'textbox' || node.role === 'searchbox'),
        fingerprint: {
          role: node.role,
          name: node.name,
          href: node.href || '',
          inputType: node.inputType || '',
          autocomplete: node.autocomplete || '',
          formAction: node.formAction || '',
          ancestorContext: node.ancestorContext || '',
        },
      }
      if (declaredParentId) target.parentTargetId = declaredParentId
      if (declaredAncestorIds.length > 0) target.ancestorTargetIds = declaredAncestorIds
      if (node.value) target.value = node.value
      if (node.states) target.states = node.states
      if (node.box) target.box = node.box
      if (!stable) target.unstable = true
      targets.push(target)
    }
    assignTargets(
      node.children,
      generation,
      targets,
      path,
      currentTargetId ? [...ancestorTargetIds, currentTargetId] : ancestorTargetIds,
      frameId,
    )
  })
}

function renderLines(nodes: CleanNode[], depth: number, out: string[]): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    const statePart = node.states
      ? ' ' + Object.entries(node.states).map(([k, v]) => (v === true ? `[${k}]` : `[${k}=${v}]`)).join('')
      : ''
    const namePart = node.name ? ` "${node.name}"` : ''
    const valuePart = node.value ? `: ${node.value}` : ''
    out.push(`${indent}- ${node.role}${namePart}${valuePart}${statePart}`)
    renderLines(node.children, depth + 1, out)
  }
}

export interface BuildPageMapOptions {
  generation: number
  viewport: { width: number; height: number }
  /** Hard cap on the rendered text size; default 32 KB (counterplan §5.3.5). */
  maxBytes?: number
}

export function buildPageMap(rawRoots: RawAxNode[], options: BuildPageMapOptions): PageMap {
  const maxBytes = options.maxBytes ?? 32_768
  const cleaned = rawRoots.flatMap(denoise)

  const targets: PageMapTarget[] = []
  assignTargets(cleaned, options.generation, targets, [])
  const targetIds = new Set(targets.map((target) => target.targetId))
  for (const target of targets) {
    const ancestry = (target.ancestorTargetIds || [])
      .filter((targetId) => targetId !== target.targetId && targetIds.has(targetId))
    if (ancestry.length > 0) {
      target.ancestorTargetIds = ancestry
      target.parentTargetId = ancestry.at(-1)
    } else {
      delete target.ancestorTargetIds
      delete target.parentTargetId
    }
  }

  const lines: string[] = []
  renderLines(cleaned, 0, lines)
  let text = lines.join('\n')
  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    truncated = true
    const marker = '… (more targets available through browser_find cursor) …'
    const pageBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8') - 1)
    const page: string[] = []
    let pageBytes = 0
    for (const line of lines) {
      const cost = Buffer.byteLength(line, 'utf8') + 1
      if (pageBytes + cost > pageBudget) break
      page.push(line)
      pageBytes += cost
    }
    text = [...page, marker].join('\n')
  }

  return {
    generation: options.generation,
    viewport: options.viewport,
    text,
    targets,
    truncated,
  }
}

/**
 * Parse a targetId back into its parts. Returns null for malformed ids. Used by
 * `browser_click/browser_type` to enforce the stale-generation contract (§5.4.1).
 */
export function parseTargetId(
  targetId: string,
): { generation: number; frameId: string; node: string } | null {
  const match = /^(\d+):([^:]+):(.+)$/.exec(targetId)
  if (!match) return null
  return { generation: Number(match[1]), frameId: match[2], node: match[3] }
}
