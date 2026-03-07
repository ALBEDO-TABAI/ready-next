import { useState, useCallback, useRef, useEffect } from 'react'
import { Minus, Plus, Upload, RotateCw } from 'lucide-react'
import type { CanvasObject, ActiveTool, ShapeType } from './types'

// --- Handle types and constants ---

type HandlePosition = 'nw' | 'n' | 'ne' | 'w' | 'e' | 'sw' | 's' | 'se'

const HANDLE_SIZE = 8

const HANDLES: {
  pos: HandlePosition
  getXY: (w: number, h: number) => [number, number]
  cursor: string
}[] = [
  { pos: 'nw', getXY: () => [0, 0], cursor: 'nwse-resize' },
  { pos: 'n', getXY: (w) => [w / 2, 0], cursor: 'ns-resize' },
  { pos: 'ne', getXY: (w) => [w, 0], cursor: 'nesw-resize' },
  { pos: 'w', getXY: (_w, h) => [0, h / 2], cursor: 'ew-resize' },
  { pos: 'e', getXY: (w, h) => [w, h / 2], cursor: 'ew-resize' },
  { pos: 'sw', getXY: (_w, h) => [0, h], cursor: 'nesw-resize' },
  { pos: 's', getXY: (w, h) => [w / 2, h], cursor: 'ns-resize' },
  { pos: 'se', getXY: (w, h) => [w, h], cursor: 'nwse-resize' },
]

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp']

// --- Props ---

interface ImageCanvasProps {
  objects: CanvasObject[]
  selectedIds: string[]
  zoom: number
  activeTool: ActiveTool
  shapeType: ShapeType
  loadedImageUrl: string | null
  canvasWidth: number
  canvasHeight: number
  onZoomChange: (zoom: number) => void
  onObjectSelect: (id: string | null, addToSelection?: boolean) => void
  onObjectUpdate: (id: string, updates: Partial<CanvasObject>) => void
  onAddObject: (obj: CanvasObject) => void
  onToolChange: (tool: ActiveTool) => void
}

// --- Component ---

export default function ImageCanvas({
  objects,
  selectedIds,
  zoom,
  activeTool,
  shapeType,
  loadedImageUrl,
  canvasWidth,
  canvasHeight,
  onZoomChange,
  onObjectSelect,
  onObjectUpdate,
  onAddObject,
  onToolChange,
}: ImageCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const outerRef = useRef<HTMLDivElement>(null)
  const exportCanvasRef = useRef<HTMLCanvasElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const objectsRef = useRef(objects)
  objectsRef.current = objects

  const [drawPreview, setDrawPreview] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  const selectedObj = selectedIds.length === 1
    ? objects.find((o) => o.id === selectedIds[0]) ?? null
    : null

  // --- Cleanup on unmount ---
  useEffect(() => {
    return () => cleanupRef.current?.()
  }, [])

  // --- Cmd+Scroll zoom ---
  useEffect(() => {
    const el = outerRef.current
    if (!el) return
    const handleWheel = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        onZoomChange(Math.min(4, Math.max(0.25, zoom + delta)))
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [zoom, onZoomChange])

  // --- Cmd+0 reset zoom ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        onZoomChange(1)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onZoomChange])

  // --- Zoom buttons ---
  const handleZoomIn = useCallback(() => {
    onZoomChange(Math.min(4, zoom + 0.25))
  }, [zoom, onZoomChange])

  const handleZoomOut = useCallback(() => {
    onZoomChange(Math.max(0.25, zoom - 0.25))
  }, [zoom, onZoomChange])

  const handleZoomReset = useCallback(() => {
    onZoomChange(1)
  }, [onZoomChange])

  // --- Canvas export to PNG ---
  const handleExport = useCallback(() => {
    const canvas = exportCanvasRef.current
    if (!canvas) return

    canvas.width = canvasWidth
    canvas.height = canvasHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Clear
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)

    // Sort by zIndex
    const sorted = [...objectsRef.current]
      .filter((o) => o.visible)
      .sort((a, b) => a.zIndex - b.zIndex)

    // Track images to load
    const imagePromises: Promise<void>[] = []

    // First pass: draw non-image objects and queue image loads
    const imageElements = new Map<string, HTMLImageElement>()

    for (const obj of sorted) {
      if (obj.type === 'image') {
        const src = obj.imageSrc || (obj.id === 'loaded-image' ? loadedImageUrl : null)
        if (src) {
          const promise = new Promise<void>((resolve) => {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.onload = () => {
              imageElements.set(obj.id, img)
              resolve()
            }
            img.onerror = () => resolve()
            img.src = src
          })
          imagePromises.push(promise)
        }
      }
    }

    Promise.all(imagePromises).then(() => {
      // Render all objects in order
      for (const obj of sorted) {
        ctx.save()

        // Apply rotation
        if (obj.rotation) {
          const cx = obj.x + obj.width / 2
          const cy = obj.y + obj.height / 2
          ctx.translate(cx, cy)
          ctx.rotate((obj.rotation * Math.PI) / 180)
          ctx.translate(-cx, -cy)
        }

        // Apply opacity
        ctx.globalAlpha = obj.fillOpacity ?? 1

        switch (obj.type) {
          case 'rect':
            if (obj.fill) {
              ctx.fillStyle = obj.fill
              ctx.fillRect(obj.x, obj.y, obj.width, obj.height)
            }
            if (obj.strokeEnabled && obj.stroke) {
              ctx.strokeStyle = obj.stroke
              ctx.lineWidth = obj.strokeWidth || 1
              ctx.strokeRect(obj.x, obj.y, obj.width, obj.height)
            }
            break

          case 'ellipse': {
            const cx = obj.x + obj.width / 2
            const cy = obj.y + obj.height / 2
            const rx = obj.width / 2
            const ry = obj.height / 2
            ctx.beginPath()
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
            if (obj.fill) {
              ctx.fillStyle = obj.fill
              ctx.fill()
            }
            if (obj.strokeEnabled && obj.stroke) {
              ctx.strokeStyle = obj.stroke
              ctx.lineWidth = obj.strokeWidth || 1
              ctx.stroke()
            }
            break
          }

          case 'text':
            if (obj.text) {
              ctx.globalAlpha = 1
              const weight = obj.fontWeight
                ? obj.fontWeight
                : obj.fontSize && obj.fontSize > 24
                  ? '700'
                  : '400'
              const family = obj.fontFamily || 'Inter, Arial, sans-serif'
              ctx.font = `${weight} ${obj.fontSize || 16}px ${family}`
              ctx.fillStyle = obj.fill || '#333333'

              const align = obj.textAlign || 'left'
              ctx.textAlign = align
              ctx.textBaseline = 'top'

              let textX = obj.x
              if (align === 'center') textX = obj.x + obj.width / 2
              else if (align === 'right') textX = obj.x + obj.width

              // Simple text wrapping
              const lines = obj.text.split('\n')
              const lineHeight = (obj.fontSize || 16) * 1.4
              let ty = obj.y + (obj.height - lines.length * lineHeight) / 2
              if (ty < obj.y) ty = obj.y

              for (const line of lines) {
                ctx.fillText(line, textX, ty)
                ty += lineHeight
              }
            }
            break

          case 'image': {
            const imgEl = imageElements.get(obj.id)
            if (imgEl) {
              ctx.drawImage(imgEl, obj.x, obj.y, obj.width, obj.height)
            }
            break
          }
        }

        ctx.restore()
      }

      // Export
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `ready-export-${Date.now()}.png`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }, 'image/png')
    })
  }, [canvasWidth, canvasHeight, loadedImageUrl])

  // --- Drag-move an object ---
  const handleObjectMouseDown = useCallback(
    (e: React.MouseEvent, objId: string) => {
      if (activeTool !== 'select') return
      const obj = objects.find((o) => o.id === objId)
      if (!obj || obj.locked) return
      e.stopPropagation()
      e.preventDefault()

      const addToSelection = e.shiftKey
      onObjectSelect(objId, addToSelection)

      const startX = e.clientX
      const startY = e.clientY
      const curZoom = zoom

      // For multi-select moves, track all selected objects' starting positions
      const currentSelectedIds = addToSelection
        ? [...selectedIds, objId]
        : selectedIds.includes(objId)
          ? selectedIds
          : [objId]

      const startPositions = currentSelectedIds
        .map((id) => {
          const o = objects.find((ob) => ob.id === id)
          return o ? { id: o.id, x: o.x, y: o.y } : null
        })
        .filter((s): s is { id: string; x: number; y: number } => s !== null)

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / curZoom
        const dy = (ev.clientY - startY) / curZoom
        for (const sp of startPositions) {
          onObjectUpdate(sp.id, {
            x: Math.round(sp.x + dx),
            y: Math.round(sp.y + dy),
          })
        }
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        cleanupRef.current = null
      }

      cleanupRef.current = onUp
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [activeTool, objects, zoom, selectedIds, onObjectSelect, onObjectUpdate],
  )

  // --- Resize via handle ---
  const handleHandleMouseDown = useCallback(
    (e: React.MouseEvent, handle: HandlePosition) => {
      if (!selectedObj) return
      e.stopPropagation()
      e.preventDefault()

      const startX = e.clientX
      const startY = e.clientY
      const objStartX = selectedObj.x
      const objStartY = selectedObj.y
      const objStartW = selectedObj.width
      const objStartH = selectedObj.height
      const aspectRatio = objStartW / objStartH
      const curZoom = zoom
      const objId = selectedObj.id
      const isCorner = ['nw', 'ne', 'sw', 'se'].includes(handle)

      const onMove = (ev: MouseEvent) => {
        const dx = (ev.clientX - startX) / curZoom
        const dy = (ev.clientY - startY) / curZoom

        let newX = objStartX
        let newY = objStartY
        let newW = objStartW
        let newH = objStartH

        switch (handle) {
          case 'se':
            newW = objStartW + dx
            newH = isCorner ? newW / aspectRatio : objStartH + dy
            break
          case 'nw':
            newW = objStartW - dx
            newH = isCorner ? newW / aspectRatio : objStartH - dy
            newX = objStartX + objStartW - newW
            newY = objStartY + objStartH - newH
            break
          case 'ne':
            newW = objStartW + dx
            newH = isCorner ? newW / aspectRatio : objStartH - dy
            newY = objStartY + objStartH - newH
            break
          case 'sw':
            newW = objStartW - dx
            newH = isCorner ? newW / aspectRatio : objStartH + dy
            newX = objStartX + objStartW - newW
            break
          case 'n':
            newH = objStartH - dy
            newY = objStartY + dy
            break
          case 's':
            newH = objStartH + dy
            break
          case 'w':
            newW = objStartW - dx
            newX = objStartX + dx
            break
          case 'e':
            newW = objStartW + dx
            break
        }

        newW = Math.max(10, newW)
        newH = Math.max(10, newH)

        onObjectUpdate(objId, {
          x: Math.round(newX),
          y: Math.round(newY),
          width: Math.round(newW),
          height: Math.round(newH),
        })
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        cleanupRef.current = null
      }

      cleanupRef.current = onUp
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [selectedObj, zoom, onObjectUpdate],
  )

  // --- Pan tool mouse handling ---
  const handlePanMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsPanning(true)
      const startX = e.clientX
      const startY = e.clientY
      const startPanX = panOffset.x
      const startPanY = panOffset.y

      const onMove = (ev: MouseEvent) => {
        setPanOffset({
          x: startPanX + (ev.clientX - startX),
          y: startPanY + (ev.clientY - startY),
        })
      }

      const onUp = () => {
        setIsPanning(false)
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        cleanupRef.current = null
      }

      cleanupRef.current = onUp
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [panOffset],
  )

  // --- Canvas mousedown: deselect / draw shape / place text / pan ---
  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool === 'pan') {
        handlePanMouseDown(e)
        return
      }

      if (activeTool === 'select') {
        // For select tool, only deselect on direct canvas background click
        if (e.target !== canvasRef.current) return
        onObjectSelect(null)
        setEditingTextId(null)
        return
      }

      if (activeTool === 'text') {
        const rect = canvasRef.current!.getBoundingClientRect()
        const x = (e.clientX - rect.left) / zoom
        const y = (e.clientY - rect.top) / zoom
        const maxZ = Math.max(
          ...objectsRef.current.map((o) => o.zIndex),
          0,
        )
        const textCount =
          objectsRef.current.filter((o) => o.type === 'text').length + 1
        const newObj: CanvasObject = {
          id: `text-${Date.now()}`,
          type: 'text',
          name: `文本 ${textCount}`,
          x: Math.round(x),
          y: Math.round(y),
          width: 120,
          height: 30,
          text: 'Text',
          fontSize: 16,
          fontFamily: 'Inter',
          textAlign: 'left',
          fill: '#333333',
          fillOpacity: 1,
          visible: true,
          locked: false,
          zIndex: maxZ + 1,
        }
        onAddObject(newObj)
        onObjectSelect(newObj.id)
        onToolChange('select')
        return
      }

      if (activeTool === 'shape') {
        e.preventDefault()
        const rect = canvasRef.current!.getBoundingClientRect()
        const startX = (e.clientX - rect.left) / zoom
        const startY = (e.clientY - rect.top) / zoom
        const curZoom = zoom
        const currentShapeType = shapeType

        setDrawPreview({ x: startX, y: startY, w: 0, h: 0 })

        const onMove = (ev: MouseEvent) => {
          const curX = (ev.clientX - rect.left) / curZoom
          const curY = (ev.clientY - rect.top) / curZoom
          setDrawPreview({
            x: Math.min(startX, curX),
            y: Math.min(startY, curY),
            w: Math.abs(curX - startX),
            h: Math.abs(curY - startY),
          })
        }

        const onUp = (ev: MouseEvent) => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          cleanupRef.current = null

          const curX = (ev.clientX - rect.left) / curZoom
          const curY = (ev.clientY - rect.top) / curZoom
          const fx = Math.min(startX, curX)
          const fy = Math.min(startY, curY)
          const fw = Math.abs(curX - startX)
          const fh = Math.abs(curY - startY)

          setDrawPreview(null)

          if (fw > 5 && fh > 5) {
            const maxZ = Math.max(
              ...objectsRef.current.map((o) => o.zIndex),
              0,
            )
            const isEllipse = currentShapeType === 'ellipse'
            const typeCount =
              objectsRef.current.filter((o) => o.type === currentShapeType).length + 1
            const newObj: CanvasObject = {
              id: `${currentShapeType}-${Date.now()}`,
              type: currentShapeType,
              name: `${isEllipse ? '椭圆' : '矩形'} ${typeCount}`,
              x: Math.round(fx),
              y: Math.round(fy),
              width: Math.round(fw),
              height: Math.round(fh),
              fill: '#E5E5E5',
              fillOpacity: 1,
              stroke: '#333333',
              strokeWidth: 1,
              strokeEnabled: true,
              visible: true,
              locked: false,
              zIndex: maxZ + 1,
            }
            onAddObject(newObj)
            onObjectSelect(newObj.id)
          }
          onToolChange('select')
        }

        cleanupRef.current = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
        return
      }

      // Frame tool — draw a frame container (rect with layout capabilities)
      if (activeTool === 'frame') {
        e.preventDefault()
        const rect = canvasRef.current!.getBoundingClientRect()
        const startX = (e.clientX - rect.left) / zoom
        const startY = (e.clientY - rect.top) / zoom
        const curZoom = zoom

        setDrawPreview({ x: startX, y: startY, w: 0, h: 0 })

        const onMove = (ev: MouseEvent) => {
          const curX = (ev.clientX - rect.left) / curZoom
          const curY = (ev.clientY - rect.top) / curZoom
          setDrawPreview({
            x: Math.min(startX, curX),
            y: Math.min(startY, curY),
            w: Math.abs(curX - startX),
            h: Math.abs(curY - startY),
          })
        }

        const onUp = (ev: MouseEvent) => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          cleanupRef.current = null

          const curX = (ev.clientX - rect.left) / curZoom
          const curY = (ev.clientY - rect.top) / curZoom
          const fx = Math.min(startX, curX)
          const fy = Math.min(startY, curY)
          const fw = Math.abs(curX - startX)
          const fh = Math.abs(curY - startY)

          setDrawPreview(null)

          if (fw > 5 && fh > 5) {
            const maxZ = Math.max(
              ...objectsRef.current.map((o) => o.zIndex),
              0,
            )
            const frameCount =
              objectsRef.current.filter((o) => o.name.startsWith('Frame')).length + 1
            const newObj: CanvasObject = {
              id: `frame-${Date.now()}`,
              type: 'rect',
              name: `Frame ${frameCount}`,
              x: Math.round(fx),
              y: Math.round(fy),
              width: Math.round(fw),
              height: Math.round(fh),
              fill: '#FFFFFF',
              fillOpacity: 1,
              stroke: '#5B8DEF',
              strokeWidth: 1,
              strokeEnabled: true,
              cornerRadius: 0,
              visible: true,
              locked: false,
              zIndex: maxZ + 1,
              layoutDirection: 'vertical',
              layoutGap: 0,
              layoutPaddingH: 0,
              layoutPaddingV: 0,
              layoutAlign: 'start',
            }
            onAddObject(newObj)
            onObjectSelect(newObj.id)
          }
          onToolChange('select')
        }

        cleanupRef.current = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
        return
      }

      // Pen tool — click to place path points
      if (activeTool === 'pen') {
        const rect = canvasRef.current!.getBoundingClientRect()
        const px = Math.round((e.clientX - rect.left) / zoom)
        const py = Math.round((e.clientY - rect.top) / zoom)

        // Check if we're continuing an existing path (last selected object is a path being drawn)
        const lastSelected = selectedIds.length === 1
          ? objectsRef.current.find((o) => o.id === selectedIds[0])
          : null

        if (lastSelected && lastSelected.type === 'path' && lastSelected.pathPoints) {
          // Close path if clicking near starting point
          const first = lastSelected.pathPoints[0]
          if (first && Math.abs(px - first.x) < 8 && Math.abs(py - first.y) < 8 && lastSelected.pathPoints.length >= 3) {
            // Close the path — switch back to select
            onToolChange('select')
            return
          }
          // Add point to existing path
          const newPoints = [...lastSelected.pathPoints, { x: px, y: py }]
          const minX = Math.min(...newPoints.map((p) => p.x))
          const minY = Math.min(...newPoints.map((p) => p.y))
          const maxX = Math.max(...newPoints.map((p) => p.x))
          const maxY = Math.max(...newPoints.map((p) => p.y))
          onObjectUpdate(lastSelected.id, {
            pathPoints: newPoints,
            x: minX, y: minY,
            width: Math.max(maxX - minX, 1),
            height: Math.max(maxY - minY, 1),
          })
        } else {
          // Start new path
          const maxZ = Math.max(
            ...objectsRef.current.map((o) => o.zIndex),
            0,
          )
          const pathCount =
            objectsRef.current.filter((o) => o.type === 'path').length + 1
          const newObj: CanvasObject = {
            id: `path-${Date.now()}`,
            type: 'path',
            name: `路径 ${pathCount}`,
            x: px, y: py,
            width: 1, height: 1,
            pathPoints: [{ x: px, y: py }],
            stroke: '#333333',
            strokeWidth: 2,
            strokeEnabled: true,
            fill: 'transparent',
            fillOpacity: 1,
            visible: true,
            locked: false,
            zIndex: maxZ + 1,
          }
          onAddObject(newObj)
          onObjectSelect(newObj.id)
        }
        return
      }
    },
    [activeTool, shapeType, zoom, selectedIds, onObjectSelect, onObjectUpdate, onAddObject, onToolChange, handlePanMouseDown],
  )

  // --- Double-click for inline text editing ---
  const handleObjectDoubleClick = useCallback(
    (e: React.MouseEvent, objId: string) => {
      e.stopPropagation()
      const obj = objects.find((o) => o.id === objId)
      if (!obj || obj.type !== 'text' || obj.locked) return
      setEditingTextId(objId)
    },
    [objects],
  )

  // --- Inline text commit ---
  const handleTextEditCommit = useCallback(
    (objId: string, newText: string) => {
      onObjectUpdate(objId, { text: newText })
      setEditingTextId(null)
    },
    [onObjectUpdate],
  )

  // --- Image drop handler ---
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return

      const dropX = (e.clientX - rect.left) / zoom
      const dropY = (e.clientY - rect.top) / zoom

      // Try text/plain first (sidebar file tree drag)
      const filePath = e.dataTransfer.getData('text/plain')
      if (filePath && filePath.startsWith('/')) {
        const ext = filePath.split('.').pop()?.toLowerCase() || ''
        if (IMAGE_EXTS.includes(ext)) {
          createImageObject(
            filePath,
            `local-file://${filePath}`,
            dropX,
            dropY,
          )
          return
        }
      }

      // Try native file drop (from Finder)
      const files = e.dataTransfer.files
      if (files.length > 0) {
        const file = files[0]
        const ext = file.name.split('.').pop()?.toLowerCase() || ''
        if (IMAGE_EXTS.includes(ext)) {
          // Electron adds .path to File objects
          const nativePath = (file as File & { path?: string }).path
          if (nativePath) {
            createImageObject(
              nativePath,
              `local-file://${nativePath}`,
              dropX,
              dropY,
            )
          } else {
            // Fallback: use object URL for web preview
            const objUrl = URL.createObjectURL(file)
            createImageObject(file.name, objUrl, dropX, dropY)
          }
        }
      }
    },
    [zoom], // eslint-disable-line react-hooks/exhaustive-deps -- createImageObject is stable via objectsRef
  )

  const createImageObject = useCallback(
    (name: string, src: string, dropX: number, dropY: number) => {
      const defaultW = 200
      const defaultH = 200
      const maxZ = Math.max(
        ...objectsRef.current.map((o) => o.zIndex),
        0,
      )
      const fileName = name.includes('/') ? name.split('/').pop()! : name
      const newObj: CanvasObject = {
        id: `img-${Date.now()}`,
        type: 'image',
        name: fileName,
        x: Math.round(dropX - defaultW / 2),
        y: Math.round(dropY - defaultH / 2),
        width: defaultW,
        height: defaultH,
        imageSrc: src,
        visible: true,
        locked: false,
        zIndex: maxZ + 1,
      }

      // Try to get actual image dimensions
      const img = new Image()
      img.onload = () => {
        const maxW = 400
        const maxH = 400
        const scale = Math.min(
          maxW / img.naturalWidth,
          maxH / img.naturalHeight,
          1,
        )
        const w = Math.round(img.naturalWidth * scale)
        const h = Math.round(img.naturalHeight * scale)
        onObjectUpdate(newObj.id, {
          width: w,
          height: h,
          x: Math.round(dropX - w / 2),
          y: Math.round(dropY - h / 2),
        })
      }
      img.src = src

      onAddObject(newObj)
      onObjectSelect(newObj.id)
    },
    [onAddObject, onObjectSelect, onObjectUpdate],
  )

  // --- Rotation handle drag ---
  const handleRotateMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!selectedObj) return
      e.stopPropagation()
      e.preventDefault()

      const objCenterX = selectedObj.x + selectedObj.width / 2
      const objCenterY = selectedObj.y + selectedObj.height / 2
      const canvasRect = canvasRef.current!.getBoundingClientRect()
      const curZoom = zoom
      const objId = selectedObj.id

      const onMove = (ev: MouseEvent) => {
        const mouseX = (ev.clientX - canvasRect.left) / curZoom
        const mouseY = (ev.clientY - canvasRect.top) / curZoom
        const angle = Math.atan2(mouseY - objCenterY, mouseX - objCenterX) * (180 / Math.PI) + 90
        onObjectUpdate(objId, { rotation: Math.round(angle) })
      }

      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        cleanupRef.current = null
      }

      cleanupRef.current = onUp
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [selectedObj, zoom, onObjectUpdate],
  )

  // --- Cursor for canvas based on active tool ---
  const canvasCursor =
    activeTool === 'shape' || activeTool === 'frame'
      ? 'crosshair'
      : activeTool === 'text'
        ? 'text'
        : activeTool === 'pen'
          ? 'crosshair'
          : activeTool === 'pan'
            ? isPanning ? 'grabbing' : 'grab'
            : 'default'

  // --- Sorted objects by zIndex ---
  const sortedObjects = [...objects]
    .filter((o) => o.visible)
    .sort((a, b) => a.zIndex - b.zIndex)

  // Grid style removed — V5 design has no grid toggle

  return (
    <div
      ref={outerRef}
      className="flex-1 relative overflow-auto"
      style={{ background: '#F0EFED' }}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Hidden canvas for export */}
      <canvas
        ref={exportCanvasRef}
        style={{ display: 'none' }}
      />

      {/* Zoomable canvas area */}
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          minWidth: '100%',
          minHeight: '100%',
          transform: `scale(${zoom}) translate(${panOffset.x / zoom}px, ${panOffset.y / zoom}px)`,
          transformOrigin: 'center center',
        }}
      >
        {/* Canvas Container */}
        <div
          ref={canvasRef}
          className="relative bg-[var(--bg-primary)] shadow-xl rounded-sm"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            cursor: canvasCursor,
          }}
          onMouseDown={handleCanvasMouseDown}
        >
          {/* Render objects */}
          {sortedObjects.map((obj) => {
            const isEditing = editingTextId === obj.id
            const isSelected = selectedIds.includes(obj.id)

            // Ellipse uses borderRadius: 50%
            const borderRadius = obj.type === 'ellipse' ? '50%' : undefined

            return (
              <div
                key={obj.id}
                onMouseDown={(e) => handleObjectMouseDown(e, obj.id)}
                onDoubleClick={(e) => handleObjectDoubleClick(e, obj.id)}
                className={`absolute ${
                  obj.locked ? 'cursor-default' : 'cursor-pointer'
                }`}
                style={{
                  left: obj.x,
                  top: obj.y,
                  width: obj.width,
                  height: obj.height,
                  background:
                    obj.type === 'text' || obj.type === 'path' ? 'transparent' : obj.fill,
                  opacity: obj.fillOpacity ?? 1,
                  border: obj.strokeEnabled
                    ? `${obj.strokeWidth || 1}px solid ${obj.stroke || '#000'}`
                    : undefined,
                  borderRadius,
                  fontSize: obj.fontSize,
                  fontWeight: obj.fontWeight
                    ? obj.fontWeight
                    : obj.fontSize && obj.fontSize > 24
                      ? 700
                      : 400,
                  fontFamily: obj.fontFamily || undefined,
                  textAlign: obj.textAlign || undefined,
                  display: 'flex',
                  alignItems: obj.type === 'text' ? 'center' : undefined,
                  justifyContent: obj.type === 'text'
                    ? obj.textAlign === 'center' ? 'center'
                      : obj.textAlign === 'right' ? 'flex-end'
                      : 'flex-start'
                    : undefined,
                  zIndex: obj.zIndex,
                  pointerEvents: isEditing || activeTool !== 'select' ? 'none' : 'auto',
                  transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
                  transformOrigin: obj.rotation ? 'center center' : undefined,
                  // Subtle selection highlight for multi-select
                  outline: isSelected && selectedIds.length > 1 ? '2px solid rgba(59, 130, 246, 0.4)' : undefined,
                }}
              >
                {/* Text content */}
                {obj.type === 'text' && !isEditing && (
                  <span style={{ color: obj.fill }}>{obj.text}</span>
                )}

                {/* Image content - general imageSrc */}
                {obj.type === 'image' &&
                  (obj.imageSrc ||
                    (obj.id === 'loaded-image' && loadedImageUrl)) && (
                    <img
                      src={
                        obj.imageSrc ||
                        loadedImageUrl ||
                        ''
                      }
                      alt={obj.name}
                      className="w-full h-full object-contain pointer-events-none"
                      draggable={false}
                    />
                  )}

                {/* Path rendering */}
                {obj.type === 'path' && obj.pathPoints && obj.pathPoints.length > 0 && (
                  <svg
                    className="absolute inset-0 w-full h-full pointer-events-none"
                    viewBox={`${obj.x} ${obj.y} ${obj.width} ${obj.height}`}
                    preserveAspectRatio="none"
                  >
                    <polyline
                      points={obj.pathPoints.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill={obj.fill && obj.fill !== 'transparent' ? obj.fill : 'none'}
                      stroke={obj.stroke || '#333333'}
                      strokeWidth={obj.strokeWidth || 2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </svg>
                )}

                {/* Image placeholder for loaded-image without URL */}
                {obj.type === 'image' &&
                  !obj.imageSrc &&
                  obj.id === 'loaded-image' &&
                  !loadedImageUrl && (
                    <div className="w-full h-full flex items-center justify-center bg-[var(--bg-canvas)] text-[var(--text-light)]">
                      <div className="text-center">
                        <Upload className="w-8 h-8 mx-auto mb-2 opacity-50" />
                        <p className="text-[11px]">
                          浏览器预览模式
                        </p>
                      </div>
                    </div>
                  )}
              </div>
            )
          })}

          {/* Selection overlay with handles (single selection) */}
          {selectedObj &&
            selectedObj.visible &&
            !editingTextId && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: selectedObj.x,
                  top: selectedObj.y,
                  width: selectedObj.width,
                  height: selectedObj.height,
                  zIndex: 9999,
                  transform: selectedObj.rotation ? `rotate(${selectedObj.rotation}deg)` : undefined,
                  transformOrigin: selectedObj.rotation ? 'center center' : undefined,
                  borderRadius: selectedObj.type === 'ellipse' ? '50%' : undefined,
                }}
              >
                {/* Selection border - blue dashed */}
                <div
                  className="absolute inset-0"
                  style={{
                    border: '2px dashed #3B82F6',
                    borderRadius: selectedObj.type === 'ellipse' ? '50%' : undefined,
                  }}
                />

                {/* Rotation handle */}
                {!selectedObj.locked && (
                  <>
                    {/* Line from top center to rotation handle */}
                    <div
                      className="absolute"
                      style={{
                        left: selectedObj.width / 2,
                        top: -24,
                        width: 1,
                        height: 24,
                        background: '#3B82F6',
                        pointerEvents: 'none',
                      }}
                    />
                    {/* Rotation circle handle */}
                    <div
                      className="absolute pointer-events-auto"
                      style={{
                        left: selectedObj.width / 2 - 6,
                        top: -36,
                        width: 12,
                        height: 12,
                        background: '#FFFFFF',
                        border: '2px solid #3B82F6',
                        borderRadius: '50%',
                        cursor: 'grab',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onMouseDown={handleRotateMouseDown}
                      title="旋转"
                    >
                      <RotateCw style={{ width: 7, height: 7, color: '#3B82F6' }} />
                    </div>
                  </>
                )}

                {/* 8 resize handles */}
                {!selectedObj.locked &&
                  HANDLES.map((h) => {
                    const [hx, hy] = h.getXY(
                      selectedObj.width,
                      selectedObj.height,
                    )
                    return (
                      <div
                        key={h.pos}
                        className="absolute pointer-events-auto"
                        style={{
                          left: hx - HANDLE_SIZE / 2,
                          top: hy - HANDLE_SIZE / 2,
                          width: HANDLE_SIZE,
                          height: HANDLE_SIZE,
                          background: '#FFFFFF',
                          border: '2px solid #3B82F6',
                          borderRadius: 1,
                          cursor: h.cursor,
                        }}
                        onMouseDown={(e) =>
                          handleHandleMouseDown(e, h.pos)
                        }
                      />
                    )
                  })}
              </div>
            )}

          {/* Draw preview rectangle / ellipse */}
          {drawPreview && (
            <div
              className="absolute pointer-events-none"
              style={{
                left: drawPreview.x,
                top: drawPreview.y,
                width: drawPreview.w,
                height: drawPreview.h,
                border: '2px dashed #60A5FA',
                background: 'rgba(96, 165, 250, 0.08)',
                borderRadius: shapeType === 'ellipse' ? '50%' : undefined,
                zIndex: 9998,
              }}
            />
          )}

          {/* Inline text editor overlay */}
          {editingTextId && (() => {
            const editObj = objects.find((o) => o.id === editingTextId)
            if (!editObj) return null
            return (
              <InlineTextEditor
                key={editObj.id}
                obj={editObj}
                onCommit={(text) => handleTextEditCommit(editObj.id, text)}
                onCancel={() => setEditingTextId(null)}
              />
            )
          })()}
        </div>
      </div>

      {/* Zoom Controls */}
      <div className="absolute bottom-4 left-4 flex items-center gap-1 bg-white/90 backdrop-blur rounded-lg shadow-md border border-[var(--border-default)] px-2 py-1">
        <button
          onClick={handleZoomOut}
          className="p-1 hover:bg-black/5 rounded"
        >
          <Minus className="w-3 h-3" />
        </button>
        <button
          onClick={handleZoomReset}
          className="text-[11px] w-12 text-center hover:bg-black/5 rounded px-1 py-0.5"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          onClick={handleZoomIn}
          className="p-1 hover:bg-black/5 rounded"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {/* Export button removed — now in right inspector panel */}
    </div>
  )
}

// --- Inline Text Editor sub-component ---

function InlineTextEditor({
  obj,
  onCommit,
  onCancel,
}: {
  obj: CanvasObject
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(obj.text || '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.focus()
      ta.select()
    }
  }, [])

  const handleBlur = () => {
    onCommit(value)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onCommit(value)
    }
  }

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className="absolute resize-none outline-none border-2 border-[#3B82F6] bg-white/90 p-0 m-0"
      style={{
        left: obj.x,
        top: obj.y,
        width: obj.width,
        height: obj.height,
        fontSize: obj.fontSize || 16,
        fontWeight: obj.fontWeight
          ? obj.fontWeight
          : obj.fontSize && obj.fontSize > 24
            ? 700
            : 400,
        fontFamily: obj.fontFamily || 'Inter, Arial, sans-serif',
        textAlign: obj.textAlign || 'left',
        color: obj.fill || '#333',
        lineHeight: 1.4,
        zIndex: 10000,
        transform: obj.rotation ? `rotate(${obj.rotation}deg)` : undefined,
        transformOrigin: obj.rotation ? 'center center' : undefined,
      }}
    />
  )
}
