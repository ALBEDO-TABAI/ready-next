import { Children, isValidElement, useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, ExternalLink, Wrench } from 'lucide-react'
import { EBOOK_INLINE_IMAGE_TITLE } from '../../../shared/ebook'
import { documentCodeBehavior } from '../../../shared/document-code-language'
import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import { resolvePreviewReference } from './note-preview-parser'

interface MarkdownOptions {
  mode: 'document' | 'external'
  notePath?: string | null
  externalBaseUrl?: string
  openHref: (href: string, localPath?: string | null) => unknown
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

export async function copyTextToClipboard(value: string): Promise<boolean> {
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
    // silent-catch: the caller receives false and does not report a successful copy.
    return false
  }
}

function isMermaidLanguage(className: string | undefined): boolean {
  return documentCodeBehavior(className) === 'mermaid'
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

function isMermaidPreChildren(children: ReactNode): boolean {
  const onlyChild = Children.toArray(children)[0]
  return isValidElement<{ className?: string }>(onlyChild) && isMermaidLanguage(onlyChild.props.className)
}

function isMarkdownSourceLanguage(className?: string): boolean {
  return documentCodeBehavior(className) === 'markdown'
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

export function createMarkdownComponents({ mode, notePath, openHref, externalBaseUrl }: MarkdownOptions) {
  const external = mode === 'external'
  const resolveReference = (reference: string) => {
    if (!external) return resolvePreviewReference(reference, notePath)
    try {
      const url = new URL(reference, externalBaseUrl)
      return { resolvedUrl: reference && ['http:', 'https:'].includes(url.protocol) ? url.href : '', localPath: null }
    } catch { /* silent-catch: unsupported source URLs remain inert text. */ return { resolvedUrl: '', localPath: null } }
  }
  return {
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
        if (!external && isMermaidPreChildren(children)) return <>{children}</>
        const codeChild = getPreCodeChild(children)
        if (
          !external && codeChild
          && isMarkdownSourceLanguage(codeChild.className)
          && shouldRenderMarkdownCodeAsDocument(codeChild.code)
        ) {
          return <MarkdownSourceBlock code={codeChild.code} />
        }
        return <CodeBlockWithCopy code={codeChild?.code ?? extractMarkdownText(children)}>{children}</CodeBlockWithCopy>
      })()
    ),
    code: ({ children, className, ...props }: { children?: ReactNode; className?: string }) => {
      if (!external && isMermaidLanguage(className)) {
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
      const resolved = resolveReference(reference)
      if (!resolved.resolvedUrl) return <span>{children}</span>
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
      const resolved = resolveReference(reference)
      if (!resolved.resolvedUrl) return <span>{alt || ''}</span>
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
  }
}

export function MarkdownContent({ content, externalBaseUrl, onOpenLink }: {
  content: string
  externalBaseUrl: string
  onOpenLink: (href: string) => unknown
}) {
  const components = useMemo(() => createMarkdownComponents({ mode: 'external', externalBaseUrl, openHref: onOpenLink }), [externalBaseUrl, onOpenLink])
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{content}</ReactMarkdown>
}
