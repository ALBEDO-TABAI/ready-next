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
