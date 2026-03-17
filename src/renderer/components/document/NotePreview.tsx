import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  ExternalLink,
} from 'lucide-react'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useMode } from '../../stores/useMode'
import {
  buildStructuredNotePreview,
  resolvePreviewReference,
  type PreviewBlock,
  type PreviewEmbed,
  type PreviewProperty,
  type PreviewTag,
} from './note-preview-parser'
import WidgetRenderer from './WidgetRenderer'

interface NotePreviewProps {
  content: string
  notePath?: string | null
  focusWidgetTitle?: string | null
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

export default function NotePreview({ content, notePath, focusWidgetTitle }: NotePreviewProps) {
  const [copiedChipId, setCopiedChipId] = useState<string | null>(null)
  const preview = useMemo(() => buildStructuredNotePreview(content, notePath), [content, notePath])
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
        hr: () => <hr className="note-preview-markdown-hr" />,
        blockquote: ({ children }) => <blockquote className="note-preview-markdown-quote">{children}</blockquote>,
        ul: ({ children }) => <ul className="note-preview-markdown-ul">{children}</ul>,
        ol: ({ children }) => <ol className="note-preview-markdown-ol">{children}</ol>,
        li: ({ children }) => <li className="note-preview-markdown-li">{children}</li>,
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
    <div className="note-preview-shell">
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
            return (
              <div key={block.id} data-ready-widget-title={widget.title || ''}>
                <WidgetRenderer
                  title={widget.title}
                  widgetCode={widget.widgetCode}
                />
              </div>
            )
          }

          return null
        })}
      </div>
    </div>
  )
}
