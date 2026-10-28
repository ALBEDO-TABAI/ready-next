import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from '../renderer/components/document/MarkdownContent'
import { isOutdatedRSSExtraction, readSavedRSSArticle } from '../renderer/modules/rss/read-article'
import type { RSSArticleExcerpt } from '../shared/rss-workspace'
import RSSCoverImage from '../renderer/components/rss/RSSCoverImage'
import { describeRSSMedia, rssVideoEmbed } from '../shared/rss-media'
import RSSArticleReader from '../renderer/components/rss/RSSArticleReader'
import { RSSTranslatedBody, RSSTranslationControl } from '../renderer/components/rss/RSSTranslationControl'
import type { RSSArticleTranslationState } from '../renderer/modules/rss/article-translation'
import type { RSSArticleTranslation } from '../shared/rss-translation'
import type { RSSItem } from '../renderer/components/rss/RSSFeed'

test('saved covers render passively and media descriptions keep reference and understanding separate', () => {
  const video = describeRSSMedia('https://media.test/video.mp4', 'https://media.test/cover.png')
  assert.equal(video.kind, 'video')
  assert.equal(video.cover.availability, 'not_checked')
  assert.equal(video.readPerformsMediaUnderstanding, false)
  const html = renderToStaticMarkup(<RSSCoverImage link="https://media.test/video.mp4" coverImage="https://media.test/cover.png" />)
  assert.match(html, /src="https:\/\/media.test\/cover.png"/)
  assert.match(html, /loading="lazy"/)
  assert.equal(renderToStaticMarkup(<RSSCoverImage link="https://media.test/video.mp4" coverImage="file:///private/local.png" />), '')
  assert.equal(describeRSSMedia('https://media.test/primary.webp').kind, 'image')
  assert.equal(describeRSSMedia('https://media.test/primary.webp').cover.url, 'https://media.test/primary.webp')
  assert.equal(describeRSSMedia('javascript:alert(1)').source.url, null)
  assert.equal(describeRSSMedia('https://media.test/news/story', '../cover.jpg').cover.url, 'https://media.test/cover.jpg')
  assert.equal(describeRSSMedia('https://media.test/news/story', '//cdn.test/cover.jpg').cover.url, 'https://cdn.test/cover.jpg')
  assert.equal(describeRSSMedia('https://media.test/news/story').cover.url, null)
})

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

test('Bilibili and YouTube items resolve to the framed players; a dynamic plays only the single video it shares', () => {
  assert.deepEqual(rssVideoEmbed('https://www.bilibili.com/video/BV15far6dEjT/?p=2&spm=x'), {
    provider: 'bilibili', embedUrl: 'https://player.bilibili.com/player.html?isOutside=true&bvid=BV15far6dEjT&p=2&autoplay=0', pageUrl: 'https://www.bilibili.com/video/BV15far6dEjT/',
  })
  assert.equal(rssVideoEmbed('https://m.bilibili.com/video/av170001')?.embedUrl, 'https://player.bilibili.com/player.html?isOutside=true&aid=170001&p=1&autoplay=0')
  const shared = '这是我们一次全新的测试//转发自: @飓多多StormCrew: 视频地址：https://www.bilibili.com/video/BV15far6dEjT'
  assert.equal(rssVideoEmbed('https://t.bilibili.com/1060000000000000000', shared)?.pageUrl, 'https://www.bilibili.com/video/BV15far6dEjT/')
  assert.equal(rssVideoEmbed('https://t.bilibili.com/1060000000000000000', `${shared} 以及 https://www.bilibili.com/video/BV1xx411c7mD`), null, 'two shared videos name no single player')
  assert.equal(rssVideoEmbed('https://space.bilibili.com/946974'), null)
  for (const link of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) {
    assert.equal(rssVideoEmbed(link)?.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0', link)
  }
  assert.equal(rssVideoEmbed('https://vimeo.com/123456'), null, 'only players the renderer CSP frames')
  assert.equal(rssVideoEmbed('javascript:alert(1)'), null)
  assert.match(renderToStaticMarkup(<RSSCoverImage variant="thumb" link="https://www.bilibili.com/video/BV15far6dEjT" coverImage="https://i0.hdslb.com/cover.jpg" />), /class="rss-card-play"/)
  assert.doesNotMatch(renderToStaticMarkup(<RSSCoverImage variant="thumb" link="https://example.test/story" coverImage="https://example.test/cover.jpg" />), /rss-card-play/)
})

test('a video item plays in the reader instead of showing only its cover', () => {
  const item = { id: 'v', title: '这是我们一次全新的测试', link: 'https://www.bilibili.com/video/BV15far6dEjT', source: '影视飓风', summary: '视频地址：https://www.bilibili.com/video/BV15far6dEjT', coverImage: 'https://i0.hdslb.com/cover.jpg' } as RSSItem
  const html = renderToStaticMarkup(<RSSArticleReader item={item} onClose={() => {}} onOpened={async () => {}} onToggleStar={() => {}} />)
  assert.match(html, /<figure class="rss-reader-video"><iframe src="https:\/\/player\.bilibili\.com\/player\.html\?isOutside=true&amp;bvid=BV15far6dEjT&amp;p=1&amp;autoplay=0"/)
  assert.match(html, /allowfullscreen/i)
  assert.doesNotMatch(html, /i0\.hdslb\.com\/cover\.jpg/, 'the player shows its own poster')
  assert.match(html, /视频可直接在上方播放/)
})

test('a linked gallery picture stays a full picture that opens its link, and its caption stays a text link', () => {
  const html = renderToStaticMarkup(<MarkdownContent readingAnchors externalBaseUrl="https://site.test/news/a" onOpenLink={() => {}} content={
    '[![Max Verstappen](https://cdn.test/a.webp)](https://site.test/g/#1)\n\n[Sunday, in photos](https://site.test/g/#1)'
  } />)
  assert.match(html, /<a href="https:\/\/site.test\/g\/#1" class="note-preview-picture-link"><img src="https:\/\/cdn.test\/a.webp" alt="Max Verstappen" class="note-preview-image"[^>]*\/><\/a>/)
  assert.match(html, /class="note-preview-markdown-link"><span>.*Sunday, in photos.*<\/span><svg/)
})

test('only bodies the old extraction left as page source count as outdated', () => {
  assert.equal(isOutdatedRSSExtraction('window.__SSR__=truewindow.__INITIAL_STATE__={"global":{}}'), true)
  assert.equal(isOutdatedRSSExtraction('Intro\n\n<table id="hnmain"><tbody><tr><td></td></tr></tbody></table>'), true)
  assert.equal(isOutdatedRSSExtraction('Use the `<table>` element for data, not layout.'), false, 'prose about tables is an article')
  assert.equal(isOutdatedRSSExtraction('| A | B |\n| --- | --- |\n| 1 | 2 |'), false)
  // A link around a whole gallery card, split across blocks by the old extraction.
  assert.equal(isOutdatedRSSExtraction('## Photos\n\n [![Max Verstappen](https://cdn.test/a.webp)\n\n## Sunday, in photos](https://site.test/g/#1) [![Lewis Hamilton](https://cdn.test/b.webp)'), true)
  assert.equal(isOutdatedRSSExtraction(' [![Max Verstappen](https://cdn.test/a.webp)\n\nSunday, in photos](https://site.test/g/#1)'), true)
  assert.equal(isOutdatedRSSExtraction('[![Max Verstappen](https://cdn.test/a.webp)](https://site.test/g/#1)\n\n[Sunday, in photos](https://site.test/g/#1)'), false)
  assert.equal(isOutdatedRSSExtraction('## [Section](https://site.test/#s)\n\n![Photo](https://cdn.test/a.webp)\n\n## A heading with [a link](https://x.test)'), false)
})

test('translated and bilingual views show the translation in place of or under each source block', () => {
  const body = '## Museum\n\nThe hall opened.\n\n![Hall](https://cdn.test/hall.jpg)\n\nSecond paragraph.'
  const translation: RSSArticleTranslation = {
    itemId: 'a', targetLang: 'zh-CN', bodyRevision: 'r1', status: 'partial', done: 3, total: 3, error: null, updatedAt: 1,
    blocks: [
      { start: 0, end: 9, state: 'translated', markdown: '## 博物馆' },
      { start: 11, end: 27, state: 'translated', markdown: '大厅开放了。' },
      { start: 66, end: 83, state: 'untranslated', markdown: null },
    ],
  }
  const view = (bilingual: boolean) => renderToStaticMarkup(<RSSTranslatedBody body={body} translation={translation} bilingual={bilingual}
    externalBaseUrl="https://site.test/a" onOpenLink={() => {}} />)
  const translated = view(false)
  assert.match(translated, /博物馆/)
  assert.doesNotMatch(translated, /The hall opened/)
  assert.match(translated, /src="https:\/\/cdn.test\/hall.jpg"/)
  assert.match(translated, /Second paragraph/, 'an untranslated block reads in its source language')
  const bilingual = view(true)
  assert.match(bilingual, /The hall opened\.[\s\S]*class="rss-translation-text" lang="zh-CN"[\s\S]*大厅开放了/)
  assert.equal(bilingual.match(/class="rss-translation-text"/g)?.length, 2)
})

test('the translate control starts with one click, shows progress, and then switches views', () => {
  const base = { available: true, targetLang: 'zh-CN' as const, view: 'source' as const, setView: () => {}, translate: async () => {}, cancel: () => {}, error: null }
  const control = (state: Partial<RSSArticleTranslationState>) => renderToStaticMarkup(
    <RSSTranslationControl state={{ ...base, translation: null, ...state } as RSSArticleTranslationState} />)
  assert.match(control({}), /用已配置的模型翻译整篇正文[\s\S]*翻译/)
  const blocks = [{ start: 0, end: 1, state: 'translated' as const, markdown: '甲' }, { start: 2, end: 3, state: 'pending' as const, markdown: null }]
  const running = { itemId: 'a', targetLang: 'zh-CN' as const, bodyRevision: 'r1', status: 'running' as const, done: 1, total: 2, blocks, error: null, updatedAt: 1 }
  assert.match(control({ translation: running }), /翻译中 1\/2/)
  const done = { ...running, status: 'completed' as const, done: 2, blocks: blocks.map((block) => ({ ...block, state: 'translated' as const, markdown: '乙' })) }
  assert.match(control({ translation: done, view: 'source' }), />译文</)
  assert.match(control({ translation: done, view: 'translated' }), />原文</)
  assert.match(control({ available: false }), /disabled/)
})
