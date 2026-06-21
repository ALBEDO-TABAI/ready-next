import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import NotePreview from '../renderer/components/document/NotePreview'
import { EBOOK_INLINE_IMAGE_TITLE, EBOOK_MARKDOWN_MARKER } from '../shared/ebook'

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

test('NotePreview lazy-loads local images from embed blocks and markdown body', () => {
  const markdown = [
    '![](hero.gif)',
    '',
    '正文里的图片 ![inline](inline.png)',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/clip/note.md',
    }),
  )

  assert.equal(html.match(/<img/g)?.length, 2)
  assert.equal(html.match(/loading="lazy"/g)?.length, 2)
  assert.equal(html.match(/decoding="async"/g)?.length, 2)
  assert.match(html, /local-file:\/\/\/tmp\/clip\/hero\.gif/)
  assert.match(html, /local-file:\/\/\/tmp\/clip\/inline\.png/)
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

test('NotePreview keeps fenced markdown blocks with blank lines intact', () => {
  const markdown = [
    '### 5. 参考帧',
    '',
    '```md',
    'assets/shot01-line-art-v1.png',
    '',
    '时长：3s',
    '主动作：A 对镜自拍检查脸部状态。',
    '镜头运动：handheld mirror selfie',
    '音频：厕所环境声，轻微叹气',
    '```',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/reference-frame.md',
    }),
  )

  assert.equal(html.match(/note-preview-markdown-pre/g)?.length, 1)
  assert.doesNotMatch(html, /data-ready-markdown-source-rendered="true"/)
  assert.match(html, /assets\/shot01-line-art-v1\.png/)
  assert.match(html, /时长：3s/)
  assert.match(html, /主动作：A 对镜自拍检查脸部状态。/)
})

test('NotePreview renders longer outer markdown fences as formatted markdown', () => {
  const markdown = [
    '````md',
    '## Shot 01 / 3s',
    '',
    '### 1. 画面',
    '```text',
    'A 在厕所镜前自拍检查脸。',
    '```',
    '',
    '### 2. 镜头',
    '```text',
    '手机前置镜头感，中近景。',
    '```',
    '````',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/shot-template.md',
    }),
  )

  assert.match(html, /data-ready-markdown-source-rendered="true"/)
  assert.equal(html.match(/note-preview-markdown-pre/g)?.length, 2)
  assert.match(html, /data-ready-heading-title="Shot 01 \/ 3s"/)
  assert.match(html, /data-ready-heading-title="1\. 画面"/)
  assert.match(html, /data-ready-heading-title="2\. 镜头"/)
  assert.match(html, /A 在厕所镜前自拍检查脸。/)
  assert.doesNotMatch(html, /```text/)
})

test('NotePreview renders nested markdown source fences as formatted markdown', () => {
  const markdown = [
    '`````md',
    '---',
    '',
    '## Shot 01 / 3s',
    '',
    '### 1. 画面',
    '```text',
    'A 在厕所镜前自拍检查脸。',
    '```',
    '',
    '---',
    '',
    '````md',
    '## Shot 02 / 3s',
    '',
    '### 1. 画面',
    '```text',
    '手机前置镜头感，中近景。',
    '```',
    '````',
    '`````',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/nested-shot-template.md',
    }),
  )

  assert.equal(html.match(/data-ready-markdown-source-rendered="true"/g)?.length, 2)
  assert.equal(html.match(/note-preview-markdown-pre/g)?.length, 2)
  assert.match(html, /data-ready-heading-title="Shot 01 \/ 3s"/)
  assert.match(html, /data-ready-heading-title="Shot 02 \/ 3s"/)
  assert.match(html, /手机前置镜头感，中近景。/)
  assert.doesNotMatch(html, /## Shot 02/)
  assert.doesNotMatch(html, /```text/)
  assert.doesNotMatch(html, /````md/)
})

test('NotePreview renders shot sections with separate real code blocks', () => {
  const markdown = [
    '---',
    '',
    '## Shot 01 / 3s',
    '',
    '### 1. 画面',
    '```text',
    'A 在厕所镜前自拍检查脸，脸色疲惫，表情崩溃。',
    '```',
    '',
    '### 2. 镜头',
    '```text',
    '手机前置镜头感，中近景，镜面反射构图。',
    '```',
    '',
    '---',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/shot-sections.md',
    }),
  )

  assert.equal(html.match(/note-preview-markdown-pre/g)?.length, 2)
  assert.match(html, /note-preview-markdown-hr/)
  assert.match(html, /data-ready-heading-title="Shot 01 \/ 3s"/)
  assert.match(html, /data-ready-heading-title="1\. 画面"/)
  assert.match(html, /data-ready-heading-title="2\. 镜头"/)
})

test('NotePreview renders GitHub-style details blocks with markdown inside', () => {
  const markdown = [
    '<details>',
    '<summary>Shot 01 / 3s</summary>',
    '',
    '### 1. 画面',
    '```text',
    'A 在厕所镜前自拍检查脸，脸色疲惫。',
    '```',
    '',
    '### 2. 镜头',
    '```text',
    '手机前置镜头感，中近景。',
    '```',
    '',
    '</details>',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/shot-details.md',
    }),
  )

  assert.match(html, /<details class="note-preview-details">/)
  assert.match(html, /<summary class="note-preview-details-summary">Shot 01 \/ 3s<\/summary>/)
  assert.equal(html.match(/note-preview-markdown-pre/g)?.length, 2)
  assert.match(html, /data-ready-heading-title="1\. 画面"/)
  assert.match(html, /data-ready-heading-title="2\. 镜头"/)
  assert.doesNotMatch(html, /&lt;details&gt;/)
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

test('NotePreview renders imported ebook inline images without block image chrome', () => {
  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: [
        EBOOK_MARKDOWN_MARKER,
        '',
        '# Book',
        '',
        `正文前 ![](<glyph.png> "${EBOOK_INLINE_IMAGE_TITLE}") 正文后。`,
      ].join('\n'),
      notePath: '/tmp/book.md',
    }),
  )

  assert.match(html, /class="note-preview-image note-preview-image--inline"/)
  assert.match(html, /local-file:\/\/\/tmp\/glyph\.png/)
  assert.doesNotMatch(html, new RegExp(EBOOK_INLINE_IMAGE_TITLE))
})

test('NotePreview does not double-encode imported ebook inline image paths', () => {
  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: [
        EBOOK_MARKDOWN_MARKER,
        '',
        '# 春琴抄',
        '',
        `春琴，本名 ![](<春琴抄.assets/00004.jpeg> "${EBOOK_INLINE_IMAGE_TITLE}") 屋琴。`,
      ].join('\n'),
      notePath: '/tmp/多看书/春琴抄/春琴抄.md',
    }),
  )

  assert.match(html, /local-file:\/\/\/tmp\/%E5%A4%9A%E7%9C%8B%E4%B9%A6\/%E6%98%A5%E7%90%B4%E6%8A%84\/%E6%98%A5%E7%90%B4%E6%8A%84\.assets\/00004\.jpeg/)
  assert.doesNotMatch(html, /%25E5|%25E6|%25E7/)
  assert.match(html, /class="note-preview-image note-preview-image--inline"/)
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
  assert.match(css, /\.note-preview-shell--ebook \.note-preview-image--inline/)
  const paragraphRule = css.match(/\.note-preview-shell--ebook \.note-preview-markdown-p\s*\{[^}]+\}/)?.[0] || ''
  assert.doesNotMatch(paragraphRule, /text-indent/)
})

test('NotePreview renders b 站 player iframe as a real iframe (not raw HTML)', () => {
  const markdown = [
    '---',
    'title: "面包科普"',
    'source: "https://www.bilibili.com/video/BV1Uu5k6TETr/"',
    '---',
    '',
    '<iframe src="https://player.bilibili.com/player.html?isOutside=true&bvid=BV1Uu5k6TETr&p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" style="width:100%; height:500px;"></iframe>',
    '',
  ].join('\n')

  const html = renderToStaticMarkup(
    React.createElement(NotePreview, {
      content: markdown,
      notePath: '/tmp/bilibili.md',
    }),
  )

  // A real <iframe> mounted with the player URL — this is what produces the
  // playable card. The previous behavior dropped the iframe entirely (raw
  // HTML gets sanitized out of markdown).
  assert.match(html, /<iframe[^>]+src="https:\/\/player\.bilibili\.com\/player\.html[^"]+bvid=BV1Uu5k6TETr/)
  // The iframe reuses the YouTube card frame styling.
  assert.match(html, /class="note-preview-youtube-iframe"/)
  // Phantom metadata keys (height / src) must NOT appear in the rendered
  // property table — the inline style attribute previously leaked them.
  assert.doesNotMatch(html, /<dt[^>]*>\s*height\s*<\/dt>/i)
  assert.doesNotMatch(html, /\sheight:\s*500px;"><\/iframe>/)
})
