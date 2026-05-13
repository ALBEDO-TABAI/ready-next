import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  ExternalLink,
} from 'lucide-react'
import { browserTabActivationSequencer } from '../../modules/browser/browserTabActivationSequencer'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useMode } from '../../stores/useMode'
import { EBOOK_MARKDOWN_MARKER } from '../../../shared/ebook'
import {
  buildStructuredNotePreview,
  resolvePreviewReference,
  type PreviewBlock,
  type PreviewEmbed,
  type PreviewProperty,
  type PreviewTag,
} from './note-preview-parser'
import DocumentWidgetCardShell from './DocumentWidgetCardShell'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import { getDocumentWidgetRenderBudget, getWidgetPersistenceKey } from './widget-card-helpers'
import WidgetRenderer from './WidgetRenderer'

interface NotePreviewProps {
  content: string
  notePath?: string | null
  focusWidgetTitle?: string | null
  onWidgetRename?: (currentTitle: string, widgetCode: string, nextTitle: string) => void
  onWidgetQuote?: (title: string, widgetCode: string) => void
  onWidgetExport?: (title: string, widgetCode: string, widgetState?: DocumentWidgetPersistedState | null) => void
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
      style={{
        background: copied ? 'rgba(52, 211, 153, 0.14)' : 'var(--color-blue-light)',
        color: copied ? 'var(--color-green)' : 'var(--color-blue)',
      }}
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

function MediaEmbed({
  embed,
  onOpen,
}: {
  embed: PreviewEmbed
  onOpen: (href: string, localPath?: string | null) => void
}) {
  if (embed.kind === 'youtube') {
    return <YouTubeCard embed={embed} onOpen={onOpen} />
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
      />
      {(embed.alt || embed.title) ? (
        <figcaption className="note-preview-image-caption">{embed.alt || embed.title}</figcaption>
      ) : null}
    </figure>
  )
}

export default function NotePreview({
  content,
  notePath,
  focusWidgetTitle,
  onWidgetRename,
  onWidgetQuote,
  onWidgetExport,
  onWidgetStateChange,
  widgetStates,
}: NotePreviewProps) {
  const [copiedChipId, setCopiedChipId] = useState<string | null>(null)
  const isEbookMarkdown = content.includes(EBOOK_MARKDOWN_MARKER)
  const displayContent = useMemo(() => (
    isEbookMarkdown
      ? content.split(EBOOK_MARKDOWN_MARKER).join('').replace(/^\s*\n/, '')
      : content
  ), [content, isEbookMarkdown])
  const preview = useMemo(() => buildStructuredNotePreview(displayContent, notePath), [displayContent, notePath])
  const widgetRenderBudget = useMemo(() => getDocumentWidgetRenderBudget(displayContent), [displayContent])
  const embedsById = useMemo(
    () => new Map(preview.embeds.map((embed) => [embed.id, embed])),
    [preview.embeds],
  )
  const widgetsById = useMemo(
    () => new Map(preview.widgets.map((widget) => [widget.id || '', widget])),
    [preview.widgets],
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
    if (localPath && window.electronAPI?.document?.openPath) {
      await window.electronAPI.document.openPath(localPath)
      return
    }

    if (window.electronAPI?.browser?.createTab) {
      const result = await window.electronAPI.browser.createTab(href)
      if (result?.success && result.tabId) {
        const browserTabs = useBrowserTabs.getState()
        if (!browserTabs.tabs.some((tab) => tab.id === result.tabId)) {
          browserTabs.addTab({
            id: result.tabId,
            url: href,
            title: result.title || href,
            loading: true,
            canGoBack: false,
            canGoForward: false,
          })
        }
        browserTabActivationSequencer.invalidate()
        browserTabs.setActiveTabId(result.tabId)
        browserTabs.setUrlInput(href)
        useMode.getState().setWorkbenchMode('browser')
        return
      }
    }

    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleCopyChip = useCallback(async (value: string, id: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedChipId(id)
    } catch {
      setCopiedChipId(null)
    }
  }, [])

  const renderMarkdownBlock = useCallback((block: Extract<PreviewBlock, { type: 'markdown' }>) => (
    <ReactMarkdown
      key={block.id}
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="note-preview-markdown-h1">{children}</h1>,
        h2: ({ children }) => <h2 className="note-preview-markdown-h2">{children}</h2>,
        h3: ({ children }) => <h3 className="note-preview-markdown-h3">{children}</h3>,
        h4: ({ children }) => <h4 className="note-preview-markdown-h4">{children}</h4>,
        p: ({ children }) => <p className="note-preview-markdown-p">{children}</p>,
        em: ({ children, node: _node, ...props }) => <em className="note-preview-markdown-em" {...props}>{children}</em>,
        hr: () => <hr className="note-preview-markdown-hr" />,
        blockquote: ({ children }) => <blockquote className="note-preview-markdown-quote">{children}</blockquote>,
        ul: ({ children }) => <ul className="note-preview-markdown-ul">{children}</ul>,
        ol: ({ children }) => <ol className="note-preview-markdown-ol">{children}</ol>,
        li: ({ children }) => <li className="note-preview-markdown-li">{children}</li>,
        table: ({ children, node: _node, ...props }) => (
          <div className="note-preview-table-scroll" data-note-preview-table="true">
            <table className="note-preview-markdown-table" {...props}>{children}</table>
          </div>
        ),
        thead: ({ children, node: _node, ...props }) => <thead className="note-preview-markdown-thead" {...props}>{children}</thead>,
        tbody: ({ children, node: _node, ...props }) => <tbody className="note-preview-markdown-tbody" {...props}>{children}</tbody>,
        tr: ({ children, node: _node, ...props }) => <tr className="note-preview-markdown-tr" {...props}>{children}</tr>,
        th: ({ children, node: _node, className, ...props }) => (
          <th className={className ? `${className} note-preview-markdown-th` : 'note-preview-markdown-th'} {...props}>
            {children}
          </th>
        ),
        td: ({ children, node: _node, className, ...props }) => (
          <td className={className ? `${className} note-preview-markdown-td` : 'note-preview-markdown-td'} {...props}>
            {children}
          </td>
        ),
        pre: ({ children }) => <pre className="note-preview-markdown-pre">{children}</pre>,
        code: ({ children, className, ...props }) => (
          <code className={className ? `${className} note-preview-markdown-code` : 'note-preview-markdown-code'} {...props}>
            {children}
          </code>
        ),
        a: ({ href, children }) => {
          const reference = href || ''
          const resolved = resolvePreviewReference(reference, notePath)
          return (
            <a
              href={resolved.resolvedUrl}
              className="note-preview-markdown-link"
              onClick={(event) => {
                event.preventDefault()
                void openHref(resolved.resolvedUrl, resolved.localPath)
              }}
            >
              <span>{children}</span>
              <ExternalLink style={{ width: 11, height: 11 }} strokeWidth={2} />
            </a>
          )
        },
        img: ({ src, alt }) => {
          const reference = src || ''
          const resolved = resolvePreviewReference(reference, notePath)
          return (
            <img
              src={resolved.resolvedUrl}
              alt={alt || 'embedded media'}
              className="note-preview-image"
            />
          )
        },
      }}
    >
      {block.markdown}
    </ReactMarkdown>
  ), [notePath, openHref])

  return (
    <div className={isEbookMarkdown ? 'note-preview-shell note-preview-shell--ebook' : 'note-preview-shell'}>
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

      {preview.heroEmbed ? (
        <div className="note-preview-hero">
          <MediaEmbed embed={preview.heroEmbed} onOpen={openHref} />
        </div>
      ) : null}

      <div className="note-preview-body">
        {preview.blocks.map((block) => {
          if (block.type === 'markdown') {
            return renderMarkdownBlock(block)
          }

          if (block.type === 'chips') {
            return (
              <div key={block.id} className="note-preview-chip-group note-preview-inline-chip-block">
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
            return <MediaEmbed key={block.id} embed={embed} onOpen={openHref} />
          }

          if (block.type === 'widget') {
            const widget = widgetsById.get(block.widgetId)
            if (!widget) return null
            const widgetState = widgetStates?.[getWidgetPersistenceKey(widget.title || 'widget', widget.widgetCode)] || widget.widgetState || null
            return (
              <DocumentWidgetCardShell
                key={block.id}
                title={widget.title || 'widget'}
                onRenameTitle={onWidgetRename ? (nextTitle) => onWidgetRename(widget.title || 'widget', widget.widgetCode, nextTitle) : undefined}
                onQuote={onWidgetQuote ? () => onWidgetQuote(widget.title || 'widget', widget.widgetCode) : undefined}
                onExport={onWidgetExport ? () => onWidgetExport(widget.title || 'widget', widget.widgetCode, widgetState) : undefined}
                dataReadyWidgetTitle={widget.title || ''}
                previewClassName="ready-doc-widget-card-preview ready-doc-widget-card-preview-static"
              >
                <WidgetRenderer
                  title={widget.title}
                  widgetCode={widget.widgetCode}
                  preferManualPreview={widgetRenderBudget.forceManualPreviewAll}
                  widgetState={widgetState}
                  onWidgetStateChange={onWidgetStateChange ? (state) => onWidgetStateChange(widget.title || 'widget', widget.widgetCode, state) : undefined}
                />
              </DocumentWidgetCardShell>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}
