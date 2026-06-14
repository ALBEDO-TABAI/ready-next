import { Languages, Plus, Sparkles, X } from 'lucide-react'
import type { FastCardResultPanelData } from '../../../shared/fastcard'
import { LiquidSurfaceLayer } from '../ui/liquid-glass/LiquidFloatingPanel'

export type FastCardResultPanelState = FastCardResultPanelData

interface FastCardResultPanelProps {
  state: FastCardResultPanelState
  onClose: () => void
  onAddToFastCard: () => void
  onTargetLanguageChange: (language: string) => void
}

const TARGET_LANGUAGE_OPTIONS = [
  { value: 'zh-CN', label: '简中' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
  { value: 'ko', label: '韩文' },
  { value: 'fr', label: '法文' },
  { value: 'de', label: '德文' },
  { value: 'es', label: '西文' },
]

export default function FastCardResultPanel({
  state,
  onClose,
  onAddToFastCard,
  onTargetLanguageChange,
}: FastCardResultPanelProps) {
  const isTranslation = state.kind === 'translation'
  const title = isTranslation ? '翻译' : '反推描述'
  const icon = isTranslation ? <Languages size={16} /> : <Sparkles size={16} />
  const body = state.kind === 'translation'
    ? state.translatedText || (state.status === 'loading' ? '翻译中…' : state.error || '')
    : state.description || (state.status === 'loading' ? '生成中…' : state.error || '')

  return (
    <aside className="browser-fastcard-drawer browser-fastcard-surface content-surface-panel ready-app-liquid-panel is-entered" aria-label={title}>
      <LiquidSurfaceLayer
        className="ready-liquid-popover__lens ready-app-liquid-panel__lens"
        radius={18}
        withProjection={false}
        blur={8}
        frost={0}
        saturation={1.16}
        brightness={1.06}
        contrast={0.82}
      />
      <header className="browser-fastcard-header">
        <div className="browser-fastcard-title-row">
          {icon}
          <h2>{title}</h2>
        </div>
        <button className="browser-fastcard-icon-button" type="button" aria-label="关闭" title="关闭" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className="browser-fastcard-result-body">
        {state.kind === 'translation' && (
          <>
            <label className="browser-fastcard-field">
              <span>目标语言</span>
              <select value={state.targetLanguage} onChange={(event) => onTargetLanguageChange(event.target.value)}>
                {TARGET_LANGUAGE_OPTIONS.map((option) => (
                  <option value={option.value} key={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <section>
              <h3>原文</h3>
              <p>{state.originalText}</p>
            </section>
          </>
        )}

        <section className={state.status === 'error' ? 'is-error' : ''}>
          <h3>{state.kind === 'translation' ? '译文' : '描述词'}</h3>
          <p>{body}</p>
        </section>
      </div>

      <footer className="browser-fastcard-footer">
        <button className="browser-fastcard-action" type="button" onClick={onAddToFastCard} disabled={state.status !== 'ready'}>
          <Plus size={14} />
          <span>添加到 FastCard</span>
        </button>
        <button className="browser-fastcard-action subtle" type="button" onClick={onClose}>
          <X size={14} />
          <span>关闭</span>
        </button>
      </footer>
    </aside>
  )
}
