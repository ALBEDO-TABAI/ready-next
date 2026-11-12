import { useCallback, useEffect, useRef, useState } from 'react'
import { Languages, Loader2 } from 'lucide-react'
import { MarkdownContent } from '../document/MarkdownContent'
import { Button } from '../ui'
import type { BrowserReadArticle, BrowserReadResult } from '../../../shared/browser-shell'
import { useSelectionBar } from '../../modules/workbench/selection-bar/open-selection-bar'
import { webSelectionCapture } from '../../modules/browser/web-selection-bar'
import { selectedReadingRange } from '../../modules/rss/reading-selection'
import { announceHighlight } from '../../modules/workbench/capture-receipt'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'

// 阅读视图 (W7 §4.10): the page's article in 资讯's reader — its typography, its reading runs and the shared selection
// bar. 划线 goes to the web page's source page with a link back to the live page at those words; the other actions
// take the web page as their source. The page is read from what is rendered now; nothing is fetched again.

type Refusal = Exclude<BrowserReadResult, { success: true }>['error']
const READ_REFUSAL: Record<Refusal, string> = {
  tab_missing: '这个标签已经关闭。',
  unsupported_protocol: '这个网页没有阅读视图。',
  not_readable: '这个网页读不出正文。',
  too_large: '这个网页的正文太长，阅读视图放不下。',
  page_changed: '网页刚刚变了，请重新打开阅读视图。',
  extraction_failed: '这个网页读不出正文。',
}

const opensWithTitle = (page: BrowserReadArticle) => {
  const first = /^\s*#{1,2}\s+(.+?)\s*#*\s*$/m.exec(page.text.trimStart().split('\n', 1)[0] ?? '')
  return Boolean(first && first[1].replace(/\s+/g, ' ').trim() === page.title.replace(/\s+/g, ' ').trim())
}
const publishedOn = (value: number) => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

type ReadState = { phase: 'loading' } | { phase: 'ready'; page: BrowserReadArticle } | { phase: 'failed'; message: string }

export default function BrowserReadingView({ tabId, url, onClose, onTranslate }: {
  tabId: string
  /** The address the reading view was opened for; the article must still be from it. */
  url: string
  onClose: () => void
  /** 翻译, the web page's own extra on the selection bar. */
  onTranslate: (selection: { text: string; url: string; title: string }) => void
}) {
  const [state, setState] = useState<ReadState>({ phase: 'loading' })
  const bodyRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    window.electronAPI.browser.readTab({ tabId }).then(result => {
      if (cancelled) return
      if (!result.success) setState({ phase: 'failed', message: READ_REFUSAL[result.error] })
      else if (result.data.url !== url) setState({ phase: 'failed', message: READ_REFUSAL.page_changed })
      else setState({ phase: 'ready', page: result.data })
    }).catch(error => {
      console.warn('[reading-view] read failed:', error instanceof Error ? error.message : String(error))
      if (!cancelled) setState({ phase: 'failed', message: READ_REFUSAL.extraction_failed })
    })
    return () => { cancelled = true }
  }, [tabId, url])

  // Opening the view hands it the keyboard: Esc closes it, the page keys scroll the article.
  useEffect(() => { sectionRef.current?.focus({ preventScroll: true }) }, [])

  const page = state.phase === 'ready' ? state.page : null
  const read = useCallback(() => {
    const body = bodyRef.current, selection = window.getSelection()
    if (!body || !page || !selection || selection.isCollapsed || !selectedReadingRange(body, selection).selection) return null
    return webSelectionCapture({ text: selection.toString(), url: page.url, title: page.title })
  }, [page])
  useSelectionBar(bodyRef, {
    enabled: Boolean(page),
    read,
    highlight: async () => {
      const body = bodyRef.current, selection = window.getSelection()
      const range = body ? selectedReadingRange(body, selection).selection : null
      const text = selection?.toString().trim()
      if (!page || !range || !text) throw new Error('选区已经变了，请重新选择文字')
      const result = await window.electronAPI.sourceAnnotations.webReading({ tabId, revision: page.article.revision, range })
      if (!result.success) throw new Error(result.error)
      announceHighlight(result.data, text)
    },
    extras: [{ id: 'translate', label: '翻译', icon: <Languages />, run: () => {
      const selection = read()
      if (!selection) throw new Error('选区已经变了，请重新选择文字')
      onTranslate({ text: selection.text, url: selection.pageUrl ?? url, title: selection.title })
    } }],
  })

  return (
    <section
      ref={sectionRef}
      className="rss-article-reader rn-reading-view"
      aria-label="阅读视图"
      tabIndex={-1}
      data-browser-reading-view={state.phase}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        event.preventDefault()
        onClose()
      }}
    >
      <div className="rss-reader-layout">
        <article className="rss-reader-content">
          {state.phase === 'loading' && <p className="rn-reading-view__status" role="status"><Loader2 className="animate-spin" aria-hidden="true" />正在读出正文</p>}
          {state.phase === 'failed' && <div className="rn-reading-view__status" role="alert">
            <span>{state.message}</span>
            <Button size="sm" variant="ghost" onClick={onClose}>回到网页</Button>
          </div>}
          {page && <>
            <p className="rss-reader-source">
              <strong>{page.siteName}</strong>
              {page.byline && page.byline !== page.siteName ? <span>· {page.byline}</span> : null}
              {page.publishedAt != null ? <span>· {publishedOn(page.publishedAt)}</span> : null}
            </p>
            {/* Many articles open with their own title; it stays in the text (its reading runs are Main's too). */}
            {!opensWithTitle(page) && <h1 className="rss-reader-title">{page.title}</h1>}
            <div className="note-preview-body rss-reader-body" ref={bodyRef} lang={page.lang ?? undefined}>
              <MarkdownContent readingAnchors content={page.text} externalBaseUrl={page.url} onOpenLink={href => { void openWebpageInBrowser(href) }} />
            </div>
          </>}
        </article>
      </div>
    </section>
  )
}
