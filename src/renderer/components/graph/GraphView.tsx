import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useDocTabs } from '../../stores/useDocTabs'
import { requestWorkbenchModeOpen } from '../../modules/workbench/mode-transition'
import {
  applyGraphWheelGesture,
  buildGraphDocumentPreview,
  type GraphViewport,
} from './graph-interactions'
import {
  drawGraphCanvas,
  findGraphNodeAtPoint,
  fitGraphViewport,
  readGraphPalette,
  type GraphCanvasPalette,
} from './graph-canvas-renderer'
import { graphSessionRegistry, type GraphDataFetcher } from './graph-session'
import { createLatestFrameScheduler, type LatestFrameScheduler } from './graph-frame-scheduler'
import {
  getLocalPoint,
  isOpenableDocumentNode,
  normalizeGraphData,
  type CachedDocumentPreview,
  type HoveredDocumentPreview,
  type PendingGraphPin,
  type PointerInteraction,
} from './graph-view-model'
import type { GraphNode, GraphQuery } from './graph-types'
import { buildGraphTopology } from './graph-topology'

export interface GraphViewProps {
  centerPath?: string
  workspaceRoot?: string
  depth?: number
  width?: number
  height?: number
  className?: string
  viewId?: string
  onDocumentOpen?: (path: string) => void
}

const fetchGraphData: GraphDataFetcher = async (query: GraphQuery) => {
  const response = await window.electronAPI?.document?.getGraph({
    workspaceRoot: query.workspaceRoot,
    centerPath: query.centerPath,
    depth: query.depth,
  })
  if (!response?.success || !response.data) {
    throw new Error(response?.error || '暂时无法读取图谱')
  }
  return normalizeGraphData(response.data)
}

export default function GraphView({
  centerPath,
  workspaceRoot,
  depth = 2,
  width = 800,
  height = 600,
  className,
  viewId = 'panel',
  onDocumentOpen,
}: GraphViewProps) {
  const storedWorkspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const selectFile = useWorkspace((state) => state.selectFile)
  const resolvedWorkspaceRoot = workspaceRoot ?? storedWorkspaceRoot ?? ''
  const session = useMemo(() => graphSessionRegistry.get({
    workspaceRoot: resolvedWorkspaceRoot,
    centerPath,
    depth,
  }), [centerPath, depth, resolvedWorkspaceRoot])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const previewCacheRef = useRef<Map<string, CachedDocumentPreview>>(new Map())
  const interactionRef = useRef<PointerInteraction | null>(null)
  const viewportSchedulerRef = useRef<LatestFrameScheduler<GraphViewport> | null>(null)
  const pinSchedulerRef = useRef<LatestFrameScheduler<PendingGraphPin> | null>(null)
  const suppressClickRef = useRef(false)
  const viewportRef = useRef<GraphViewport>({ x: width / 2, y: height / 2, zoom: 1 })
  const [viewport, setViewport] = useState<GraphViewport>(() => (
    session.getViewState(viewId)?.viewport ?? viewportRef.current
  ))
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [hoveredPreview, setHoveredPreview] = useState<HoveredDocumentPreview | null>(null)
  const [darkTheme, setDarkTheme] = useState(() => (
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
  ))

  useEffect(() => {
    if (!resolvedWorkspaceRoot) return
    void session.ensureLoaded(fetchGraphData)
  }, [resolvedWorkspaceRoot, session])

  useEffect(() => {
    const root = document.documentElement
    const updateTheme = () => setDarkTheme(root.dataset.theme === 'dark')
    updateTheme()
    const observer = new MutationObserver(updateTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const requestFrame = window.requestAnimationFrame.bind(window)
    const cancelFrame = window.cancelAnimationFrame.bind(window)
    viewportSchedulerRef.current = createLatestFrameScheduler((next) => {
      setViewport(next)
      session.setViewState(viewId, { viewport: next, userAdjusted: true })
    }, requestFrame, cancelFrame)
    pinSchedulerRef.current = createLatestFrameScheduler(
      (next) => session.pinNode(next.id, next.x, next.y),
      requestFrame,
      cancelFrame,
    )
    return () => {
      viewportSchedulerRef.current?.cancel()
      pinSchedulerRef.current?.cancel()
      viewportSchedulerRef.current = null
      pinSchedulerRef.current = null
    }
  }, [session, viewId])

  useEffect(() => {
    const stored = session.getViewState(viewId)
    const next = stored?.viewport ?? { x: width / 2, y: height / 2, zoom: 1 }
    viewportRef.current = next
    setViewport(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restores the stored viewport only when the session or view changes; width/height only seed the fallback center, and resize re-fitting is owned by the fit effect below
  }, [session, viewId])

  useEffect(() => {
    const positions = session.getSnapshot().positions
    if (positions.length < 2) return
    const stored = session.getViewState(viewId)
    if (stored?.userAdjusted) return
    const next = fitGraphViewport(positions, width, height, width >= 600 ? 64 : 30)
    viewportRef.current = next
    setViewport(next)
    session.setViewState(viewId, { viewport: next, userAdjusted: false })
  }, [height, session, snapshot.revision, snapshot.settled, viewId, width])

  const schedulePersistentViewport = useCallback((next: GraphViewport) => {
    viewportRef.current = next
    viewportSchedulerRef.current?.schedule(next)
  }, [])

  const { indexById, degrees: nodeDegrees } = useMemo(
    () => buildGraphTopology(snapshot.graph.nodes, snapshot.graph.edges),
    [snapshot.graph.nodes, snapshot.graph.edges],
  )
  const relatedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return null
    const related = new Set<string>([hoveredNodeId])
    for (const edge of snapshot.graph.edges) {
      if (edge.source === hoveredNodeId) related.add(edge.target)
      if (edge.target === hoveredNodeId) related.add(edge.source)
    }
    return related
  }, [hoveredNodeId, snapshot.graph.edges])

  // The tokens resolve where the canvas sits; read them once per theme, not on every frame of a pan.
  const paletteRef = useRef<{ dark: boolean; palette: GraphCanvasPalette } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    if (paletteRef.current?.dark !== darkTheme) paletteRef.current = { dark: darkTheme, palette: readGraphPalette(canvas) }
    drawGraphCanvas(context, snapshot.graph, snapshot.positions, {
      width,
      height,
      pixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
      viewport,
      hoveredNodeId,
      relatedNodeIds,
      palette: paletteRef.current.palette,
      indexById,
      degrees: nodeDegrees,
    })
  }, [darkTheme, height, hoveredNodeId, indexById, nodeDegrees, relatedNodeIds, snapshot.graph, snapshot.positions, viewport, width])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = getLocalPoint(canvas, event.clientX, event.clientY)
      const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(1, height)
          : 1
      schedulePersistentViewport(applyGraphWheelGesture(viewportRef.current, {
        deltaX: event.deltaX * deltaScale,
        deltaY: event.deltaY * deltaScale,
        ctrlKey: event.ctrlKey,
        pointerX: point.x,
        pointerY: point.y,
      }))
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [height, schedulePersistentViewport])

  const positionPreview = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect()
    const localX = clientX - (rect?.left ?? 0)
    const localY = clientY - (rect?.top ?? 0)
    const cardWidth = Math.min(320, Math.max(80, width - 24))
    const cardHeight = 166
    let left = localX + 16
    if (left + cardWidth > width - 8) left = localX - cardWidth - 16
    let top = localY + 16
    if (top + cardHeight > height - 8) top = localY - cardHeight - 16
    return {
      left: Math.max(8, Math.min(Math.max(8, width - cardWidth - 8), left)),
      top: Math.max(8, Math.min(Math.max(8, height - cardHeight - 8), top)),
      width: cardWidth,
    }
  }, [height, width])

  const previewPath = hoveredPreview?.path
  const previewFallbackTitle = hoveredPreview?.title
  useEffect(() => {
    if (!previewPath || !previewFallbackTitle || previewCacheRef.current.has(previewPath)) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      const reader = window.electronAPI?.document?.readFile
      if (!reader) return
      void reader(previewPath).then((response) => {
        if (cancelled) return
        const content = response?.data?.type === 'text'
          ? response.data.content
          : typeof response?.content === 'string'
            ? response.content
            : null
        const next: CachedDocumentPreview = content !== null
          ? { ...buildGraphDocumentPreview(content, previewFallbackTitle), status: 'ready' }
          : {
              title: previewFallbackTitle,
              body: '这个文件暂时不能显示文字预览，点击仍可在文档模式打开。',
              status: 'unavailable',
            }
        previewCacheRef.current.set(previewPath, next)
        setHoveredPreview((current) => current?.path === previewPath ? { ...current, ...next } : current)
      }).catch(() => {
        if (cancelled) return
        const next: CachedDocumentPreview = {
          title: previewFallbackTitle,
          body: '暂时无法读取预览，点击仍可在文档模式打开。',
          status: 'unavailable',
        }
        previewCacheRef.current.set(previewPath, next)
        setHoveredPreview((current) => current?.path === previewPath ? { ...current, ...next } : current)
      })
    }, 100)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [previewFallbackTitle, previewPath])

  const hitTest = useCallback((clientX: number, clientY: number): GraphNode | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const point = getLocalPoint(canvas, clientX, clientY)
    return findGraphNodeAtPoint(snapshot.graph.nodes, snapshot.positions, viewportRef.current, point.x, point.y)
  }, [snapshot.graph.nodes, snapshot.positions])

  const updateHover = useCallback((clientX: number, clientY: number) => {
    const node = hitTest(clientX, clientY)
    setHoveredNodeId(node?.id ?? null)
    if (!isOpenableDocumentNode(node)) {
      setHoveredPreview(null)
      return
    }
    const cached = previewCacheRef.current.get(node.path)
    setHoveredPreview({
      nodeId: node.id,
      path: node.path,
      title: cached?.title || node.label,
      body: cached?.body || '',
      status: cached?.status || 'loading',
      ...positionPreview(clientX, clientY),
    })
  }, [hitTest, positionPreview])

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    setHoveredPreview(null)
    const point = getLocalPoint(event.currentTarget, event.clientX, event.clientY)
    const node = findGraphNodeAtPoint(
      snapshot.graph.nodes,
      snapshot.positions,
      viewportRef.current,
      point.x,
      point.y,
    )
    if (node) {
      const index = indexById.get(node.id)
      if (index === undefined) return
      const worldX = (point.x - viewportRef.current.x) / viewportRef.current.zoom
      const worldY = (point.y - viewportRef.current.y) / viewportRef.current.zoom
      interactionRef.current = {
        kind: 'node',
        id: node.id,
        offsetX: worldX - snapshot.positions[index * 2],
        offsetY: worldY - snapshot.positions[index * 2 + 1],
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      }
    } else {
      interactionRef.current = {
        kind: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: viewportRef.current.x,
        originY: viewportRef.current.y,
        moved: false,
      }
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const interaction = interactionRef.current
    if (!interaction) {
      updateHover(event.clientX, event.clientY)
      return
    }
    const distance = Math.hypot(
      event.clientX - interaction.startClientX,
      event.clientY - interaction.startClientY,
    )
    if (!interaction.moved && distance >= 3) {
      interaction.moved = true
      if (interaction.kind === 'node') {
        session.setViewState(viewId, { viewport: viewportRef.current, userAdjusted: true })
      }
    }
    if (!interaction.moved) return
    if (interaction.kind === 'pan') {
      schedulePersistentViewport({
        x: interaction.originX + event.clientX - interaction.startClientX,
        y: interaction.originY + event.clientY - interaction.startClientY,
        zoom: viewportRef.current.zoom,
      })
      return
    }
    const point = getLocalPoint(event.currentTarget, event.clientX, event.clientY)
    pinSchedulerRef.current?.schedule({
      id: interaction.id,
      x: (point.x - viewportRef.current.x) / viewportRef.current.zoom - interaction.offsetX,
      y: (point.y - viewportRef.current.y) / viewportRef.current.zoom - interaction.offsetY,
    })
  }

  const finishPointerInteraction = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const interaction = interactionRef.current
    if (interaction?.kind === 'node' && interaction.moved) {
      pinSchedulerRef.current?.flush()
      session.releaseNode(interaction.id)
    }
    if (interaction?.kind === 'pan' && interaction.moved) viewportSchedulerRef.current?.flush()
    if (interaction?.moved) {
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    interactionRef.current = null
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }
  }

  const openDocument = useCallback((node: GraphNode | null) => {
    if (!isOpenableDocumentNode(node)) return
    selectFile(node.path)
    useDocTabs.getState().openTab(node.path)
    requestWorkbenchModeOpen('document')
    onDocumentOpen?.(node.path)
  }, [onDocumentOpen, selectFile])

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (suppressClickRef.current) return
    openDocument(hitTest(event.clientX, event.clientY))
  }

  const showInitialLoader = snapshot.status === 'loading' && snapshot.graph.nodes.length === 0
  const isEmpty = snapshot.status !== 'loading' && snapshot.graph.nodes.length === 0

  return (
    <div
      ref={containerRef}
      className={className}
      data-graph-view="true"
      data-graph-settled={snapshot.settled ? 'true' : 'false'}
      style={{ position: 'relative', width, height, overflow: 'hidden' }}
    >
      <canvas
        ref={canvasRef}
        data-knowledge-graph-canvas="true"
        aria-label="关系图谱，可用双指移动和捏合缩放"
        width={Math.max(1, Math.round(width))}
        height={Math.max(1, Math.round(height))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishPointerInteraction}
        onPointerCancel={finishPointerInteraction}
        onPointerLeave={() => {
          if (!interactionRef.current) {
            setHoveredNodeId(null)
            setHoveredPreview(null)
          }
        }}
        onClick={onClick}
        style={{
          display: 'block',
          width,
          height,
          cursor: hoveredNodeId ? 'pointer' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
        }}
      />
      {hoveredPreview && (
        <div
          className="knowledge-graph-preview rn-float"
          data-graph-document-preview="true"
          role="tooltip"
          style={{ left: hoveredPreview.left, top: hoveredPreview.top, width: hoveredPreview.width }}
        >
          <strong>{hoveredPreview.title}</strong>
          <p>{hoveredPreview.status === 'loading' ? '正在读取文档预览…' : hoveredPreview.body}</p>
          <span>点击在文档模式打开</span>
        </div>
      )}
      {showInitialLoader && <div className="knowledge-graph-status">正在加载图谱…</div>}
      {snapshot.status === 'loading' && snapshot.graph.nodes.length > 0 && (
        <div className="knowledge-graph-status">正在更新图谱…</div>
      )}
      {snapshot.error && snapshot.graph.nodes.length > 0 && (
        <div className="knowledge-graph-status knowledge-graph-status--warning">
          更新失败，已保留上次图谱
        </div>
      )}
      {snapshot.graph.truncated && (
        <div className="knowledge-graph-status knowledge-graph-status--warning">
          {`已显示 ${snapshot.graph.nodes.length} 个节点，当前文档总数 ${snapshot.graph.totalDocs}`}
        </div>
      )}
      {isEmpty && (
        <div className="knowledge-graph-empty">
          {snapshot.error || snapshot.graph.note || '暂无图谱数据 — 先在搜索面板点「重建索引」'}
        </div>
      )}
    </div>
  )
}
