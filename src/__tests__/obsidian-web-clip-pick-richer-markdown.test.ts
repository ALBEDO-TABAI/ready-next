/**
 * Tests for `pickRicherMarkdown` — the readability-vs-Jina selector.
 *
 * Jina r.jina.ai sees the JS-rendered page; raw readability sees the static
 * HTTP fetch. For image-heavy modern news/photo sites, Jina captures more
 * media. We prefer whichever has materially more image refs; tiebreaker is
 * body length.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cleanJinaReaderMarkdown,
  pickRicherMarkdown,
  runClipPipeline,
  sanitizeUnfetchableImageRefs,
} from '../main/modules/clipping/clip-pipeline'

const READ = 'readability content with a few words'
const JINA = 'jina content rendered after JS'
const PRESET_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'assets',
  'embedded-skills',
  'obsidian-web-clip',
  'assets',
  'presets',
)

describe('pickRicherMarkdown · empty cases', () => {
  it('returns Jina when readability is empty', () => {
    assert.equal(pickRicherMarkdown('', JINA), JINA)
    assert.equal(pickRicherMarkdown(undefined, JINA), JINA)
  })
  it('returns readability when Jina is empty', () => {
    assert.equal(pickRicherMarkdown(READ, ''), READ)
    assert.equal(pickRicherMarkdown(READ, undefined), READ)
  })
})

describe('pickRicherMarkdown · image-count signal', () => {
  it('picks Jina when it has ≥2 more images', () => {
    const r = `${READ}\n\n![](https://e.com/a.jpg)`
    const j = `${JINA}\n\n![](https://e.com/a.jpg)\n![](https://e.com/b.jpg)\n![](https://e.com/c.jpg)`
    // r:1, j:3 → diff 2 → Jina wins
    assert.equal(pickRicherMarkdown(r, j), j)
  })

  it('picks readability when it has ≥2 more images', () => {
    const r = `${READ}\n\n![](https://e.com/a.jpg)\n![](https://e.com/b.jpg)\n![](https://e.com/c.jpg)`
    const j = `${JINA}\n\n![](https://e.com/a.jpg)`
    assert.equal(pickRicherMarkdown(r, j), r)
  })

  it('keeps readability when image counts are equal', () => {
    const r = `${READ}\n\n![](https://e.com/a.jpg)`
    const j = `${JINA}\n\n![](https://e.com/a.jpg)`
    assert.equal(pickRicherMarkdown(r, j), r)
  })

  it('keeps readability when image diff is 1 (avoid flipping on small differences)', () => {
    const r = `${READ}\n\n![](https://e.com/a.jpg)`
    const j = `${JINA}\n\n![](https://e.com/a.jpg)\n![](https://e.com/b.jpg)`
    assert.equal(pickRicherMarkdown(r, j), r)
  })
})

describe('pickRicherMarkdown · length tiebreaker', () => {
  it('picks Jina when both have zero images and Jina is >2x longer', () => {
    const r = 'short readability'
    const j = 'a much longer jina body '.repeat(20)
    assert.equal(pickRicherMarkdown(r, j), j.trim())
  })

  it('keeps readability when length difference is modest', () => {
    const r = 'readability with similar body length'
    const j = 'jina with similar body lengthxx'
    assert.equal(pickRicherMarkdown(r, j), r)
  })

  it('keeps readability when it has ≥5 real http imgs even if Jina is much longer', () => {
    // Real PaperMag-shaped scenario: readability recovers 16 gallery images
    // via reconciliation; Jina dumps the full page including nav menu (3x
    // longer) but only 3 fetchable http images (the rest are blob: URLs
    // already sanitized out). The picker must prefer readability.
    const r = [
      '# Title',
      ...Array.from({ length: 16 }, (_, i) => `![alt${i}](https://cdn.example.com/g${i}.jpg)`),
      'body paragraph',
    ].join('\n\n')
    const j = [
      '# Title',
      '*   [Home](https://e.com)',
      '*   [LGBTQ](https://e.com)',
      '![](https://cdn.example.com/logo.jpg)',
      '![](https://cdn.example.com/hero.jpg)',
      '![](https://cdn.example.com/one.jpg)',
      'a much longer jina body with full nav and lots of footer content '.repeat(30),
    ].join('\n\n')
    assert.ok(j.length > r.length * 2, 'Jina is longer in this scenario')
    assert.equal(pickRicherMarkdown(r, j), r, 'readability must win when it has ≥5 real imgs')
  })

  it('still lets Jina win when its real-img count is overwhelmingly larger', () => {
    // If readability has 5 imgs and Jina has 15 real http imgs, that's the
    // "JS-rendered images" gap the picker is supposed to close.
    const r = [
      '# Title',
      ...Array.from({ length: 5 }, (_, i) => `![](https://cdn.example.com/r${i}.jpg)`),
    ].join('\n\n')
    const j = [
      '# Title',
      ...Array.from({ length: 15 }, (_, i) => `![](https://cdn.example.com/j${i}.jpg)`),
    ].join('\n\n')
    assert.equal(pickRicherMarkdown(r, j), j)
  })
})

describe('sanitizeUnfetchableImageRefs', () => {
  it('drops blob: image refs entirely when alt is empty or "Image N"', () => {
    const input = '![](blob:http://localhost/abc)\n\n![Image 7](blob:http://localhost/def)'
    const out = sanitizeUnfetchableImageRefs(input)
    assert.ok(!out.includes('blob:'), 'no blob: refs should remain')
    assert.ok(!out.includes('![]'), 'no broken markdown image syntax should remain')
    assert.ok(!out.includes('Image 7'), 'Jina auto-numbered "Image N" is dropped')
  })

  it('preserves real alt text as italic fallback when ref is unfetchable', () => {
    const input = '![Shay at Dior show](blob:http://localhost/abc)'
    const out = sanitizeUnfetchableImageRefs(input)
    assert.equal(out.trim(), '_Shay at Dior show_')
  })

  it('drops data: image refs (svg placeholders, base64 inline images)', () => {
    const input = '![Hero](data:image/svg+xml,%3Csvg/%3E)\n\nbody'
    const out = sanitizeUnfetchableImageRefs(input)
    assert.ok(!out.includes('data:'))
    assert.equal(out.trim(), '_Hero_\n\nbody')
  })

  it('drops javascript: refs', () => {
    const input = '![](javascript:alert(1))'
    const out = sanitizeUnfetchableImageRefs(input)
    assert.ok(!out.includes('javascript:'))
  })

  it('keeps real http(s) image refs untouched', () => {
    const input = '![Hero](https://cdn.example.com/hero.jpg)\n\n![](http://e.com/x.png)'
    assert.equal(sanitizeUnfetchableImageRefs(input), input)
  })

  it('handles a mixed PaperMag-style markdown correctly', () => {
    const input = [
      '![Hero](https://cdn.example.com/hero.jpg)',
      '![Image 5: ...](https://cdn.example.com/h2.jpg)',
      '![Image 6](blob:http://localhost/x1)',
      '![Image 7](blob:http://localhost/x2)',
      '![Image 8](blob:http://localhost/x3)',
      '![Hero again](data:image/svg+xml,placeholder)',
    ].join('\n\n')
    const out = sanitizeUnfetchableImageRefs(input)
    const httpRefs = (out.match(/!\[[^\]]*\]\(https?:\/\/[^)]+\)/g) || []).length
    const unfetchableRefs = (out.match(/!\[[^\]]*\]\((blob|data|javascript):[^)]+\)/g) || []).length
    assert.equal(httpRefs, 2, 'real http(s) refs preserved')
    assert.equal(unfetchableRefs, 0, 'no unfetchable refs survive')
    assert.ok(out.includes('_Hero again_'), 'real alt promoted to italic')
  })
})

describe('cleanJinaReaderMarkdown', () => {
  it('keeps the article body while removing Jina full-page navigation and language noise', () => {
    const sourceUrl = 'https://znetwork.org/znetarticle/gaza-elders-who-survived-the-nakba-reflect-on-being-displaced-by-israel-again-78-years-later/'
    const raw = [
      'Title: Gaza Elders Who Survived The Nakba Reflect On Being Displaced By Israel Again, 78 Years Later',
      '',
      `URL Source: ${sourceUrl}`,
      '',
      'Published Time: 2026-05-16T15:42:50+00:00',
      '',
      'Markdown Content:',
      '# Gaza Elders Who Survived The Nakba Reflect On Being Displaced By Israel Again, 78 Years Later - ZNetwork',
      '',
      '[Close Menu](https://znetwork.org/#)',
      '',
      '[Facebook](https://www.facebook.com/OfficialZNet)[X (Twitter)](https://twitter.com/OfficialZNet)[RSS](https://znetwork.org/rss-feeds/)',
      '',
      '[![Image 4: ZNetwork](https://znetwork.org/wp-content/uploads/2022/08/Z_logo_64.png)](https://znetwork.org/ "ZNetwork")',
      '',
      `[![Image 6: af](${sourceUrl})Afrikaans](https://znetwork.org/af/znetarticle/example)[![Image 7: sq](${sourceUrl})Albanian](https://znetwork.org/sq/znetarticle/example)[![Image 8: am](${sourceUrl})Amharic](https://znetwork.org/am/znetarticle/example)[![Image 9: hy](${sourceUrl})Armenian](https://znetwork.org/hy/znetarticle/example)[![Image 10: az](${sourceUrl})Azerbaijani](https://znetwork.org/az/znetarticle/example)[![Image 11: eu](${sourceUrl})Basque](https://znetwork.org/eu/znetarticle/example)`,
      '',
      '[Home](https://znetwork.org/) » [ZNet Articles](https://znetwork.org/znetarticle/) » Gaza Elders Who Survived The Nakba Reflect On Being Displaced By Israel Again, 78 Years Later',
      '',
      '[Featured](https://znetwork.org/category/contenttype/featured/)[Human Rights](https://znetwork.org/category/topic/politics-gov/social-policy/human-rights/)[Palestine & Israel](https://znetwork.org/category/place/middle-east/israel-palestine/)',
      '',
      '# Gaza Elders Who Survived The Nakba Reflect On Being Displaced By Israel Again, 78 Years Later',
      '',
      '“Every moment I connect my life now to those years after the Nakba,” says 85-year-old Fatima Ibrahim Khalfallah.',
      '',
      'By[Mohamed Solaimane](https://znetwork.org/author/mohamed-solaimane/ "Posts by Mohamed Solaimane")May 16, 2026 Z Article[No Comments](https://znetwork.org/#respond)9 Mins Read',
      '',
      'Source: [Mondoweiss](https://mondoweiss.net/2026/05/source-article/)',
      '',
      '[![Image 146: Gaza Elders Who Survived The Nakba Reflect On Being Displaced By Israel Again, 78 Years Later](https://znetwork.org/wp-content/uploads/2026/05/hero-600x338.jpeg)](https://znetwork.org/wp-content/uploads/2026/05/hero.jpeg "Gaza Elders")',
      '',
      'Ismail Atiya Nasir al-Din treads cautiously through the ruins of his three-story home in the Amal neighborhood of western Khan Younis.',
      '',
      '### Related Posts',
      '',
      '*   [Israel’s Gaza War Is One of History’s Worst Crimes Ever](https://znetwork.org/znetarticle/related/)',
      '',
      'Leave A Reply[Cancel Reply](https://znetwork.org/#respond)',
    ].join('\n')

    const out = cleanJinaReaderMarkdown(raw, sourceUrl)

    assert.ok(out.startsWith('# Gaza Elders Who Survived'), 'article heading should become the start')
    assert.ok(out.includes('Ismail Atiya Nasir al-Din treads cautiously'), 'article prose should remain')
    assert.ok(out.includes('![Gaza Elders Who Survived'), 'content image should remain as an image')
    assert.ok(out.includes('hero.jpeg'), 'linked full-size image target should be preferred')
    assert.ok(!out.includes('Close Menu'))
    assert.ok(!out.includes('Afrikaans'))
    assert.ok(!out.includes('Related Posts'))
    assert.ok(!out.includes('Z_logo_64'))
    assert.ok(!out.includes('Markdown Content:'))
    assert.ok(out.includes('By [Mohamed Solaimane]'), 'cramped inline links should be spaced')
  })
})

describe('runClipPipeline · Jina-only fallback', () => {
  it('writes a canonical Bilibili player iframe when og:url carries tracking parameters', async () => {
    const outputsRoot = mkdtempSync(join(tmpdir(), 'ready-clip-bilibili-'))
    const result = await runClipPipeline(
      {
        html: [
          '<!doctype html>',
          '<html>',
          '<head>',
          '<title>Bilibili Demo</title>',
          '<meta property="og:url" content="https://www.bilibili.com/video/BV1XX1XXXXX1/?spm_id_from=333.999.0.0" />',
          '<meta name="keywords" content="demo,bilibili" />',
          '<meta name="author" content="Ready" />',
          '</head>',
          '<body><main><h1>Bilibili Demo</h1><p>Body</p></main></body>',
          '</html>',
        ].join(''),
        url: 'https://www.bilibili.com/video/BV1XX1XXXXX1/?spm_id_from=333.999.0.0',
      },
      {
        presetDir: PRESET_DIR,
        preset: 'b站-clipper',
        outputsRoot,
      },
    )

    const saved = readFileSync(result.savedPath, 'utf-8')
    const iframeLine = saved.split('\n').find((line) => line.includes('player.bilibili.com')) || ''
    assert.ok(iframeLine.includes('bvid=BV1XX1XXXXX1&p=1&autoplay=0'))
    assert.ok(!iframeLine.includes('spm_id_from'))
  })

  it('writes a note when raw HTML is unavailable but Jina markdown is present', async () => {
    const outputsRoot = mkdtempSync(join(tmpdir(), 'ready-clip-jina-only-'))
    const result = await runClipPipeline(
      {
        html: '',
        url: 'https://example.com/cloudflare',
        jinaMarkdown: 'Title: Cloudflare Article\n\nMarkdown Content:\n# Cloudflare Article\n\nBody from Jina',
      },
      {
        presetDir: PRESET_DIR,
        preset: 'article-clipper',
        outputsRoot,
      },
    )

    assert.equal(result.title, 'Cloudflare Article')
    assert.ok(result.warnings.includes('raw_html_unavailable_jina_fallback'))
    const saved = readFileSync(result.savedPath, 'utf-8')
    assert.ok(saved.includes('Body from Jina'))
    assert.ok(!saved.includes('Markdown Content:'))
  })

  it('writes cleaned Jina content instead of full-page menu dumps', async () => {
    const outputsRoot = mkdtempSync(join(tmpdir(), 'ready-clip-jina-clean-'))
    const result = await runClipPipeline(
      {
        html: '',
        url: 'https://example.com/article',
        jinaMarkdown: [
          'Title: Useful Article',
          '',
          'Markdown Content:',
          '# Useful Article - Example',
          '',
          '[Close Menu](https://example.com/#)',
          '',
          '[Facebook](https://facebook.com/example)[RSS](https://example.com/rss-feeds/)',
          '',
          '# Useful Article',
          '',
          'This is the first real paragraph of the clipped article, with enough words to look like prose.',
          '',
          '![Hero](https://example.com/wp-content/uploads/2026/05/hero.jpg)',
          '',
          '### Related Posts',
          '',
          '* [Other story](https://example.com/other)',
        ].join('\n'),
      },
      {
        presetDir: PRESET_DIR,
        preset: 'article-clipper',
        outputsRoot,
      },
    )

    const saved = readFileSync(result.savedPath, 'utf-8')
    assert.ok(saved.includes('This is the first real paragraph'))
    assert.ok(saved.includes('![Hero](https://example.com/wp-content/uploads/2026/05/hero.jpg)'))
    assert.ok(!saved.includes('Close Menu'))
    assert.ok(!saved.includes('Related Posts'))
    assert.ok(!saved.includes('rss-feeds'))
  })
})
