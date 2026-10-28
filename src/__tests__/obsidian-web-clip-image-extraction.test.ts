/**
 * P1.6 image extraction — verify that `ReadabilityJsdomAdapter`:
 *   1. Promotes lazy-load attributes (data-src, data-original, srcset, …)
 *      to a usable `src` BEFORE readability runs.
 *   2. Resolves relative URLs against the page baseUrl.
 *   3. Picks the largest-descriptor candidate from `srcset`.
 *   4. Never emits `data:` placeholders in the resulting markdown.
 *   5. Preserves `<figure>` + `<figcaption>` semantics.
 *
 * These are pure-extraction tests — no network, no electron, no jsdom mocks.
 * The adapter pulls jsdom + readability + turndown via normal imports.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import { ReadabilityJsdomAdapter } from '../main/modules/clipping/readability-jsdom-adapter'

const adapter = new ReadabilityJsdomAdapter()

const ARTICLE_WRAPPER = (inner: string) =>
  `<!doctype html><html><head><title>Test</title></head><body><article>` +
  // readability needs enough body to consider the article qualifying
  `<p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}</p>` +
  inner +
  `<p>${'Curabitur non nulla sit amet nisl tempus convallis. '.repeat(20)}</p>` +
  `</article></body></html>`

describe('ReadabilityJsdomAdapter · lazy-load image promotion', () => {
  it('promotes data-src when src is empty', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="" data-src="https://cdn.example.com/real-image.jpg" alt="Hero"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    assert.match(result.contentMarkdown, /!\[Hero\]\(https:\/\/cdn\.example\.com\/real-image\.jpg\)/)
  })

  it('promotes data-original when src is a placeholder gif', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-original="https://cdn.example.com/real.png" alt="X"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    assert.match(result.contentMarkdown, /!\[X\]\(https:\/\/cdn\.example\.com\/real\.png\)/)
    // Ensure no data: URL leaked through.
    assert.equal(result.contentMarkdown.includes('data:image/gif'), false)
  })

  it('picks the largest from srcset (w descriptors)', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="" srcset="https://cdn.example.com/sm.jpg 480w, https://cdn.example.com/md.jpg 768w, https://cdn.example.com/lg.jpg 1600w" alt="Y"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    assert.match(result.contentMarkdown, /!\[Y\]\(https:\/\/cdn\.example\.com\/lg\.jpg\)/)
  })

  it('picks the largest from srcset (x descriptors)', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="" srcset="https://cdn.example.com/1x.jpg 1x, https://cdn.example.com/2x.jpg 2x, https://cdn.example.com/3x.jpg 3x" alt="Z"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    assert.match(result.contentMarkdown, /!\[Z\]\(https:\/\/cdn\.example\.com\/3x\.jpg\)/)
  })

  it('resolves relative URLs against page baseUrl', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="/assets/hero.jpg" alt="Rel"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/posts/123' })
    assert.match(result.contentMarkdown, /!\[Rel\]\(https:\/\/example\.com\/assets\/hero\.jpg\)/)
  })

  it('resolves protocol-relative URLs (//)', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="//cdn.example.com/x.jpg" alt="Proto"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/posts/123' })
    assert.match(result.contentMarkdown, /!\[Proto\]\(https:\/\/cdn\.example\.com\/x\.jpg\)/)
  })

  it('keeps figure + figcaption with promoted src', async () => {
    const html = ARTICLE_WRAPPER(
      `<figure><img src="" data-src="https://cdn.example.com/figure.jpg" alt="Fig"><figcaption>Caption text here</figcaption></figure>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    assert.match(result.contentMarkdown, /!\[Fig\]\(https:\/\/cdn\.example\.com\/figure\.jpg\)/)
    assert.match(result.contentMarkdown, /_Caption text here_/)
  })

  it('never emits data: URLs even when src is data: and no fallback exists', async () => {
    const html = ARTICLE_WRAPPER(
      `<p><img src="data:image/svg+xml,%3Csvg/%3E" alt="OnlyData"></p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    assert.equal(result.contentMarkdown.includes('data:image/svg'), false)
    // Image without resolvable src should not appear at all.
    assert.equal(result.contentMarkdown.includes('OnlyData'), false)
  })
})

describe('ReadabilityJsdomAdapter · links around blocks', () => {
  // motorsport.com gallery cards: one link holds the picture, slide arrows and the gallery title heading.
  // Readability keeps the strip because its titles carry ten or more commas, as the real 41-card strip does.
  const card = (id: number, alt: string) =>
    `<a href="/galleries/sunday-in-photos/14291/#${id}" class="article-fullwidth-gallery_item"><div class="article-fullwidth-gallery_img-wrapper">` +
    `<picture><img src="https://cdn.example.com/s700/${id}.webp" width="700" height="466" alt="${alt}"></picture>` +
    `<div class="article-fullwidth-gallery_nav"><svg aria-hidden="true"><use href="#chevron-right"></use></svg></div></div>` +
    `<h2 class="article-fullwidth-gallery_title">Sunday, in photos</h2></a>`

  it('keeps each card link on its picture and caption instead of wrapping the blocks', async () => {
    const html = ARTICLE_WRAPPER(
      `<h2>Photos from the race</h2><div class="article-fullwidth-gallery"><div class="article-fullwidth-gallery_items">${card(1, 'Max Verstappen, Red Bull Racing')}${card(2, 'Lewis Hamilton, Ferrari')}` +
      `${Array.from({ length: 8 }, (_, index) => card(index + 3, `Driver ${index + 3}`)).join('')}</div></div>` +
      `<a href="#details"><h2>Race details</h2></a><p>${'The race restarted after the safety car came in. '.repeat(6)}</p>`,
    )
    const result = await adapter.extract({ html, url: 'https://example.com/post' })
    const markdown = result.contentMarkdown

    assert.match(markdown, /^\s*\[!\[Max Verstappen, Red Bull Racing\]\(https:\/\/cdn\.example\.com\/s700\/1\.webp\)\]\(https:\/\/example\.com\/galleries\/sunday-in-photos\/14291\/#1\)$/m)
    assert.match(markdown, /^\[Sunday, in photos\]\(https:\/\/example\.com\/galleries\/sunday-in-photos\/14291\/#2\)$/m)
    // The card title is a caption; the article's own sections stay headings, with their link inside.
    assert.deepEqual(markdown.match(/^#{1,6} .*$/gm), ['## Photos from the race', '## [Race details](#details)'])
    assert.doesNotMatch(markdown, /^#{1,6} [^[\n]*\]\(/m)
    assert.doesNotMatch(markdown, /^\s*\[!\[[^\]\n]*\]\([^)\s]*\)\s*$/m)
    assert.doesNotMatch(markdown, /\[\]\(/, 'arrows without content get no empty link')
  })
})

describe('ReadabilityJsdomAdapter · pictures Readability dropped', () => {
  it('returns article pictures where they stood and leaves site and teaser pictures out', async () => {
    const paragraph = (label: string) => `<p>${label} ${'The archive holds decades of stop-motion tests and production notes. '.repeat(6)}</p>`
    const html = `<!doctype html><html><head><title>Archive</title></head><body>` +
      `<header class="site-header"><nav><a href="/"><img src="https://cdn.example.com/wordmark.png" width="200" height="60" alt="Site"></a></nav></header>` +
      `<main><article><h1>Archive found</h1>` +
      `<div class="hero-wrap"><div><img src="https://cdn.example.com/lead.jpg" width="1200" height="800" alt="Lead"></div></div>` +
      `<div class="article-body">${paragraph('FIRST')}` +
      `<div class="gallery-slider"><button>Prev</button><button>Next</button><a href="#s1">1</a><a href="#s2">2</a>` +
      `<template><img src="https://cdn.example.com/slide-1.jpg" alt="Slide one"><img src="https://cdn.example.com/slide-2.jpg" alt="Slide two"></template></div>` +
      `${paragraph('SECOND')}` +
      `<div class="related-posts"><div><img src="https://cdn.example.com/related.jpg" style="aspect-ratio: 3/2"></div><a href="/other-story">Other story</a></div>` +
      // A row of story cards, as on 1011now: Readability drops it, and its pictures link to other stories.
      `<div class="card-deck"><div class="card"><a href="/another-story"><img src="https://cdn.example.com/teaser.jpg" width="600" height="400" alt="Teaser"></a>` +
      `<a href="/another-story">Another story</a></div><div class="card"><a href="/third-story"><img src="https://cdn.example.com/teaser-2.jpg" width="600" height="400" alt="Teaser two"></a>` +
      `<a href="/third-story">Third story</a></div></div>` +
      `${paragraph('THIRD')}</div></article>` +
      `<aside><img src="https://cdn.example.com/aside-ad.jpg" width="300" height="250"></aside></main>` +
      `<footer><img src="https://cdn.example.com/badge.png" width="120" height="40"></footer></body></html>`
    const markdown = (await adapter.extract({ html, url: 'https://example.com/archive' })).contentMarkdown
    const at = (needle: string) => markdown.indexOf(needle)

    assert.ok(at('lead.jpg') >= 0 && at('lead.jpg') < at('FIRST'), 'the lead picture opens the article')
    assert.ok(at('FIRST') < at('slide-1.jpg') && at('slide-1.jpg') < at('slide-2.jpg') && at('slide-2.jpg') < at('SECOND'),
      'slides return between the paragraphs around them')
    for (const outside of ['wordmark.png', 'related.jpg', 'teaser.jpg', 'teaser-2.jpg', 'aside-ad.jpg', 'badge.png']) {
      assert.equal(markdown.includes(outside), false, outside)
    }
    assert.match(markdown.trim().split(/\n\s*\n/).at(-1) ?? '', /^THIRD /, 'the body ends with its text, not a pile of pictures')
  })
})
