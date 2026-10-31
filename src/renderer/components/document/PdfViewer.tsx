import { memo, useState, useCallback, useRef, useEffect, useMemo } from 'react'
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
  Highlighter,
} from 'lucide-react'
import { PdfSelectionSchema, locatePdfQuote, type PdfSelection } from '../../../shared/pdf-source-anchor'
import { usePdfReference } from '../../modules/workbench/open-ready-ref'
import { type DocTab } from '../../stores/useDocTabs'
import {
  loadDocumentReadingPosition,
  saveDocumentReadingPosition,
} from '../../modules/document/documentScrollAnchor'
import {
  arePdfPageSlotRenderInputsEqual,
  getPdfPageRenderRange,
} from '../../modules/document/pdfPageWindow'
import { recordDocumentPerformanceMaximum } from '../../../shared/document-performance-diagnostics'

// Configure PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300]
const DEFAULT_PDF_PAGE_HEIGHT = 792
const PAGE_WINDOW_RADIUS = 3

interface PdfViewerProps {
  tab: DocTab
  fileUrl: string
}

type PdfPageProxy = {
  getViewport(options: { scale: number }): { height: number }
}

const PdfPageSlot = memo(function PdfPageSlot({
  pageNumber,
  shouldRender,
  pageHeight,
  scale,
  registerPageRef,
  recordPageHeight,
  textLayerState,
}: {
  pageNumber: number
  shouldRender: boolean
  pageHeight: number
  scale: number
  registerPageRef(pageNumber: number, element: HTMLDivElement | null): void
  recordPageHeight(pageNumber: number, page: PdfPageProxy): void
  textLayerState(pageNumber: number, state: 'loading' | 'ready' | 'failed'): void
}) {
  const setPageRef = useCallback((element: HTMLDivElement | null) => {
    registerPageRef(pageNumber, element)
  }, [pageNumber, registerPageRef])
  const onPageLoad = useCallback((page: PdfPageProxy) => {
    textLayerState(pageNumber, 'loading')
    recordPageHeight(pageNumber, page)
  }, [pageNumber, recordPageHeight, textLayerState])

  return (
    <div
      ref={setPageRef}
      data-page={pageNumber}
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        minHeight: `calc(${pageHeight}px * var(--ready-pdf-scale, 1) + 24px)`,
        padding: '12px 0',
      }}
    >
      {shouldRender ? (
        <div
          data-ready-pdf-page-mounted={pageNumber}
          style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}
        >
          <Page
            pageNumber={pageNumber}
            scale={scale}
            renderTextLayer={true}
            renderAnnotationLayer={true}
            loading={null}
            onLoadSuccess={onPageLoad}
            onLoadError={() => textLayerState(pageNumber, 'failed')}
            onRenderTextLayerSuccess={() => textLayerState(pageNumber, 'ready')}
            onGetTextError={() => textLayerState(pageNumber, 'failed')}
            onRenderTextLayerError={() => textLayerState(pageNumber, 'failed')}
          />
        </div>
      ) : null}
    </div>
  )
}, arePdfPageSlotRenderInputsEqual)

/** Offsets are measured in this one page's DOM text layer, including whitespace. */
function readPdfSelection(container: HTMLElement, id: string, expectedHash: string): PdfSelection | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const parent = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement
  const layer = parent?.closest('.react-pdf__Page__textContent')
  if (!layer || !container.contains(layer) || !layer.contains(range.endContainer)) return null
  const prefix = document.createRange(); prefix.selectNodeContents(layer); prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length, exact = range.toString()
  const parsed = PdfSelectionSchema.safeParse({ id, expectedHash, page: Number(layer.closest('[data-page]')?.getAttribute('data-page')),
    text: layer.textContent ?? '', start, end: start + exact.length, exact })
  return parsed.success ? parsed.data : null
}

function highlightPdfRange(layer: Element, start: number, end: number): () => void {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), marks: HTMLElement[] = []
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  let offset = 0
  for (const node of nodes) {
    const length = node.length, from = Math.max(0, start - offset), to = Math.min(length, end - offset)
    offset += length
    if (from >= to) continue
    const range = document.createRange(); range.setStart(node, from); range.setEnd(node, to)
    // pdf.js's "highlight appended" keeps the mark in the text flow (text layer spans are absolutely positioned).
    const mark = document.createElement('span'); mark.className = 'highlight appended'; mark.dataset.readyPdfHighlight = 'true'
    // The text layer sits over the rendered page, so the mark has to stay translucent to keep the quote readable.
    Object.assign(mark.style, { backgroundColor: 'rgba(255, 196, 0, 0.42)', mixBlendMode: 'multiply', borderRadius: '2px', transition: 'background-color 400ms ease' })
    range.surroundContents(mark); marks.push(mark)
  }
  return () => { for (const mark of marks) mark.replaceWith(...mark.childNodes) }
}

export default function PdfViewer({ tab, fileUrl }: PdfViewerProps) {
  const [pdfHash, setPdfHash] = useState('')
  const [selection, setSelection] = useState<PdfSelection | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ role: 'status' | 'alert'; text: string } | null>(null)
  const target = usePdfReference(s => s.target)
  const generation = useRef(0)
  const [numPages, setNumPages] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [currentPage, setCurrentPage] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [pageHeights, setPageHeights] = useState<Map<number, number>>(() => new Map())

  const containerRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const visiblePageEntriesRef = useRef<Map<number, IntersectionObserverEntry>>(new Map())
  const saveScrollTimerRef = useRef<number | null>(null)
  const restoredScrollKeyRef = useRef<string | null>(null)
  const documentScrollKey = useMemo(() => tab.objectId || tab.path || tab.id, [tab.id, tab.objectId, tab.path])

  useEffect(() => {
    const current = ++generation.current
    setPdfHash(''); setSelection(null); setNotice(null); setSaving(false)
    setNumPages(0)
    setCurrentPage(1)
    setPageHeights(new Map())
    setError(tab.path && fileUrl ? null : 'No file path provided')
    pageRefs.current.clear()
    visiblePageEntriesRef.current.clear()
    restoredScrollKeyRef.current = null
    return () => { generation.current = current + 1 }
  }, [tab.path, fileUrl])

  const fileOption = fileUrl || null

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
    if (!snapshot || !element) return undefined
    const restore = () => {
      const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight)
      const nextTop = snapshot.maxScroll === maxScroll ? snapshot.top : snapshot.ratio * maxScroll
      element.scrollTop = Math.max(0, Math.min(Math.round(nextTop), maxScroll))
    }
    let frame = requestAnimationFrame(restore)
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(restore)
        })
    observer?.observe(element)
    const timeout = window.setTimeout(() => observer?.disconnect(), 800)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timeout)
      observer?.disconnect()
    }
  }, [documentScrollKey])

  const onLoadSuccess = useCallback(async (pdf: { numPages: number; getData(): Promise<Uint8Array> }) => {
    const current = generation.current
    setNumPages(pdf.numPages)
    setError(null)
    try {
      const bytes = await pdf.getData()
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
      if (generation.current === current) setPdfHash(Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join(''))
    } catch (error) {
      if (generation.current === current) setNotice({ role: 'alert', text: `无法读取 PDF 版本：${error instanceof Error ? error.message : String(error)}` })
    }
  }, [])

  const onLoadError = useCallback((err: Error) => {
    console.error('[PdfViewer] PDF.js load error:', err)
    setError(err.message || 'PDF 加载失败')
  }, [])

  // Track visible page via IntersectionObserver
  useEffect(() => {
    const visiblePageEntries = visiblePageEntriesRef.current
    if (numPages === 0) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNum = Number(entry.target.getAttribute('data-page'))
          if (!Number.isFinite(pageNum)) continue
          if (entry.isIntersecting) visiblePageEntriesRef.current.set(pageNum, entry)
          else visiblePageEntriesRef.current.delete(pageNum)
        }
        const topEntry = Array.from(visiblePageEntriesRef.current.entries())
          .sort((left, right) => left[1].boundingClientRect.top - right[1].boundingClientRect.top)[0]
        if (topEntry) setCurrentPage(topEntry[0])
      },
      {
        root: containerRef.current,
        rootMargin: '0px',
        // A zoomed page can be taller than the viewport, so a 30% threshold
        // may never fire and the virtual page window would stop advancing.
        threshold: 0,
      },
    )

    pageRefs.current.forEach((el) => observerRef.current?.observe(el))

    return () => {
      observerRef.current?.disconnect()
      visiblePageEntries.clear()
    }
  }, [numPages, zoom])

  useEffect(() => {
    if (numPages === 0 || restoredScrollKeyRef.current === documentScrollKey || target?.path === tab.path) return
    restoredScrollKeyRef.current = documentScrollKey
    return restorePdfReadingPosition()
  }, [documentScrollKey, numPages, restorePdfReadingPosition, target, tab.path])

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

  const recordPageHeight = useCallback((pageNumber: number, page: PdfPageProxy) => {
    const height = page.getViewport({ scale: 1 }).height
    if (!Number.isFinite(height) || height <= 0) return
    setPageHeights((current) => {
      if (current.get(pageNumber) === height) return current
      const next = new Map(current)
      next.set(pageNumber, height)
      return next
    })
  }, [])

  const textLayerState = useCallback((page: number, state: 'loading' | 'ready' | 'failed') => {
    const element = pageRefs.current.get(page)
    if (element) element.dataset.pdfTextState = state
  }, [])

  useEffect(() => {
    const update = () => setSelection(containerRef.current && tab.objectId && pdfHash
      ? readPdfSelection(containerRef.current, tab.objectId, pdfHash) : null)
    document.addEventListener('selectionchange', update)
    update()
    return () => document.removeEventListener('selectionchange', update)
  }, [tab.objectId, pdfHash])

  const saveSelection = async () => {
    const current = generation.current
    const selected = containerRef.current && tab.objectId && pdfHash ? readPdfSelection(containerRef.current, tab.objectId, pdfHash) : null
    if (!selected || saving) return
    setSaving(true); setNotice(null)
    try {
      const result = await window.electronAPI.sourceAnnotations.pdf(selected)
      if (generation.current !== current) return
      if (!result.success) throw new Error(result.error)
      setNotice({ role: 'status', text: result.data.warning || (result.data.persistence === 'saved' ? '已划线到来源页' : '已合并到来源页，请保存') })
    } catch (error) {
      if (generation.current === current) setNotice({ role: 'alert', text: error instanceof Error ? error.message : String(error) })
    } finally { if (generation.current === current) setSaving(false) }
  }

  useEffect(() => {
    if (!target || !numPages || target.path !== tab.path || target.id !== tab.objectId) return
    const anchor = target.anchor
    const consume = () => { if (usePdfReference.getState().target === target) usePdfReference.setState({ target: null }) }
    const unavailable = () => setNotice({ role: 'alert', text: '已打开 PDF，但无法定位引文，请以来源页摘录为准' })
    if (anchor.page > numPages) { unavailable(); consume(); return }
    restoredScrollKeyRef.current = documentScrollKey
    setCurrentPage(anchor.page)
    pageRefs.current.get(anchor.page)?.scrollIntoView({ block: 'start' })
    if (!('exact' in anchor)) { consume(); return }
    let clearHighlight: (() => void) | undefined, timer: number | undefined
    const observer = new MutationObserver(reveal)
    function reveal() {
      const page = pageRefs.current.get(anchor.page)
      if (!page || !['ready', 'failed'].includes(page.dataset.pdfTextState ?? '')) return
      observer.disconnect()
      const layer = page.querySelector('.react-pdf__Page__textContent')
      const range = layer && locatePdfQuote(layer.textContent ?? '', anchor)
      if (!layer || !range) { unavailable(); timer = window.setTimeout(consume, 0); return }
      clearHighlight = highlightPdfRange(layer, range.start, range.end)
      pageRefs.current.get(anchor.page)?.scrollIntoView({ block: 'start' })
      setNotice({ role: 'status', text: '已定位引文' })
      timer = window.setTimeout(() => { clearHighlight?.(); clearHighlight = undefined; consume() }, 2000)
    }
    if (containerRef.current) observer.observe(containerRef.current, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-pdf-text-state'] })
    reveal()
    return () => { observer.disconnect(); if (timer !== undefined) window.clearTimeout(timer); clearHighlight?.() }
  }, [target, numPages, tab.objectId, tab.path, documentScrollKey])

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
    // Default PDF page width is 612pt at scale 1. Actual page sizes remain untouched.
    const containerWidth = containerRef.current.clientWidth - 48
    const pct = Math.round((containerWidth / 612) * 100)
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
  const renderRange = useMemo(
    () => getPdfPageRenderRange(numPages, currentPage, PAGE_WINDOW_RADIUS),
    [currentPage, numPages],
  )
  const mountedPageCount = renderRange.end >= renderRange.start
    ? renderRange.end - renderRange.start + 1
    : 0

  useEffect(() => {
    recordDocumentPerformanceMaximum('pdfMountedPagesPeak', mountedPageCount)
  }, [mountedPageCount])

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
    <div className="flex flex-col h-full" data-ready-pdf-mounted-page-count={mountedPageCount}>
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

        <button
          onMouseDown={event => event.preventDefault()}
          onClick={saveSelection}
          disabled={!selection || saving}
          className="bg-transparent hover:bg-[var(--bg-hover)] disabled:opacity-30"
          style={{ width: 28, height: 28, borderRadius: 4, border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: !selection || saving ? 'not-allowed' : 'pointer' }}
          title="划线到来源页"
          aria-label="划线到来源页"
        >
          <Highlighter size={14} color="var(--text-muted)" />
        </button>
        {notice && <span role={notice.role} style={{ fontSize: 11, color: notice.role === 'alert' ? 'var(--color-red, #d93025)' : 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>{notice.text}</span>}

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
        style={{
          background: '#525659',
          '--ready-pdf-scale': scale,
        } as React.CSSProperties}
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
          {Array.from({ length: numPages }, (_, i) => {
            const pageNumber = i + 1
            return (
              <PdfPageSlot
                key={pageNumber}
                pageNumber={pageNumber}
                shouldRender={pageNumber >= renderRange.start && pageNumber <= renderRange.end}
                pageHeight={pageHeights.get(pageNumber) ?? DEFAULT_PDF_PAGE_HEIGHT}
                scale={scale}
                registerPageRef={registerPageRef}
                recordPageHeight={recordPageHeight}
                textLayerState={textLayerState}
              />
            )
          })}
        </Document>
      </div>
    </div>
  )
}
