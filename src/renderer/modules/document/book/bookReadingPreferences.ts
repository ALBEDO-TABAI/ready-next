/**
 * bookReadingPreferences.ts — 阅读模式排版偏好（字号/行高/页边距）。
 * localStorage 持久化；损坏数据静默回默认。
 */

export type BookMarginPreset = 'narrow' | 'normal' | 'wide'

export interface BookReadingPreferences {
  fontSize: number
  lineHeight: number
  margin: BookMarginPreset
  /** null 跟随应用昼夜；否则为六位十六进制背景色。 */
  background: string | null
}

export const BOOK_READING_PREFERENCES_KEY = 'ready-document-book-reading-preferences-v1'
export const BOOK_FONT_SIZE_RANGE = { min: 12, max: 22 } as const
export const BOOK_LINE_HEIGHT_RANGE = { min: 1.5, max: 1.9 } as const

export const DEFAULT_BOOK_READING_PREFERENCES: BookReadingPreferences = {
  fontSize: 15,
  lineHeight: 1.75,
  margin: 'normal',
  background: null,
}

type StorageLike = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function clampBookReadingPreferences(value: Partial<BookReadingPreferences>): BookReadingPreferences {
  const fontSize = Number(value.fontSize)
  const lineHeight = Number(value.lineHeight)
  const margin = value.margin
  return {
    fontSize: Number.isFinite(fontSize)
      ? clamp(fontSize, BOOK_FONT_SIZE_RANGE.min, BOOK_FONT_SIZE_RANGE.max)
      : DEFAULT_BOOK_READING_PREFERENCES.fontSize,
    lineHeight: Number.isFinite(lineHeight)
      ? clamp(lineHeight, BOOK_LINE_HEIGHT_RANGE.min, BOOK_LINE_HEIGHT_RANGE.max)
      : DEFAULT_BOOK_READING_PREFERENCES.lineHeight,
    margin: margin === 'narrow' || margin === 'wide' ? margin : 'normal',
    background: typeof value.background === 'string' && /^#[0-9a-f]{6}$/i.test(value.background)
      ? value.background.toLowerCase()
      : null,
  }
}

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage || null
}

export function loadBookReadingPreferences(storage?: StorageLike | null): BookReadingPreferences {
  const target = resolveStorage(storage)
  if (!target) return { ...DEFAULT_BOOK_READING_PREFERENCES }
  try {
    const raw = target.getItem(BOOK_READING_PREFERENCES_KEY)
    if (!raw) return { ...DEFAULT_BOOK_READING_PREFERENCES }
    return clampBookReadingPreferences(JSON.parse(raw) as Partial<BookReadingPreferences>)
  } catch {
    // silent-catch: 偏好损坏不应阻塞阅读模式
    return { ...DEFAULT_BOOK_READING_PREFERENCES }
  }
}

export function saveBookReadingPreferences(
  preferences: BookReadingPreferences,
  storage?: StorageLike | null,
): void {
  const target = resolveStorage(storage)
  if (!target) return
  try {
    target.setItem(BOOK_READING_PREFERENCES_KEY, JSON.stringify(clampBookReadingPreferences(preferences)))
  } catch {
    // silent-catch: 偏好持久化尽力而为
  }
}
