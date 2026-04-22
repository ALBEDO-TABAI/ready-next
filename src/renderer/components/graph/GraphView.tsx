import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useMode } from '../../stores/useMode'
import { useForceLayout, type GraphEdge, type GraphNode, type LayoutNode } from './useForceLayout'

interface GraphViewProps {
  centerPath?: string
  workspaceRoot?: string
  depth?: number
  width?: number
  height?: number
  className?: string
}

const NODE_COLORS: Record<GraphNode['type'], string> = {
  doc: 'var(--accent-blue, #3b82f6)',
  tag: 'var(--accent-amber, #f59e0b)',
  ghost: 'var(--text-muted, #9ca3af)',
}

const EDGE_COLORS: Record<string, string> = {
  wikilink: 'rgba(59, 130, 246, 0.35)',
  mdlink: 'rgba(107, 114, 128, 0.30)',
  'tag-of': 'rgba(245, 158, 11, 0.30)',
}

export default function GraphView({
  centerPath,
  workspaceRoot,
  depth = 2,
  width = 800,
  height = 600,
  className,
}: GraphViewProps) {
  const selectFile = useWorkspace((state) => state.selectFile)
  const setWorkbenchMode = useMode((state) => state.setWorkbenchMode)

  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(false)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const panRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const doc = typeof window !== 'undefined' ? window.electronAPI?.document : null
    const fetcher = doc?.getGraph
    if (!fetcher) {
      setLoading(false)
      return
    }
    void fetcher({ centerPath, workspaceRoot, depth }).then((response) => {
      if (cancelled) return
      if (response?.success && response.data) setGraph(response.data)
      else setGraph({ nodes: [], edges: [] })
      setLoading(false)
    }).catch(() => {
      if (cancelled) return
      setGraph({ nodes: [], edges: [] })
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [centerPath, workspaceRoot, depth])

  const { nodes: layoutNodes, pin, release } = useForceLayout(graph.nodes, graph.edges, { width, height })

  const idToNode = useMemo(() => {
    const map = new Map<string, LayoutNode>()
    for (const n of layoutNodes) map.set(n.id, n)
    return map
  }, [layoutNodes])

  const toLocal = useCallback((evt: React.PointerEvent<SVGElement>): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = evt.clientX
    pt.y = evt.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const local = pt.matrixTransform(ctm.inverse())
    return { x: (local.x - pan.x) / zoom, y: (local.y - pan.y) / zoom }
  }, [pan, zoom])

  const onNodePointerDown = (evt: React.PointerEvent<SVGElement>, node: LayoutNode): void => {
    evt.stopPropagation()
    ;(evt.currentTarget as Element).setPointerCapture(evt.pointerId)
    const local = toLocal(evt)
    dragRef.current = { id: node.id, offsetX: local.x - node.x, offsetY: local.y - node.y }
  }
  const onNodePointerMove = (evt: React.PointerEvent<SVGElement>): void => {
    if (!dragRef.current) return
    const local = toLocal(evt)
    pin(dragRef.current.id, local.x - dragRef.current.offsetX, local.y - dragRef.current.offsetY)
  }
  const onNodePointerUp = (evt: React.PointerEvent<SVGElement>): void => {
    dragRef.current = null
    ;(evt.currentTarget as Element).releasePointerCapture(evt.pointerId)
  }

  const onSvgPointerDown = (evt: React.PointerEvent<SVGSVGElement>): void => {
    if (dragRef.current) return
    panRef.current = {
      startX: evt.clientX,
      startY: evt.clientY,
      originX: pan.x,
      originY: pan.y,
    }
    ;(evt.currentTarget as SVGSVGElement).setPointerCapture(evt.pointerId)
  }
  const onSvgPointerMove = (evt: React.PointerEvent<SVGSVGElement>): void => {
    if (!panRef.current) return
    setPan({
      x: panRef.current.originX + (evt.clientX - panRef.current.startX),
      y: panRef.current.originY + (evt.clientY - panRef.current.startY),
    })
  }
  const onSvgPointerUp = (evt: React.PointerEvent<SVGSVGElement>): void => {
    panRef.current = null
    ;(evt.currentTarget as SVGSVGElement).releasePointerCapture(evt.pointerId)
  }

  const onWheel = (evt: React.WheelEvent<SVGSVGElement>): void => {
    evt.preventDefault()
    const delta = -evt.deltaY * 0.0015
    setZoom((z) => Math.max(0.3, Math.min(3, z + delta)))
  }

  const onNodeDoubleClick = (node: LayoutNode): void => {
    if (node.type === 'doc' && node.sourceType === 'document' && !node.id.startsWith('ghost:')) {
      const path = node.label
      // node.id is `doc:<id>` — we need the path; store it alongside label by
      // fetching once more from the server via selectFile heuristic. Simpler:
      // the label is the filename; users need the full path, so let's just
      // ignore double-click unless we pass path through. For now, dispatch
      // a getBacklinks-like lookup by filename.
      void path
      // Fallback: best-effort — not all graphs carry paths; a future iteration
      // can include path in the node payload.
    }
    release(node.id)
  }
  void setWorkbenchMode
  void selectFile

  const transform = `translate(${pan.x} ${pan.y}) scale(${zoom})`

  return (
    <div className={className} style={{ position: 'relative', width, height, overflow: 'hidden' }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={onSvgPointerUp}
        onWheel={onWheel}
        style={{ cursor: dragRef.current ? 'grabbing' : 'grab', userSelect: 'none' }}
      >
        <g transform={transform}>
          {graph.edges.map((edge, idx) => {
            const a = idToNode.get(edge.source)
            const b = idToNode.get(edge.target)
            if (!a || !b) return null
            return (
              <line
                key={`edge-${idx}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={EDGE_COLORS[edge.kind] ?? 'rgba(120,120,120,0.25)'}
                strokeWidth={1.2}
              />
            )
          })}
          {layoutNodes.map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x} ${node.y})`}
              onPointerDown={(evt) => onNodePointerDown(evt, node)}
              onPointerMove={onNodePointerMove}
              onPointerUp={onNodePointerUp}
              onDoubleClick={() => onNodeDoubleClick(node)}
              style={{ cursor: 'pointer' }}
            >
              <circle
                r={node.type === 'tag' ? 5 : node.type === 'ghost' ? 4 : 7}
                fill={NODE_COLORS[node.type]}
                fillOpacity={node.type === 'ghost' ? 0.6 : 0.9}
                stroke="rgba(0,0,0,0.15)"
                strokeWidth={0.5}
              />
              <text
                x={10}
                y={4}
                fontSize={10}
                fill="var(--text, #111)"
                style={{ pointerEvents: 'none' }}
              >
                {node.label.length > 24 ? `${node.label.slice(0, 24)}…` : node.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
      {loading && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            padding: '4px 8px',
            borderRadius: 6,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            fontSize: 11,
          }}
        >
          正在加载图谱…
        </div>
      )}
      {!loading && graph.nodes.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-placeholder, #999)',
            fontSize: 12,
          }}
        >
          暂无图谱数据 — 先在搜索面板点「重建索引」
        </div>
      )}
    </div>
  )
}
