import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import NotePreview from '../renderer/components/document/NotePreview'

test('NotePreview renders markdown tables with a dedicated preview shell', () => {
  const markdown = [
    '| 维度 | 平均分 | 这一维在看什么 |',
    '|------|------:|-------------------|',
    '| 冲击力 | 8.5 | 画面进来的瞬间有没有叫人停下来的力量 |',
    '| 美学 | 8.7 | 视觉语言的完成度和统一感 |',
    '',
    '*生成时间: 2026-04-20 10:10:24*',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/scorecard.md',
    }),
  )

  assert.match(html, /data-note-preview-table="true"/)
  assert.match(html, /note-preview-table-scroll/)
  assert.match(html, /note-preview-markdown-table/)
  assert.match(html, /note-preview-markdown-th/)
  assert.match(html, /note-preview-markdown-td/)
})
