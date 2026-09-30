import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from '../renderer/components/document/MarkdownContent'
import { readSavedRSSArticle } from '../renderer/modules/rss/read-article'
import type { RSSArticleExcerpt } from '../shared/rss-workspace'

test('RSS reuses document typography while source widgets, HTML and local links remain inert', () => {
  const html = renderToStaticMarkup(<MarkdownContent externalBaseUrl="https://example.test/news/a" onOpenLink={() => {}} content={[
    '# Title', 'A **strong** paragraph.', '| A | B |', '| - | - |', '| 1 | 2 |',
    '[Related](../related)', '![Image](../photo.png)', '[Local](file:///etc/passwd)',
    '<script>alert(1)</script>', '```ready-widget', '{"html":"<script>bad()</script>"}', '```',
    '```mermaid', 'graph TD; A-->B', '```',
  ].join('\n\n')} />)
  assert.match(html, /note-preview-markdown-h1/)
  assert.match(html, /<strong>strong<\/strong>/)
  assert.match(html, /href="https:\/\/example.test\/related"/)
  assert.match(html, /src="https:\/\/example.test\/photo.png"/)
  assert.doesNotMatch(html, /<script|<iframe|file:\/\/|data-ready-widget|data-ready-mermaid=/)
  assert.match(html, /language-ready-widget/)
})

test('an empty or invalid source URL never enables trusted document references', () => {
  for (const externalBaseUrl of ['', 'not-a-url', undefined]) {
    const html = renderToStaticMarkup(<MarkdownContent externalBaseUrl={externalBaseUrl as string} onOpenLink={() => {}} content={'![local](/Users/synthetic/private.png)\n\n```mermaid\ngraph TD; A-->B\n```'} />)
    assert.doesNotMatch(html, /local-file:|<img|data-ready-mermaid=/)
    assert.match(html, /language-mermaid/)
  }
})

test('article reader assembles all saved chunks against one version without fetching or marking read', async () => {
  const requests: unknown[] = []
  const chunks = ['first ', 'middle ', 'last']
  const result = await readSavedRSSArticle({ readArticle: async (input) => {
    requests.push(input)
    const index = requests.length - 1
    return { success: true, data: { article: { id: 'a', revision: 'v1' }, body: { status: 'ready' },
      text: chunks[index], textKind: 'body', offset: input.offset || 0, totalLength: 17,
      nextOffset: index < 2 ? (index + 1) * 6 : null } as RSSArticleExcerpt }
  } }, 'a', new AbortController().signal)
  assert.equal(result.text, chunks.join(''))
  assert.deepEqual(requests, [
    { itemId: 'a', offset: 0, length: 24000 },
    { itemId: 'a', offset: 6, length: 24000, expectedRevision: 'v1' },
    { itemId: 'a', offset: 12, length: 24000, expectedRevision: 'v1' },
  ])
})

test('article reader cannot combine old and new versions or publish after navigation cancels it', async () => {
  let calls = 0
  await assert.rejects(readSavedRSSArticle({ readArticle: async () => ++calls === 1
    ? { success: true, data: { article: { revision: 'old' }, text: 'old', nextOffset: 3 } as RSSArticleExcerpt }
    : { success: false, error: 'article_changed' } }, 'a', new AbortController().signal), /article_changed/)
  const controller = new AbortController()
  await assert.rejects(readSavedRSSArticle({ readArticle: async () => {
    controller.abort()
    return { success: true, data: { article: { revision: 'old' }, text: 'old', nextOffset: null } as RSSArticleExcerpt }
  } }, 'a', controller.signal), /abort/i)
})
