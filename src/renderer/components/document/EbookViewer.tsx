import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileInput,
  Loader2,
  Minus,
  Plus,
} from 'lucide-react'
import { type DocTab, useDocTabs } from '../../stores/useDocTabs'
import { useWorkspace } from '../../stores/useWorkspace'
import { isEpubExtension } from '../../../shared/ebook'

type FoliateViewElement = HTMLElement & {
  open(book: unknown): Promise<void>
  init?(options?: { lastLocation?: unknown; showTextStart?: boolean }): Promise<void>
  close?(): void
  goTo(target: unknown): Promise<unknown>
  prev(): Promise<unknown> | unknown
  next(): Promise<unknown> | unknown
  renderer?: {
    getContents?: () => Array<{ doc?: Document }>
  }
  book?: {
    toc?: Array<{ label?: string; href?: string }>
    metadata?: { title?: unknown }
    transformTarget?: EventTarget
  }
}

type ReaderState = {
  path: string
  size: number
  modifiedTime: number
  fraction?: number
  index?: number
  updatedAt: number
}

type ImportState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

interface EbookViewerProps {
  tab: DocTab
  fileUrl: string
  currentExt: string
}

const READING_STATE_KEY = 'ready-ebook-reading-state-v1'
const MAX_READING_STATES = 500
const DEFAULT_FONT_SIZE = 17

function normalizeEbookBytes(value: unknown): Uint8Array | null {
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

function getEbookMimeType(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'epub':
      return 'application/epub+zip'
    case 'mobi':
      return 'application/x-mobipocket-ebook'
    case 'azw':
    case 'azw3':
      return 'application/vnd.amazon.ebook'
    case 'fb2':
      return 'application/x-fictionbook+xml'
    case 'cbz':
      return 'application/vnd.comicbook+zip'
    default:
      return 'application/octet-stream'
  }
}

async function makeBookFromLocalFile(
  filePath: string,
  fileUrl: string,
  currentExt: string,
  makeBook: (file: File | string) => Promise<unknown>,
): Promise<FoliateViewElement['book']> {
  const readResult = await window.electronAPI.document.readFile(filePath).catch(() => null)
  const binaryData = readResult?.success && readResult.data?.type === 'binary'
    ? readResult.data
    : null
  const bytes = binaryData?.category === 'ebook' ? normalizeEbookBytes(binaryData.bytes) : null

  if (bytes && bytes.length > 0) {
    const mimeType = getEbookMimeType(currentExt)
    const blob = new Blob([Uint8Array.from(bytes)], { type: mimeType })
    const name = filePath.split(/[\\/]/).pop() || `book.${currentExt || 'ebook'}`
    return await makeBook(new File([blob], name, { type: mimeType })) as FoliateViewElement['book']
  }

  return await makeBook(binaryData?.localUrl || fileUrl) as FoliateViewElement['book']
}

function readStateStore(): ReaderState[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_STATE_KEY) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ReaderState => (
      typeof item === 'object' &&
      item !== null &&
      typeof (item as ReaderState).path === 'string' &&
      typeof (item as ReaderState).updatedAt === 'number'
    ))
  } catch {
    // silent-catch: corrupted cached reader state should reset to an empty cache.
    return []
  }
}

function findReaderState(path: string, size: number, modifiedTime: number): ReaderState | null {
  return readStateStore().find((item) => (
    item.path === path &&
    item.size === size &&
    item.modifiedTime === modifiedTime
  )) || null
}

function saveReaderState(next: ReaderState): void {
  try {
    const rest = readStateStore().filter((item) => item.path !== next.path)
    const merged = [next, ...rest]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_READING_STATES)
    localStorage.setItem(READING_STATE_KEY, JSON.stringify(merged))
  } catch {
    // silent-catch: reading state is a convenience cache and may be unavailable.
    // Reading state is a convenience cache; failure should not break reading.
  }
}

function sanitizeHtmlDocument(raw: string, mimeType: string): string {
  if (!/(xhtml|html|svg)/i.test(mimeType)) return raw
  try {
    const parser = new DOMParser()
    const doc = parser.parseFromString(raw, /svg/i.test(mimeType) ? 'image/svg+xml' : 'text/html')
    doc.querySelectorAll('script, iframe').forEach((node) => node.remove())
    doc.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase()
        const value = attr.value.trim().toLowerCase()
        if (name.startsWith('on') || value.startsWith('javascript:')) {
          node.removeAttribute(attr.name)
        }
      }
    })
    return new XMLSerializer().serializeToString(doc)
  } catch {
    // silent-catch: DOMParser failures fall back to regex-based sanitization.
    return raw
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, ' $1="#"')
      .replace(/\s+(href|src|xlink:href)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"')
  }
}

function attachBookSanitizer(book: FoliateViewElement['book']): void {
  book?.transformTarget?.addEventListener('data', (event) => {
    const detail = (event as CustomEvent<{ data: unknown; type: unknown }>).detail
    const type = typeof detail?.type === 'string' ? detail.type : ''
    if (!/(xhtml|html|svg|javascript|ecmascript)/i.test(type)) return
    detail.data = Promise.resolve(detail.data).then(async (value) => {
      const raw = value instanceof Blob ? await value.text() : String(value ?? '')
      if (/javascript|ecmascript/i.test(type)) return ''
      return sanitizeHtmlDocument(raw, type)
    })
  })
}

function formatProgress(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0%'
  return `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`
}

function disposeView(view: FoliateViewElement | null): void {
  if (!view) return
  try {
    view.close?.()
  } catch {
    // silent-catch: best-effort cleanup should not block replacing the reader element.
    // Best-effort cleanup; replacing/removing the element is enough for UI recovery.
  }
  view.remove()
}

export default function EbookViewer({ tab, fileUrl, currentExt }: EbookViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateViewElement | null>(null)
  const fileMetaRef = useRef<{ size: number; modifiedTime: number }>({ size: 0, modifiedTime: 0 })
  const fontSizeRef = useRef(DEFAULT_FONT_SIZE)
  const openTab = useDocTabs((state) => state.openTab)
  const revealFile = useWorkspace((state) => state.revealFile)

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE)
  const [importState, setImportState] = useState<ImportState>({ kind: 'idle' })

  const canImport = isEpubExtension(currentExt)
  const title = useMemo(() => tab.title || tab.path?.split(/[\\/]/).pop() || '电子书', [tab.path, tab.title])

  const applyReadingStyle = useCallback(() => {
    const contents = viewRef.current?.renderer?.getContents?.() || []
    for (const item of contents) {
      const doc = item.doc
      if (!doc) continue
      doc.documentElement.style.fontSize = `${fontSizeRef.current}px`
      doc.documentElement.style.lineHeight = '1.62'
      doc.documentElement.style.background = 'var(--bg-editor, #ffffff)'
      doc.documentElement.style.color = 'var(--text-primary, #1f2933)'
    }
  }, [])

  useEffect(() => {
    fontSizeRef.current = fontSize
    applyReadingStyle()
  }, [applyReadingStyle, fontSize])

  useEffect(() => {
    if (!tab.path) return undefined
    const filePath = tab.path
    let cancelled = false
    const mount = async () => {
      setStatus('loading')
      setError(null)
      setProgress(null)
      setImportState({ kind: 'idle' })
      disposeView(viewRef.current)
      viewRef.current = null

      try {
        const statResult = await window.electronAPI.document.stat(filePath)
        const size = statResult.data?.size ?? statResult.stat?.size ?? 0
        const modifiedTime = statResult.data?.modifiedTime ?? (
          statResult.stat?.modified ? new Date(statResult.stat.modified).getTime() : 0
        )
        fileMetaRef.current = { size, modifiedTime }

        const foliate = await import('foliate-js/view.js')
        const book = await makeBookFromLocalFile(filePath, fileUrl, currentExt, foliate.makeBook)
        attachBookSanitizer(book)

        if (cancelled || !containerRef.current) return
        const view = document.createElement('foliate-view') as FoliateViewElement
        view.style.width = '100%'
        view.style.height = '100%'
        view.style.display = 'block'
        view.addEventListener('load', applyReadingStyle as EventListener)
        view.addEventListener('relocate', (event) => {
          const detail = (event as CustomEvent<{ fraction?: number; index?: number }>).detail
          const nextProgress = typeof detail?.fraction === 'number' ? detail.fraction : null
          setProgress(nextProgress)
          saveReaderState({
            path: filePath,
            size: fileMetaRef.current.size,
            modifiedTime: fileMetaRef.current.modifiedTime,
            fraction: nextProgress ?? undefined,
            index: typeof detail?.index === 'number' ? detail.index : undefined,
            updatedAt: Date.now(),
          })
        })

        containerRef.current.replaceChildren(view)
        viewRef.current = view
        await view.open(book)

        const saved = findReaderState(filePath, size, modifiedTime)
        let openedInitialLocation = false
        if (saved?.fraction != null) {
          openedInitialLocation = Boolean(await view.goTo({ fraction: saved.fraction }).catch(() => undefined))
        }
        if (!openedInitialLocation && saved?.index != null) {
          openedInitialLocation = Boolean(await view.goTo(saved.index).catch(() => undefined))
        }
        if (!openedInitialLocation) {
          if (typeof view.init === 'function') {
            await view.init({ showTextStart: true }).catch(() => view.next())
          } else {
            await view.next()
          }
        }
        applyReadingStyle()
        if (!cancelled) setStatus('ready')
      } catch (err) {
        if (!cancelled) {
          setStatus('error')
          setError(err instanceof Error ? err.message : '电子书加载失败')
        }
      }
    }
    void mount()
    return () => {
      cancelled = true
      disposeView(viewRef.current)
      viewRef.current = null
    }
  }, [applyReadingStyle, fileUrl, tab.path])

  const handleImport = useCallback(async () => {
    if (!tab.path || !canImport || importState.kind === 'running') return
    setImportState({ kind: 'running' })
    try {
      const result = await window.electronAPI.document.importEbookAsMarkdown({ sourcePath: tab.path })
      if (!result.success || !result.indexPath) {
        throw new Error(result.error || '导入失败')
      }
      openTab(result.indexPath)
      await revealFile(result.indexPath)
      const warningText = result.warnings && result.warnings.length > 0
        ? `，${result.warnings.length} 条提示`
        : ''
      setImportState({ kind: 'done', message: `已导入 ${result.assetCount || 0} 个资源${warningText}` })
    } catch (err) {
      // silent-catch: the UI surfaces the import failure in component state.
      setImportState({ kind: 'error', message: err instanceof Error ? err.message : '导入失败' })
    }
  }, [canImport, importState.kind, openTab, revealFile, tab.path])

  const stepFont = useCallback((delta: number) => {
    setFontSize((value) => Math.max(13, Math.min(26, value + delta)))
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-editor)' }}>
      <div
        className="flex items-center gap-1 border-b px-3"
        style={{ height: 42, borderColor: 'var(--border-default)', background: 'var(--bg-content)' }}
      >
        <button
          type="button"
          onClick={() => void viewRef.current?.prev()}
          disabled={status !== 'ready'}
          className="flex h-7 w-7 items-center justify-center bg-transparent disabled:opacity-40"
          style={{ border: 'none', borderRadius: 4, cursor: status === 'ready' ? 'pointer' : 'default' }}
          title="上一页"
        >
          <ChevronLeft size={15} color="var(--text-muted)" />
        </button>
        <button
          type="button"
          onClick={() => void viewRef.current?.next()}
          disabled={status !== 'ready'}
          className="flex h-7 w-7 items-center justify-center bg-transparent disabled:opacity-40"
          style={{ border: 'none', borderRadius: 4, cursor: status === 'ready' ? 'pointer' : 'default' }}
          title="下一页"
        >
          <ChevronRight size={15} color="var(--text-muted)" />
        </button>
        <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 6px' }} />
        <button
          type="button"
          onClick={() => stepFont(-1)}
          className="flex h-7 w-7 items-center justify-center bg-transparent"
          style={{ border: 'none', borderRadius: 4, cursor: 'pointer' }}
          title="减小字号"
        >
          <Minus size={14} color="var(--text-muted)" />
        </button>
        <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)', minWidth: 36, textAlign: 'center' }}>
          {fontSize}px
        </span>
        <button
          type="button"
          onClick={() => stepFont(1)}
          className="flex h-7 w-7 items-center justify-center bg-transparent"
          style={{ border: 'none', borderRadius: 4, cursor: 'pointer' }}
          title="增大字号"
        >
          <Plus size={14} color="var(--text-muted)" />
        </button>
        <div style={{ width: 1, height: 16, background: 'var(--border-default)', margin: '0 6px' }} />
        <button
          type="button"
          onClick={() => void handleImport()}
          disabled={!canImport || importState.kind === 'running'}
          className="flex h-7 items-center gap-1.5 bg-transparent px-2 text-[11px] font-medium disabled:opacity-45"
          style={{ border: 'none', borderRadius: 4, color: 'var(--text-muted)', cursor: canImport ? 'pointer' : 'default' }}
          title={canImport ? '导入为 Markdown' : '当前只支持 EPUB 导入'}
        >
          {importState.kind === 'running' ? <Loader2 size={13} className="animate-spin" /> : <FileInput size={13} />}
          导入
        </button>
        <div className="min-w-0 flex flex-1 items-center justify-end gap-2">
          <span className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{title}</span>
          <span className="text-[10px] font-semibold uppercase" style={{ color: 'var(--text-light)' }}>{currentExt}</span>
          <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)', minWidth: 38, textAlign: 'right' }}>
            {formatProgress(progress)}
          </span>
        </div>
      </div>

      {importState.kind === 'done' || importState.kind === 'error' ? (
        <div
          className="border-b px-3 py-1.5 text-[11px] font-medium"
          style={{
            borderColor: 'var(--border-default)',
            color: importState.kind === 'error' ? 'var(--color-red, #c0392b)' : 'var(--text-muted)',
            background: 'var(--bg-content)',
          }}
        >
          {importState.message}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-[13px] font-medium">正在打开电子书</span>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-8 text-center" style={{ color: 'var(--text-muted)' }}>
            <BookOpen className="h-8 w-8" />
            <div>
              <p className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>电子书加载失败</p>
              <p className="mt-1 text-[12px] leading-5">{error || '该文件可能受 DRM 保护，或格式暂不支持。'}</p>
            </div>
          </div>
        )}
        <div ref={containerRef} className="ebook-viewer-layout h-full min-h-0" />
      </div>
    </div>
  )
}
