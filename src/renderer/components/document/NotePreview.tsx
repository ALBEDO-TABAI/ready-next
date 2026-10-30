import { remarkSyncedBlocks } from '../../modules/document/annotations/inline-links'
import { createContext, useContext } from 'react'
import { SyncedBlock } from '../../modules/document/annotations/SyncedBlock'
import { InlineDatabase, parseDatabaseLink, remarkDatabaseViews } from '../../modules/document/database'
import { LibraryQuoteCard } from './LibraryQuoteCard'
import { openReadyRef } from '../../modules/workbench/open-ready-ref'
import { createMarkdownComponents, copyTextToClipboard } from './MarkdownContent'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Element as HastElement, ElementContent } from 'hast'
import ReactMarkdown, { defaultUrlTransform, type Components, type Options as MarkdownOptions } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  ExternalLink,
  Wrench,
} from 'lucide-react'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import { EBOOK_MARKDOWN_MARKER } from '../../../shared/ebook'
import {
  type PreviewEmbed,
  type PreviewProperty,
  type PreviewTag,
} from './note-preview-parser'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import { resolveDocumentWidgetRenderCode } from '../../../shared/document-widget-render-code'
import type { DocumentWidgetData } from '../../../shared/document-widget-parse'
import { getDocumentWidgetRenderBudgetFromCodes, getWidgetPersistenceKey } from './widget-card-helpers'
import DocumentWidgetPreviewBlock from './DocumentWidgetPreviewBlock'
import { ReadyBlockEditor } from '../../modules/document/block-editor/ReadyBlockEditor'
import { resolveNotePreviewModel } from '../../modules/document/notePreviewModel'
import { recordDocumentPerformanceCounter } from '../../../shared/document-performance-diagnostics'

interface NotePreviewProps {
  content: string
  notePath?: string | null
  focusWidgetTitle?: string | null
  editorTabId?: string
  widgetEditable?: boolean
  forceManualPreview?: boolean
  onWidgetRename?: (currentTitle: string, widgetCode: string, nextTitle: string) => void
  onWidgetQuote?: (title: string, widgetCode: string) => void
  onWidgetExport?: (title: string, widgetCode: string, widgetState?: DocumentWidgetPersistedState | null) => void
  onWidgetEdit?: (widget: DocumentWidgetData) => void
  onWidgetStateChange?: (title: string, widgetCode: string, widgetState: DocumentWidgetPersistedState) => void
  widgetStates?: Record<string, DocumentWidgetPersistedState>
}

function Chip({
  chip,
  copied,
  onCopy,
  onOpen,
}: {
  chip: PreviewTag
  copied: boolean
  onCopy: (value: string, id: string) => void
  onOpen: (href: string, localPath?: string | null) => void
}) {
  const isOpenable = !!chip.href

  return (
    <button
      type="button"
      onClick={() => {
        if (isOpenable && chip.href) {
          onOpen(chip.href)
          return
        }
        onCopy(chip.label, chip.id)
      }}
      className="note-preview-chip"
      title={isOpenable ? `打开 ${chip.label}` : `点击复制 ${chip.label}`}
      data-copied={copied ? 'true' : undefined}
    >
      <span>{chip.label}</span>
      {copied ? (
        <Check style={{ width: 11, height: 11 }} strokeWidth={2} />
      ) : isOpenable ? (
        <ExternalLink style={{ width: 11, height: 11 }} strokeWidth={2} />
      ) : (
        <Copy style={{ width: 11, height: 11 }} strokeWidth={2} />
      )}
    </button>
  )
}

function PropertyRow({
  property,
  copiedChipId,
  onCopyChip,
  onOpen,
}: {
  property: PreviewProperty
  copiedChipId: string | null
  onCopyChip: (value: string, id: string) => void
  onOpen: (href: string, localPath?: string | null) => void
}) {
  return (
    <div className="note-preview-property-row">
      <div className="note-preview-property-key">{property.label}</div>
      <div className="note-preview-property-value">
        {property.kind === 'chips' && property.chips ? (
          <div className="note-preview-chip-group">
            {property.chips.map((chip) => (
              <Chip
                key={chip.id}
                chip={chip}
                copied={copiedChipId === chip.id}
                onCopy={onCopyChip}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : property.kind === 'link' && property.href ? (
          (() => {
            const href = property.href
            return (
              <button
                type="button"
                className="note-preview-link-button"
                onClick={() => onOpen(href)}
                title={href}
              >
                <span>{property.displayValue}</span>
                <ExternalLink style={{ width: 12, height: 12 }} strokeWidth={2} />
              </button>
            )
          })()
        ) : (
          <span>{property.displayValue}</span>
        )}
      </div>
    </div>
  )
}

function YouTubeCard({
  embed,
  onOpen,
}: {
  embed: PreviewEmbed
  onOpen: (href: string, localPath?: string | null) => void
}) {
  const hasIframe = !!embed.embedUrl

  return (
    <div className="note-preview-youtube-card">
      <div className="note-preview-youtube-thumb-shell">
        {hasIframe ? (
          <iframe
            src={embed.embedUrl}
            title={embed.title || 'Embedded YouTube video'}
            className="note-preview-youtube-iframe"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ) : embed.thumbnailUrl ? (
          <button
            type="button"
            className="note-preview-youtube-fallback-button"
            onClick={() => onOpen(embed.url, embed.localPath)}
            title={embed.title || embed.displayUrl}
          >
            <img
              src={embed.thumbnailUrl}
              alt={embed.title || 'YouTube preview'}
              className="note-preview-youtube-thumb"
              loading="lazy"
              decoding="async"
            />
          </button>
        ) : (
          <button
            type="button"
            className="note-preview-youtube-fallback"
            onClick={() => onOpen(embed.url, embed.localPath)}
            title={embed.title || embed.displayUrl}
          >
            YouTube
          </button>
        )}
      </div>

      <div className="note-preview-youtube-meta">
        {embed.title ? (
          <button
            type="button"
            className="note-preview-youtube-title-button"
            onClick={() => onOpen(embed.url, embed.localPath)}
          >
            <span className="note-preview-youtube-title">{embed.title}</span>
            <ExternalLink style={{ width: 13, height: 13 }} strokeWidth={2} />
          </button>
        ) : null}

        <div className="note-preview-youtube-subline">
          {embed.channel ? <span>{embed.channel}</span> : null}
          {embed.published ? <span>{embed.published}</span> : null}
          {embed.duration ? <span>{embed.duration}</span> : null}
        </div>
      </div>
    </div>
  )
}

function BilibiliCard({
  embed,
  onOpen,
}: {
  embed: PreviewEmbed
  onOpen: (href: string, localPath?: string | null) => void
}) {
  // Reuses the YouTube card frame because the visual contract is identical
  // (16:9 iframe + open-in-browser fallback). The trust origin is checked
  // upstream in `extractBilibiliEmbed` — we only mount embedUrl that came
  // from a `player.bilibili.com/player.html?...` source.
  return (
    <div className="note-preview-youtube-card">
      <div className="note-preview-youtube-thumb-shell">
        {embed.embedUrl ? (
          <iframe
            src={embed.embedUrl}
            title={embed.title || `Bilibili video ${embed.videoId || ''}`}
            className="note-preview-youtube-iframe"
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            className="note-preview-youtube-fallback"
            onClick={() => onOpen(embed.url, embed.localPath)}
            title={embed.title || embed.displayUrl}
          >
            Bilibili
          </button>
        )}
      </div>
      <div className="note-preview-youtube-meta">
        <button
          type="button"
          className="note-preview-youtube-title-button"
          onClick={() => onOpen(embed.url, embed.localPath)}
        >
          <span className="note-preview-youtube-title">
            {embed.title || embed.videoId || '哔哩哔哩视频'}
          </span>
          <ExternalLink style={{ width: 13, height: 13 }} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

interface MediaEmbedProps {
  embed: PreviewEmbed
  onOpen: (href: string, localPath?: string | null) => void
}

const PREVIEW_EMBED_FIELDS: ReadonlyArray<keyof PreviewEmbed> = [
  'id', 'kind', 'source', 'url', 'displayUrl', 'embedUrl', 'videoId',
  'thumbnailUrl', 'title', 'channel', 'published', 'duration', 'alt',
  'localPath', 'isLocal',
]

export function arePreviewEmbedPropsEqual(previous: MediaEmbedProps, next: MediaEmbedProps): boolean {
  return previous.onOpen === next.onOpen
    && PREVIEW_EMBED_FIELDS.every((field) => previous.embed[field] === next.embed[field])
}

const MediaEmbed = memo(function MediaEmbed({
  embed,
  onOpen,
}: MediaEmbedProps) {
  if (embed.kind === 'library-quote') return <LibraryQuoteCard raw={embed.url} />
  if (embed.kind === 'youtube') {
    return <YouTubeCard embed={embed} onOpen={onOpen} />
  }

  if (embed.kind === 'bilibili') {
    return <BilibiliCard embed={embed} onOpen={onOpen} />
  }

  if (embed.kind === 'video') {
    return (
      <div className="note-preview-media-block">
        <video
          className="note-preview-video"
          controls
          preload="metadata"
          src={embed.url}
        />
        {embed.title ? (
          <button
            type="button"
            className="note-preview-embed-caption"
            onClick={() => onOpen(embed.url, embed.localPath)}
          >
            <span>{embed.title}</span>
            <ExternalLink style={{ width: 12, height: 12 }} strokeWidth={2} />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <figure className="note-preview-media-block">
      <img
        src={embed.url}
        alt={embed.alt || embed.title || 'embedded media'}
        className="note-preview-image"
        loading="lazy"
        decoding="async"
      />
      {(embed.alt || embed.title) ? (
        <figcaption className="note-preview-image-caption">{embed.alt || embed.title}</figcaption>
      ) : null}
    </figure>
  )
}, arePreviewEmbedPropsEqual)

function BrokenWidgetFallback({ reason }: { reason: string }) {
  return (
    <div className="note-preview-widget-error" data-ready-widget-error="true">
      <div className="note-preview-widget-error__title">此信息卡已损坏</div>
      <div className="note-preview-widget-error__body">{reason}</div>
      <div className="note-preview-widget-error__actions">
        <button
          type="button"
          className="note-preview-repair-button"
          data-ready-widget-repair="true"
          onClick={() => appendToAgentInput(`请修复当前文档里损坏的信息卡。问题：${reason}`)}
        >
          <Wrench size={14} strokeWidth={2} />
          <span>让 AI 修复</span>
        </button>
        <span>也可以切到编辑模式手动修复。</span>
      </div>
    </div>
  )
}

const SyncedPathContext = createContext<string | null>(null)

const MarkdownPreviewBlock = memo(function MarkdownPreviewBlock({
  markdown,
  components,
  remarkPlugins,
}: {
  markdown: string
  components: Components
  remarkPlugins: MarkdownOptions['remarkPlugins']
}) {
  const syncedPath = useContext(SyncedPathContext)
  recordDocumentPerformanceCounter('previewBlockRenders')
  const databaseComponents = useMemo<Components>(() => {
    const Link = components.a
    const Paragraph = components.p
    const hasDatabase = (node: HastElement | ElementContent): boolean => node.type === 'element'
      && (node.tagName === 'a' && /^ready-(?:db|sync):/.test(String(node.properties.href)) || node.children.some(hasDatabase))
    return {
      ...components,
      a: ({ node, href, ...props }) => {
        const synced = /^ready-sync:([^#]*)#([\w-]+)$/.exec(href ?? '')
        if (synced) return <SyncedBlock path={syncedPath} page={decodeURIComponent(synced[1])} blockId={synced[2]} />
        const reference = parseDatabaseLink(href ?? '')
        return reference ? <InlineDatabase {...reference} /> : Link && typeof Link !== 'string' ? <Link node={node} href={href} {...props} /> : <a href={href} {...props} />
      },
      p: ({ node, ...props }) => node && hasDatabase(node) ? <div {...props} /> : Paragraph && typeof Paragraph !== 'string' ? <Paragraph node={node} {...props} /> : <p {...props} />,
    }
  }, [components, syncedPath])
  const databasePlugins = useMemo(() => [...remarkPlugins ?? [], remarkSyncedBlocks, remarkDatabaseViews], [remarkPlugins])
  return (
    <ReactMarkdown urlTransform={href => href.startsWith('ready://') || href.startsWith('ready-db:') || href.startsWith('ready-sync:') ? href : defaultUrlTransform(href)} remarkPlugins={databasePlugins} components={databaseComponents}>
      {markdown}
    </ReactMarkdown>
  )
})

const DetailsPreviewBlock = memo(function DetailsPreviewBlock({
  summary,
  markdown,
  open,
  components,
  remarkPlugins,
}: {
  summary: string
  markdown: string
  open: boolean
  components: Components
  remarkPlugins: MarkdownOptions['remarkPlugins']
}) {
  recordDocumentPerformanceCounter('previewBlockRenders')
  return (
    <details className="note-preview-details" open={open || undefined}>
      <summary className="note-preview-details-summary">{summary}</summary>
      {markdown ? (
        <div className="note-preview-details-body">
          <MarkdownPreviewBlock markdown={markdown} components={components} remarkPlugins={remarkPlugins} />
        </div>
      ) : null}
    </details>
  )
})

function NotePreview({
  content,
  notePath,
  focusWidgetTitle,
  editorTabId,
  widgetEditable = false,
  forceManualPreview = false,
  onWidgetRename,
  onWidgetQuote,
  onWidgetExport,
  onWidgetEdit,
  onWidgetStateChange,
  widgetStates,
}: NotePreviewProps) {
  const [navigationError, setNavigationError] = useState('')
  const [copiedChipId, setCopiedChipId] = useState<string | null>(null)
  const isEbookMarkdown = content.includes(EBOOK_MARKDOWN_MARKER)
  const displayContent = useMemo(() => (
    isEbookMarkdown
      ? content.split(EBOOK_MARKDOWN_MARKER).join('').replace(/^\s*\n/, '')
      : content
  ), [content, isEbookMarkdown])
  const { preview, blockRenderKeys, blockSourceLines, remarkPlugins } = useMemo(
    () => resolveNotePreviewModel(displayContent, notePath),
    [displayContent, notePath],
  )
  const canEdit = Boolean(editorTabId || widgetEditable) && !isEbookMarkdown
  const embedsById = useMemo(
    () => new Map(preview.embeds.map((embed) => [embed.id, embed])),
    [preview.embeds],
  )
  const widgetsById = useMemo(
    () => new Map(preview.widgets.map((widget) => [widget.id || '', {
      widget,
      renderCode: resolveDocumentWidgetRenderCode({
        widgetCode: widget.widgetCode,
        skeletonSpec: widget.skeletonSpec,
        componentSpec: widget.componentSpec,
      }).widgetCode,
    }])),
    [preview.widgets],
  )
  const widgetFigureIndexByBlockId = useMemo(() => {
    const indexes = new Map<string, number>()
    for (const block of preview.blocks) {
      if (block.type === 'widget') indexes.set(block.id, indexes.size + 1)
    }
    return indexes
  }, [preview.blocks])
  const widgetRenderBudget = useMemo(
    () => getDocumentWidgetRenderBudgetFromCodes([...widgetsById.values()].map((entry) => entry.renderCode)),
    [widgetsById],
  )

  useEffect(() => {
    if (!copiedChipId) return
    const timer = window.setTimeout(() => setCopiedChipId(null), 1200)
    return () => window.clearTimeout(timer)
  }, [copiedChipId])

  useEffect(() => {
    if (!focusWidgetTitle) return
    const target = document.querySelector(`[data-ready-widget-title="${focusWidgetTitle.replace(/"/g, '\\"')}"]`)
    if (!(target instanceof HTMLElement)) return
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [focusWidgetTitle, preview.widgets.length])

  const openHref = useCallback(async (href: string, localPath?: string | null) => {
    if (href.startsWith('ready://')) {
      try { setNavigationError(''); await openReadyRef(href, 'document') }
      catch (error) { setNavigationError(error instanceof Error ? error.message : String(error)) }
      return
    }
    if (localPath && window.electronAPI?.document?.openPath) {
      await window.electronAPI.document.openPath(localPath)
      return
    }

    await openWebpageInBrowser(href)
  }, [])

  const handleCopyChip = useCallback(async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedChipId(id)
    } catch {
      setCopiedChipId(null)
    }
  }, [])

  const markdownComponents = useMemo(() => createMarkdownComponents({ mode: 'document', notePath, openHref }), [notePath, openHref])

  return (
    <div
      className={isEbookMarkdown ? 'note-preview-shell note-preview-shell--ebook' : 'note-preview-shell'}
      data-ready-preview-line-count={preview.lineCount}
    >
      {preview.warnings.length > 0 ? (
        <div className="note-preview-warning">
          {preview.warnings.join('；')}
        </div>
      ) : null}

      {preview.properties.length > 0 ? (
        <section className="note-preview-properties">
          {preview.properties.map((property) => (
            <PropertyRow
              key={property.key}
              property={property}
              copiedChipId={copiedChipId}
              onCopyChip={handleCopyChip}
              onOpen={openHref}
            />
          ))}
        </section>
      ) : null}

      {navigationError && <p role="alert">{navigationError}</p>}
      {preview.heroEmbed ? (
        <div className="note-preview-hero">
          <MediaEmbed embed={preview.heroEmbed} onOpen={openHref} />
        </div>
      ) : null}

      <SyncedPathContext.Provider value={notePath ?? null}>{editorTabId && !isEbookMarkdown ? (
        <ReadyBlockEditor tabId={editorTabId} content={content} renderSource={block => block.type === 'frontmatter' ? null : (
          <NotePreview content={block.raw} notePath={notePath} widgetEditable
            forceManualPreview={widgetRenderBudget.forceManualPreviewAll}
            onWidgetRename={onWidgetRename} onWidgetQuote={onWidgetQuote} onWidgetExport={onWidgetExport}
            onWidgetEdit={onWidgetEdit} onWidgetStateChange={onWidgetStateChange} widgetStates={widgetStates} />
        )} />
      ) : <div className="note-preview-body">
        {preview.blocks.map((block) => {
          const renderBlockBody = (): ReactNode => {
            if (block.type === 'markdown') {
              return <MarkdownPreviewBlock markdown={block.markdown} components={markdownComponents} remarkPlugins={remarkPlugins} />
            }

            if (block.type === 'details') {
              return (
                <DetailsPreviewBlock
                  summary={block.summary}
                  markdown={block.markdown}
                  open={block.open}
                  components={markdownComponents}
                  remarkPlugins={remarkPlugins}
                />
              )
            }

            if (block.type === 'chips') {
              return (
                <div className="note-preview-chip-group note-preview-inline-chip-block">
                  {block.chips.map((chip) => (
                    <Chip
                      key={chip.id}
                      chip={chip}
                      copied={copiedChipId === chip.id}
                      onCopy={handleCopyChip}
                      onOpen={openHref}
                    />
                  ))}
                </div>
              )
            }

            if (block.type === 'embed') {
              const embed = embedsById.get(block.embedId)
              if (!embed) return null
              return <MediaEmbed embed={embed} onOpen={openHref} />
            }

            if (block.type === 'widget') {
              const resolvedWidget = widgetsById.get(block.widgetId)
              if (!resolvedWidget) return null
              const { widget, renderCode } = resolvedWidget
              const widgetState = widgetStates?.[getWidgetPersistenceKey(widget.title || 'widget', widget.widgetCode)] || widget.widgetState || null
              return (
                <DocumentWidgetPreviewBlock
                  renderIdentity={blockRenderKeys.get(block.id) || block.id}
                  figureIndex={widgetFigureIndexByBlockId.get(block.id) ?? null}
                  widget={widget}
                  renderCode={renderCode}
                  widgetState={widgetState}
                  widgetStateSignature={JSON.stringify(widgetState)}
                  preferManualPreview={forceManualPreview || widgetRenderBudget.forceManualPreviewAll}
                  canEdit={canEdit}
                  onWidgetRename={onWidgetRename}
                  onWidgetQuote={onWidgetQuote}
                  onWidgetExport={onWidgetExport}
                  onWidgetEdit={onWidgetEdit}
                  onWidgetStateChange={onWidgetStateChange}
                />
              )
            }

            if (block.type === 'widget_error') {
              return <BrokenWidgetFallback reason={block.reason} />
            }

            return null
          }

          const body = renderBlockBody()
          if (body === null) return null
          return (
            <div key={blockRenderKeys.get(block.id) || block.id} className="note-preview-render-block"
              data-ready-block-source-line={blockSourceLines.get(block.id)}>
              {body}
            </div>
          )
        })}

      </div>}
      </SyncedPathContext.Provider>
    </div>
  )
}

export default memo(NotePreview)
