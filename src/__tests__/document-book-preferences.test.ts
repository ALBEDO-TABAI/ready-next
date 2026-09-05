/**
 * 阅读模式偏好合同：存取往返、越界夹取、损坏数据静默回默认。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BOOK_READING_PREFERENCES_KEY,
  DEFAULT_BOOK_READING_PREFERENCES,
  clampBookReadingPreferences,
  loadBookReadingPreferences,
  saveBookReadingPreferences,
} from '../renderer/modules/document/book/bookReadingPreferences'

function createStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    dump: () => Object.fromEntries(map),
  }
}

test('空存储返回默认偏好', () => {
  const prefs = loadBookReadingPreferences(createStorage())
  assert.deepEqual(prefs, DEFAULT_BOOK_READING_PREFERENCES)
})

test('存取往返', () => {
  const storage = createStorage()
  saveBookReadingPreferences({ fontSize: 18, lineHeight: 1.6, margin: 'wide', background: '#e7e4dd' }, storage)
  assert.deepEqual(loadBookReadingPreferences(storage), { fontSize: 18, lineHeight: 1.6, margin: 'wide', background: '#e7e4dd' })
  assert.ok(storage.dump()[BOOK_READING_PREFERENCES_KEY].includes('"fontSize":18'))
})

test('越界值夹取到合法区间', () => {
  assert.deepEqual(
    clampBookReadingPreferences({ fontSize: 99, lineHeight: 5, margin: 'narrow' }),
    { fontSize: 22, lineHeight: 1.9, margin: 'narrow', background: null },
  )
  assert.deepEqual(
    clampBookReadingPreferences({ fontSize: 1, lineHeight: 0.5 }),
    { fontSize: 12, lineHeight: 1.5, margin: 'normal', background: null },
  )
})

test('旧排版偏好默认跟随昼夜；自选色可恢复并拒绝非法样式', () => {
  const storage = createStorage()
  storage.setItem(BOOK_READING_PREFERENCES_KEY, '{"fontSize":16,"margin":"wide"}')
  assert.equal(loadBookReadingPreferences(storage).background, null)
  assert.equal(loadBookReadingPreferences(storage).fontSize, 16)
  assert.equal(clampBookReadingPreferences({ background: '#ABCdef' }).background, '#abcdef')
  assert.equal(clampBookReadingPreferences({ background: 'url(https://example.com)' }).background, null)
})

test('损坏 JSON 与非法 margin 静默回默认', () => {
  const storage = createStorage()
  storage.setItem(BOOK_READING_PREFERENCES_KEY, '{oops')
  assert.deepEqual(loadBookReadingPreferences(storage), DEFAULT_BOOK_READING_PREFERENCES)
  storage.setItem(BOOK_READING_PREFERENCES_KEY, '{"fontSize":"abc","margin":"huge"}')
  const prefs = loadBookReadingPreferences(storage)
  assert.equal(prefs.fontSize, DEFAULT_BOOK_READING_PREFERENCES.fontSize)
  assert.equal(prefs.margin, 'normal')
})
