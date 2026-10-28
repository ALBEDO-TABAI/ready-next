import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Languages, Loader2 } from 'lucide-react'
import { MarkdownContent } from '../document/MarkdownContent'
import { LiquidFloatingPanel } from '../ui/liquid-glass/LiquidFloatingPanel'
import { chatMenuSurfaceStyle } from '../agent/chatMenuStyles'
import { RSS_TRANSLATION_LANGUAGES, rssTranslatedSegments, type RSSArticleTranslation } from '../../../shared/rss-translation'
import type { RSSArticleTranslationState } from '../../modules/rss/article-translation'

export function RSSTranslationControl({ state, disabled }: { state: RSSArticleTranslationState; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { translation, view, targetLang } = state
  const running = translation?.status === 'running'
  const translated = translation?.blocks.filter((block) => block.state === 'translated').length ?? 0
  const untranslated = translation?.blocks.filter((block) => block.state === 'untranslated').length ?? 0

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const primary = () => {
    if (running) setOpen(true)
    else if (translated > 0) state.setView(view === 'source' ? 'translated' : 'source')
    else void state.translate(targetLang)
  }
  const label = running ? `翻译中 ${translation!.done}/${translation!.total}` : translated > 0 ? (view === 'source' ? '译文' : '原文') : '翻译'
  const status = !translation ? null
    : running ? `正在翻译 ${translation.done}/${translation.total} 段`
      : translation.status === 'cancelled' ? `已停止，译好 ${translated}/${translation.total} 段`
        : untranslated > 0 ? `已翻译 ${translated}/${translation.total} 段，${untranslated} 段保留原文`
          : `已翻译全部 ${translation.total} 段`

  return <div ref={ref} className="rss-translate">
    <button type="button" className="rss-btn" disabled={disabled || !state.available} onClick={primary}
      title={translated > 0 ? '在原文与译文之间切换' : '用已配置的模型翻译整篇正文'}>
      {running ? <Loader2 size={14} className="animate-spin" /> : <Languages size={15} strokeWidth={1.8} />}{label}
    </button>
    <button type="button" className="rss-btn rss-btn--icon" aria-label="翻译选项" aria-haspopup="menu" aria-expanded={open}
      disabled={disabled || !state.available} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)}>
      <ChevronDown size={12} strokeWidth={2} />
    </button>
    {open && <LiquidFloatingPanel className="rss-reference-menu-panel overflow-hidden rounded-[14px]" role="menu" radius={14}
      style={{ ...chatMenuSurfaceStyle, position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30, width: 220 }}>
      <div className="rss-menu">
        <p className="rss-menu-label">翻译为</p>
        {RSS_TRANSLATION_LANGUAGES.map((language) => <button type="button" key={language.code} role="menuitemradio"
          aria-checked={language.code === targetLang} className="rss-menu-item ready-floating-menu-item"
          onClick={() => { void state.translate(language.code); setOpen(false) }}>
          <span>{language.label}</span>{language.code === targetLang && <Check size={13} strokeWidth={2} />}
        </button>)}
        {translated > 0 && <>
          <p className="rss-menu-label">显示</p>
          {([['source', '原文'], ['translated', '译文'], ['bilingual', '对照']] as const).map(([value, text]) => (
            <button type="button" key={value} role="menuitemradio" aria-checked={view === value}
              className="rss-menu-item ready-floating-menu-item" onClick={() => { state.setView(value); setOpen(false) }}>
              <span>{text}</span>{view === value && <Check size={13} strokeWidth={2} />}
            </button>
          ))}
        </>}
        {status && <p className="rss-menu-note" role="status">{status}</p>}
        {running && <button type="button" className="rss-menu-item ready-floating-menu-item" onClick={state.cancel}>停止翻译</button>}
        {!running && translation && translated < translation.total && <button type="button" className="rss-menu-item ready-floating-menu-item"
          onClick={() => { void state.translate(targetLang, true); setOpen(false) }}>重试未译段落</button>}
        {(state.error || (!running && translation?.error && translation.error !== 'interrupted' ? translation.error : null)) &&
          <p className="rss-menu-note" role="alert">{state.error || translation?.error}</p>}
      </div>
    </LiquidFloatingPanel>}
  </div>
}

/** Translated view: each translated block replaces its source; bilingual view keeps the source and adds the translation under it. */
export function RSSTranslatedBody({ body, translation, bilingual, externalBaseUrl, onOpenLink }: {
  body: string
  translation: RSSArticleTranslation
  bilingual: boolean
  externalBaseUrl: string
  onOpenLink(href: string): unknown
}) {
  const segments = rssTranslatedSegments(body, translation.blocks)
  if (!bilingual) {
    return <MarkdownContent content={segments.map((segment) => segment.translation ?? segment.source).join('\n\n')}
      externalBaseUrl={externalBaseUrl} onOpenLink={onOpenLink} />
  }
  return <>{segments.map((segment, index) => <div key={index} className="rss-translation-pair">
    <MarkdownContent content={segment.source} externalBaseUrl={externalBaseUrl} onOpenLink={onOpenLink} />
    {segment.translation && <div className="rss-translation-text" lang={translation.targetLang}>
      <MarkdownContent content={segment.translation} externalBaseUrl={externalBaseUrl} onOpenLink={onOpenLink} />
    </div>}
  </div>)}</>
}
