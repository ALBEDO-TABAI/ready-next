import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Copy, ExternalLink, Loader2, RefreshCw, Star } from 'lucide-react'
import { MarkdownContent, copyTextToClipboard } from '../document/MarkdownContent'
import { readSavedRSSArticle } from '../../modules/rss/read-article'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { openRSSItemInBrowserTab } from '../../modules/rss/open-rss-item-in-browser'
import { hasLikelyVideoResource } from '../../../shared/browser-tab-resource-classifier'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import type { RSSItem } from './RSSFeed'
import RssTimeHintBanner from './RssTimeHintBanner'

interface RSSArticleReaderProps {
  item: RSSItem
  onClose(): void
  onOpened(itemId: string): Promise<void>
  onToggleStar(itemId: string): void
  onBodyLoaded?(article: RSSArticleExcerpt['article']): Promise<void>
  notice?: string | null
}

const BODY_LABELS = {
  missing: '尚未获取正文', loading: '正在获取正文', ready: '已保存正文', partial: '已获取部分正文',
  stale: '原文已变化，正在更新正文', login_required: '需要在原网站登录', failed: '正文获取失败',
} as const

export default function RSSArticleReader({ item, onClose, onOpened, onToggleStar, onBodyLoaded, notice }: RSSArticleReaderProps) {
  const [content, setContent] = useState<RSSArticleExcerpt | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [reload, setReload] = useState(0)
  const forceReload = useRef(false)
  const [headings, setHeadings] = useState<Array<{ title: string; level: number }>>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  const video = hasLikelyVideoResource(item.link)

  useEffect(() => {
    const controller = new AbortController()
    const force = forceReload.current
    forceReload.current = false
    // A query readback may acknowledge the body this reader has just loaded.
    if (!force && item.revision && content?.article.revision === item.revision) { setBusy(false); return }
    const api = window.electronAPI.rss
    setContent(null)
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        let saved = await readSavedRSSArticle(api, item.id, controller.signal)
        setContent(saved)
        if (!video && (force || ['missing', 'stale', 'loading'].includes(saved.body.status))) {
          const fetched = await api.loadArticle({ itemId: item.id, force })
          controller.signal.throwIfAborted()
          saved = await readSavedRSSArticle(api, item.id, controller.signal)
          setContent(saved)
          await onBodyLoaded?.(saved.article)
          controller.signal.throwIfAborted()
          if (!fetched.success) setError(fetched.error || '正文获取失败，仍可阅读来源摘要或打开原文。')
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    })()
    return () => controller.abort()
  }, [item.id, item.revision, item.title, item.link, item.summary, reload, video])

  useEffect(() => {
    if (content?.article.id === item.id && !content.article.read) void onOpened(item.id)
  }, [content?.article.id, content?.article.read, item.id, onOpened])

  useEffect(() => {
    const nodes = bodyRef.current?.querySelectorAll<HTMLElement>('[data-ready-heading-level]')
    setHeadings(Array.from(nodes || []).map((node) => ({ title: node.dataset.readyHeadingTitle || '', level: Number(node.dataset.readyHeadingLevel) })))
  }, [content])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const openLink = useCallback((href: string) => { void openWebpageInBrowser(href) }, [])
  const openOriginal = useCallback(() => {
    void openRSSItemInBrowserTab(item).then((opened) => { if (!opened) setError('未能打开原文，请稍后重试。') })
  }, [item])
  const article = content?.article
  const title = article?.title || item.title
  const date = article?.publishedAt ?? article?.collectedAt
  const author = article?.author || item.author

  return <section className="rss-article-reader" aria-label="资讯阅读" data-rss-article-id={item.id}>
    <header className="rss-reader-toolbar glass-surface-floating">
      <button type="button" className="rss-reader-button" onClick={onClose}><ArrowLeft size={16} />返回列表</button>
      <div className="rss-reader-actions">
        <button type="button" className="rss-reader-button" title={item.starred ? '取消收藏' : '收藏文章'} aria-pressed={item.starred} onClick={() => onToggleStar(item.id)}><Star size={16} fill={item.starred ? 'currentColor' : 'none'} /></button>
        <button type="button" className="rss-reader-button" disabled={!content} onClick={() => { if (content) void copyTextToClipboard(`${title}\n来源：${article?.link || item.link}\n\n${content.text}`).then(setCopied) }}><Copy size={15} />{copied ? '已复制' : '复制内容'}</button>
        <button type="button" className="rss-reader-button" onClick={openOriginal}><ExternalLink size={15} />打开原文</button>
      </div>
    </header>
    <div className="rss-reader-layout">
      {headings.length > 0 && <nav className="rss-reader-toc" aria-label="本文目录">
        <p>本文目录</p>
        {headings.map((heading, index) => <button type="button" key={index} style={{ paddingLeft: `${Math.min(heading.level - 1, 3) * 10}px` }} onClick={() => bodyRef.current?.querySelectorAll('[data-ready-heading-level]')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{heading.title}</button>)}
      </nav>}
      <article className="rss-reader-content">
        <p className="rss-reader-source">{article?.source || item.source}{author && author !== (article?.source || item.source) ? ` · ${author}` : ''}{date != null ? ` · ${article?.publishedAt == null ? '收录于 ' : ''}${new Date(date).toLocaleString()}` : ''}</p>
        <h1 className="rss-reader-title">{title}</h1>
        <RssTimeHintBanner itemId={item.id} title={title} summary={article?.summary || item.summary} author={author} />
        {video && <p className="rss-reader-notice">视频资讯：下方为来源提供的文字。观看、转录和视觉分析需使用对应操作。</p>}
        <div className="rss-reader-status" role="status">
          {busy && <Loader2 size={14} className="animate-spin" />}
          <span>{content ? `${content.textKind === 'source_summary' ? '来源摘要 · ' : ''}${BODY_LABELS[content.body.status]}` : busy ? '正在读取文章' : '文章读取失败'}</span>
          {!video && <button type="button" className="rss-reader-button" disabled={busy} onClick={() => { forceReload.current = true; setReload((value) => value + 1) }}><RefreshCw size={13} />重新获取正文</button>}
        </div>
        {(error || notice || content?.body.status === 'partial' || content?.body.status === 'login_required') && <p className="rss-reader-notice" role="alert">{error || notice || (content?.body.status === 'partial' ? '目前仅获取到部分正文，请打开原文查看完整内容。' : '请先打开原文登录，再重新获取正文。')}</p>}
        <div className="note-preview-body rss-reader-body" ref={bodyRef}>
          {content && <MarkdownContent content={content.text} externalBaseUrl={content.body.sourceUrl || article?.link || item.link} onOpenLink={openLink} />}
        </div>
      </article>
    </div>
  </section>
}
