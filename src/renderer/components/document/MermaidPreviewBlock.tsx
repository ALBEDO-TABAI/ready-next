import { useEffect, useId, useState } from 'react'
import { Wrench } from 'lucide-react'

import { appendToAgentInput } from '../../modules/agent/chat-input-bridge'
import { renderCachedMermaidSvg, type MermaidColorScheme } from '../../modules/document/mermaidRenderCache'
import { subscribeWidgetThemeChanges } from './widget-theme-observer'

function readColorScheme(): MermaidColorScheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export default function MermaidPreviewBlock({ code }: { code: string }) {
  const renderId = `ready-mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scheme, setScheme] = useState<MermaidColorScheme>(readColorScheme)

  useEffect(() => subscribeWidgetThemeChanges(() => setScheme(readColorScheme())), [])

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    void renderCachedMermaidSvg(code, renderId, scheme)
      .then((nextSvg) => {
        if (!cancelled) setSvg(nextSvg)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => { cancelled = true }
  }, [code, renderId, scheme])

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
        <div className="note-preview-mermaid__svg" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="note-preview-mermaid__loading" aria-live="polite">正在渲染图表…</div>
      )}
    </div>
  )
}
