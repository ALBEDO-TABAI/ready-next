import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkCallouts } from '../renderer/modules/document/callouts'

const render = (markdown: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkCallouts]}>{markdown}</ReactMarkdown>).replace(/>\s+</g, '><')

test('a library highlight callout renders its title link and excerpt, not the raw marker', () => {
  const html = render('> [!quote|yellow] 来源书 · [原文](https://example.com/x)\n> 乙丙丁戊己')
  assert.match(html, /^<aside class="ready-callout" data-callout="quote" data-callout-color="yellow">/)
  assert.match(html, /<div class="ready-callout-title">来源书 · <a href="https:\/\/example.com\/x">原文<\/a><\/div>/)
  assert.match(html, /<div class="ready-callout-body"><p>乙丙丁戊己<\/p><\/div>/)
  assert.doesNotMatch(html, /\[!quote/)
})

test('callout types get a default title; folding uses details and summary', () => {
  assert.match(render('> [!NOTE]\n> 正文'), /data-callout="note"><div class="ready-callout-title">笔记<\/div><div class="ready-callout-body"><p>正文<\/p>/)
  const folded = render('> [!TIP]- 小技巧\n> 折叠的正文')
  assert.match(folded, /^<details class="ready-callout" data-callout="tip"><summary class="ready-callout-title">小技巧<\/summary>/)
  assert.match(render('> [!TIP]+ 展开\n> 正文'), /^<details class="ready-callout" data-callout="tip" open="">/)
})

test('multi-paragraph bodies stay together and plain quotes are untouched', () => {
  const html = render('> [!WARNING] 注意\n>\n> 第一段\n>\n> 第二段')
  assert.match(html, /<div class="ready-callout-body"><p>第一段<\/p><p>第二段<\/p><\/div>/)
  assert.equal(render('> 普通引用'), '<blockquote><p>普通引用</p></blockquote>')
})
