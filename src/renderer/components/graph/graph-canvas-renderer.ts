import type { GraphViewport } from './graph-interactions'
import type { GraphData, GraphNode } from './graph-types'
import { buildGraphTopology } from './graph-topology'

export interface GraphCanvasPalette {
  document: string
  tag: string
  label: string
  edge: string
  tagEdge: string
  linkEdge: string
  highlight: string
  /** Canvas font for the labels; the UI face of the tokens when read from the page. */
  font?: string
}

export interface GraphCanvasRenderOptions {
  width: number
  height: number
  pixelRatio: number
  viewport: GraphViewport
  hoveredNodeId: string | null
  relatedNodeIds: ReadonlySet<string> | null
  palette: GraphCanvasPalette
  indexById?: ReadonlyMap<string, number>
  degrees?: Uint32Array
}

export function graphNodeRadius({
  nodeType,
  degree,
  zoom,
  nodeCount,
  isHovered,
}: {
  nodeType: GraphNode['type']
  degree: number
  zoom: number
  nodeCount: number
  isHovered: boolean
}): number {
  const base = nodeType === 'ghost' ? 1.9 : 2.6
  const densityScale = nodeCount <= 240
    ? 1
    : clamp(1 - Math.log2(nodeCount / 240) * 0.1, 0.7, 1)
  const zoomScale = clamp(0.58 + Math.sqrt(Math.max(0.04, zoom)) * 0.42, 0.66, 1.18)
  const degreeScale = degree < 2 ? 1 : 1 + Math.min(1.8, Math.log2(degree + 1) * 0.32)
  const radius = clamp(base * densityScale * zoomScale * degreeScale, 1.05, 5)
  return isHovered ? Math.max(5.2, radius + 1.8) : radius
}

// Connection roles: quiet isolates, secondary-ink satellites and larger full-ink hubs, all from the four ink levels
// (DL6); the signal colour marks only the node under the pointer and its links (DL5: "here, now"). The same
// relationship uses the same visual language for documents and tags. Values are the --rn-* tokens where the canvas
// sits, so they follow the theme without a palette of their own (DS1).
export function readGraphPalette(element: Element): GraphCanvasPalette {
  const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(element)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    document: token('--rn-ink-3'),
    tag: token('--rn-ink-2'),
    label: token('--rn-ink'),
    edge: token('--rn-ink-4'),
    tagEdge: token('--rn-ink-4'),
    linkEdge: token('--rn-ink-3'),
    highlight: token('--rn-accent'),
    font: `11px ${token('--rn-font-ui') || 'system-ui, sans-serif'}`,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function fitGraphViewport(
  positions: Float32Array,
  width: number,
  height: number,
  padding = 44,
): GraphViewport {
  if (positions.length < 2) return { x: width / 2, y: height / 2, zoom: 1 }
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let index = 0; index < positions.length; index += 2) {
    minX = Math.min(minX, positions[index])
    maxX = Math.max(maxX, positions[index])
    minY = Math.min(minY, positions[index + 1])
    maxY = Math.max(maxY, positions[index + 1])
  }
  const availableWidth = Math.max(1, width - padding * 2)
  const availableHeight = Math.max(1, height - padding * 2)
  const graphWidth = Math.max(1, maxX - minX)
  const graphHeight = Math.max(1, maxY - minY)
  const zoom = clamp(Math.min(availableWidth / graphWidth, availableHeight / graphHeight), 0.08, 2.4)
  return {
    x: width / 2 - ((minX + maxX) / 2) * zoom,
    y: height / 2 - ((minY + maxY) / 2) * zoom,
    zoom,
  }
}

export function findGraphNodeAtPoint(
  nodes: GraphNode[],
  positions: Float32Array,
  viewport: GraphViewport,
  screenX: number,
  screenY: number,
): GraphNode | null {
  const hitRadius = 10
  const hitRadiusSquared = hitRadius * hitRadius
  let closest: GraphNode | null = null
  let closestDistanceSquared = hitRadiusSquared
  for (let index = 0; index < nodes.length; index += 1) {
    const offset = index * 2
    if (offset + 1 >= positions.length) continue
    const x = positions[offset] * viewport.zoom + viewport.x
    const y = positions[offset + 1] * viewport.zoom + viewport.y
    if (Math.abs(x - screenX) > hitRadius || Math.abs(y - screenY) > hitRadius) continue
    const dx = x - screenX
    const dy = y - screenY
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared <= closestDistanceSquared) {
      closest = nodes[index]
      closestDistanceSquared = distanceSquared
    }
  }
  return closest
}

export function shouldDrawGraphLabel({
  zoom,
  nodeCount,
  degree = 0,
  isHovered,
  isRelated,
}: {
  zoom: number
  nodeCount: number
  degree?: number
  isHovered: boolean
  isRelated: boolean
}): boolean {
  return graphLabelOpacity({ zoom, nodeCount, degree, isHovered, isRelated }) >= 0.04
}

export function graphLabelOpacity({
  zoom,
  nodeCount,
  degree,
  isHovered,
  isRelated,
}: {
  zoom: number
  nodeCount: number
  degree: number
  isHovered: boolean
  isRelated: boolean
}): number {
  if (isHovered) return 1
  const densityThreshold = nodeCount > 1200
    ? 1.4
    : nodeCount > 600
      ? 1.04
      : nodeCount > 220
        ? 0.72
        : 0.38
  const importance = clamp(Math.log2(Math.max(0, degree) + 1) / 5.2, 0, 1)
  const isolatedPenalty = degree === 0 ? (nodeCount > 600 ? 0.3 : 0.15) : 0
  const start = densityThreshold + isolatedPenalty - importance * 0.55 - (isRelated ? 0.65 : 0)
  const end = start + (nodeCount > 600 ? 0.32 : 0.24)
  const progress = clamp((zoom - start) / Math.max(0.01, end - start), 0, 1)
  return progress * progress * (3 - 2 * progress)
}

function edgeColor(kind: string, palette: GraphCanvasPalette): string {
  if (kind === 'tag-of') return palette.tagEdge
  if (kind === 'wikilink') return palette.linkEdge
  return palette.edge
}

function nodeColor(degree: number, palette: GraphCanvasPalette): string {
  if (degree === 0) return palette.document
  return degree === 1 ? palette.tag : palette.label
}

function isVisible(x: number, y: number, width: number, height: number, margin = 24): boolean {
  return x >= -margin && y >= -margin && x <= width + margin && y <= height + margin
}

interface GraphLabelCandidate {
  label: string
  x: number
  y: number
  opacity: number
  priority: number
  hovered: boolean
}

function reserveLabelSpace(
  occupied: Set<string>,
  candidate: GraphLabelCandidate,
): boolean {
  const labelWidth = Math.max(18, candidate.label.length * 6.15)
  const minCellX = Math.floor((candidate.x - 3) / 64)
  const maxCellX = Math.floor((candidate.x + labelWidth + 3) / 64)
  const minCellY = Math.floor((candidate.y - 8) / 18)
  const maxCellY = Math.floor((candidate.y + 8) / 18)
  const cells: string[] = []
  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) cells.push(`${cellX}:${cellY}`)
  }
  if (!candidate.hovered && cells.some((cell) => occupied.has(cell))) return false
  for (const cell of cells) occupied.add(cell)
  return true
}

export function drawGraphCanvas(
  context: CanvasRenderingContext2D,
  graph: GraphData,
  positions: Float32Array,
  options: GraphCanvasRenderOptions,
): void {
  const { width, height, pixelRatio, viewport, hoveredNodeId, relatedNodeIds, palette } = options
  const requiredWidth = Math.max(1, Math.round(width * pixelRatio))
  const requiredHeight = Math.max(1, Math.round(height * pixelRatio))
  if (context.canvas.width !== requiredWidth) context.canvas.width = requiredWidth
  if (context.canvas.height !== requiredHeight) context.canvas.height = requiredHeight
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, width, height)

  const topology = options.indexById && options.degrees ? null : buildGraphTopology(graph.nodes, graph.edges)
  const indexById = options.indexById ?? topology!.indexById
  const degrees = options.degrees ?? topology!.degrees
  const hasHoverContext = relatedNodeIds !== null
  context.lineCap = 'round'
  for (const edge of graph.edges) {
    const source = indexById.get(edge.source)
    const target = indexById.get(edge.target)
    if (source === undefined || target === undefined) continue
    const sourceOffset = source * 2
    const targetOffset = target * 2
    if (targetOffset + 1 >= positions.length) continue
    const sourceX = positions[sourceOffset] * viewport.zoom + viewport.x
    const sourceY = positions[sourceOffset + 1] * viewport.zoom + viewport.y
    const targetX = positions[targetOffset] * viewport.zoom + viewport.x
    const targetY = positions[targetOffset + 1] * viewport.zoom + viewport.y
    if (!isVisible(sourceX, sourceY, width, height, 80) && !isVisible(targetX, targetY, width, height, 80)) continue
    const emphasized = Boolean(hoveredNodeId && (edge.source === hoveredNodeId || edge.target === hoveredNodeId))
    const overviewEdgeAlpha = clamp(0.34 + Math.sqrt(Math.max(0.04, viewport.zoom)) * 0.24, 0.38, 0.72)
    context.globalAlpha = hoveredNodeId ? (emphasized ? 0.95 : 0.05) : overviewEdgeAlpha
    context.strokeStyle = emphasized ? palette.highlight : edgeColor(edge.kind, palette)
    const overviewLineScale = clamp(0.55 + Math.sqrt(Math.max(0.04, viewport.zoom)) * 0.35, 0.55, 1)
    context.lineWidth = emphasized ? 1.5 : 0.75 * overviewLineScale
    context.beginPath()
    context.moveTo(sourceX, sourceY)
    context.lineTo(targetX, targetY)
    context.stroke()
  }

  context.textBaseline = 'middle'
  context.font = palette.font ?? '11px system-ui, sans-serif'
  const labelCandidates: GraphLabelCandidate[] = []
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const offset = index * 2
    if (offset + 1 >= positions.length) continue
    const node = graph.nodes[index]
    const x = positions[offset] * viewport.zoom + viewport.x
    const y = positions[offset + 1] * viewport.zoom + viewport.y
    if (!isVisible(x, y, width, height)) continue
    const isHovered = node.id === hoveredNodeId
    const isRelated = Boolean(relatedNodeIds?.has(node.id))
    const isContextVisible = !hasHoverContext || isRelated
    const radius = graphNodeRadius({
      nodeType: node.type,
      degree: degrees[index],
      zoom: viewport.zoom,
      nodeCount: graph.nodes.length,
      isHovered,
    })
    const prominence = clamp(0.68 + Math.log2(degrees[index] + 1) * 0.055, 0.68, 0.92)
    context.globalAlpha = isContextVisible ? (node.type === 'ghost' ? 0.5 : prominence) : 0.16
    context.fillStyle = nodeColor(degrees[index], palette)
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    if (isHovered) {
      context.globalAlpha = 0.9
      context.strokeStyle = palette.highlight
      context.lineWidth = 1.4
      context.stroke()
    }

    const labelOpacity = graphLabelOpacity({
      zoom: viewport.zoom,
      nodeCount: graph.nodes.length,
      degree: degrees[index],
      isHovered,
      isRelated,
    })
    if (labelOpacity < 0.04 || (hasHoverContext && !isRelated)) continue
    const maxLength = viewport.zoom > 1.4 ? 38 : 24
    const label = node.label.length > maxLength ? `${node.label.slice(0, maxLength)}…` : node.label
    labelCandidates.push({
      label,
      x: x + radius + 4,
      y: y + 0.5,
      opacity: labelOpacity,
      priority: (isHovered ? 1_000_000 : 0) + (isRelated ? 100_000 : 0) + degrees[index] * 100 + labelOpacity,
      hovered: isHovered,
    })
  }

  labelCandidates.sort((left, right) => right.priority - left.priority)
  const occupiedLabels = new Set<string>()
  for (const candidate of labelCandidates) {
    if (!reserveLabelSpace(occupiedLabels, candidate)) continue
    context.globalAlpha = 0.92 * candidate.opacity
    context.fillStyle = palette.label
    context.fillText(candidate.label, candidate.x, candidate.y)
  }
  context.globalAlpha = 1
}
