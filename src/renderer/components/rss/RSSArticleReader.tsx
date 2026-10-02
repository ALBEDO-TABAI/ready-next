import RSSSelectionReferences from './RSSSelectionReferences'
import { revealReadingRange } from '../../modules/rss/reading-selection'
import type { RSSReadingRange } from '../../../shared/rss-reading'
import type { RSSDefinition } from '../../../shared/rss-organization'
import RSSMembershipEditor from './RSSMembershipEditor'
import RSSEventPanel from './RSSEventPanel'
import RSSReferenceButton from './RSSReferenceButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ChevronDown, Copy, Loader2, MessageSquareQuote, RefreshCw, Star } from 'lucide-react'
import { MarkdownContent, copyTextToClipboard } from '../document/MarkdownContent'
import { readSavedRSSArticle } from '../../modules/rss/read-article'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { describeRSSMedia } from '../../../shared/rss-media'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import type { RSSItem } from './RSSFeed'
import RssTimeHintBanner from './RssTimeHintBanner'
import RSSSaveNoteButton from './RSSSaveNoteButton'
import RSSCoverImage from './RSSCoverImage'
import RSSTopbarTools from './RSSTopbarTools'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'
import { chatMenuSurfaceStyle } from '../agent/chatMenuStyles'

interface RSSArticleReaderProps {
  reveal?: { id: string; range: RSSReadingRange }
  expectedRevision?: string
  onSelectRelated?(item: RSSItem): void
  definitions?: RSSDefinition[]
  active?: boolean
  item: RSSItem
  onClose(): void
  onOpened(itemId: string): Promise<void>
  onToggleStar(itemId: string): void
  onBodyLoaded?(article: RSSArticleExcerpt['article']): Promise<void>
  notice?: string | null
  /** Opens the live page beside the reader (RSSMode's side preview). */
  onOpenOriginal?(item: RSSItem): void
}

const BODY_LABELS = {
  missing: '尚未获取正文', loading: '正在获取正文', ready: '已保存正文', partial: '已获取部分正文',
  stale: '原文已变化，正在更新正文', login_required: '需要在原网站登录', failed: '正文获取失败',
} as const

function readerTime(value: number): string {
  const date = new Date(value)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

// 阅读：返回与操作放在画布顶栏，内容框里只留一条安静的阅读栏；整理与关联在正文之后。
export default function RSSArticleReader({ item, expectedRevision, reveal, onClose, onOpened, onToggleStar, onBodyLoaded, notice, active = true, definitions = [], onSelectRelated, onOpenOriginal }: RSSArticleReaderProps) {
  const [content, setContent] = useState<RSSArticleExcerpt | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [reload, setReload] = useState(0)
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false)
  const forceReload = useRef(false)
  const [headings, setHeadings] = useState<Array<{ title: string; level: number }>>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  const referenceMenuRef = useRef<HTMLDivElement>(null)
  const mediaKind = describeRSSMedia(item.link, item.coverImage).kind
  const video = mediaKind === 'video', image = mediaKind === 'image'

  useEffect(() => {
    const controller = new AbortController()
    const force = forceReload.current
    forceReload.current = false
    // A query readback may acknowledge the body this reader has just loaded.
    if (!force && item.revision && content?.article.revision === item.revision && !content.body.fetching) { setBusy(false); return }
    const api = window.electronAPI.rss
    setContent(null)
    setError(null)
    setBusy(true)
    void (async () => {
      try {
        let saved = await readSavedRSSArticle(api, item.id, controller.signal, expectedRevision)
        setContent(saved)
        if (!expectedRevision && !video && !image && (force || saved.body.fetching || ['missing', 'stale', 'loading'].includes(saved.body.status))) {
          const fetched = await api.loadArticle({ itemId: item.id, force })
          controller.signal.throwIfAborted()
          saved = await readSavedRSSArticle(api, item.id, controller.signal, expectedRevision)
          setContent(saved)
          await onBodyLoaded?.(saved.article)
          controller.signal.throwIfAborted()
          if (!fetched.success) setError(fetched.error || '正文获取失败，仍可阅读来源摘要或打开原文。')
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message === 'article_changed' ? expectedRevision ? '引用文章已变化，无法打开指定版本。刊物仍保留当时的摘句。' : '文章读取期间发生变化，请重新读取。' : message)
        }
      } finally {
        if (!controller.signal.aborted) setBusy(false)
      }
    })()
    return () => controller.abort()
  }, [item.id, item.revision, item.title, item.link, item.summary, reload, video, image, expectedRevision])

  useEffect(() => {
    if (content?.article.id === item.id && !content.article.read) void onOpened(item.id)
  }, [content?.article.id, content?.article.read, item.id, onOpened])

  useEffect(() => {
    const nodes = bodyRef.current?.querySelectorAll<HTMLElement>('[data-ready-heading-level]')
    setHeadings(Array.from(nodes || []).map((node) => ({ title: node.dataset.readyHeadingTitle || '', level: Number(node.dataset.readyHeadingLevel) })))
  }, [content])

  useEffect(() => {
    if (!active || !reveal || !content || content.article.id !== item.id || content.article.revision !== expectedRevision || !bodyRef.current) return
    try { revealReadingRange(bodyRef.current, reveal.range) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [active, reveal?.id, content?.article.revision, item.id, expectedRevision])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!referenceMenuOpen) return
    const close = (event: MouseEvent) => { if (!referenceMenuRef.current?.contains(event.target as Node)) setReferenceMenuOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [referenceMenuOpen])

  useEffect(() => { if (!active) setReferenceMenuOpen(false) }, [active])

  const openLink = useCallback((href: string) => { void openWebpageInBrowser(href) }, [])
  const article = content?.article
  const title = article?.title || item.title
  const date = article?.publishedAt ?? article?.collectedAt
  const author = article?.author || item.author
  const source = article?.source || item.source
  const included = (article?.classifications || item.classifications || []).filter((entry) => entry.included)
  const closeReferenceMenu = () => setReferenceMenuOpen(false)

  return <section className="rss-article-reader" aria-label="资讯阅读" data-rss-article-id={item.id}>
    <RSSTopbarTools slot="lead" show={active}>
      <button type="button" className="rss-topbar__back" onClick={onClose}><ArrowLeft size={14} strokeWidth={2} />返回列表</button>
      <span title={source}>{source}</span>
    </RSSTopbarTools>
    <RSSTopbarTools show={active}>
      <div ref={referenceMenuRef} className="relative">
        <button type="button" className="rss-btn" aria-haspopup="menu" aria-expanded={referenceMenuOpen} disabled={busy && !content}
          onMouseDown={(event) => event.preventDefault()} onClick={() => setReferenceMenuOpen((open) => !open)} title="把这篇文章、所选文字或当前段落交给助手">
          <MessageSquareQuote size={15} strokeWidth={1.8} />引用<ChevronDown size={12} strokeWidth={2} />
        </button>
        {referenceMenuOpen && <LiquidFloatingPanel className="rss-reference-menu-panel overflow-hidden rounded-[14px]" role="menu" radius={14}
          style={{ ...chatMenuSurfaceStyle, position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30, width: 200 }}>
          <div className="rss-menu">
            <RSSReferenceButton className="rss-menu-item ready-floating-menu-item" name={title} label="引用文章" disabled={busy} onDone={closeReferenceMenu}
              reference={article ? { kind: 'article', read: { itemId: article.id, expectedRevision: article.revision, offset: 0, length: 12000 } } : null} />
            {article && <RSSSelectionReferences bodyRef={bodyRef} article={article} active={active && !busy} className="rss-menu-item ready-floating-menu-item" onDone={closeReferenceMenu} />}
          </div>
        </LiquidFloatingPanel>}
      </div>
      <button type="button" className="rss-btn rss-btn--icon" title={item.starred ? '取消收藏' : '收藏文章'} aria-label={item.starred ? '取消收藏' : '收藏文章'} aria-pressed={item.starred} onClick={() => onToggleStar(item.id)}>
        <Star size={16} strokeWidth={1.8} fill={item.starred ? 'currentColor' : 'none'} />
      </button>
      <button type="button" className="rss-btn rss-btn--icon" disabled={!content} aria-label={copied ? '已复制' : '复制内容'} title={copied ? '已复制' : '复制标题、来源与正文'}
        onClick={() => { if (content) void copyTextToClipboard(`${title}\n来源：${article?.link || item.link}\n\n${content.text}`).then(setCopied) }}>
        {copied ? <Check size={16} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.8} />}
      </button>
      <RSSSaveNoteButton article={content?.article || null} disabled={busy} active={active} onError={setError} />
      <span className="rss-tool-gap" />
      {onOpenOriginal && item.link && <button type="button" className="rss-btn" onClick={() => onOpenOriginal(item)}>打开原文<ArrowUpRight size={14} strokeWidth={1.9} /></button>}
    </RSSTopbarTools>
    <div className="rss-reader-layout">
      {headings.length > 0 && <nav className="rss-reader-toc" aria-label="本文目录">
        <p>本文目录</p>
        {headings.map((heading, index) => <button type="button" key={index} style={{ paddingLeft: `${Math.min(heading.level - 1, 3) * 12}px` }} onClick={() => bodyRef.current?.querySelectorAll('[data-ready-heading-level]')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{heading.title}</button>)}
      </nav>}
      <article className="rss-reader-content">
        <p className="rss-reader-source">
          <strong>{source}</strong>
          {author && author !== source ? <span>· {author}</span> : null}
          {date != null ? <span>· {article?.publishedAt == null ? '收录于 ' : ''}{readerTime(date)}</span> : null}
        </p>
        <h1 className="rss-reader-title">{title}</h1>
        {included.length > 0 && <div className="rss-reader-tags">{included.map((entry) => <span key={entry.definitionId} className="rss-tag" title={entry.reason}>{entry.name}</span>)}</div>}
        <div className="rss-reader-status" role="status">
          <span>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {content ? `${content.textKind === 'source_summary' ? '来源摘要 · ' : ''}${BODY_LABELS[content.body.status]}` : busy ? '正在读取文章' : '文章读取失败'}
          </span>
          {!video && !image && <button type="button" disabled={busy || !!expectedRevision} title={expectedRevision ? '刊物引用保留对应版本；可返回资讯列表获取新正文。' : undefined}
            onClick={() => { forceReload.current = true; setReload((value) => value + 1) }}><RefreshCw size={12} strokeWidth={2} />重新获取正文</button>}
        </div>
        {(!expectedRevision || content) && <RSSCoverImage link={article?.link || item.link} coverImage={article ? article.coverImage : item.coverImage} />}
        <RssTimeHintBanner itemId={item.id} title={title} summary={article?.summary || item.summary} author={author} />
        {expectedRevision && content && <p className="rss-reader-notice" role="status">此处按引用版本阅读；获取最新内容请返回列表。</p>}
        {video && <p className="rss-reader-notice">视频资讯：下方为来源提供的文字。观看、转录和视觉分析需使用对应操作。</p>}
        {image && <p className="rss-reader-notice">图片资讯：下方为已有文字与图片引用，查看图片不会自动进行画面分析。</p>}
        {content?.body.fetching && <p className="rss-reader-notice" role="status">正在获取正文，已有内容仍可阅读。</p>}
        {content?.body.error && ['ready', 'partial'].includes(content.body.status) && <p className="rss-reader-notice" role="alert">重新获取未完成，已保留上次保存的正文。{content.body.error}</p>}
        {(error || notice || content?.body.status === 'partial' || content?.body.status === 'login_required') && <p className="rss-reader-notice" role="alert">{error || notice || (content?.body.status === 'partial' ? '目前仅获取到部分正文，请打开原文查看完整内容。' : '请先打开原文登录，再重新获取正文。')}</p>}
        <div className="note-preview-body rss-reader-body" ref={bodyRef}>
          {content && <MarkdownContent readingAnchors content={content.text} externalBaseUrl={content.body.sourceUrl || article?.link || item.link} onOpenLink={openLink} />}
        </div>
        {content && <div className="rss-reader-extras">
          <p>整理与关联</p>
          {definitions.length > 0 && <RSSMembershipEditor article={content.article} definitions={definitions} active={active} />}
          <RSSEventPanel article={content.article} active={active} onSelect={onSelectRelated} />
        </div>}
      </article>
    </div>
  </section>
}
