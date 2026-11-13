import { highlightReadingSelection, readingSelectionCapture, revealReadingRange, selectedReadingRange } from '../../modules/rss/reading-selection'
import type { RSSReadingRange } from '../../../shared/rss-reading'
import type { RSSDefinition } from '../../../shared/rss-organization'
import RSSMembershipEditor from './RSSMembershipEditor'
import RSSEventPanel from './RSSEventPanel'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, Copy, Inbox, Loader2, MessageSquareQuote, RefreshCw, Shapes, Star, TextQuote } from 'lucide-react'
import { MarkdownContent, copyTextToClipboard } from '../document/MarkdownContent'
import { readSavedRSSArticle, isOutdatedRSSExtraction } from '../../modules/rss/read-article'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { describeRSSMedia, rssVideoEmbed } from '../../../shared/rss-media'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import type { RSSItem } from './RSSFeed'
import RssTimeHintBanner from './RssTimeHintBanner'
import RSSSaveNoteButton from './RSSSaveNoteButton'
import RSSCoverImage from './RSSCoverImage'
import RSSTopbarTools from './RSSTopbarTools'
import { RSSTranslatedBody, RSSTranslationControl } from './RSSTranslationControl'
import { rssReaderHeadings, useRSSArticleTranslation } from '../../modules/rss/article-translation'
import { RefCapsule } from '../ui/RefCapsule'
import { ReadyRefSchema } from '../../../shared/ready-ref'
import { anchorOf } from '../ui/float/float-store'
import { openMenu } from '../ui/float/open-menu'
import { Button, IconButton } from '../ui/Button'
import { addRSSReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import { useSelectionBar } from '../../modules/workbench/selection-bar/open-selection-bar'
import type { CaptureSelection } from '../../modules/workbench/capture'
import { askAboutSelection, receiveToCanvas, receiveToDocument, receiveToFastCard, reportCaptureError } from '../../modules/workbench/capture-receipt'

// Items re-extracted in this session; a page that still extracts badly is not fetched again on every open.
const reextracted = new Set<string>()

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
  const forceReload = useRef(false)
  const [headings, setHeadings] = useState<Array<{ title: string; level: number }>>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  const mediaKind = describeRSSMedia(item.link, item.coverImage).kind
  const video = mediaKind === 'video', image = mediaKind === 'image'
  const embed = rssVideoEmbed(item.link, item.summary)
  // Quotes, copies and the assistant always take the source; a reference version is read as quoted.
  const translation = useRSSArticleTranslation(content, !expectedRevision && !video && !image)

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
        // A body extracted the old way re-reads once per session, as if the user had asked to fetch it again.
        const outdated = !expectedRevision && !force && ['ready', 'partial'].includes(saved.body.status) && !reextracted.has(item.id) && isOutdatedRSSExtraction(saved.text)
        if (outdated) reextracted.add(item.id)
        else setContent(saved)
        if (!expectedRevision && !video && !image && (force || outdated || saved.body.fetching || ['missing', 'stale', 'loading'].includes(saved.body.status))) {
          const fetched = await api.loadArticle({ itemId: item.id, force: force || outdated })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content is read only to skip reloading a body this reader already holds for the item's revision, and onBodyLoaded is a completion notification (RSSMode passes a stable callback); re-running on either would refetch after every setContent
  }, [item.id, item.revision, item.title, item.link, item.summary, reload, video, image, expectedRevision])

  useEffect(() => {
    if (content?.article.id === item.id && !content.article.read) void onOpened(item.id)
  }, [content?.article.id, content?.article.read, item.id, onOpened])

  useEffect(() => {
    setHeadings(rssReaderHeadings(bodyRef.current).map((node) => ({ title: node.dataset.readyHeadingTitle || '', level: Number(node.dataset.readyHeadingLevel) })))
  }, [content, translation.view, translation.translation])

  useEffect(() => {
    if (!active || !reveal || !content || content.article.id !== item.id || content.article.revision !== expectedRevision || !bodyRef.current) return
    try { revealReadingRange(bodyRef.current, reveal.range) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on reveal.id and the loaded revision: each reveal request carries a fresh id with its own range, and content is only checked for a match, so new object identities on re-render must not scroll the reader again
  }, [active, reveal?.id, content?.article.revision, item.id, expectedRevision])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const openLink = useCallback((href: string) => { void openWebpageInBrowser(href) }, [])
  const article = content?.article
  const title = article?.title || item.title
  const date = article?.publishedAt ?? article?.collectedAt
  const author = article?.author || item.author
  const source = article?.source || item.source
  // 出处: the source names the original page, a reference capsule that opens it in Ready's browser (W6 §2.1).
  const originalLink = article?.link || item.link
  const originalRef = originalLink ? ReadyRefSchema.safeParse({ kind: 'web', url: originalLink }).data ?? null : null
  const included = (article?.classifications || item.classifications || []).filter((entry) => entry.included)
  // Selections in the source text share the reading scenes' bar (W6 §3.2); a translation has no reading ranges.
  const readSelection = () => bodyRef.current && article ? readingSelectionCapture(bodyRef.current, article, window.getSelection()) : null
  useSelectionBar(bodyRef, { enabled: active && !busy && !!article && translation.view === 'source', read: readSelection,
    highlight: () => highlightReadingSelection(readSelection()),
    // The composer names a selection as 引用本段 names a paragraph: the article, then its scope.
    ask: async () => {
      const selection = readSelection()
      if (!selection) throw new Error('选区已经变了，请重新选择文字')
      await askAboutSelection({ ...selection, title: `${selection.title} · 选区` })
    } })
  // 收下 the whole article: its summary (or the opening of its text) with the article as the source.
  const articleCapture = (): CaptureSelection => {
    if (!article || !content) throw new Error('文章还没有读出来')
    return { ref: { kind: 'rss-item', id: article.id }, title: article.title, text: article.summary.trim() || content.text.replace(/\s+/g, ' ').trim().slice(0, 280) }
  }
  const openCaptureMenu = (element: HTMLElement) => openMenu(anchorOf(element), [
    { id: 'fastcard', label: '存入 FastCard', icon: <Inbox />, onSelect: () => { void receiveToFastCard(articleCapture()).catch(reportCaptureError) } },
    { id: 'canvas', label: '保存到画板', icon: <Shapes />, onSelect: () => { void receiveToCanvas(articleCapture()).catch(reportCaptureError) } },
    { id: 'document', label: '引用到文档', icon: <TextQuote />, onSelect: () => { void receiveToDocument(articleCapture()).catch(reportCaptureError) } },
  ], { placement: 'bottom-end', label: '收下这篇文章' })
  // 引用: the article, or the paragraph the selection sits in (read before the menu takes focus).
  const openReferenceMenu = (element: HTMLElement) => {
    const paragraph: RSSReadingRange | null = bodyRef.current && translation.view === 'source' ? selectedReadingRange(bodyRef.current, window.getSelection()).paragraph : null
    openMenu(anchorOf(element), [
      { id: 'article', label: '引用文章', icon: <MessageSquareQuote />, disabled: busy || !article,
        onSelect: () => { if (article) addRSSReferenceToAgentInput(title, { kind: 'article', read: { itemId: article.id, expectedRevision: article.revision, offset: 0, length: 12000 } }) } },
      ...(article ? [{ id: 'paragraph', label: '引用本段', icon: <MessageSquareQuote />, disabled: !paragraph,
        onSelect: () => { if (paragraph) addRSSReferenceToAgentInput(`${article.title} · 段落`, { kind: 'excerpt', read: { format: 'reading-v1', itemId: article.id, expectedRevision: article.revision, range: paragraph, offset: 0, length: 12000 } }) } }] : []),
    ], { placement: 'bottom-end', label: '把这篇文章或当前段落交给助手' })
  }

  return <section className="rss-article-reader" aria-label="资讯阅读" data-rss-article-id={item.id} data-navigation-loaded={!!content && !busy}>
    <RSSTopbarTools slot="lead" show={active}>
      {/* A breadcrumb, not a second back arrow: the way back across modes is the entry before it (W6 §4). */}
      <Button variant="ghost" size="sm" className="rss-topbar__back" aria-label="回到资讯列表" title="回到列表" onClick={onClose}>资讯</Button>
      <span className="rss-topbar__sep" aria-hidden>/</span>
      <span title={source}>{source}</span>
    </RSSTopbarTools>
    <RSSTopbarTools show={active}>
      <Button variant="ghost" size="sm" icon={<MessageSquareQuote />} aria-haspopup="menu" disabled={busy && !content}
        onMouseDown={(event) => event.preventDefault()} onClick={(event) => openReferenceMenu(event.currentTarget)} title="把这篇文章或当前段落交给助手">
        引用<ChevronDown className="rss-btn-caret" />
      </Button>
      <Button variant="ghost" size="sm" icon={<Inbox />} aria-haspopup="menu" disabled={!content} onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => openCaptureMenu(event.currentTarget)} title="把这篇文章存入 FastCard、画板或当前文档">
        收下<ChevronDown className="rss-btn-caret" />
      </Button>
      <RSSTranslationControl state={translation} disabled={busy} />
      <span className="rss-topbar__divider" aria-hidden />
      <IconButton icon={<Star fill={item.starred ? 'currentColor' : 'none'} />} title={item.starred ? '取消收藏' : '收藏文章'} active={item.starred} onClick={() => onToggleStar(item.id)} />
      <IconButton disabled={!content} icon={copied ? <Check /> : <Copy />} title={copied ? '已复制' : '复制标题、来源与正文'} aria-label={copied ? '已复制' : '复制内容'}
        onClick={() => { if (content) void copyTextToClipboard(`${title}\n来源：${article?.link || item.link}\n\n${content.text}`).then(setCopied) }} />
      <RSSSaveNoteButton article={content?.article || null} disabled={busy} active={active} onError={setError} />
      {onOpenOriginal && item.link && <>
        <span className="rss-topbar__divider" aria-hidden />
        <Button variant="ghost" size="sm" onClick={() => onOpenOriginal(item)}>打开原文<ArrowUpRight /></Button>
      </>}
    </RSSTopbarTools>
    <div className="rss-reader-layout">
      {headings.length > 0 && <nav className="rss-reader-toc" aria-label="本文目录">
        <p>本文目录</p>
        {headings.map((heading, index) => <button type="button" key={index} style={{ paddingLeft: `${Math.min(heading.level - 1, 3) * 12}px` }} onClick={() => rssReaderHeadings(bodyRef.current)[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{heading.title}</button>)}
      </nav>}
      <article className="rss-reader-content">
        <p className="rss-reader-source">
          {originalRef ? <RefCapsule reference={originalRef} title={source} /> : <strong>{source}</strong>}
          {author && author !== source ? <span>· {author}</span> : null}
          {date != null ? <span>· {article?.publishedAt == null ? '收录于 ' : ''}{readerTime(date)}</span> : null}
        </p>
        <h1 className="rss-reader-title">{title}</h1>
        {included.length > 0 && <div className="rss-reader-tags">{included.map((entry) => <span key={entry.definitionId} className="rss-tag" title={entry.reason}>{entry.name}</span>)}</div>}
        <div className="rss-reader-status" role="status">
          <span>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {content ? `${content.textKind === 'source_summary' ? '来源摘要 · ' : ''}${BODY_LABELS[content.body.status]}` : busy ? '正在读取文章' : '文章读取失败'}
          </span>
          {!video && !image && <Button variant="ghost" size="sm" icon={<RefreshCw />} disabled={busy || !!expectedRevision} title={expectedRevision ? '刊物引用保留对应版本；可返回资讯列表获取新正文。' : undefined}
            onClick={() => { forceReload.current = true; setReload((value) => value + 1) }}>重新获取正文</Button>}
        </div>
        {embed ? <figure className="rss-reader-video">
          <iframe src={embed.embedUrl} title={`${title}（视频）`} loading="lazy" referrerPolicy="strict-origin-when-cross-origin"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" allowFullScreen />
        </figure> : (!expectedRevision || content) && <RSSCoverImage link={article?.link || item.link} coverImage={article ? article.coverImage : item.coverImage} />}
        <RssTimeHintBanner itemId={item.id} title={title} summary={article?.summary || item.summary} author={author} />
        {expectedRevision && content && <p className="rss-reader-notice" role="status">此处按引用版本阅读；获取最新内容请返回列表。</p>}
        {video && <p className="rss-reader-notice">{embed ? '视频可直接在上方播放；下方是来源提供的文字，转录和画面分析需使用对应操作。' : '视频资讯：下方为来源提供的文字。观看、转录和视觉分析需使用对应操作。'}</p>}
        {image && <p className="rss-reader-notice">图片资讯：下方为已有文字与图片引用，查看图片不会自动进行画面分析。</p>}
        {content?.body.fetching && <p className="rss-reader-notice" role="status">正在获取正文，已有内容仍可阅读。</p>}
        {content?.body.error && ['ready', 'partial'].includes(content.body.status) && <p className="rss-reader-notice" role="alert">重新获取未完成，已保留上次保存的正文。{content.body.error}</p>}
        {(error || notice || content?.body.status === 'partial' || content?.body.status === 'login_required') && <p className="rss-reader-notice" role="alert">{error || notice || (content?.body.status === 'partial' ? '目前仅获取到部分正文，请打开原文查看完整内容。' : '请先打开原文登录，再重新获取正文。')}</p>}
        <div className="note-preview-body rss-reader-body" ref={bodyRef}>
          {content && (translation.translation && translation.view !== 'source'
            ? <RSSTranslatedBody body={content.text} translation={translation.translation} bilingual={translation.view === 'bilingual'}
              externalBaseUrl={content.body.sourceUrl || article?.link || item.link} onOpenLink={openLink} />
            : <MarkdownContent readingAnchors content={content.text} externalBaseUrl={content.body.sourceUrl || article?.link || item.link} onOpenLink={openLink} />)}
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
