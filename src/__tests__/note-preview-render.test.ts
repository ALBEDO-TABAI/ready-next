import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import NotePreview from '../renderer/components/document/NotePreview'
import { EBOOK_MARKDOWN_MARKER } from '../shared/ebook'

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

test('NotePreview renders mermaid fences through a dedicated diagram block', () => {
  const markdown = [
    '# 图表',
    '',
    '```mermaid',
    'graph TD',
    '  A[开始] --> B[结束]',
    '```',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/diagram.md',
    }),
  )

  assert.match(html, /data-ready-heading-title="图表"/)
  assert.match(html, /data-ready-mermaid="true"/)
  assert.match(html, /note-preview-mermaid/)
  assert.doesNotMatch(html, /<pre class="note-preview-markdown-pre"><div class="note-preview-mermaid/)
})

test('NotePreview preserves ordered, unordered and nested markdown list structure', () => {
  const markdown = [
    '3. 有序列表第一项',
    '4. 有序列表第二项',
    '   1. 嵌套有序列表',
    '',
    '- 无序列表项',
    '  - 嵌套无序列表项',
    '',
    '- [ ] 待办项',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/list-demo.md',
    }),
  )

  assert.match(html, /<ol[^>]*class="note-preview-markdown-ol"[^>]*start="3"/)
  assert.match(html, /<ul class="note-preview-markdown-ul">/)
  assert.match(html, /<li class="note-preview-markdown-li">有序列表第一项<\/li>/)
  assert.match(html, /<li class="note-preview-markdown-li">有序列表第二项\s*<ol class="note-preview-markdown-ol">/)
  assert.match(html, /<li class="note-preview-markdown-li">无序列表项\s*<ul class="note-preview-markdown-ul">/)
  assert.match(html, /<ul class="contains-task-list note-preview-markdown-ul">/)
  assert.match(html, /<li class="task-list-item note-preview-markdown-li"><input type="checkbox" disabled=""/)
  assert.doesNotMatch(html, /<p class="note-preview-markdown-p">3\. 有序列表第一项<\/p>/)
  assert.doesNotMatch(html, /<p class="note-preview-markdown-p">- 无序列表项<\/p>/)
})

test('NotePreview only applies ebook reading class to imported ebook markdown', () => {
  const plainHtml = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: '# Plain Note\n\nReadable text.',
      notePath: '/tmp/plain.md',
    }),
  )
  assert.doesNotMatch(plainHtml, /note-preview-shell--ebook/)

  const ebookHtml = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: `${EBOOK_MARKDOWN_MARKER}\n\n# Book\n\nReadable text.`,
      notePath: '/tmp/book.md',
    }),
  )
  assert.match(ebookHtml, /note-preview-shell--ebook/)
  assert.doesNotMatch(ebookHtml, /ready:ebook-import/)
})

test('ebook reading CSS covers body text and non-indented block elements', async () => {
  const css = await import('node:fs/promises').then(({ readFile }) => (
    readFile(new URL('../renderer/styles/index.css', import.meta.url), 'utf-8')
  ))
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-markdown-p/)
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-markdown-ul/)
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-markdown-ol/)
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-markdown-quote/)
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-table-scroll/)
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-image/)
  const paragraphRule = css.match(/\.note-preview-shell--ebook \.note-preview-markdown-p\s*\{[^}]+\}/)?.[0] || ''
  assert.doesNotMatch(paragraphRule, /text-indent/)
})
