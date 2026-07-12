import {
  Children,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  ExternalLink,
  Wrench,
} from 'lucide-react'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import { EBOOK_INLINE_IMAGE_TITLE, EBOOK_MARKDOWN_MARKER } from '../../../shared/ebook'
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
import { resolveDocumentWidgetRenderCode } from '../../../shared/document-widget-render-code'
import type { DocumentWidgetData } from '../../../shared/document-widget-parse'
import { getDocumentWidgetRenderBudget, getWidgetPersistenceKey } from './widget-card-helpers'
import WidgetRenderer from './WidgetRenderer'
import {
  EditableBlockShell,
  PreviewAppendComposer,
  PreviewBlockEditor,
  type PreviewDropIndicator,
} from './NotePreviewEditable'
import {
  appendPreviewParagraph,
  getPreviewBlockSourceText,
  movePreviewBlockSource,
  replacePreviewBlockSource,
} from '../../modules/document/previewEditOperations'

export const PREVIEW_BLOCK_DRAG_MIME = 'application/x-ready-preview-block'

interface NotePreviewProps {
  content: string
  notePath?: string | null
  focusWidgetTitle?: string | null
  /** Preview-edit mode: blocks become editable/movable in place. */
  editable?: boolean
  /** Receives the full next document text after a preview-edit operation. */
  onApplyContentEdit?: (nextContent: string) => void
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
}

function mergeMarkdownClassName(className: string | undefined, previewClassName: string): string {
  return className ? `${className} ${previewClassName}` : previewClassName
}

function extractMarkdownText(children: ReactNode): string {
  if (children === null || children === undefined || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractMarkdownText).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) return extractMarkdownText(children.props.children)
  return ''
}

async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }

    if (typeof document === 'undefined') return false
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(textarea)
    return copied
  } catch {
    return false
  }
}

function isMermaidLanguage(className: string | undefined): boolean {
  return /\blanguage-mermaid\b/.test(className || '')
}

function MermaidBlock({ code }: { code: string }) {
  const renderId = `ready-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)

    void import('mermaid')
      .then(async (module) => {
        const mermaid = module.default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
        })
        return mermaid.render(renderId, code)
      })
      .then((result) => {
        if (!cancelled) setSvg(result.svg)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
    }
  }, [code, renderId])

  if (error) {
    return (
      <div className="note-preview-mermaid note-preview-mermaid--error" data-ready-mermaid-render-error={error}>
        <div className="note-preview-mermaid__error">Mermaid 渲染失败：{error}</div>
        <button
          type="button"
          className="note-preview-repair-button"
          onClick={() => appendToAgentInput(`请修复当前文档里渲染失败的 Mermaid 图。预览报错：${error}`)}
        >
          <Wrench size={14} strokeWidth={2} />
          <span>让 AI 修复</span>
        </button>
      </div>
    )
  }

  return (
    <div className="note-preview-mermaid" data-ready-mermaid="true">
      {svg ? (
        <div
          className="note-preview-mermaid__svg"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div className="note-preview-mermaid__loading" aria-live="polite">
          正在渲染图表…
        </div>
      )}
    </div>
  )
}

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

function isMermaidPreChildren(children: ReactNode): boolean {
  const onlyChild = Children.toArray(children)[0]
  return isValidElement<{ className?: string }>(onlyChild) && isMermaidLanguage(onlyChild.props.className)
}

function isMarkdownSourceLanguage(className?: string): boolean {
  return /\blanguage-(md|markdown)\b/i.test(className || '')
}

function getPreCodeChild(children: ReactNode): { className?: string; code: string } | null {
  const onlyChild = Children.toArray(children)[0]
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) return null
  return {
    className: onlyChild.props.className,
    code: extractMarkdownText(onlyChild.props.children),
  }
}

function shouldRenderMarkdownCodeAsDocument(code: string): boolean {
  return code.split('\n').some((line) => (
    /^[ \t]{0,3}#{1,6}\s+\S/.test(line)
    || /^[ \t]{0,3}[-*_]{3,}[ \t]*$/.test(line)
    || /^[ \t]{0,3}(`{3,}|~{3,})/.test(line)
    || /^<details(\s+open)?\s*>$/i.test(line.trim())
  ))
}

function CodeBlockWithCopy({
  children,
  code,
}: {
  children?: ReactNode
  code: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = useCallback(async () => {
    const didCopy = await copyTextToClipboard(code)
    if (didCopy) setCopied(true)
  }, [code])

  return (
    <div className="note-preview-code-block">
      <button
        type="button"
        className="note-preview-code-copy-button"
        aria-label={copied ? '已复制代码块' : '复制代码块'}
        title={copied ? '已复制' : '复制代码'}
        data-ready-code-copy-button="true"
        data-ready-code-copied={copied ? 'true' : undefined}
        onClick={() => { void handleCopy() }}
      >
        {copied ? (
          <Check style={{ width: 14, height: 14 }} strokeWidth={2} />
        ) : (
          <Copy style={{ width: 14, height: 14 }} strokeWidth={2} />
        )}
      </button>
      <pre className="note-preview-markdown-pre">{children}</pre>
    </div>
  )
}

function MarkdownSourceBlock({ code }: { code: string }) {
  return (
    <div className="note-preview-markdown-source-rendered" data-ready-markdown-source-rendered="true">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="note-preview-markdown-h1" data-ready-heading-level="1" data-ready-heading-title={extractMarkdownText(children)}>{children}</h1>,
          h2: ({ children }) => <h2 className="note-preview-markdown-h2" data-ready-heading-level="2" data-ready-heading-title={extractMarkdownText(children)}>{children}</h2>,
          h3: ({ children }) => <h3 className="note-preview-markdown-h3" data-ready-heading-level="3" data-ready-heading-title={extractMarkdownText(children)}>{children}</h3>,
          h4: ({ children }) => <h4 className="note-preview-markdown-h4" data-ready-heading-level="4" data-ready-heading-title={extractMarkdownText(children)}>{children}</h4>,
          p: ({ children }) => <p className="note-preview-markdown-p">{children}</p>,
          hr: () => <hr className="note-preview-markdown-hr" />,
          blockquote: ({ children }) => <blockquote className="note-preview-markdown-quote">{children}</blockquote>,
          ul: ({ children, node: _node, className, ...props }) => (
            <ul className={mergeMarkdownClassName(className, 'note-preview-markdown-ul')} {...props}>{children}</ul>
          ),
          ol: ({ children, node: _node, className, ...props }) => (
            <ol className={mergeMarkdownClassName(className, 'note-preview-markdown-ol')} {...props}>{children}</ol>
          ),
          li: ({ children, node: _node, className, ...props }) => (
            <li className={mergeMarkdownClassName(className, 'note-preview-markdown-li')} {...props}>{children}</li>
          ),
          pre: ({ children }) => {
            if (isMermaidPreChildren(children)) return <>{children}</>
            const codeChild = getPreCodeChild(children)
            if (
              codeChild
              && isMarkdownSourceLanguage(codeChild.className)
              && shouldRenderMarkdownCodeAsDocument(codeChild.code)
            ) {
              return <MarkdownSourceBlock code={codeChild.code} />
            }
            return <CodeBlockWithCopy code={codeChild?.code ?? extractMarkdownText(children)}>{children}</CodeBlockWithCopy>
          },
          code: ({ children, className, ...props }) => (
            <code className={className ? `${className} note-preview-markdown-code` : 'note-preview-markdown-code'} {...props}>
              {children}
            </code>
          ),
        }}
      >
        {code}
      </ReactMarkdown>
    </div>
  )
}

function NotePreview({
  content,
  notePath,
  focusWidgetTitle,
  editable,
  onApplyContentEdit,
  onWidgetRename,
  onWidgetQuote,
  onWidgetExport,
  onWidgetEdit,
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
  // Ebook markdown strips a marker before parsing, so ranges would not line up
  // with the tab content — preview-edit stays off there.
  const canEdit = Boolean(editable && onApplyContentEdit) && !isEbookMarkdown
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null)
  const [draggingBlockId, setDraggingBlockId] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<PreviewDropIndicator | null>(null)
  const widgetRenderBudget = useMemo(() => getDocumentWidgetRenderBudget(displayContent), [displayContent])
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

  // ─── Preview-edit (预览内编辑) ─────────────────────────────
  const blocksById = useMemo(
    () => new Map(preview.blocks.map((block) => [block.id, block])),
    [preview.blocks],
  )

  useEffect(() => {
    if (canEdit) return
    setEditingBlockId(null)
    setDraggingBlockId(null)
    setDropIndicator(null)
  }, [canEdit])

  // Drag state must clear even when the drop lands outside the preview
  // (dragend fires on the source; drop may land anywhere).
  useEffect(() => {
    if (!canEdit) return undefined
    const reset = () => {
      setDraggingBlockId(null)
      setDropIndicator(null)
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('drop', reset)
    }
  }, [canEdit])

  const applyContentEdit = useCallback((next: string | null) => {
    if (next === null || next === displayContent) return
    onApplyContentEdit?.(next)
  }, [displayContent, onApplyContentEdit])

  const handleBlockEditCommit = useCallback((block: PreviewBlock, nextText: string) => {
    setEditingBlockId(null)
    applyContentEdit(replacePreviewBlockSource(displayContent, block, nextText))
  }, [applyContentEdit, displayContent])

  const handleBlockDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, blockId: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(PREVIEW_BLOCK_DRAG_MIME, blockId)
    setDraggingBlockId(blockId)
  }, [])

  const handleBlockDragEnd = useCallback(() => {
    setDraggingBlockId(null)
    setDropIndicator(null)
  }, [])

  const handleBlockDragOver = useCallback((event: React.DragEvent<HTMLDivElement>, blockId: string) => {
    if (!draggingBlockId || draggingBlockId === blockId) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position: PreviewDropIndicator['position'] = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    setDropIndicator((prev) => (
      prev && prev.blockId === blockId && prev.position === position ? prev : { blockId, position }
    ))
  }, [draggingBlockId])

  const handleBlockDrop = useCallback((event: React.DragEvent<HTMLDivElement>, blockId: string) => {
    if (!draggingBlockId) return
    event.preventDefault()
    event.stopPropagation()
    const moved = blocksById.get(draggingBlockId)
    const target = blocksById.get(blockId)
    const indicator = dropIndicator
    setDraggingBlockId(null)
    setDropIndicator(null)
    if (!moved || !target || !indicator || indicator.blockId !== blockId) return
    applyContentEdit(movePreviewBlockSource(displayContent, moved, target, indicator.position))
  }, [applyContentEdit, blocksById, displayContent, draggingBlockId, dropIndicator])

  const handleAppendParagraph = useCallback((text: string) => {
    applyContentEdit(appendPreviewParagraph(displayContent, text))
  }, [applyContentEdit, displayContent])

  const markdownComponents = useMemo(() => ({
    h1: ({ children }: { children?: ReactNode }) => <h1 className="note-preview-markdown-h1" data-ready-heading-level="1" data-ready-heading-title={extractMarkdownText(children)}>{children}</h1>,
    h2: ({ children }: { children?: ReactNode }) => <h2 className="note-preview-markdown-h2" data-ready-heading-level="2" data-ready-heading-title={extractMarkdownText(children)}>{children}</h2>,
    h3: ({ children }: { children?: ReactNode }) => <h3 className="note-preview-markdown-h3" data-ready-heading-level="3" data-ready-heading-title={extractMarkdownText(children)}>{children}</h3>,
    h4: ({ children }: { children?: ReactNode }) => <h4 className="note-preview-markdown-h4" data-ready-heading-level="4" data-ready-heading-title={extractMarkdownText(children)}>{children}</h4>,
    p: ({ children }: { children?: ReactNode }) => <p className="note-preview-markdown-p">{children}</p>,
    em: ({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) => <em className="note-preview-markdown-em" {...props}>{children}</em>,
    hr: () => <hr className="note-preview-markdown-hr" />,
    blockquote: ({ children }: { children?: ReactNode }) => <blockquote className="note-preview-markdown-quote">{children}</blockquote>,
    ul: ({ children, node: _node, className, ...props }: { children?: ReactNode; node?: unknown; className?: string }) => (
      <ul className={mergeMarkdownClassName(className, 'note-preview-markdown-ul')} {...props}>{children}</ul>
    ),
    ol: ({ children, node: _node, className, ...props }: { children?: ReactNode; node?: unknown; className?: string }) => (
      <ol className={mergeMarkdownClassName(className, 'note-preview-markdown-ol')} {...props}>{children}</ol>
    ),
    li: ({ children, node: _node, className, ...props }: { children?: ReactNode; node?: unknown; className?: string }) => (
      <li className={mergeMarkdownClassName(className, 'note-preview-markdown-li')} {...props}>{children}</li>
    ),
    table: ({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) => (
      <div className="note-preview-table-scroll" data-note-preview-table="true">
        <table className="note-preview-markdown-table" {...props}>{children}</table>
      </div>
    ),
    thead: ({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) => <thead className="note-preview-markdown-thead" {...props}>{children}</thead>,
    tbody: ({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) => <tbody className="note-preview-markdown-tbody" {...props}>{children}</tbody>,
    tr: ({ children, node: _node, ...props }: { children?: ReactNode; node?: unknown }) => <tr className="note-preview-markdown-tr" {...props}>{children}</tr>,
    th: ({ children, node: _node, className, ...props }: { children?: ReactNode; node?: unknown; className?: string }) => (
      <th className={className ? `${className} note-preview-markdown-th` : 'note-preview-markdown-th'} {...props}>
        {children}
      </th>
    ),
    td: ({ children, node: _node, className, ...props }: { children?: ReactNode; node?: unknown; className?: string }) => (
      <td className={className ? `${className} note-preview-markdown-td` : 'note-preview-markdown-td'} {...props}>
        {children}
      </td>
    ),
    pre: ({ children }: { children?: ReactNode }) => (
      (() => {
        if (isMermaidPreChildren(children)) return <>{children}</>
        const codeChild = getPreCodeChild(children)
        if (
          codeChild
          && isMarkdownSourceLanguage(codeChild.className)
          && shouldRenderMarkdownCodeAsDocument(codeChild.code)
        ) {
          return <MarkdownSourceBlock code={codeChild.code} />
        }
        return <CodeBlockWithCopy code={codeChild?.code ?? extractMarkdownText(children)}>{children}</CodeBlockWithCopy>
      })()
    ),
    code: ({ children, className, ...props }: { children?: ReactNode; className?: string }) => {
      if (isMermaidLanguage(className)) {
        return <MermaidBlock code={extractMarkdownText(children).trim()} />
      }
      return (
        <code className={className ? `${className} note-preview-markdown-code` : 'note-preview-markdown-code'} {...props}>
          {children}
        </code>
      )
    },
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
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
    img: ({ src, alt, title }: { src?: string; alt?: string; title?: string }) => {
      const reference = src || ''
      const resolved = resolvePreviewReference(reference, notePath)
      const isInlineEbookImage = title === EBOOK_INLINE_IMAGE_TITLE
      return (
        <img
          src={resolved.resolvedUrl}
          alt={alt || (isInlineEbookImage ? '' : 'embedded media')}
          className={isInlineEbookImage ? 'note-preview-image note-preview-image--inline' : 'note-preview-image'}
          loading="lazy"
          decoding="async"
        />
      )
    },
  }), [notePath, openHref])

  const renderMarkdownBlock = useCallback((block: Extract<PreviewBlock, { type: 'markdown' }>) => (
    <ReactMarkdown
      key={block.id}
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
    >
      {block.markdown}
    </ReactMarkdown>
  ), [markdownComponents])

  const renderDetailsBlock = useCallback((block: Extract<PreviewBlock, { type: 'details' }>) => (
    <details key={block.id} className="note-preview-details" open={block.open || undefined}>
      <summary className="note-preview-details-summary">{block.summary}</summary>
      {block.markdown ? (
        <div className="note-preview-details-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {block.markdown}
          </ReactMarkdown>
        </div>
      ) : null}
    </details>
  ), [markdownComponents])

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

      <div className="note-preview-body" data-preview-editable={canEdit ? 'true' : undefined}>
        {preview.blocks.map((block) => {
          const renderBlockBody = (): ReactNode => {
            if (block.type === 'markdown') {
              return renderMarkdownBlock(block)
            }

            if (block.type === 'details') {
              return renderDetailsBlock(block)
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
                <DocumentWidgetCardShell
                  title={widget.title || 'widget'}
                  onRenameTitle={onWidgetRename ? (nextTitle) => onWidgetRename(widget.title || 'widget', widget.widgetCode, nextTitle) : undefined}
                  onQuote={onWidgetQuote ? () => onWidgetQuote(widget.title || 'widget', widget.widgetCode) : undefined}
                  onExport={onWidgetExport ? () => onWidgetExport(widget.title || 'widget', renderCode, widgetState) : undefined}
                  onEdit={canEdit && onWidgetEdit ? () => onWidgetEdit(widget) : undefined}
                  dataReadyWidgetTitle={widget.title || ''}
                  previewClassName="ready-doc-widget-card-preview ready-doc-widget-card-preview-static"
                >
                  <WidgetRenderer
                    title={widget.title}
                    widgetCode={renderCode}
                    preferManualPreview={widgetRenderBudget.forceManualPreviewAll}
                    widgetState={widgetState}
                    onWidgetStateChange={onWidgetStateChange ? (state) => onWidgetStateChange(widget.title || 'widget', widget.widgetCode, state) : undefined}
                  />
                </DocumentWidgetCardShell>
              )
            }

            if (block.type === 'widget_error') {
              return <BrokenWidgetFallback reason={block.reason} />
            }

            return null
          }

          if (!canEdit) {
            const body = renderBlockBody()
            return body === null ? null : <Fragment key={block.id}>{body}</Fragment>
          }

          const hasSource = block.source !== null
          const textEditable = hasSource && (block.type === 'markdown' || block.type === 'details')

          if (textEditable && editingBlockId === block.id) {
            const seed = getPreviewBlockSourceText(displayContent, block)
            if (seed !== null) {
              return (
                <PreviewBlockEditor
                  key={block.id}
                  initialText={seed}
                  ariaLabel="编辑此段内容"
                  onCommit={(nextText) => handleBlockEditCommit(block, nextText)}
                  onCancel={() => setEditingBlockId(null)}
                />
              )
            }
          }

          const body = renderBlockBody()
          if (body === null) return null
          const embed = block.type === 'embed' ? embedsById.get(block.embedId) : undefined
          const blockDraggable = hasSource && block.type === 'embed' && (embed?.kind === 'image' || embed?.kind === 'video')

          return (
            <EditableBlockShell
              key={block.id}
              blockId={block.id}
              textEditable={textEditable}
              draggable={blockDraggable}
              dropTargetable={hasSource && Boolean(draggingBlockId) && draggingBlockId !== block.id}
              isDraggingSelf={draggingBlockId === block.id}
              dropIndicator={dropIndicator}
              onStartEdit={textEditable ? () => setEditingBlockId(block.id) : undefined}
              onDragStartBlock={(event) => handleBlockDragStart(event, block.id)}
              onDragEndBlock={handleBlockDragEnd}
              onDragOverBlock={(event) => handleBlockDragOver(event, block.id)}
              onDropBlock={(event) => handleBlockDrop(event, block.id)}
            >
              {body}
            </EditableBlockShell>
          )
        })}

        {canEdit && <PreviewAppendComposer onAppend={handleAppendParagraph} />}
      </div>
    </div>
  )
}

export default memo(NotePreview)
