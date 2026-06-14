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
import {
  loadDocumentReadingPosition,
  saveDocumentReadingPosition,
} from '../../modules/document/documentScrollAnchor'

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

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

function normalizePdfBytes(value: unknown): Uint8Array | null {
  if (!value) return null
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value)) return new Uint8Array(value)
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'data' in value &&
    value.type === 'Buffer' &&
    Array.isArray(value.data)
  ) {
    return new Uint8Array(value.data)
  }
  return null
}

export default function PdfViewer({ tab, fileUrl }: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [currentPage, setCurrentPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const saveScrollTimerRef = useRef<number | null>(null)
  const restoredScrollKeyRef = useRef<string | null>(null)
  const documentScrollKey = useMemo(() => tab.path || tab.id, [tab.id, tab.path])

  // Load PDF data via IPC
  useEffect(() => {
    if (!tab.path) {
      setPdfData(null)
      setPdfUrl(null)
      setError('No file path provided')
      return
    }

    let cancelled = false
    setNumPages(0)
    setCurrentPage(1)
    setPdfData(null)
    setPdfUrl(null)
    setError(null)
    pageRefs.current.clear()
    restoredScrollKeyRef.current = null

    const loadPdf = async () => {
      try {
        const filePath = tab.path
        if (!filePath) {
          setError('No file path provided')
          return
        }

        console.log('[PdfViewer] Loading PDF from path:', filePath)

        // Read via IPC so renderer does not depend on custom-scheme fetch behavior.
        const result = await window.electronAPI.document.readFile(filePath)

        if (!result.success) {
          throw new Error(result.error || 'Failed to read file')
        }

        const binaryData = result.data?.type === 'binary' ? result.data : null
        const ipcBytes = normalizePdfBytes(binaryData?.bytes)

        if (!cancelled && binaryData?.category === 'pdf' && ipcBytes && ipcBytes.length > 0) {
          console.log('[PdfViewer] Loaded PDF bytes from IPC:', ipcBytes.length)
          setPdfData(ipcBytes)
          setError(null)
          return
        }

        if (!cancelled && binaryData?.category === 'pdf' && binaryData.localUrl) {
          console.log('[PdfViewer] Falling back to local-file URL:', binaryData.localUrl)
          setPdfUrl(binaryData.localUrl)
          setError(null)
          return
        }

        if (!cancelled && result.content) {
          const bytes = decodeBase64ToBytes(result.content)
          console.log('[PdfViewer] Loaded legacy base64 PDF bytes:', bytes.length)
          setPdfData(bytes)
          setError(null)
          return
        }

        if (!cancelled && fileUrl) {
          console.log('[PdfViewer] Falling back to provided file URL:', fileUrl)
          setPdfUrl(fileUrl)
          setError(null)
          return
        }

        throw new Error('No PDF data returned')
      } catch (err) {
        if (!cancelled) {
          console.error('[PdfViewer] PDF load error:', err)
          setError(err instanceof Error ? err.message : 'PDF 加载失败')
        }
      }
    }

    loadPdf()

    return () => {
      cancelled = true
    }
  }, [tab.path, fileUrl])

  // Stable file prop to avoid Document re-renders
  const fileOption = useMemo(() => {
    if (pdfData) return { data: pdfData }
    return pdfUrl
  }, [pdfData, pdfUrl])

  const savePdfReadingPosition = useCallback(() => {
    const element = containerRef.current
    if (!element) return
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
    const top = Math.max(0, Math.min(element.scrollTop, maxScroll))
    saveDocumentReadingPosition(documentScrollKey, {
      top,
      ratio: maxScroll > 0 ? top / maxScroll : 0,
      maxScroll,
      anchorTitle: null,
      anchorOrdinal: null,
      anchorProgress: null,
    })
  }, [documentScrollKey])

  const restorePdfReadingPosition = useCallback(() => {
    const snapshot = loadDocumentReadingPosition(documentScrollKey)
    const element = containerRef.current
    if (!snapshot || !element) return
    const restore = () => {
      const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
      const nextTop = snapshot.maxScroll === maxScroll ? snapshot.top : snapshot.ratio * maxScroll
      element.scrollTop = Math.max(0, Math.min(Math.round(nextTop), maxScroll))
    }
    requestAnimationFrame(restore)
    requestAnimationFrame(() => requestAnimationFrame(restore))
    window.setTimeout(restore, 180)
    window.setTimeout(restore, 520)
    window.setTimeout(restore, 1100)
  }, [documentScrollKey])

  const onLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n)
    setError(null)
  }, [])

  const onLoadError = useCallback((err: Error) => {
    console.error('[PdfViewer] PDF.js load error:', err)
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

  useEffect(() => {
    if (numPages === 0 || restoredScrollKeyRef.current === documentScrollKey) return
    restoredScrollKeyRef.current = documentScrollKey
    restorePdfReadingPosition()
  }, [documentScrollKey, numPages, restorePdfReadingPosition])

  useEffect(() => () => {
    if (saveScrollTimerRef.current !== null) {
      window.clearTimeout(saveScrollTimerRef.current)
      saveScrollTimerRef.current = null
    }
    savePdfReadingPosition()
  }, [savePdfReadingPosition])

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

  const handleScroll = useCallback(() => {
    if (saveScrollTimerRef.current !== null) {
      window.clearTimeout(saveScrollTimerRef.current)
    }
    saveScrollTimerRef.current = window.setTimeout(() => {
      saveScrollTimerRef.current = null
      savePdfReadingPosition()
    }, 220)
  }, [savePdfReadingPosition])

  const scale = zoom / 100

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-[var(--text-muted)] gap-2">
        <p className="text-[13px]">PDF 加载失败</p>
        <p className="text-[11px] text-[var(--text-light)]">{error}</p>
        <p className="text-[10px] text-[var(--text-light)] mt-2">文件: {tab.path}</p>
      </div>
    )
  }

  if (!fileOption) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--text-muted)' }} />
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
            borderRadius: 4,
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
        data-ready-document-scroll-key={documentScrollKey}
        className="panel-hover-scrollbar flex-1 overflow-auto"
        style={{ background: '#525659' }}
        onWheel={handleWheel}
        onScroll={handleScroll}
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
