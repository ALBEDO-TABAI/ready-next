import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'

function codeLanguageLabel(language: string): string {
  const normalized = language.trim().toLowerCase()
  if (!normalized) return '代码'
  if (normalized === 'diff' || normalized === 'patch') return '变更'
  return normalized
}

function diffLineKind(line: string, language: string): 'add' | 'remove' | 'meta' | 'context' {
  if (!/^(?:diff|patch)$/i.test(language.trim())) return 'context'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

export function MessageCodeBlock({
  language,
  code,
  streaming = false,
}: {
  language: string
  code: string
  streaming?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const lines = code.split('\n')

  useEffect(() => () => {
    if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (resetTimerRef.current != null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      // silent-catch: clipboard access was refused, so the button just does not show the copied state
      setCopied(false)
    }
  }

  return (
    <div
      className="ready-code-block"
      data-ready-code-block="true"
      data-ready-code-kind={/^(?:diff|patch)$/i.test(language.trim()) ? 'diff' : 'code'}
    >
      <div className="ready-code-block-header">
        <span className="ready-code-block-language" data-ready-code-language="true">
          {codeLanguageLabel(language)}
        </span>
        <button
          type="button"
          className="ready-code-block-copy"
          onClick={() => { void copy() }}
          aria-label={copied ? '代码已复制' : '复制代码'}
        >
          {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.8} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="ready-code-block-body">
        <code>
          {lines.map((line, index) => (
            <span
              key={`${index}-${line}`}
              className="ready-code-line"
              data-ready-code-line={index + 1}
              data-ready-diff-line={diffLineKind(line, language)}
            >
              <span className="ready-code-line-number" aria-hidden="true">{index + 1}</span>
              <span className="ready-code-line-text">
                {line || '\u00a0'}
                {streaming && index === lines.length - 1 ? (
                  <span className="ready-stream-caret" data-ready-stream-caret="true" aria-hidden="true" />
                ) : null}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  )
}
