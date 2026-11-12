import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Languages, Loader2 } from 'lucide-react'
import { MarkdownContent } from '../document/MarkdownContent'
import { FloatPanel } from '../ui/float/FloatPanel'
import { MenuList, type MenuEntry } from '../ui/float/Menu'
import { Button, IconButton } from '../ui/Button'
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

  // The options follow the running translation live, so they stay in a panel placed under the button (the shared
  // FloatPanel) and list their choices with the shared MenuList.
  const entries: MenuEntry[] = [
    { kind: 'group', label: '翻译为' },
    ...RSS_TRANSLATION_LANGUAGES.map((language): MenuEntry => ({ id: `lang:${language.code}`, label: language.label, checked: language.code === targetLang,
      onSelect: () => { void state.translate(language.code) } })),
    ...(translated > 0 ? [{ kind: 'group', label: '显示' } as MenuEntry, ...([['source', '原文'], ['translated', '译文'], ['bilingual', '对照']] as const)
      .map(([value, text]): MenuEntry => ({ id: `view:${value}`, label: text, checked: view === value, onSelect: () => state.setView(value) }))] : []),
    ...(running ? [{ kind: 'separator' } as MenuEntry, { id: 'cancel', label: '停止翻译', onSelect: state.cancel }] : []),
    ...(!running && translation && translated < translation.total ? [{ kind: 'separator' } as MenuEntry, { id: 'retry', label: '重试未译段落', onSelect: () => { void state.translate(targetLang, true) } }] : []),
  ]
  const failure = state.error || (!running && translation?.error && translation.error !== 'interrupted' ? translation.error : null)
  return <div ref={ref} className="rss-translate">
    <Button variant="ghost" size="sm" icon={running ? <Loader2 className="animate-spin" /> : <Languages />} disabled={disabled || !state.available} onClick={primary}
      title={translated > 0 ? '在原文与译文之间切换' : '用已配置的模型翻译整篇正文'}>{label}</Button>
    <IconButton size="sm" icon={<ChevronDown />} title="翻译选项" aria-haspopup="menu" aria-expanded={open} active={open}
      disabled={disabled || !state.available} onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen((value) => !value)} />
    {open && <FloatPanel className="rss-translate__panel" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 30, width: 220 }}>
      <MenuList label="翻译选项" items={entries} onDone={() => setOpen(false)} />
      {status && <p className="rss-menu-note" role="status">{status}</p>}
      {failure && <p className="rss-menu-note" role="alert">{failure}</p>}
    </FloatPanel>}
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
