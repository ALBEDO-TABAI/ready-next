import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import PhotoSwipe from 'photoswipe'
import 'photoswipe/dist/photoswipe.css'
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Shrink,
  RotateCcw,
  RotateCw,
  Images,
} from 'lucide-react'
import { type DocTab, useDocTabs } from '../../stores/useDocTabs'
import {
  createImageGalleryRequestGate,
  getImageGalleryDirectory,
  loadImageGalleryDirectory,
  subscribeImageGalleryDirectory,
  type ImageGallerySibling,
} from '../../modules/document/imageGalleryDirectoryCache'

const TRANSPARENT_EXTS = ['png', 'webp', 'svg', 'gif']

const tbBtnBase: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 4,
  border: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
}

interface ImageGalleryProps {
  tab: DocTab
  fileUrl: string
  currentExt: string
}

export default function ImageGallery({ tab, fileUrl, currentExt }: ImageGalleryProps) {
  const setTabPath = useDocTabs((state) => state.setTabPath)
  const [zoom, setZoom] = useState(100)
  const [rotation, setRotation] = useState(0)
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [siblings, setSiblings] = useState<ImageGallerySibling[]>([])

  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const lightboxRef = useRef<PhotoSwipeLightbox | null>(null)
  const directoryRequestGateRef = useRef(createImageGalleryRequestGate())

  const isTransparent = TRANSPARENT_EXTS.includes(currentExt)
  const currentIndex = useMemo(() => siblings.findIndex((s) => s.path === tab.path), [siblings, tab.path])

  const directory = useMemo(() => tab.path ? getImageGalleryDirectory(tab.path) : '', [tab.path])

  // Load sibling images once per directory and refresh only when that directory changes.
  useEffect(() => {
    const directoryRequestGate = directoryRequestGateRef.current
    if (!directory || typeof window === 'undefined' || !window.electronAPI) return undefined
    let cancelled = false
    const load = () => {
      const generation = directoryRequestGateRef.current.begin()
      void loadImageGalleryDirectory(directory, (path) => window.electronAPI.document.listFiles(path))
        .then((items) => {
          if (!cancelled && directoryRequestGateRef.current.isCurrent(generation)) setSiblings(items)
        })
        .catch(() => {
          if (!cancelled && directoryRequestGateRef.current.isCurrent(generation)) setSiblings([])
        })
    }
    const unsubscribe = subscribeImageGalleryDirectory(directory, load)
    load()
    return () => {
      cancelled = true
      directoryRequestGate.invalidate()
      unsubscribe()
    }
  }, [directory])

  // Init PhotoSwipe lightbox
  useEffect(() => {
    const lightbox = new PhotoSwipeLightbox({
      pswpModule: PhotoSwipe,
      zoom: true,
      close: true,
      counter: true,
      arrowPrev: true,
      arrowNext: true,
      wheelToZoom: true,
      bgOpacity: 0.92,
      loop: true,
      showHideAnimationType: 'fade',
      indexIndicatorSep: ' / ',
      initialZoomLevel: 'fit',
      secondaryZoomLevel: 2,
      maxZoomLevel: 6,
    })

    lightbox.init()
    lightboxRef.current = lightbox

    return () => {
      lightbox.destroy()
      lightboxRef.current = null
    }
  }, [])

  // Open gallery at current image
  const openGallery = useCallback(() => {
    if (!lightboxRef.current || siblings.length === 0) return
    lightboxRef.current.loadAndOpen(Math.max(0, currentIndex), siblings)
  }, [currentIndex, siblings])

  const openSibling = useCallback((delta: number) => {
    if (siblings.length <= 1) return
    const baseIndex = currentIndex >= 0 ? currentIndex : 0
    const nextIndex = (baseIndex + delta + siblings.length) % siblings.length
    const next = siblings[nextIndex]
    if (next?.path && next.path !== tab.path) {
      setTabPath(tab.id, next.path)
    }
  }, [currentIndex, setTabPath, siblings, tab.id, tab.path])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    openSibling(e.key === 'ArrowRight' ? 1 : -1)
  }, [openSibling])

  useEffect(() => {
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const surface = containerRef.current
      if (!surface) return
      const rect = surface.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0 || surface.closest('[aria-hidden="true"], [inert]')) {
        return
      }
      const target = e.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      e.preventDefault()
      openSibling(e.key === 'ArrowRight' ? 1 : -1)
    }

    window.addEventListener('keydown', handleWindowKeyDown)
    return () => window.removeEventListener('keydown', handleWindowKeyDown)
  }, [openSibling])

  useEffect(() => {
    setPanOffset({ x: 0, y: 0 })
  }, [zoom])

  useEffect(() => {
    setZoom(100)
    setRotation(0)
    setImageDims(null)
    setPanOffset({ x: 0, y: 0 })
    containerRef.current?.focus({ preventScroll: true })
  }, [tab.path])

  // Ctrl/Cmd + scroll wheel to zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      const step = e.deltaY > 0 ? -10 : 10
      setZoom((z) => Math.max(10, Math.min(800, z + step)))
    }
  }, [])

  const fitToWidth = useCallback(() => {
    if (!containerRef.current || !imageDims) return
    const cw = containerRef.current.clientWidth - 48
    setZoom(Math.max(10, Math.min(800, Math.round((cw / imageDims.w) * 100))))
  }, [imageDims])

  const fitToScreen = useCallback(() => {
    if (!containerRef.current || !imageDims) return
    const cw = containerRef.current.clientWidth - 48
    const ch = containerRef.current.clientHeight - 48
    const pct = Math.round(Math.min(cw / imageDims.w, ch / imageDims.h) * 100)
    setZoom(Math.max(10, Math.min(800, pct)))
  }, [imageDims])

  // Drag-to-pan
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return
      setIsDragging(true)
      dragStart.current = { x: e.clientX, y: e.clientY, ox: panOffset.x, oy: panOffset.y }
    },
    [panOffset],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return
      setPanOffset({
        x: dragStart.current.ox + (e.clientX - dragStart.current.x),
        y: dragStart.current.oy + (e.clientY - dragStart.current.y),
      })
    },
    [isDragging],
  )

  const handleMouseUp = useCallback(() => setIsDragging(false), [])

  useEffect(() => {
    if (!isDragging) return
    const up = () => setIsDragging(false)
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [isDragging])

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setImageDims({ w: img.naturalWidth, h: img.naturalHeight })
  }, [])

  const checkerboardStyle: React.CSSProperties = isTransparent
    ? {
        // The checkerboard that shows transparency, drawn in the paper and fill tokens.
        backgroundColor: 'var(--rn-sheet)',
        backgroundImage: [
          'linear-gradient(45deg, var(--rn-fill-2) 25%, transparent 25%, transparent 75%, var(--rn-fill-2) 75%)',
          'linear-gradient(45deg, var(--rn-fill-2) 25%, transparent 25%, transparent 75%, var(--rn-fill-2) 75%)',
        ].join(', '),
        backgroundSize: '20px 20px',
        backgroundPosition: '0 0, 10px 10px',
      }
    : {}

  const needsPan = zoom > 100

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg-content)' }}>
        {/* Toolbar */}
        <div
          className="flex items-center gap-1 px-3 border-b border-[var(--border-default)]"
          style={{ height: 34, background: 'var(--bg-toolbar)', flexShrink: 0 }}
        >
          {/* Zoom out */}
          <button
            onClick={() => setZoom((z) => Math.max(10, z - 10))}
            style={tbBtnBase}
            className="bg-transparent hover:bg-[var(--bg-hover)]"
            title="缩小"
          >
            <ZoomOut size={14} color="var(--text-muted)" />
          </button>

          {/* Zoom percentage */}
          <button
            onClick={() => setZoom(100)}
            style={{ ...tbBtnBase, width: 'auto', padding: '0 4px', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'inherit' }}
            className="bg-transparent hover:bg-[var(--bg-hover)]"
            title="重置 100%"
          >
            {zoom}%
          </button>

          {/* Zoom in */}
          <button
            onClick={() => setZoom((z) => Math.min(800, z + 10))}
            style={tbBtnBase}
            className="bg-transparent hover:bg-[var(--bg-hover)]"
            title="放大"
          >
            <ZoomIn size={14} color="var(--text-muted)" />
          </button>

          <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />

          {/* Fit to width */}
          <button onClick={fitToWidth} style={tbBtnBase} className="bg-transparent hover:bg-[var(--bg-hover)]" title="适应宽度">
            <Maximize2 size={14} color="var(--text-muted)" />
          </button>

          {/* Fit to screen */}
          <button onClick={fitToScreen} style={tbBtnBase} className="bg-transparent hover:bg-[var(--bg-hover)]" title="适应屏幕">
            <Shrink size={14} color="var(--text-muted)" />
          </button>

          {/* 1:1 */}
          <button
            onClick={() => setZoom(100)}
            style={{ ...tbBtnBase, width: 'auto', padding: '0 6px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, fontFamily: 'inherit' }}
            className="bg-transparent hover:bg-[var(--bg-hover)]"
            title="原始尺寸"
          >
            1:1
          </button>

          <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />

          {/* Rotate */}
          <button onClick={() => setRotation((r) => r - 90)} style={tbBtnBase} className="bg-transparent hover:bg-[var(--bg-hover)]" title="左旋转">
            <RotateCcw size={14} color="var(--text-muted)" />
          </button>
          <button onClick={() => setRotation((r) => r + 90)} style={tbBtnBase} className="bg-transparent hover:bg-[var(--bg-hover)]" title="右旋转">
            <RotateCw size={14} color="var(--text-muted)" />
          </button>

          <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />

          {/* Gallery button */}
          <button
            onClick={openGallery}
            disabled={siblings.length === 0}
            style={{ ...tbBtnBase, width: 'auto', padding: '0 8px', gap: 4, display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', fontFamily: 'inherit' }}
            className="bg-transparent hover:bg-[var(--bg-hover)] disabled:opacity-30"
            title="浏览同目录图片"
          >
            <Images size={14} color="var(--text-muted)" />
            {siblings.length > 0 && <span>{siblings.length}</span>}
          </button>

          <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />

          {/* File info */}
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 2 }}>{tab.title}</span>
          {imageDims && (
            <span style={{ fontSize: 10, color: 'var(--text-light)', marginLeft: 6 }}>
              {imageDims.w} &times; {imageDims.h}
            </span>
          )}
          <span
            style={{
              fontSize: 9,
              color: 'var(--text-light)',
              background: 'var(--bg-hover)',
              borderRadius: 4,
              padding: '1px 5px',
              marginLeft: 6,
              textTransform: 'uppercase',
              fontWeight: 500,
            }}
          >
            {currentExt}
          </span>
        </div>

        {/* Image container */}
        <div
          ref={containerRef}
          className="panel-hover-scrollbar flex-1 flex items-center justify-center overflow-auto"
          data-ready-image-gallery="surface"
          tabIndex={0}
          style={{
            padding: 24,
            outline: 'none',
            cursor: needsPan ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
          onKeyDown={handleKeyDown}
          onWheel={handleWheel}
          onMouseDown={needsPan ? handleMouseDown : undefined}
          onMouseMove={needsPan ? handleMouseMove : undefined}
          onMouseUp={needsPan ? handleMouseUp : undefined}
          onDoubleClick={openGallery}
        >
          <div
            style={{
              ...checkerboardStyle,
              borderRadius: 4,
              border: '1px solid var(--border-default)',
              lineHeight: 0,
            }}
          >
            <img
              src={fileUrl}
              alt={tab.title}
              onLoad={handleImageLoad}
              draggable={false}
              style={{
                display: 'block',
                maxWidth: zoom <= 100 ? '100%' : 'none',
                maxHeight: zoom <= 100 ? '100%' : 'none',
                width: zoom !== 100 && imageDims ? `${imageDims.w * (zoom / 100)}px` : undefined,
                height: zoom !== 100 && imageDims ? `${imageDims.h * (zoom / 100)}px` : undefined,
                objectFit: 'contain',
                borderRadius: 4,
                transform: `translate(${panOffset.x}px, ${panOffset.y}px) rotate(${rotation}deg)`,
                userSelect: 'none',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
