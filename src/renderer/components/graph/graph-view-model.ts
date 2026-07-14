import type { GraphDocumentPreview } from './graph-interactions'
import type { GraphData, GraphNode } from './graph-types'

export type PreviewStatus = 'loading' | 'ready' | 'unavailable'

export interface CachedDocumentPreview extends GraphDocumentPreview {
  status: Exclude<PreviewStatus, 'loading'>
}

export interface HoveredDocumentPreview extends GraphDocumentPreview {
  nodeId: string
  path: string
  left: number
  top: number
  width: number
  status: PreviewStatus
}

export interface PendingGraphPin {
  id: string
  x: number
  y: number
}

export type PointerInteraction =
  | {
      kind: 'pan'
      startClientX: number
      startClientY: number
      originX: number
      originY: number
      moved: boolean
    }
  | {
      kind: 'node'
      id: string
      offsetX: number
      offsetY: number
      startClientX: number
      startClientY: number
      moved: boolean
    }

export function isOpenableDocumentNode(node: GraphNode | null): node is GraphNode & { path: string } {
  return Boolean(node?.type === 'doc' && node.path && (!node.sourceType || node.sourceType === 'document'))
}

export function getLocalPoint(
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

export function normalizeGraphData(
  data: Partial<GraphData> & Pick<GraphData, 'nodes' | 'edges'>,
): GraphData {
  return {
    nodes: data.nodes,
    edges: data.edges,
    totalDocs: data.totalDocs ?? data.nodes.filter((node) => node.type === 'doc').length,
    truncated: data.truncated ?? false,
    note: data.note,
  }
}
