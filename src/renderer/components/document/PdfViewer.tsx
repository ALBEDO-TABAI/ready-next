import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import {
  ZoomIn,
  ZoomOut,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Loader2,
} from 'lucide-react'
import { type DocTab } from '../../stores/useDocTabs'

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300]

interface PdfViewerProps {
  tab: DocTab
  fileUrl: string
}

export default function PdfViewer({ tab, fileUrl }: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [currentPage, setCurrentPage] = useState(1)
  const [error, setError] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)

  // Stable file prop to avoid Document re-renders
  const fileOption = useMemo(() => ({ url: fileUrl }), [fileUrl])

  const onLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n)
    setError(null)
  }, [])

  const onLoadError = useCallback((err: Error) => {
    setError(err.message || 'PDF 加载失败')
  }, [])

  // Track visible page via IntersectionObserver
  useEffect(() => {
    if (numPages === 0) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        let topVisiblePage = Infinity
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.getAttribute('data-page'))
            if (pageNum < topVisiblePage) topVisiblePage = pageNum
          }
        }
        if (topVisiblePage !== Infinity) setCurrentPage(topVisiblePage)
      },
      {
        root: containerRef.current,
        rootMargin: '0px',
        threshold: 0.3,
      },
    )

    pageRefs.current.forEach((el) => observerRef.current?.observe(el))

    return () => observerRef.current?.disconnect()
  }, [numPages, zoom])

  const registerPageRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) pageRefs.current.set(pageNum, el)
    else pageRefs.current.delete(pageNum)
  }, [])

  // Zoom helpers
  const zoomIn = useCallback(() => {
    setZoom((z) => {
      const next = ZOOM_STEPS.find((s) => s > z)
      return next ?? Math.min(z + 25, 500)
    })
  }, [])

  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const prev = [...ZOOM_STEPS].reverse().find((s) => s < z)
      return prev ?? Math.max(z - 25, 25)
    })
  }, [])

  const fitToWidth = useCallback(() => {
    if (!containerRef.current) return
    // Default PDF page width is 612pt (~816px at 100%). Approximate fit.
    const containerWidth = containerRef.current.clientWidth - 48
    const pct = Math.round((containerWidth / 816) * 100)
    setZoom(Math.max(25, Math.min(500, pct)))
  }, [])

  // Scroll to page
  const goToPage = useCallback((page: number) => {
    const el = pageRefs.current.get(page)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const prevPage = useCallback(() => {
    if (currentPage > 1) goToPage(currentPage - 1)
  }, [currentPage, goToPage])

  const nextPage = useCallback(() => {
    if (currentPage < numPages) goToPage(currentPage + 1)
  }, [currentPage, numPages, goToPage])

  // Ctrl/Cmd + scroll to zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.deltaY > 0) zoomOut()
        else zoomIn()
      }
    },
    [zoomIn, zoomOut],
  )

  const scale = zoom / 100

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
        <p className="text-[13px]">PDF 加载失败: {error}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-3 border-b border-[var(--border-default)]"
        style={{ height: 34, background: 'var(--bg-toolbar)', flexShrink: 0 }}
      >
        {/* Navigation */}
        <button
          onClick={prevPage}
          disabled={currentPage <= 1}
          className="bg-transparent hover:bg-[var(--bg-hover)] disabled:opacity-30"
          style={{ width: 28, height: 28, borderRadius: 4, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: currentPage <= 1 ? 'not-allowed' : 'pointer' }}
          title="上一页"
        >
          <ChevronUp size={14} color="var(--text-muted)" />
        </button>

        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 48, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
          {numPages > 0 ? `${currentPage} / ${numPages}` : '...'}
        </span>

        <button
          onClick={nextPage}
          disabled={currentPage >= numPages}
          className="bg-transparent hover:bg-[var(--bg-hover)] disabled:opacity-30"
          style={{ width: 28, height: 28, borderRadius: 4, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: currentPage >= numPages ? 'not-allowed' : 'pointer' }}
          title="下一页"
        >
          <ChevronDown size={14} color="var(--text-muted)" />
        </button>

        {/* Separator */}
        <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />

        {/* Zoom */}
        <button
          onClick={zoomOut}
          className="bg-transparent hover:bg-[var(--bg-hover)]"
          style={{ width: 28, height: 28, borderRadius: 4, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          title="缩小"
        >
          <ZoomOut size={14} color="var(--text-muted)" />
        </button>

        <button
          onClick={() => setZoom(100)}
          className="bg-transparent hover:bg-[var(--bg-hover)]"
          style={{ height: 28, borderRadius: 4, border: 'none', padding: '0 4px', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit' }}
          title="重置缩放"
        >
          {zoom}%
        </button>

        <button
          onClick={zoomIn}
          className="bg-transparent hover:bg-[var(--bg-hover)]"
          style={{ width: 28, height: 28, borderRadius: 4, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          title="放大"
        >
          <ZoomIn size={14} color="var(--text-muted)" />
        </button>

        <button
          onClick={fitToWidth}
          className="bg-transparent hover:bg-[var(--bg-hover)]"
          style={{ width: 28, height: 28, borderRadius: 4, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          title="适应宽度"
        >
          <Maximize2 size={14} color="var(--text-muted)" />
        </button>

        {/* Separator */}
        <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 4px' }} />

        {/* File name */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{tab.title}</span>
        <span
          style={{
            fontSize: 9,
            color: 'var(--text-light)',
            background: 'var(--bg-hover)',
            borderRadius: 3,
            padding: '1px 5px',
            marginLeft: 6,
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          PDF
        </span>
      </div>

      {/* PDF content - continuous scroll */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto"
        style={{ background: '#525659' }}
        onWheel={handleWheel}
      >
        <Document
          file={fileOption}
          onLoadSuccess={onLoadSuccess}
          onLoadError={onLoadError}
          loading={
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: '#999' }} />
            </div>
          }
        >
          {Array.from({ length: numPages }, (_, i) => (
            <div
              key={i + 1}
              ref={(el) => registerPageRef(i + 1, el)}
              data-page={i + 1}
              style={{
                display: 'flex',
                justifyContent: 'center',
                padding: '12px 0',
              }}
            >
              <div style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
                <Page
                  pageNumber={i + 1}
                  scale={scale}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  loading={null}
                />
              </div>
            </div>
          ))}
        </Document>
      </div>
    </div>
  )
}
