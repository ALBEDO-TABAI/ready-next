import type { GraphEdge, GraphNode } from './graph-types'

// Layout, node size and color all count distinct, valid neighbors.
export function buildGraphTopology(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { edgePairs: Int32Array; degrees: Uint32Array; indexById: Map<string, number> } {
  const indexById = new Map(nodes.map((node, index) => [node.id, index] as const))
  const degrees = new Uint32Array(nodes.length)
  const pairs: number[] = []
  const seen = new Set<string>()
  for (const edge of edges) {
    const source = indexById.get(edge.source)
    const target = indexById.get(edge.target)
    if (source === undefined || target === undefined || source === target) continue
    const low = Math.min(source, target)
    const high = Math.max(source, target)
    const key = `${low}:${high}`
    if (seen.has(key)) continue
    seen.add(key)
    pairs.push(source, target)
    degrees[source] += 1
    degrees[target] += 1
  }
  return { edgePairs: Int32Array.from(pairs), degrees, indexById }
}
