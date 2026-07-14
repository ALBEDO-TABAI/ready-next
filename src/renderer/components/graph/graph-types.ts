import type { GraphViewport } from './graph-interactions'

export interface GraphNode {
  id: string
  type: 'doc' | 'tag' | 'ghost'
  label: string
  sourceType?: string
  path?: string
}

export interface GraphEdge {
  source: string
  target: string
  kind: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  totalDocs: number
  truncated: boolean
  note?: string
}

export interface GraphQuery {
  workspaceRoot: string
  centerPath?: string
  depth?: number
}

export interface GraphViewState {
  viewport: GraphViewport
  userAdjusted: boolean
}
