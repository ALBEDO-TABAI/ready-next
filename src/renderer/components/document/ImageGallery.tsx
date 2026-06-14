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
import { type DocTab } from '../../stores/useDocTabs'
import { toLocalFileUrl } from '../../utils/dragDrop'

const TRANSPARENT_EXTS = ['png', 'webp', 'svg', 'gif']
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico']

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

interface SiblingImage {
  src: string
  width: number
  height: number
  alt: string
  path: string
}

interface ImageGalleryProps {
  tab: DocTab
  fileUrl: string
  currentExt: string
}

export default function ImageGallery({ tab, fileUrl, currentExt }: ImageGalleryProps) {
  const [zoom, setZoom] = useState(100)
  const [rotation, setRotation] = useState(0)
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null)
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [siblings, setSiblings] = useState<SiblingImage[]>([])

  const dragStart = useRef({ x: 0, y: 0, ox: 0, oy: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const lightboxRef = useRef<PhotoSwipeLightbox | null>(null)

  const isTransparent = TRANSPARENT_EXTS.includes(currentExt)

  // Load sibling images from same directory
  useEffect(() => {
    if (!tab.path) return
    const dir = tab.path.substring(0, tab.path.lastIndexOf('/'))
    if (!dir || typeof window === 'undefined' || !window.electronAPI) return

    // fire-and-forget: sibling-image discovery for the gallery; if it fails the gallery just renders the current image with no peers (graceful degradation).
    window.electronAPI.document.listFiles(dir).then((result) => {
      if (!result.success || !result.items) return
      const imageFiles = result.items
        .filter((f) => !f.isDirectory && IMAGE_EXTS.includes(f.name.split('.').pop()?.toLowerCase() || ''))
        .map((f) => ({
          src: toLocalFileUrl(f.path),
          width: 1920, // PhotoSwipe needs dimensions; will be updated on load
          height: 1080,
          alt: f.name,
          path: f.path,
        }))
      setSiblings(imageFiles)
    }).catch(() => { /* ignore */ })
  }, [tab.path])

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
    const currentIdx = siblings.findIndex((s) => s.path === tab.path)
    lightboxRef.current.loadAndOpen(Math.max(0, currentIdx), siblings)
  }, [siblings, tab.path])

  // Reset pan when zoom changes
  useEffect(() => {
    setPanOffset({ x: 0, y: 0 })
  }, [zoom])

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
        backgroundColor: '#FFFFFF',
        backgroundImage: [
          'linear-gradient(45deg, #E8E8E8 25%, transparent 25%, transparent 75%, #E8E8E8 75%)',
          'linear-gradient(45deg, #E8E8E8 25%, transparent 25%, transparent 75%, #E8E8E8 75%)',
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
          style={{
            padding: 24,
            cursor: needsPan ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
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
