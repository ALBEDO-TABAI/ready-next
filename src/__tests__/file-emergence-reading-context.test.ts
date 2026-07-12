import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { DOCUMENT_READING_POSITIONS_KEY } from '../renderer/modules/document/documentScrollAnchor'
import {
  EBOOK_READING_STATE_KEY,
  collectReadingProgress,
  readWorkspaceReadingProgress,
} from '../renderer/modules/file-emergence/readingIntentContext'

function storage(values: Record<string, unknown>) {
  return {
    getItem: (key: string) => {
      const value = values[key]
      return value === undefined ? null : JSON.stringify(value)
    },
  }
}

test('reading context collects existing document and ebook progress inside workspace roots', async () => {
  const now = Date.now()
  const fakeStorage = storage({
    [DOCUMENT_READING_POSITIONS_KEY]: [{
      key: '/workspace/docs/置身钉内.md',
      top: 10,
      ratio: 0.4,
      maxScroll: 100,
      anchorTitle: '第二章',
      anchorOrdinal: 0,
      anchorProgress: 0.2,
      updatedAt: now,
    }, {
      key: '/outside/docs/旧文.md',
      top: 10,
      ratio: 0.8,
      maxScroll: 100,
      updatedAt: now,
    }],
    [EBOOK_READING_STATE_KEY]: [{
      path: '/workspace/books/白痴.epub',
      fraction: 0.62,
      updatedAt: now - 1000,
    }, {
      path: '/workspace/books/残留.epub',
      fraction: 0.7,
      updatedAt: now - 2000,
    }],
  })

  const collected = collectReadingProgress({
    storage: fakeStorage,
    workspaceRoots: ['/workspace'],
  })
  assert.deepEqual(collected.map((item) => item.title), ['置身钉内', '白痴', '残留'])

  const checked = await readWorkspaceReadingProgress({
    storage: fakeStorage,
    workspaceRoots: ['/workspace'],
    statPath: async (path) => path !== '/workspace/books/残留.epub',
  })
  assert.deepEqual(checked.map((item) => item.title), ['置身钉内', '白痴'])
  assert.equal(checked.find((item) => item.title === '白痴')?.progressRatio, 0.62)
})

test('reading context preserves the receiver required by native Web Storage', () => {
  const now = Date.now()
  const dom = new JSDOM('<!doctype html>', { url: 'http://localhost' })
  dom.window.localStorage.setItem(DOCUMENT_READING_POSITIONS_KEY, JSON.stringify([
    { key: '/workspace/docs/继续写.md', top: 20, ratio: 0.45, maxScroll: 100, updatedAt: now },
    { key: '/workspace/papers/继续读.pdf', top: 40, ratio: 0.7, maxScroll: 100, updatedAt: now - 1 },
  ]))
  dom.window.localStorage.setItem(EBOOK_READING_STATE_KEY, JSON.stringify([
    { path: '/workspace/books/继续读.epub', fraction: 0.6, updatedAt: now - 2 },
  ]))

  const records = collectReadingProgress({
    storage: dom.window.localStorage,
    workspaceRoots: ['/workspace'],
  })

  assert.deepEqual(records.map((record) => record.kind), ['document', 'pdf', 'ebook'])
})
