import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isBookReadablePath,
  isBookReadingSessionVisible,
  shouldFinalizeBookReadingSession,
} from '../renderer/modules/document/book/bookTabEligibility'

test('阅读入口只出现在 MarkdownEditor 真实支持的文档格式上', () => {
  for (const path of [
    null,
    '/notes/untitled',
    '/notes/a.md',
    '/notes/a.markdown',
    '/notes/a.txt',
    '/notes/a.json',
    '/notes/a.ts',
    '/notes/a.tsx',
    '/notes/a.js',
    '/notes/a.css',
    '/notes/a.html',
    '/notes/a.docx',
  ]) {
    assert.equal(isBookReadablePath(path), true, String(path))
  }

  for (const path of [
    '/notes/a.pdf',
    '/notes/a.epub',
    '/notes/a.png',
    '/notes/a.xlsx',
    '/notes/a.bin',
    '/notes/a.unknown',
    '/notes/a.readyboard',
  ]) {
    assert.equal(isBookReadablePath(path), false, path)
  }
})

test('阅读会话只显示进入时的标签，切换目标标签会立即卸载阅读视图', () => {
  assert.equal(isBookReadingSessionVisible(true, 'tab-a', 'tab-a', true, true), true)
  assert.equal(isBookReadingSessionVisible(true, 'tab-a', 'tab-b', true, true), false)
  assert.equal(isBookReadingSessionVisible(false, 'tab-a', 'tab-a', true, true), false)
  assert.equal(isBookReadingSessionVisible(true, 'tab-a', 'tab-a', false, true), false)
  assert.equal(isBookReadingSessionVisible(true, 'tab-a', 'tab-a', true, false), false)
})

test('离开 Document 场景或阅读标签丢失时结束会话，返回后不得复活旧阅读层', () => {
  assert.equal(shouldFinalizeBookReadingSession(true, 'tab-a', 'tab-a', true), false)
  assert.equal(shouldFinalizeBookReadingSession(true, 'tab-a', 'tab-a', false), true)
  assert.equal(shouldFinalizeBookReadingSession(true, 'tab-a', 'tab-b', true), true)
  assert.equal(shouldFinalizeBookReadingSession(true, null, 'tab-a', true), true)
  assert.equal(shouldFinalizeBookReadingSession(false, 'tab-a', 'tab-b', false), false)
})
