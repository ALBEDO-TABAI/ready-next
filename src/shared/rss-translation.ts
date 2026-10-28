import { z } from 'zod'

export const RSS_TRANSLATION_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文', name: 'Simplified Chinese' },
  { code: 'en', label: 'English', name: 'English' },
  { code: 'ja', label: '日本語', name: 'Japanese' },
  { code: 'ko', label: '한국어', name: 'Korean' },
  { code: 'fr', label: 'Français', name: 'French' },
  { code: 'de', label: 'Deutsch', name: 'German' },
  { code: 'es', label: 'Español', name: 'Spanish' },
] as const

export type RSSTranslationLanguage = typeof RSS_TRANSLATION_LANGUAGES[number]['code']
const LANGUAGE_CODES = RSS_TRANSLATION_LANGUAGES.map((language) => language.code) as
  [RSSTranslationLanguage, ...RSSTranslationLanguage[]]

export const RSSTranslateArticleSchema = z.object({
  itemId: z.string().min(1),
  targetLang: z.enum(LANGUAGE_CODES),
  retryUntranslated: z.boolean().default(false),
}).strict()
export const RSSTranslationRefSchema = z.object({ itemId: z.string().min(1), targetLang: z.enum(LANGUAGE_CODES) }).strict()
export type RSSTranslateArticleInput = z.input<typeof RSSTranslateArticleSchema>
export type RSSTranslationRef = z.infer<typeof RSSTranslationRefSchema>

export type RSSTranslationStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** One translatable top-level block of the saved body, by its character range in that exact body revision. */
export interface RSSTranslationBlock {
  start: number
  end: number
  state: 'pending' | 'translated' | 'untranslated'
  markdown: string | null
}

export interface RSSArticleTranslation {
  itemId: string
  targetLang: RSSTranslationLanguage
  bodyRevision: string
  status: RSSTranslationStatus
  done: number
  total: number
  blocks: RSSTranslationBlock[]
  error: string | null
  updatedAt: number
}

export function rssTranslationLanguageName(code: RSSTranslationLanguage): string {
  return RSS_TRANSLATION_LANGUAGES.find((language) => language.code === code)!.name
}

/** Chinese when Han characters make up at least a third of the letters; decided by code, never by the model. */
export function isMostlyChinese(text: string): boolean {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  return letters > 0 && han / letters >= 1 / 3
}

export function defaultRSSTranslationTarget(text: string): RSSTranslationLanguage {
  return isMostlyChinese(text) ? 'en' : 'zh-CN'
}

/** The reader's view of a body revision: translated blocks replace or follow their source ranges. */
export function rssTranslatedSegments(
  body: string,
  blocks: readonly RSSTranslationBlock[],
): Array<{ source: string; translation: string | null }> {
  const segments: Array<{ source: string; translation: string | null }> = []
  let cursor = 0
  for (const block of [...blocks].sort((left, right) => left.start - right.start)) {
    if (block.start < cursor || block.end > body.length) continue
    if (block.start > cursor && body.slice(cursor, block.start).trim()) {
      segments.push({ source: body.slice(cursor, block.start).trim(), translation: null })
    }
    segments.push({ source: body.slice(block.start, block.end), translation: block.state === 'translated' ? block.markdown : null })
    cursor = block.end
  }
  if (body.slice(cursor).trim()) segments.push({ source: body.slice(cursor).trim(), translation: null })
  return segments
}
