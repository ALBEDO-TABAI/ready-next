import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  FileText,
  ImagePlus,
  Magnet,
  MousePointer2,
  Pencil,
  Save,
  Square,
  StickyNote,
  Trash2,
  Type,
  Video,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  ReadyBoardAsset,
  ReadyBoardAssetKind,
  ReadyBoardArrowNode,
  ReadyBoardImageNode,
  ReadyBoardMarkdownNode,
  ReadyBoardNode,
  ReadyBoardNodeType,
  ReadyBoardPathNode,
  ReadyBoardState,
  ReadyBoardVideoNode,
} from '../../../shared/ready-board'
import { createEmptyReadyBoardState, normalizeReadyBoardState } from '../../../shared/ready-board'
import { useDocTabs, type DocTab } from '../../stores/useDocTabs'
import { toLocalFileUrl } from '../../utils/dragDrop'
import {
  getBoardNodeBounds,
  getMarqueeSelectedNodeIds,
  normalizeBoardRect,
  resolveBoardSnapOffset,
  type BoardRect,
  type BoardSnapGuide,
} from './boardInteraction'
import './BoardEditor.css'

type Tool = 'select' | 'pen'
type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'
type BoardIPCResponse<T> = {
  success: boolean
  data?: T
  error?: string
  errorCode?: string
}

interface BoardEditorProps {
  tab: DocTab
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogg'])
const MARKDOWN_EXTS = new Set(['md', 'markdown'])
const MARQUEE_THRESHOLD_PX = 4
const SNAP_THRESHOLD_PX = 8

function makeNodeId(): string {
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function getPathExt(path: string): string {
  const name = path.split(/[\\/]/).pop() || path
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

function kindForPath(path: string): ReadyBoardAssetKind | null {
  const ext = getPathExt(path)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  return null
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function isLocalPathLike(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)
}

function saveStatusLabel(status: SaveStatus): string {
  if (status === 'pending') return '待保存'
  if (status === 'saving') return '保存中'
  if (status === 'saved') return '已保存'
  if (status === 'error') return '保存失败'
  return '就绪'
}

function updateNode(nodes: ReadyBoardNode[], id: string, patch: Partial<ReadyBoardNode>): ReadyBoardNode[] {
  return nodes.map((node) => node.id === id ? { ...node, ...patch } as ReadyBoardNode : node)
}

function assetUrl(boardPath: string | null, src: string): string {
  if (!boardPath) return src
  const dir = boardPath.replace(/[/\\][^/\\]+$/, '')
  return toLocalFileUrl(`${dir}/${src}`)
}

function pushUniquePath(paths: string[], value: unknown) {
  if (typeof value !== 'string') return
  const path = value.trim()
  if (!path || paths.includes(path)) return
  paths.push(path)
}

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const decoded = decodeURIComponent(url.pathname)
    return /^[a-zA-Z]:/.test(decoded.slice(1)) ? decoded.slice(1) : decoded
  } catch {
    return null
  }
}

function parseReadyDragPaths(dataTransfer: DataTransfer): string[] {
  const paths: string[] = []
  const rawValues = [
    dataTransfer.getData('application/x-ready-drag'),
    dataTransfer.getData('application/x-ready-document-tab'),
    dataTransfer.getData('application/x-ready-file'),
    dataTransfer.getData('application/x-ready-workspace-item'),
  ]
  for (const raw of rawValues) {
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as {
        path?: string
        paths?: string[]
        isDirectory?: boolean
        type?: string
        items?: Array<{ path?: string; isDirectory?: boolean; type?: string }>
      }
      if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (item.path && !item.isDirectory && item.type !== 'folder') pushUniquePath(paths, item.path)
        }
        continue
      }
      if (Array.isArray(parsed.paths)) {
        for (const path of parsed.paths) pushUniquePath(paths, path)
        continue
      }
      if (parsed.path && !parsed.isDirectory && parsed.type !== 'folder') pushUniquePath(paths, parsed.path)
    } catch {
      // Ignore malformed drag payloads; other dataTransfer slots may still carry a path.
    }
  }
  const uriList = dataTransfer.getData('text/uri-list')
  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith('#')) continue
    if (value.startsWith('file://')) pushUniquePath(paths, fileUrlToPath(value))
    else if (isHttpUrl(value)) pushUniquePath(paths, value)
  }
  const text = dataTransfer.getData('text/plain')
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim()
    if (isLocalPathLike(value) || isHttpUrl(value)) pushUniquePath(paths, value)
  }
  for (const file of Array.from(dataTransfer.files || [])) {
    pushUniquePath(paths, window.electronAPI?.getFilePathFromDrop?.(file))
  }
  return paths
}

function nodeFromAsset(asset: ReadyBoardAsset, x: number, y: number, size?: { width: number; height: number }): ReadyBoardNode {
  if (asset.kind === 'video') {
    return {
      id: makeNodeId(),
      type: 'video',
      src: asset.src,
      title: asset.title || asset.name,
      x,
      y,
      width: size?.width ?? 360,
      height: size?.height ?? 220,
    } satisfies ReadyBoardVideoNode
  }
  if (asset.kind === 'markdown') {
    return {
      id: makeNodeId(),
      type: 'markdown',
      src: asset.src,
      title: asset.title || asset.name,
      excerpt: asset.excerpt || '',
      x,
      y,
      width: size?.width ?? 280,
      height: size?.height ?? 180,
    } satisfies ReadyBoardMarkdownNode
  }
  return {
    id: makeNodeId(),
    type: 'image',
    src: asset.src,
    title: asset.title || asset.name,
    x,
    y,
    width: size?.width ?? 320,
    height: size?.height ?? 220,
  } satisfies ReadyBoardImageNode
}

function batchNodeSize(kind: ReadyBoardAssetKind, count: number): { width: number; height: number } | undefined {
  if (count <= 1) return undefined
  if (kind === 'video') return { width: 220, height: 140 }
  if (kind === 'markdown') return { width: 220, height: 150 }
  return { width: 180, height: 130 }
}

function createAssetNodes(assets: ReadyBoardAsset[], origin: { x: number; y: number }): ReadyBoardNode[] {
  if (assets.length <= 1) {
    return assets.map((asset) => nodeFromAsset(asset, origin.x, origin.y))
  }
  const columns = Math.ceil(Math.sqrt(assets.length))
  const rows = Math.ceil(assets.length / columns)
  const pitchX = 248
  const pitchY = 184
  const groupWidth = (columns - 1) * pitchX + 220
  const groupHeight = (rows - 1) * pitchY + 150
  const startX = origin.x - groupWidth / 2
  const startY = origin.y - groupHeight / 2
  return assets.map((asset, index) => {
    const row = Math.floor(index / columns)
    const col = index % columns
    const staggerX = row % 2 === 0 ? 0 : 18
    const staggerY = col % 2 === 0 ? 0 : 10
    return nodeFromAsset(
      asset,
      startX + col * pitchX + staggerX,
      startY + row * pitchY + staggerY,
      batchNodeSize(asset.kind, assets.length),
    )
  })
}

export default function BoardEditor({ tab }: BoardEditorProps) {
  const [boardId, setBoardId] = useState<string | null>(null)
  const [state, setState] = useState<ReadyBoardState>(() => createEmptyReadyBoardState(tab.title))
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [tool, setTool] = useState<Tool>('select')
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [marqueeRect, setMarqueeRect] = useState<BoardRect | null>(null)
  const [snapGuides, setSnapGuides] = useState<BoardSnapGuide[]>([])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const stateRef = useRef(state)
  const boardIdRef = useRef<string | null>(null)
  const selectedIdsRef = useRef<string[]>([])
  const snapEnabledRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const dragRef = useRef<
    | { kind: 'marquee'; startClientX: number; startClientY: number; start: { x: number; y: number }; current: { x: number; y: number } }
    | { kind: 'node'; ids: string[]; startX: number; startY: number; startNodes: Array<{ id: string; x: number; y: number; width: number; height: number }>; bounds: BoardRect }
    | { kind: 'resize'; id: string; startX: number; startY: number; width: number; height: number }
    | { kind: 'path'; points: Array<{ x: number; y: number }> }
    | null
  >(null)
  const { openTab, markTabSaved } = useDocTabs()

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])

  useEffect(() => {
    snapEnabledRef.current = snapEnabled
    if (!snapEnabled) setSnapGuides([])
  }, [snapEnabled])

  useEffect(() => {
    boardIdRef.current = boardId
  }, [boardId])

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const hasSelection = selectedIds.length > 0

  const screenToBoard = useCallback((clientX: number, clientY: number) => {
    const surface = surfaceRef.current
    if (!surface) return { x: 0, y: 0 }
    const rect = surface.getBoundingClientRect()
    return {
      x: (clientX - rect.left - rect.width / 2 - stateRef.current.viewport.x) / stateRef.current.viewport.zoom,
      y: (clientY - rect.top - rect.height / 2 - stateRef.current.viewport.y) / stateRef.current.viewport.zoom,
    }
  }, [])

  const saveNow = useCallback(async () => {
    const id = boardIdRef.current
    if (!id) return
    setSaveStatus('saving')
    const result: BoardIPCResponse<{ state: ReadyBoardState }> | undefined = await window.electronAPI?.board?.save?.({ boardId: id, state: stateRef.current }).catch((saveError) => ({
      success: false,
      error: saveError instanceof Error ? saveError.message : String(saveError),
    }))
    if (result?.success && result.data?.state) {
      setState(result.data.state)
      setSaveStatus('saved')
      markTabSaved(tab.id)
      return
    }
    setSaveStatus('error')
    setError(result?.error || '保存失败')
  }, [markTabSaved, tab.id])

  const scheduleSave = useCallback(() => {
    setSaveStatus('pending')
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void saveNow()
    }, 1500)
  }, [saveNow])

  const patchState = useCallback((updater: (current: ReadyBoardState) => ReadyBoardState, options?: { save?: boolean }) => {
    setState((current) => {
      const next = normalizeReadyBoardState(updater(current))
      stateRef.current = next
      return next
    })
    if (options?.save !== false) scheduleSave()
  }, [scheduleSave])

  useEffect(() => {
    let disposed = false
    async function openBoard() {
      if (!tab.path) return
      setError(null)
      const result: BoardIPCResponse<{ boardId: string; state: ReadyBoardState }> | undefined = await window.electronAPI?.board?.open?.({ path: tab.path }).catch((openError) => ({
        success: false,
        error: openError instanceof Error ? openError.message : String(openError),
      }))
      if (disposed) return
      if (result?.success && result.data) {
        setBoardId(result.data.boardId)
        boardIdRef.current = result.data.boardId
        setState(result.data.state)
        stateRef.current = result.data.state
        void window.electronAPI?.board?.setActive?.({ boardId: result.data.boardId })
      } else {
        setError(result?.error || '画板打开失败')
      }
    }
    void openBoard()
    return () => {
      disposed = true
      const id = boardIdRef.current
      if (id) void window.electronAPI?.board?.setActive?.({ boardId: null })
    }
  }, [tab.path])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.board?.onActiveBoardExternalImageAdded?.((result) => {
      if (!result?.success || !result.data) {
        if (result?.error) setError(result.error)
        return
      }
      if (result.data.boardId !== boardIdRef.current) return
      setState(result.data.state)
      stateRef.current = result.data.state
      setSaveStatus('saved')
    })
    return () => unsubscribe?.()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNow()
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
        event.preventDefault()
        patchState((current) => ({
          ...current,
          nodes: current.nodes.filter((node) => !selectedIds.includes(node.id)),
        }))
        setSelectedIds([])
      }
      if (event.key === 'Escape') {
        setSelectedIds([])
        setMarqueeRect(null)
        setSnapGuides([])
        setTool('select')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [patchState, saveNow, selectedIds])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [])

  const addAssetsAt = useCallback((assets: ReadyBoardAsset[], clientX?: number, clientY?: number) => {
    if (assets.length === 0) return
    const point = clientX != null && clientY != null ? screenToBoard(clientX, clientY) : { x: -160, y: -110 }
    const nodes = createAssetNodes(assets, point)
    patchState((current) => ({ ...current, nodes: [...current.nodes, ...nodes] }))
    setSelectedIds(nodes[nodes.length - 1]?.id ? [nodes[nodes.length - 1].id] : [])
  }, [patchState, screenToBoard])

  const importPaths = useCallback(async (paths: string[], clientX?: number, clientY?: number) => {
    const id = boardIdRef.current
    if (!id) return
    const uniquePaths = paths.filter((path, index) => paths.indexOf(path) === index)
    const assets: ReadyBoardAsset[] = []
    let skipped = 0
    let failed = 0
    for (const path of uniquePaths) {
      const kind = kindForPath(path)
      if (!kind) {
        skipped += 1
        continue
      }
      const result: BoardIPCResponse<ReadyBoardAsset> | undefined = await window.electronAPI?.board?.importAsset?.({ boardId: id, srcPath: path, kind }).catch((importError) => ({
        success: false,
        error: importError instanceof Error ? importError.message : String(importError),
      }))
      if (result?.success && result.data) assets.push(result.data)
      else failed += 1
    }
    if (assets.length > 0) addAssetsAt(assets, clientX, clientY)
    if (failed > 0 || skipped > 0) {
      setError(`已添加 ${assets.length} 个素材，${failed + skipped} 个未添加`)
    }
  }, [addAssetsAt])

  const importRemoteUrls = useCallback(async (urls: string[], clientX?: number, clientY?: number) => {
    const id = boardIdRef.current
    if (!id) return
    const assets: ReadyBoardAsset[] = []
    let failed = 0
    for (const url of urls.filter((value, index) => urls.indexOf(value) === index)) {
      const result: BoardIPCResponse<ReadyBoardAsset> | undefined = await window.electronAPI?.board?.importRemoteImage?.({ boardId: id, url }).catch((importError) => ({
        success: false,
        error: importError instanceof Error ? importError.message : String(importError),
      }))
      if (result?.success && result.data) assets.push(result.data)
      else failed += 1
    }
    if (assets.length > 0) addAssetsAt(assets, clientX, clientY)
    if (failed > 0) {
      setError(`已添加 ${assets.length} 张网页图片，${failed} 张未添加`)
    }
  }, [addAssetsAt])

  const pickAsset = useCallback(async (kind: ReadyBoardAssetKind | 'any') => {
    const id = boardIdRef.current
    if (!id) return
    const result: BoardIPCResponse<ReadyBoardAsset> | undefined = await window.electronAPI?.board?.pickAsset?.({ boardId: id, kind }).catch((pickError) => ({
      success: false,
      error: pickError instanceof Error ? pickError.message : String(pickError),
    }))
    if (result?.success && result.data) {
      addAssetsAt([result.data])
    } else if (result?.errorCode !== 'CANCELLED') {
      setError(result?.error || '素材导入失败')
    }
  }, [addAssetsAt])

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const text = event.clipboardData?.getData('text/plain')?.trim()
      const urls = text
        ? text.split(/\r?\n/).map((line) => line.trim()).filter(isHttpUrl)
        : []
      if (urls.length > 0) {
        event.preventDefault()
        void importRemoteUrls(urls)
        return
      }
      const files = Array.from(event.clipboardData?.files || [])
      const paths: string[] = []
      for (const file of files) {
        const path = window.electronAPI?.getFilePathFromDrop?.(file)
        if (path) paths.push(path)
      }
      if (paths.length > 0) {
        event.preventDefault()
        void importPaths(paths)
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [importPaths, importRemoteUrls])

  const addShape = useCallback((type: ReadyBoardNodeType) => {
    const base = { id: makeNodeId(), x: -80, y: -60, width: 180, height: 120 }
    let node: ReadyBoardNode
    if (type === 'text') {
      node = { ...base, type, text: 'Text', fontSize: 28, color: 'var(--text-title)' }
    } else if (type === 'note') {
      node = { ...base, type, text: 'Note', color: '#181818', background: '#fff4b8' }
    } else if (type === 'rect') {
      node = { ...base, type, fill: 'rgba(255,75,43,.14)', stroke: '#ff4b2b' }
    } else if (type === 'arrow') {
      node = { ...base, type, width: 220, height: 120, x2: 220, y2: 120, stroke: '#ff4b2b', strokeWidth: 3 } satisfies ReadyBoardArrowNode
    } else {
      return
    }
    patchState((current) => ({ ...current, nodes: [...current.nodes, node] }))
    setSelectedIds([node.id])
  }, [patchState])

  const editTextNode = useCallback((node: ReadyBoardNode) => {
    if (node.type !== 'text' && node.type !== 'note') return
    const next = window.prompt('', node.text)
    if (next == null) return
    patchState((current) => ({
      ...current,
      nodes: updateNode(current.nodes, node.id, { text: next } as Partial<ReadyBoardNode>),
    }))
  }, [patchState])

  const openMarkdownNode = useCallback(async (node: ReadyBoardMarkdownNode) => {
    const id = boardIdRef.current
    if (!id) return
    const result = await window.electronAPI?.board?.openInDocument?.({ boardId: id, relativePath: node.src })
    if (result?.success && result.data?.path) openTab(result.data.path)
  }, [openTab])

  const handleSurfacePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    setSnapGuides([])
    if (tool === 'pen') {
      const point = screenToBoard(event.clientX, event.clientY)
      dragRef.current = { kind: 'path', points: [point] }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const point = screenToBoard(event.clientX, event.clientY)
    setSelectedIds([])
    setMarqueeRect(null)
    dragRef.current = {
      kind: 'marquee',
      startClientX: event.clientX,
      startClientY: event.clientY,
      start: point,
      current: point,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [screenToBoard, tool])

  const handleNodePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, node: ReadyBoardNode) => {
    if (event.button !== 0 || tool !== 'select') return
    event.stopPropagation()
    setSnapGuides([])
    const ids = selectedIdsRef.current.includes(node.id) ? selectedIdsRef.current : [node.id]
    const startNodes = stateRef.current.nodes
      .filter((item) => ids.includes(item.id))
      .map((item) => ({ id: item.id, x: item.x, y: item.y, width: item.width, height: item.height }))
    const bounds = getBoardNodeBounds(startNodes)
    if (!bounds) return
    setSelectedIds(ids)
    dragRef.current = { kind: 'node', ids, startX: event.clientX, startY: event.clientY, startNodes, bounds }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [tool])

  const handleResizePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>, node: ReadyBoardNode) => {
    event.stopPropagation()
    setSnapGuides([])
    setSelectedIds([node.id])
    dragRef.current = { kind: 'resize', id: node.id, startX: event.clientX, startY: event.clientY, width: node.width, height: node.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }, [])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.kind === 'marquee') {
      const current = screenToBoard(event.clientX, event.clientY)
      drag.current = current
      const nextRect = normalizeBoardRect(drag.start, current)
      setMarqueeRect(nextRect)
      setSelectedIds(getMarqueeSelectedNodeIds(stateRef.current.nodes, nextRect))
      return
    }
    if (drag.kind === 'node') {
      const rawDx = (event.clientX - drag.startX) / stateRef.current.viewport.zoom
      const rawDy = (event.clientY - drag.startY) / stateRef.current.viewport.zoom
      let dx = rawDx
      let dy = rawDy
      const nextSnapGuides: BoardSnapGuide[] = []
      if (snapEnabledRef.current) {
        const snap = resolveBoardSnapOffset({
          movingBounds: drag.bounds,
          fixedNodes: stateRef.current.nodes.filter((node) => !drag.ids.includes(node.id)),
          dx: rawDx,
          dy: rawDy,
          threshold: SNAP_THRESHOLD_PX / stateRef.current.viewport.zoom,
        })
        dx = snap.dx
        dy = snap.dy
        nextSnapGuides.push(...snap.guides)
      }
      setSnapGuides(nextSnapGuides)
      patchState((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          const startNode = drag.startNodes.find((item) => item.id === node.id)
          return startNode ? { ...node, x: startNode.x + dx, y: startNode.y + dy } as ReadyBoardNode : node
        }),
      }), { save: false })
      return
    }
    if (drag.kind === 'resize') {
      const dx = (event.clientX - drag.startX) / stateRef.current.viewport.zoom
      const dy = (event.clientY - drag.startY) / stateRef.current.viewport.zoom
      patchState((current) => ({
        ...current,
        nodes: updateNode(current.nodes, drag.id, {
          width: Math.max(48, drag.width + dx),
          height: Math.max(36, drag.height + dy),
        } as Partial<ReadyBoardNode>),
      }), { save: false })
      return
    }
    if (drag.kind === 'path') {
      drag.points.push(screenToBoard(event.clientX, event.clientY))
    }
  }, [patchState, screenToBoard])

  const handlePointerUp = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    setSnapGuides([])
    if (!drag) return
    if (drag.kind === 'marquee') {
      const moved = Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y) * stateRef.current.viewport.zoom
      setMarqueeRect(null)
      if (moved < MARQUEE_THRESHOLD_PX) setSelectedIds([])
      return
    }
    if (drag.kind === 'path' && drag.points.length > 1) {
      const minX = Math.min(...drag.points.map((point) => point.x))
      const minY = Math.min(...drag.points.map((point) => point.y))
      const maxX = Math.max(...drag.points.map((point) => point.x))
      const maxY = Math.max(...drag.points.map((point) => point.y))
      const node: ReadyBoardPathNode = {
        id: makeNodeId(),
        type: 'path',
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
        points: drag.points.map((point) => ({ x: point.x - minX, y: point.y - minY })),
        stroke: '#ff4b2b',
        strokeWidth: 4,
      }
      patchState((current) => ({ ...current, nodes: [...current.nodes, node] }))
      setSelectedIds([node.id])
      setTool('select')
      return
    }
    scheduleSave()
  }, [patchState, scheduleSave])

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) {
      const delta = event.deltaY > 0 ? -0.08 : 0.08
      patchState((current) => ({
        ...current,
        viewport: {
          ...current.viewport,
          zoom: Math.max(0.12, Math.min(4, current.viewport.zoom + delta)),
        },
      }), { save: false })
      return
    }
    patchState((current) => ({
      ...current,
      viewport: {
        ...current.viewport,
        x: current.viewport.x - event.deltaX,
        y: current.viewport.y - event.deltaY,
      },
    }), { save: false })
  }, [patchState])

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const readyPaths = parseReadyDragPaths(event.dataTransfer)
    if (readyPaths.length > 0) {
      const remoteUrls = readyPaths.filter(isHttpUrl)
      const localPaths = readyPaths.filter((path) => !isHttpUrl(path))
      if (localPaths.length > 0) void importPaths(localPaths, event.clientX, event.clientY)
      if (remoteUrls.length > 0) void importRemoteUrls(remoteUrls, event.clientX, event.clientY)
      return
    }
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    const remoteUrls = text.split(/\r?\n/).map((line) => line.trim()).filter(isHttpUrl)
    if (remoteUrls.length > 0) {
      void importRemoteUrls(remoteUrls, event.clientX, event.clientY)
      return
    }
    const localPaths: string[] = []
    for (const file of Array.from(event.dataTransfer.files || [])) {
      const path = window.electronAPI?.getFilePathFromDrop?.(file)
      if (path) localPaths.push(path)
    }
    if (localPaths.length > 0) void importPaths(localPaths, event.clientX, event.clientY)
  }, [importPaths, importRemoteUrls])

  const setZoom = useCallback((delta: number) => {
    patchState((current) => ({
      ...current,
      viewport: {
        ...current.viewport,
        zoom: Math.max(0.12, Math.min(4, current.viewport.zoom + delta)),
      },
    }))
  }, [patchState])

  const renderNode = (node: ReadyBoardNode) => {
    const selected = selectedIdSet.has(node.id)
    const style = {
      left: node.x,
      top: node.y,
      width: node.width,
      height: node.height,
      transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
    }
    return (
      <div
        key={node.id}
        className={`ready-board-node ready-board-node--${node.type} ${selected ? 'is-selected' : ''}`}
        style={style}
        onPointerDown={(event) => handleNodePointerDown(event, node)}
        onDoubleClick={() => editTextNode(node)}
      >
        {node.type === 'image' && <img draggable={false} src={assetUrl(tab.path, node.src)} alt={node.alt || node.title || ''} />}
        {node.type === 'video' && <video src={assetUrl(tab.path, node.src)} controls />}
        {node.type === 'markdown' && (
          <button className="ready-board-markdown-card" onClick={() => void openMarkdownNode(node)}>
            <strong>{node.title}</strong>
            <span>{node.excerpt}</span>
          </button>
        )}
        {node.type === 'text' && (
          <div className="ready-board-text-node" style={{ fontSize: node.fontSize, color: node.color }}>{node.text}</div>
        )}
        {node.type === 'note' && (
          <div className="ready-board-note-node" style={{ color: node.color, background: node.background }}>{node.text}</div>
        )}
        {node.type === 'rect' && (
          <div className="ready-board-rect-node" style={{ background: node.fill, borderColor: node.stroke }} />
        )}
        {node.type === 'arrow' && (
          <svg className="ready-board-vector-node" viewBox={`0 0 ${Math.max(node.width, 1)} ${Math.max(node.height, 1)}`}>
            <defs>
              <marker id={`arrow-${node.id}`} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
                <path d="M0,0 L0,6 L9,3 z" fill={node.stroke} />
              </marker>
            </defs>
            <line x1="0" y1="0" x2={node.x2} y2={node.y2} stroke={node.stroke} strokeWidth={node.strokeWidth} markerEnd={`url(#arrow-${node.id})`} />
          </svg>
        )}
        {node.type === 'path' && (
          <svg className="ready-board-vector-node" viewBox={`0 0 ${Math.max(node.width, 1)} ${Math.max(node.height, 1)}`}>
            <polyline
              points={node.points.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke={node.stroke}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={node.strokeWidth}
            />
          </svg>
        )}
        {selected && selectedIds.length === 1 && (
          <button
            className="ready-board-resize-handle"
            aria-label="Resize"
            onPointerDown={(event) => handleResizePointerDown(event, node)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="ready-board-editor">
      <div className="ready-board-toolbar" role="toolbar">
        <button className={tool === 'select' ? 'is-active' : ''} title="Select" onClick={() => setTool('select')}><MousePointer2 size={16} /></button>
        <button className={tool === 'pen' ? 'is-active' : ''} title="Draw" onClick={() => setTool('pen')}><Pencil size={16} /></button>
        <span className="ready-board-toolbar-separator" />
        <button title="Image" onClick={() => void pickAsset('image')}><ImagePlus size={16} /></button>
        <button title="Video" onClick={() => void pickAsset('video')}><Video size={16} /></button>
        <button title="Markdown" onClick={() => void pickAsset('markdown')}><FileText size={16} /></button>
        <span className="ready-board-toolbar-separator" />
        <button title="Text" onClick={() => addShape('text')}><Type size={16} /></button>
        <button title="Note" onClick={() => addShape('note')}><StickyNote size={16} /></button>
        <button title="Rectangle" onClick={() => addShape('rect')}><Square size={16} /></button>
        <button title="Arrow" onClick={() => addShape('arrow')}><ArrowRight size={16} /></button>
        <span className="ready-board-toolbar-separator" />
        <button title="Zoom out" onClick={() => setZoom(-0.12)}><ZoomOut size={16} /></button>
        <span className="ready-board-zoom">{Math.round(state.viewport.zoom * 100)}%</span>
        <button title="Zoom in" onClick={() => setZoom(0.12)}><ZoomIn size={16} /></button>
        <button
          className={snapEnabled ? 'is-active' : ''}
          title={snapEnabled ? '吸附对齐：开启' : '吸附对齐：关闭'}
          onClick={() => setSnapEnabled((enabled) => !enabled)}
        >
          <Magnet size={16} />
        </button>
        <span className="ready-board-toolbar-separator" />
        <button title="Save" onClick={() => void saveNow()}><Save size={16} /></button>
        <button
          title="Delete"
          disabled={!hasSelection}
          onClick={() => {
            if (!hasSelection) return
            patchState((current) => ({ ...current, nodes: current.nodes.filter((node) => !selectedIds.includes(node.id)) }))
            setSelectedIds([])
          }}
        >
          <Trash2 size={16} />
        </button>
        <span className={`ready-board-save-status ready-board-save-status--${saveStatus}`}>{saveStatusLabel(saveStatus)}</span>
      </div>
      {error && (
        <div className="ready-board-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <div
        ref={surfaceRef}
        className={`ready-board-surface ready-board-surface--${tool}`}
        onPointerDown={handleSurfacePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <div
          className="ready-board-stage"
          style={{
            transform: `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`,
          }}
        >
          {state.nodes.map(renderNode)}
          {marqueeRect && (
            <div
              className="ready-board-selection-rect"
              style={{
                left: marqueeRect.x,
                top: marqueeRect.y,
                width: marqueeRect.width,
                height: marqueeRect.height,
              }}
            />
          )}
          {snapGuides.map((guide) => (
            <div
              key={`${guide.axis}-${guide.value}`}
              className={`ready-board-snap-guide ready-board-snap-guide--${guide.axis}`}
              style={guide.axis === 'x' ? { left: guide.value } : { top: guide.value }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
