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
  frameId?: string
  /** viewport-space box, when the node is laid out and visible */
  box?: { x: number; y: number; width: number; height: number }
  ignored?: boolean
  children?: RawAxNode[]
}

export interface PageMapTarget {
  targetId: string
  role: string
  name: string
  value?: string
  states?: Record<string, boolean | string>
  box?: { x: number; y: number; width: number; height: number }
  unstable?: boolean
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
  'heading',
  'disclosure-triangle',
  'DisclosureTriangle',
])

interface CleanNode {
  role: string
  name: string
  value?: string
  states?: Record<string, boolean | string>
  backendDOMNodeId?: number
  frameId?: string
  box?: { x: number; y: number; width: number; height: number }
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
    if (val === undefined || val === false || val === '') continue
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
    frameId: node.frameId,
    box: node.box,
    children,
  }
  return [cleaned]
}

function assignTargets(
  nodes: CleanNode[],
  generation: number,
  targets: PageMapTarget[],
  structuralPath: number[],
): void {
  nodes.forEach((node, index) => {
    const path = [...structuralPath, index]
    if (TARGET_ROLES.has(node.role) && (node.name || node.value)) {
      const stable = node.backendDOMNodeId !== undefined
      const frameId = node.frameId ?? '0'
      const targetId = stable
        ? `${generation}:${frameId}:${node.backendDOMNodeId}`
        : `${generation}:${frameId}:p${path.join('.')}`
      const target: PageMapTarget = {
        targetId,
        role: node.role,
        name: node.name,
      }
      if (node.value) target.value = node.value
      if (node.states) target.states = node.states
      if (node.box) target.box = node.box
      if (!stable) target.unstable = true
      targets.push(target)
    }
    assignTargets(node.children, generation, targets, path)
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

  const lines: string[] = []
  renderLines(cleaned, 0, lines)
  let text = lines.join('\n')
  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    truncated = true
    // D13（2026-07-04 真机实锚）：砍尾式截断会把 DOM 尾部的主行动按钮
    // （发布/发送/提交——几乎总在页面底部）砍成第一个牺牲品。改为中段
    // 截断：头部 ~75% 预算 + 尾部 ~20% 预算，行边界切割，永不半行。
    const marker = '… (truncated middle) …'
    const tailBudget = Math.max(256, Math.floor(maxBytes * 0.2))
    const headBudget = Math.max(256, maxBytes - tailBudget - Buffer.byteLength(marker, 'utf8') - 2)
    const head: string[] = []
    let headBytes = 0
    for (const line of lines) {
      const cost = Buffer.byteLength(line, 'utf8') + 1
      if (headBytes + cost > headBudget) break
      head.push(line)
      headBytes += cost
    }
    const tail: string[] = []
    let tailBytes = 0
    for (let i = lines.length - 1; i > head.length - 1; i--) {
      const cost = Buffer.byteLength(lines[i], 'utf8') + 1
      if (tailBytes + cost > tailBudget) break
      tail.unshift(lines[i])
      tailBytes += cost
    }
    text = [...head, marker, ...tail].join('\n')
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
