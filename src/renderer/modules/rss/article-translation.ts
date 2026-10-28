import { useCallback, useEffect, useRef, useState } from 'react'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import {
  defaultRSSTranslationTarget, type RSSArticleTranslation, type RSSTranslationLanguage,
} from '../../../shared/rss-translation'

export type RSSTranslationView = 'source' | 'translated' | 'bilingual'

/** Reader state for one saved body: the translation of this exact revision, and how it is shown. */
export function useRSSArticleTranslation(content: RSSArticleExcerpt | null, enabled: boolean) {
  const itemId = content?.article.id ?? null
  const body = content?.textKind === 'body' ? content.text : null
  const bodyRevision = content?.body.revision ?? null
  const [targetLang, setTargetLang] = useState<RSSTranslationLanguage>('zh-CN')
  const [translation, setTranslation] = useState<RSSArticleTranslation | null>(null)
  const [view, setView] = useState<RSSTranslationView>('source')
  const [error, setError] = useState<string | null>(null)
  const opened = useRef<string | null>(null)

  useEffect(() => {
    if (!itemId || !body || opened.current === itemId) return
    opened.current = itemId
    setTargetLang(defaultRSSTranslationTarget(body.slice(0, 4_000)))
    setView('source')
    setError(null)
  }, [itemId, body])

  useEffect(() => {
    if (!itemId || !enabled || !body || !bodyRevision) { setTranslation(null); return }
    let cancelled = false
    const api = window.electronAPI.rss
    const read = () => void api.readTranslation({ itemId, targetLang })
      .then((result) => { if (!cancelled) setTranslation(result.success ? result.data ?? null : null) })
    read()
    const off = api.onTranslationChanged((ref) => { if (ref.itemId === itemId && ref.targetLang === targetLang) read() })
    return () => { cancelled = true; off() }
  }, [itemId, targetLang, enabled, body, bodyRevision])

  const current = enabled && translation && bodyRevision && translation.bodyRevision === bodyRevision ? translation : null
  const translate = useCallback(async (lang: RSSTranslationLanguage, retryUntranslated = false) => {
    if (!itemId) return
    setTargetLang(lang)
    setError(null)
    const result = await window.electronAPI.rss.translateArticle({ itemId, targetLang: lang, retryUntranslated })
    if (!result.success || !result.data) { setError(result.error || '翻译没有开始。'); return }
    setTranslation(result.data)
    setView((value) => value === 'source' ? 'translated' : value)
  }, [itemId])
  const cancel = useCallback(() => {
    if (itemId) void window.electronAPI.rss.cancelTranslation({ itemId, targetLang })
  }, [itemId, targetLang])
  const shown = current?.blocks.some((block) => block.state === 'translated') ? view : 'source'
  return { available: Boolean(enabled && body && bodyRevision), targetLang, translation: current, view: shown, setView, translate, cancel, error }
}

export type RSSArticleTranslationState = ReturnType<typeof useRSSArticleTranslation>

/** Headings the reader's outline lists: in the bilingual view only the source ones. */
export function rssReaderHeadings(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-ready-heading-level]') ?? [])
    .filter((node) => !node.closest('.rss-translation-text'))
}
