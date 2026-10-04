/**
 * 关系图共享渲染器：openui `relationship_graph` 组件与骨架 `relation_map` 的同一实现。
 *
 * 布局哲学：模型只给 groups/nodes/edges，不接受手写坐标；坐标由这里确定性计算，
 * 分组只是一列的标签（不画底板），节点是卡片色块上的纸白嵌块，层级只有两层。
 * 输出纯 SVG（无运行时测量脚本）。同一份结构因此在 iframe、静态投影、书本阅读与
 * PDF 导出里一模一样——连线不再依赖脚本跑完才出现。
 *
 * 两套构图由容器查询切换：
 * - 宽版（>520px）：分组成列（左/中/右，未指定位置的组自动分列），相邻列之间用
 *   三次贝塞尔连线，同列关系走外侧弧线，顶/底组横向铺开。
 * - 窄版：分组纵向堆叠，所有关系画成右侧嵌套弧线（arc diagram），跨度越大弧越外。
 *
 * Ready 化纪律：连线的"身份"由标签 chip + 线型 + 图例承担，颜色只作强调
 * （emotion/主角=品牌橘红、alliance=完成绿、其余墨灰阶），无第二 accent、无彩虹；
 * 组色板同理（首组=accent，其余墨阶），模型提供的 group.color 被接受但不参与渲染。
 */

import { z } from 'zod'
import { renderWidgetChrome, renderWidgetHeading } from './document-widget-chassis'
import { widgetVar } from './document-widget-theme'

export const relationshipGroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  color: z.string().optional(),
  position: z.enum(['center', 'left', 'right', 'top', 'bottom']).optional(),
})

export const relationshipNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  subtitle: z.string().optional(),
  tag: z.string().optional(),
  group: z.string().optional(),
  emphasis: z.enum(['primary', 'secondary', 'muted']).optional(),
})

export const relationshipEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(['emotion', 'family', 'conflict', 'alliance', 'influence', 'other']).optional(),
  style: z.enum(['solid', 'dashed', 'dotted']).optional(),
  weight: z.enum(['light', 'normal', 'heavy']).optional(),
})

export const relationshipGraphPropsSchema = z.object({
  heading: z.string().optional(),
  groups: z.array(relationshipGroupSchema).max(6).optional(),
  nodes: z.array(relationshipNodeSchema).min(2).max(24),
  edges: z.array(relationshipEdgeSchema).min(1).max(40),
  note: z.string().optional(),
})

export type RelationshipGraphProps = z.infer<typeof relationshipGraphPropsSchema>
type RelationshipGroup = z.infer<typeof relationshipGroupSchema>
type RelationshipNode = z.infer<typeof relationshipNodeSchema>
type RelationshipEdgeKind = NonNullable<z.infer<typeof relationshipEdgeSchema>['kind']>
type GroupPlacement = 'left' | 'center' | 'right' | 'top' | 'bottom'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}

const INK = widgetVar('ink')
const INK2 = widgetVar('ink2')
const HAIR = widgetVar('hair')
const CARD = widgetVar('card')
const CANVAS = widgetVar('canvas')
const DC_OFF = widgetVar('dcOff')
const SANS = "var(--widget-font-sans, -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif)"
const MONO = 'var(--widget-font-mono, ui-monospace, monospace)'

/** 组色板：首组品牌橘红，其余墨阶（代码执掌，忽略模型供色）。 */
function relationshipGroupColor(index: number): string {
  const palette = [
    widgetVar('accent'),
    widgetVar('ink'),
    widgetVar('ink2'),
    widgetVar('ink3'),
    widgetVar('dcOff'),
    widgetVar('dotDim'),
  ]
  return palette[index % palette.length]
}

/** 连线色：颜色只作强调，身份由标签/线型/图例承担。 */
function relationshipEdgeColor(kind: RelationshipEdgeKind | undefined): string {
  switch (kind) {
    case 'emotion':
      return widgetVar('accent')
    case 'alliance':
      return widgetVar('ok')
    case 'family':
      return widgetVar('ink2')
    case 'conflict':
      return widgetVar('ink')
    case 'influence':
      return widgetVar('ink3')
    default:
      return DC_OFF
  }
}

/** 无显式线型时按 kind 给默认线型，让身份不只靠颜色。 */
function relationshipEdgeStyle(kind: RelationshipEdgeKind | undefined, style?: string): string {
  if (style === 'solid' || style === 'dashed' || style === 'dotted') return style
  if (kind === 'conflict') return 'dashed'
  if (kind === 'influence') return 'dotted'
  return 'solid'
}

const EDGE_KIND_LABELS: Record<RelationshipEdgeKind, string> = {
  emotion: '情感',
  family: '亲属',
  conflict: '冲突',
  alliance: '同盟',
  influence: '影响',
  other: '其他',
}

// ─── 文字度量：按字形类别估宽，用于截断与标签底板，保证布局确定性 ───

function estimateTextWidth(text: string, fontSize: number, mono = false): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x2e80) width += fontSize
    else if (char === ' ') width += fontSize * (mono ? 0.6 : 0.3)
    else if (mono) width += fontSize * 0.6
    else if (/[A-Z0-9]/.test(char)) width += fontSize * 0.64
    else width += fontSize * 0.54
  }
  return width
}

function fitText(text: string, fontSize: number, maxWidth: number, mono = false): string {
  if (estimateTextWidth(text, fontSize, mono) <= maxWidth) return text
  let output = ''
  for (const char of text) {
    if (estimateTextWidth(`${output}${char}…`, fontSize, mono) > maxWidth) break
    output += char
  }
  return `${output}…`
}

// ─── 几何 ───

const SIDE_GUTTER = 30
const COLUMN_GAP = 76
const GROUP_PAD = 0
const GROUP_LABEL_H = 28
const NODE_GAP = 6
const STACK_GAP = 16
const ROW_GAP = 30
const WIDE_W = 680
const NARROW_W = 420
const NARROW_NODE_RATIO = 0.58

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface ResolvedGroup {
  id: string
  label: string
  color: string
  placement: GroupPlacement
  nodes: RelationshipNode[]
}

interface PlacedNode extends Box {
  node: RelationshipNode
  groupId: string
  color: string
  column: number
  row: 'top' | 'middle' | 'bottom'
}

interface PlacedGroup extends Box {
  group: ResolvedGroup
}

interface ResolvedEdge {
  from: string
  to: string
  label?: string
  kind: RelationshipEdgeKind
  style: string
  weight: 'light' | 'normal' | 'heavy'
  color: string
}

interface LayoutResult {
  width: number
  height: number
  groups: PlacedGroup[]
  nodes: Map<string, PlacedNode>
  edgeMarkup: string
  labelMarkup: string
}

interface Point {
  x: number
  y: number
}

function nodeHeight(node: RelationshipNode): number {
  let height = 38
  if (node.subtitle) height += 18
  if (node.tag) height += 24
  return height
}

function groupHeight(nodes: RelationshipNode[]): number {
  return GROUP_LABEL_H + nodes.reduce((sum, node) => sum + nodeHeight(node), 0) + NODE_GAP * Math.max(nodes.length - 1, 0) + GROUP_PAD
}

type UnplacedGroup = Omit<ResolvedGroup, 'placement'> & { position?: GroupPlacement }

/** 未指定位置的组自动分列；显式位置保持不变。 */
function assignPlacements(groups: UnplacedGroup[]): ResolvedGroup[] {
  const middle: GroupPlacement[] = ['left', 'center', 'right']
  const autos = groups.filter((group) => !group.position)
  const explicitMiddle = groups.filter((group) => group.position && middle.includes(group.position))
  const load = new Map<GroupPlacement, number>(middle.map((placement) => [placement, 0]))
  for (const group of explicitMiddle) {
    load.set(group.position!, (load.get(group.position!) ?? 0) + group.nodes.length)
  }
  const autoSlots: GroupPlacement[] | null = explicitMiddle.length > 0
    ? null
    : autos.length === 1 ? ['center'] : autos.length === 2 ? ['left', 'right'] : ['left', 'center', 'right']
  let autoIndex = 0
  return groups.map((group) => {
    if (group.position) return { ...group, placement: group.position }
    const placement = autoSlots
      ? autoSlots[autoIndex % autoSlots.length]
      : [...middle].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0]
    autoIndex += 1
    load.set(placement, (load.get(placement) ?? 0) + group.nodes.length)
    return { ...group, placement }
  })
}

function renderGroupPanel(placed: PlacedGroup): string {
  const { x, y, w, h, group } = placed
  const label = fitText(group.label.toUpperCase(), 10, w - GROUP_PAD * 2 - 16, true)
  return `<g data-rg-group-panel="${escapeAttr(group.id)}">
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none"/>
    <circle cx="${(x + GROUP_PAD + 3).toFixed(1)}" cy="${(y + 15).toFixed(1)}" r="3" fill="${group.color}"/>
    <text x="${(x + GROUP_PAD + 12).toFixed(1)}" y="${(y + 18.5).toFixed(1)}" font-family="${MONO}" font-size="10" font-weight="500" letter-spacing="1" fill="${INK2}">${escapeHtml(label)}</text>
  </g>`
}

function renderNode(placed: PlacedNode): string {
  const { x, y, w, h, node } = placed
  const emphasis = node.emphasis || 'secondary'
  const isPrimary = emphasis === 'primary'
  const titleX = x + 11 + (isPrimary ? 11 : 0)
  const titleY = y + 23.5
  const subtitle = node.subtitle
    ? `<text x="${(x + 11).toFixed(1)}" y="${(titleY + 18).toFixed(1)}" font-family="${SANS}" font-size="11.5" fill="${INK2}">${escapeHtml(fitText(node.subtitle, 11.5, w - 22))}</text>`
    : ''
  const tagText = node.tag ? fitText(node.tag, 10, w - 40, true) : ''
  const tagY = y + h - 28
  const tag = node.tag
    ? `<rect x="${(x + 11).toFixed(1)}" y="${tagY.toFixed(1)}" width="${Math.min(estimateTextWidth(tagText, 10, true) + 16, w - 22).toFixed(1)}" height="18" rx="9" fill="${CARD}"/>
      <text x="${(x + 19).toFixed(1)}" y="${(tagY + 12.5).toFixed(1)}" font-family="${MONO}" font-size="10" fill="${INK2}">${escapeHtml(tagText)}</text>`
    : ''
  return `<g data-rg-node="${escapeAttr(node.id)}" data-rg-group="${escapeAttr(placed.groupId)}"${emphasis === 'muted' ? ' opacity="0.62"' : ''}>
    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="10" fill="${CANVAS}"/>
    ${isPrimary ? `<circle cx="${(x + 14).toFixed(1)}" cy="${(titleY - 4.5).toFixed(1)}" r="3" fill="${placed.color}"/>` : ''}
    <text x="${titleX.toFixed(1)}" y="${titleY.toFixed(1)}" font-family="${SANS}" font-size="13" font-weight="600" fill="${INK}">${escapeHtml(fitText(node.label, 13, w - 22 - (isPrimary ? 11 : 0)))}</text>
    ${subtitle}
    ${tag}
  </g>`
}

// ─── 连线与标签 ───

interface LabelBox {
  x: number
  y: number
  w: number
  h: number
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function edgePath(edge: ResolvedEdge, d: string, start: Point, end: Point): string {
  const width = edge.weight === 'heavy' ? 2.4 : edge.weight === 'light' ? 1.1 : 1.6
  const dash = edge.style === 'dashed' ? ' stroke-dasharray="6 5"' : edge.style === 'dotted' ? ' stroke-dasharray="0.1 5"' : ''
  const dotRadius = edge.weight === 'heavy' ? 3.4 : 2.7
  return `<g data-rg-edge="${escapeAttr(edge.from)}:${escapeAttr(edge.to)}">
    <path class="rg-edge-halo" d="${d}" fill="none" stroke="${CARD}" stroke-width="${width + 4}" stroke-linecap="round" opacity="0.8"/>
    <path class="rg-edge-line" d="${d}" fill="none" stroke="${edge.color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${edge.weight === 'light' ? 0.7 : 0.95}"${dash}/>
    <circle class="rg-edge-dot" cx="${start.x.toFixed(1)}" cy="${start.y.toFixed(1)}" r="${dotRadius}" fill="${edge.color}" stroke="${CARD}" stroke-width="1.5"/>
    <circle class="rg-edge-dot" cx="${end.x.toFixed(1)}" cy="${end.y.toFixed(1)}" r="${dotRadius}" fill="${edge.color}" stroke="${CARD}" stroke-width="1.5"/>
  </g>`
}

function edgeLabel(edge: ResolvedEdge, center: Point, placed: LabelBox[], bounds: { width: number; height: number }): string {
  const raw = (edge.label || '').trim()
  if (!raw) return ''
  const text = fitText(raw, 10, 112, true)
  const w = estimateTextWidth(text, 10, true) + 14
  const h = 18
  const baseX = Math.max(2, Math.min(bounds.width - w - 2, center.x - w / 2))
  let box: LabelBox = { x: baseX, y: center.y - h / 2, w, h }
  for (let attempt = 1; attempt <= 8 && placed.some((other) => overlaps(box, other)); attempt += 1) {
    const shift = Math.ceil(attempt / 2) * (h + 3) * (attempt % 2 === 1 ? 1 : -1)
    box = { ...box, y: Math.max(0, Math.min(bounds.height - h, center.y - h / 2 + shift)) }
  }
  placed.push(box)
  const textColor = edge.color === DC_OFF ? INK2 : edge.color
  return `<g class="rg-edge-label-group">
    <rect class="rg-edge-label-bg" x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${CARD}"/>
    <text class="rg-edge-label" x="${(box.x + w / 2).toFixed(1)}" y="${(box.y + 12.6).toFixed(1)}" text-anchor="middle" font-family="${MONO}" font-size="10" font-weight="500" fill="${textColor}">${escapeHtml(text)}</text>
  </g>`
}

function cubic(start: Point, c1: Point, c2: Point, end: Point): string {
  const f = (point: Point) => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  return `M ${f(start)} C ${f(c1)}, ${f(c2)}, ${f(end)}`
}

function bezierPoint(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t
  const at = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
  return { x: at(start.x, c1.x, c2.x, end.x), y: at(start.y, c1.y, c2.y, end.y) }
}

// ─── 宽版：分列构图 ───

function layoutWide(groups: ResolvedGroup[], edges: ResolvedEdge[]): LayoutResult | null {
  const middleOrder: GroupPlacement[] = ['left', 'center', 'right']
  const columns = middleOrder.filter((placement) => groups.some((group) => group.placement === placement))
  if (columns.length <= 1) return null
  // 左缘与卡片正文对齐；同列关系一律向右画弧，只在右侧留出弧线余量。
  const innerW = WIDE_W - SIDE_GUTTER
  const colW = (innerW - COLUMN_GAP * (columns.length - 1)) / columns.length
  const nodes = new Map<string, PlacedNode>()
  const placedGroups: PlacedGroup[] = []
  let cursorY = 0

  const layoutRow = (row: 'top' | 'bottom') => {
    for (const group of groups.filter((candidate) => candidate.placement === row)) {
      const innerGroupW = innerW - GROUP_PAD * 2
      const perRow = Math.max(1, Math.min(group.nodes.length, Math.floor((innerGroupW + NODE_GAP) / (128 + NODE_GAP))))
      const nodeW = (innerGroupW - NODE_GAP * (perRow - 1)) / perRow
      let y = cursorY + GROUP_LABEL_H
      for (let start = 0; start < group.nodes.length; start += perRow) {
        const slice = group.nodes.slice(start, start + perRow)
        const rowH = Math.max(...slice.map(nodeHeight))
        slice.forEach((node, index) => {
          nodes.set(node.id, { node, groupId: group.id, color: group.color, column: -1, row, x: GROUP_PAD + index * (nodeW + NODE_GAP), y, w: nodeW, h: rowH })
        })
        y += rowH + NODE_GAP
      }
      const h = y - NODE_GAP + GROUP_PAD - cursorY
      placedGroups.push({ group, x: 0, y: cursorY, w: innerW, h })
      cursorY += h + ROW_GAP
    }
  }

  layoutRow('top')
  const middleTop = cursorY
  let middleBottom = middleTop
  columns.forEach((placement, column) => {
    const x = column * (colW + COLUMN_GAP)
    let y = middleTop
    for (const group of groups.filter((candidate) => candidate.placement === placement)) {
      const h = groupHeight(group.nodes)
      let nodeY = y + GROUP_LABEL_H
      for (const node of group.nodes) {
        const nh = nodeHeight(node)
        nodes.set(node.id, { node, groupId: group.id, color: group.color, column, row: 'middle', x: x + GROUP_PAD, y: nodeY, w: colW - GROUP_PAD * 2, h: nh })
        nodeY += nh + NODE_GAP
      }
      placedGroups.push({ group, x, y, w: colW, h })
      y += h + STACK_GAP
    }
    middleBottom = Math.max(middleBottom, y - STACK_GAP)
  })
  cursorY = middleBottom + ROW_GAP
  layoutRow('bottom')
  const height = Math.max(cursorY - ROW_GAP, middleBottom) + 4

  const labels: LabelBox[] = []
  const sameColumnDepth = new Map<number, number>()
  let edgeMarkup = ''
  let labelMarkup = ''
  for (const edge of edges) {
    const a = nodes.get(edge.from)
    const b = nodes.get(edge.to)
    if (!a || !b || a === b) continue
    let start: Point
    let end: Point
    let c1: Point
    let c2: Point
    let labelAt: Point
    if (a.row === 'middle' && b.row === 'middle' && a.column !== b.column) {
      // 不同列：从相对的两侧出发，水平切线进出列间距。
      const forward = a.column < b.column
      start = { x: forward ? a.x + a.w : a.x, y: a.y + a.h / 2 }
      end = { x: forward ? b.x : b.x + b.w, y: b.y + b.h / 2 }
      const direction = forward ? 1 : -1
      const bend = Math.max(28, Math.min(COLUMN_GAP * 0.9, Math.abs(end.x - start.x) * 0.45))
      c1 = { x: start.x + bend * direction, y: start.y }
      c2 = { x: end.x - bend * direction, y: end.y }
      // 跨两列的线从中间列背后穿过，标签放在第一段列间距里。
      labelAt = bezierPoint(start, c1, c2, end, Math.abs(a.column - b.column) > 1 ? 0.15 : 0.5)
    } else if (a.row === 'middle' && b.row === 'middle') {
      // 同列：一律向右画弧（进入列间距或右侧余量），弧的外扩随跨度与次序递增。
      const column = a.column
      const goRight = true
      const depth = sameColumnDepth.get(column) ?? 0
      sameColumnDepth.set(column, depth + 1)
      const span = Math.abs((b.y + b.h / 2) - (a.y + a.h / 2))
      const room = column === columns.length - 1 ? SIDE_GUTTER - 6 : COLUMN_GAP * 0.42
      const reach = Math.min(room, 14 + depth * 5 + span * 0.05) * (goRight ? 1 : -1)
      start = { x: goRight ? a.x + a.w : a.x, y: a.y + a.h / 2 }
      end = { x: goRight ? b.x + b.w : b.x, y: b.y + b.h / 2 }
      c1 = { x: start.x + reach * 1.33, y: start.y }
      c2 = { x: end.x + reach * 1.33, y: end.y }
      labelAt = { x: start.x + reach, y: (start.y + end.y) / 2 }
    } else {
      // 顶/底行：竖向切线进出。
      const aIsUpper = a.y < b.y
      const upper = aIsUpper ? a : b
      const lower = aIsUpper ? b : a
      const top = { x: upper.x + upper.w / 2, y: upper.y + upper.h }
      const bottom = { x: lower.x + lower.w / 2, y: lower.y }
      const bend = Math.max(18, (bottom.y - top.y) * 0.45)
      start = aIsUpper ? top : bottom
      end = aIsUpper ? bottom : top
      c1 = { x: start.x, y: start.y + bend * (aIsUpper ? 1 : -1) }
      c2 = { x: end.x, y: end.y - bend * (aIsUpper ? 1 : -1) }
      labelAt = bezierPoint(start, c1, c2, end, 0.5)
    }
    edgeMarkup += edgePath(edge, cubic(start, c1, c2, end), start, end)
    labelMarkup += edgeLabel(edge, labelAt, labels, { width: WIDE_W, height })
  }
  return { width: WIDE_W, height, groups: placedGroups, nodes, edgeMarkup, labelMarkup }
}

// ─── 窄版 / 单列：纵向堆叠 + 右侧嵌套弧线 ───

function layoutArc(groups: ResolvedGroup[], edges: ResolvedEdge[], width: number): LayoutResult {
  const order: GroupPlacement[] = ['top', 'left', 'center', 'right', 'bottom']
  const sorted = [...groups].sort((a, b) => order.indexOf(a.placement) - order.indexOf(b.placement))
  const columnW = Math.round(width * (width > NARROW_W ? 0.46 : NARROW_NODE_RATIO))
  const nodes = new Map<string, PlacedNode>()
  const placedGroups: PlacedGroup[] = []
  let y = 0
  for (const group of sorted) {
    const h = groupHeight(group.nodes)
    let nodeY = y + GROUP_LABEL_H
    for (const node of group.nodes) {
      const nh = nodeHeight(node)
      nodes.set(node.id, { node, groupId: group.id, color: group.color, column: 0, row: 'middle', x: GROUP_PAD, y: nodeY, w: columnW - GROUP_PAD * 2, h: nh })
      nodeY += nh + NODE_GAP
    }
    placedGroups.push({ group, x: 0, y, w: columnW, h })
    y += h + STACK_GAP
  }
  const height = y - STACK_GAP + 4
  const gutter = width - columnW
  const labels: LabelBox[] = []
  // 跨度小的弧在内、跨度大的弧在外，嵌套而不交叉。
  const routable = edges
    .map((edge) => ({ edge, a: nodes.get(edge.from), b: nodes.get(edge.to) }))
    .filter((entry): entry is { edge: ResolvedEdge; a: PlacedNode; b: PlacedNode } => Boolean(entry.a && entry.b && entry.a !== entry.b))
    .sort((p, q) => Math.abs(p.a.y - p.b.y) - Math.abs(q.a.y - q.b.y))
  let edgeMarkup = ''
  let labelMarkup = ''
  routable.forEach(({ edge, a, b }, rank) => {
    const start = { x: a.x + a.w, y: a.y + a.h / 2 }
    const end = { x: b.x + b.w, y: b.y + b.h / 2 }
    const reach = Math.min(gutter - 30, 20 + rank * ((gutter - 50) / Math.max(routable.length - 1, 1)))
    const c1 = { x: start.x + reach * 1.33, y: start.y }
    const c2 = { x: end.x + reach * 1.33, y: end.y }
    edgeMarkup += edgePath(edge, cubic(start, c1, c2, end), start, end)
    labelMarkup += edgeLabel(edge, { x: start.x + reach, y: (start.y + end.y) / 2 }, labels, { width, height })
  })
  return { width, height, groups: placedGroups, nodes, edgeMarkup, labelMarkup }
}

function renderLayout(layout: LayoutResult, variant: 'wide' | 'narrow', ariaLabel: string): string {
  const groupMarkup = layout.groups.map(renderGroupPanel).join('')
  const nodeMarkup = [...layout.nodes.values()].map(renderNode).join('')
  return `<svg class="rg-layout rg-layout--${variant}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${Math.ceil(layout.height)}" role="img" aria-label="${escapeAttr(ariaLabel)}">${groupMarkup}${layout.edgeMarkup}${nodeMarkup}${layout.labelMarkup}</svg>`
}

export function compileRelationshipGraph(props: RelationshipGraphProps): string {
  const suppliedGroups = props.groups || []
  const nodeGroups = Array.from(new Set(props.nodes.map((node) => node.group).filter((value): value is string => Boolean(value))))
  const groups: RelationshipGroup[] = [
    ...suppliedGroups,
    ...nodeGroups
      .filter((groupId) => !suppliedGroups.some((group) => group.id === groupId))
      .map((groupId) => ({ id: groupId, label: groupId })),
  ]
  const groupsWithFallback: RelationshipGroup[] = groups.length > 0 ? groups : [{ id: 'main', label: '关系网络' }]
  const ungroupedId = groupsWithFallback[0]?.id || 'main'
  const resolvedGroups = assignPlacements(
    groupsWithFallback
      .map((group, index) => ({
        id: group.id,
        label: group.label,
        color: relationshipGroupColor(index),
        position: group.position,
        nodes: props.nodes.filter((node) => (node.group || ungroupedId) === group.id),
      }))
      .filter((group) => group.nodes.length > 0),
  )
  const knownNodeIds = new Set(props.nodes.map((node) => node.id))
  const invalidEdgeCount = props.edges.filter((edge) => !knownNodeIds.has(edge.from) || !knownNodeIds.has(edge.to)).length
  const edges: ResolvedEdge[] = props.edges
    .filter((edge) => knownNodeIds.has(edge.from) && knownNodeIds.has(edge.to))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      kind: edge.kind || 'other',
      style: relationshipEdgeStyle(edge.kind, edge.style),
      weight: edge.weight || 'normal',
      color: relationshipEdgeColor(edge.kind),
    }))

  const heading = props.heading || '关系图'
  const wide = layoutWide(resolvedGroups, edges) ?? layoutArc(resolvedGroups, edges, WIDE_W)
  const narrow = layoutArc(resolvedGroups, edges, NARROW_W)

  const legendKinds = Array.from(new Set(edges.map((edge) => edge.kind)))
  const legend = legendKinds.length
    ? `<div class="rg-legend">${legendKinds.map((kind) => `<span><i data-style="${relationshipEdgeStyle(kind)}" style="background:${escapeAttr(relationshipEdgeColor(kind))};color:${escapeAttr(relationshipEdgeColor(kind))};"></i>${escapeHtml(EDGE_KIND_LABELS[kind])}</span>`).join('')}</div>`
    : ''
  const warning = invalidEdgeCount > 0
    ? `<div class="rg-warning">有 ${invalidEdgeCount} 条关系引用了不存在的人物，已跳过。</div>`
    : ''
  const note = props.note ? `<div class="rg-note">${escapeHtml(props.note)}</div>` : ''

  return `<div class="card stack relationship-graph-widget" data-rg-root style="gap:20px;">
    <style>
      .relationship-graph-widget .rg-stage{container-type:inline-size;}
      .relationship-graph-widget .rg-layout{display:block;width:100%;height:auto;overflow:visible;}
      .relationship-graph-widget .rg-layout--narrow{display:none;max-width:460px;margin:0 auto;}
      @container (max-width: 520px){.relationship-graph-widget .rg-layout--wide{display:none;}.relationship-graph-widget .rg-layout--narrow{display:block;}}
      .relationship-graph-widget .rg-legend{display:flex;gap:6px 14px;flex-wrap:wrap;align-items:center;font-family:${MONO};font-size:10.5px;letter-spacing:0.04em;color:${INK2};}
      .relationship-graph-widget .rg-legend span{display:inline-flex;align-items:center;gap:6px;}
      .relationship-graph-widget .rg-legend i{display:block;width:16px;height:2px;border-radius:999px;}
      .relationship-graph-widget .rg-legend i[data-style="dashed"]{background:repeating-linear-gradient(90deg,currentColor 0 5px,transparent 5px 8px) !important;}
      .relationship-graph-widget .rg-legend i[data-style="dotted"]{height:3px;background:radial-gradient(circle,currentColor 1.2px,transparent 1.5px) 0 50% / 5px 3px repeat-x !important;}
      .relationship-graph-widget .rg-foot{display:flex;align-items:baseline;justify-content:space-between;gap:10px 24px;flex-wrap:wrap;padding-top:12px;border-top:1px solid ${HAIR};}
      .relationship-graph-widget .rg-note,.relationship-graph-widget .rg-warning{font-size:12px;line-height:1.6;color:${INK2};}
      .relationship-graph-widget .rg-warning{color:${INK};}
    </style>
    ${renderWidgetChrome({ kicker: 'RELATIONS', meta: `${props.nodes.length} 节点 · ${edges.length} 关系` })}
    ${renderWidgetHeading(heading)}
    <div class="rg-stage" data-fill="center">
      ${renderLayout(wide, 'wide', heading)}
      ${renderLayout(narrow, 'narrow', heading)}
    </div>
    ${legend || note || warning ? `<div class="rg-foot">${legend}<div>${warning}${note}</div></div>` : ''}
  </div>`
}
