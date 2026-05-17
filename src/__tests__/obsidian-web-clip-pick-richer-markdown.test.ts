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

import { pickRicherMarkdown, runClipPipeline, sanitizeUnfetchableImageRefs } from '../main/modules/clipping/clip-pipeline'

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

describe('runClipPipeline · Jina-only fallback', () => {
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
  })
})
