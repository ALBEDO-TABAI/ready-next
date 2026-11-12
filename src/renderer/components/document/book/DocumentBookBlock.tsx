/**
 * DocumentBookBlock.tsx — 书页静态块渲染器。
 *
 * 与 NotePreview 同源（react-markdown + remark-gfm + note-preview-markdown-* 类名），
 * 但完全静态：无预览内编辑、无复制按钮、无 widget 活 iframe。
 * widget 解析为无脚本静态信息卡；embed 视频退化为封面卡；mermaid 以代码块呈现。
 */

import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ExternalLink, Film } from 'lucide-react'
import type { PreviewBlock, PreviewEmbed } from '../note-preview-parser'
import type { DocumentWidgetData } from '../../../../shared/document-widget-parse'
import { resolveDocumentWidgetRenderCode } from '../../../../shared/document-widget-render-code'
import { openWebpageInBrowser } from '../../../modules/browser/openWebpageInBrowser'
import { sanitizeBookWidgetStaticHtml } from '../../../modules/document/book/bookWidgetStatic'
import DocumentBookImage from './DocumentBookImage'
import { BookImageParagraphContext } from '../../../modules/document/book/bookImageLayout'

const REMARK_PLUGINS = [remarkGfm]

const BOOK_WIDGET_SHADOW_STYLE = `
  :host {
    display: block;
    contain: layout paint style;
    min-width: 0;
    max-width: 100%;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: .72em;
    line-height: 1.55;
    color: var(--book-ink);
  }
  *, *::before, *::after { box-sizing: border-box; max-width: 100%; }
  .widget-canvas, .card { min-width: 0; background: transparent !important; }
  .card { padding: 0 !important; border: 0 !important; box-shadow: none !important; }
  .stack { display: flex; flex-direction: column; min-width: 0; }
  .title { font-family: Georgia, 'Songti SC', serif; font-size: 1.2em; font-weight: 650; line-height: 1.4; }
  .label, .subtitle, .muted { color: var(--book-ink-soft); }
  img, svg, canvas, video { max-width: 100%; height: auto; }
  ul, ol { margin: .65em 0 0; padding-left: 1.35em; }
  .chrome, .foot { display: flex; align-items: baseline; justify-content: space-between; gap: .8em; }
  .chrome { margin-bottom: .45em; }
  [data-kicker], .chrome-meta, .foot { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: .78em; letter-spacing: .08em; }
  [data-kicker] { display: inline-flex; align-items: center; gap: .5em; text-transform: uppercase; }
  [data-kicker]::before { content: ''; width: .45em; height: .45em; border-radius: 50%; background: currentColor; opacity: .7; }
  .chrome-meta, .foot { color: var(--book-ink-soft); }
  .foot { margin-top: .7em; padding-top: .5em; border-top: 1px solid color-mix(in srgb, var(--book-ink) 16%, transparent); }
  .document-book-widget-static__surface { container-type: inline-size; }
  .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: .7em .9em; align-items: start; }
  .grid > [class*="span-"] { grid-column: 1 / -1; }
  .grid.keep-pairs > [class*="span-"] { grid-column: span 6; }
  .grid.keep-row > .span-2 { grid-column: span 3; }
  .grid.keep-row > .span-8 { grid-column: span 6; }
  .dot-list { list-style: none; padding-left: 0; }
  .dot-list > li { position: relative; padding-left: 1em; }
  .dot-list > li::before { content: ''; position: absolute; left: .2em; top: .7em; width: .3em; height: .3em; border-radius: 50%; background: currentColor; opacity: .45; }
`

const BOOK_MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="note-preview-markdown-h1">{children}</h1>,
  h2: ({ children }) => <h2 className="note-preview-markdown-h2">{children}</h2>,
  h3: ({ children }) => <h3 className="note-preview-markdown-h3">{children}</h3>,
  h4: ({ children }) => <h4 className="note-preview-markdown-h4">{children}</h4>,
  p: ({ children, node }) => {
    const imagesOnly = !!node?.children.length && node.children.every(child => (
      child.type === 'text' ? !child.value.trim() : child.type === 'element' && (
        child.tagName === 'img' || (child.tagName === 'a' && child.children.every(item => (
          item.type === 'element' && item.tagName === 'img'
        )))
      )
    ))
    return (
      <BookImageParagraphContext.Provider value={imagesOnly}>
        <p className={`note-preview-markdown-p${imagesOnly ? ' document-book-image-paragraph' : ''}`}>{children}</p>
      </BookImageParagraphContext.Provider>
    )
  },
  ul: ({ children }) => <ul className="note-preview-markdown-ul">{children}</ul>,
  ol: ({ children }) => <ol className="note-preview-markdown-ol">{children}</ol>,
  li: ({ children, className }) => (
    <li className={className ? `${className} note-preview-markdown-li` : 'note-preview-markdown-li'}>{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="note-preview-markdown-blockquote">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="document-book-md-table-wrap">
      <table className="note-preview-markdown-table">{children}</table>
    </div>
  ),
  pre: ({ children }) => <pre className="document-book-md-pre">{children}</pre>,
  code: ({ children, className }) => (
    <code className={className ? `${className} note-preview-markdown-code` : 'note-preview-markdown-code'}>
      {children}
    </code>
  ),
  img: ({ src, alt }) => <DocumentBookImage src={src} alt={alt} />,
  a: ({ children, href }) => (
    <a
      className="document-book-md-link"
      href={href}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        if (href) openWebpageInBrowser(href)
      }}
    >
      {children}
    </a>
  ),
  hr: () => <hr className="document-book-md-hr" />,
}

const BookMarkdown = memo(function BookMarkdown({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={BOOK_MARKDOWN_COMPONENTS}>
      {markdown}
    </ReactMarkdown>
  )
})

function BookEmbedCard({ embed }: { embed: PreviewEmbed }) {
  if (embed.kind === 'image') {
    const src = embed.localPath || embed.displayUrl || embed.url
    return <DocumentBookImage src={src} alt={embed.alt || embed.title || ''} standalone />
  }
  return (
    <div className="document-book-embed-card">
      {embed.thumbnailUrl ? (
        <img className="document-book-embed-card__thumb" src={embed.thumbnailUrl} alt="" loading="lazy" />
      ) : (
        <Film className="document-book-embed-card__icon" aria-hidden />
      )}
      <div className="document-book-embed-card__meta">
        <div className="document-book-embed-card__title">{embed.title || embed.displayUrl || embed.url}</div>
        {embed.channel ? <div className="document-book-embed-card__sub">{embed.channel}</div> : null}
      </div>
      <ExternalLink className="document-book-embed-card__open" aria-hidden />
    </div>
  )
}

function BookWidgetStatic({ widget }: { widget: DocumentWidgetData | null }) {
  const title = (widget && typeof widget.title === 'string' && widget.title.trim()) || '小组件'
  const staticHtml = useMemo(() => {
    if (!widget) return ''
    const resolved = resolveDocumentWidgetRenderCode({
      widgetCode: widget.widgetCode,
      skeletonSpec: widget.skeletonSpec,
      componentSpec: widget.componentSpec,
    })
    return sanitizeBookWidgetStaticHtml(resolved.widgetCode)
  }, [widget])

  if (!staticHtml.trim()) {
    return (
      <div className="document-book-widget-card document-book-widget-card--error">
        <div className="document-book-widget-card__title">{title}</div>
        <div className="document-book-widget-card__sub">这张信息卡没有可用的静态内容</div>
      </div>
    )
  }
  return (
    <div className="document-book-widget-card">
      <div className="document-book-widget-card__kicker">信息卡 · {title}</div>
      <BookWidgetStaticSurface html={staticHtml} />
    </div>
  )
}

function BookWidgetStaticSurface({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({
      mode: 'open',
      clonable: true,
    } as ShadowRootInit)
    shadow.innerHTML = `<style>${BOOK_WIDGET_SHADOW_STYLE}</style><div class="document-book-widget-static__surface">${html}</div>`
  }, [html])

  return <div className="document-book-widget-static" data-book-widget-shadow ref={hostRef} />
}

export interface DocumentBookBlockProps {
  block: PreviewBlock
  embedsById: Map<string, PreviewEmbed>
  widgetsById: Map<string, DocumentWidgetData>
}

/** 单个内容块的静态渲染（父级负责 data-book-block-idx 包裹与分页偏移） */
const DocumentBookBlock = memo(function DocumentBookBlock({
  block,
  embedsById,
  widgetsById,
}: DocumentBookBlockProps) {
  switch (block.type) {
    case 'markdown':
      return <BookMarkdown markdown={block.markdown} />
    case 'details':
      return (
        <details className="note-preview-details" open={block.open || undefined}>
          <summary className="note-preview-details-summary">{block.summary}</summary>
          {block.markdown ? (
            <div className="note-preview-details-body">
              <BookMarkdown markdown={block.markdown} />
            </div>
          ) : null}
        </details>
      )
    case 'chips':
      return (
        <div className="document-book-chips">
          {block.chips.map((chip) => (
            <span key={chip.id} className="document-book-chip">{chip.label}</span>
          ))}
        </div>
      )
    case 'embed': {
      const embed = embedsById.get(block.embedId)
      return embed ? <BookEmbedCard embed={embed} /> : null
    }
    case 'widget':
      return <BookWidgetStatic widget={widgetsById.get(block.widgetId) ?? null} />
    case 'widget_error':
      return (
        <div className="document-book-widget-card document-book-widget-card--error">
          <div className="document-book-widget-card__body">
            <div className="document-book-widget-card__title">小组件不可用</div>
            <div className="document-book-widget-card__sub">{block.reason}</div>
          </div>
        </div>
      )
    default:
      return null
  }
})

export default DocumentBookBlock
