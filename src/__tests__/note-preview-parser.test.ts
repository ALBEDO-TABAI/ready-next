import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import { EBOOK_INLINE_IMAGE_TITLE } from '../shared/ebook'

describe('buildStructuredNotePreview', () => {
  it('parses YAML frontmatter into properties, tags and a YouTube card', () => {
    const preview = buildStructuredNotePreview(`---
title: Arcane
url: https://www.youtube.com/watch?v=VIXBLhoZbl4
thumbnailUrl: https://i.ytimg.com/vi/VIXBLhoZbl4/maxresdefault.jpg
published: 2024-12-16
tags:
  - "#奥术"
  - "#ArcaneS2"
---

Description

Some summary text.
`, '/notes/arcane.md')

    assert.equal(preview.heroEmbed?.kind, 'youtube')
    assert.equal(preview.heroEmbed?.thumbnailUrl, 'https://i.ytimg.com/vi/VIXBLhoZbl4/maxresdefault.jpg')
    assert.deepEqual(
      preview.tags.map((tag) => tag.label),
      ['#奥术', '#ArcaneS2'],
    )
    assert.equal(
      preview.properties.find((property) => property.key === 'published')?.displayValue,
      '2024-12-16',
    )
    assert.match(preview.bodyMarkdown, /## Description/)
  })

  it('parses half-structured top metadata blocks with list properties', () => {
    const preview = buildStructuredNotePreview(`created: 2025-05-20T21:09:30+08:00 url: "https://www.youtube.com/watch?v=VIXBLhoZbl4" title: "《奥术》 第二季深度解析" channel: "超粒方" related:
- "[[Videos]]"
published: 2024-12-16 thumbnailUrl: "https://i.ytimg.com/vi/VIXBLhoZbl4/maxresdefault.jpg" duration: "3565" tags:
- "#奥术"
- "#ArcaneS2"

About

type: #type/video/youtube/new
`, '/notes/arcane.md')

    assert.equal(preview.heroEmbed?.kind, 'youtube')
    assert.equal(preview.heroEmbed?.duration, '59:25')
    assert.equal(preview.related[0]?.label, 'Videos')
    assert.deepEqual(
      preview.tags.map((tag) => tag.label),
      ['#奥术', '#ArcaneS2'],
    )
    assert.match(preview.bodyMarkdown, /## About/)
    assert.match(preview.bodyMarkdown, /type: #type\/video\/youtube\/new/)
  })

  it('extracts local video embeds and standalone tag rows from the body', () => {
    const preview = buildStructuredNotePreview(`Intro

![[media/demo.mp4]]

#tag-one #tag-two
`, '/vault/notes/demo.md')

    assert.equal(preview.embeds[0]?.kind, 'video')
    assert.equal(preview.embeds[0]?.localPath, '/vault/notes/media/demo.mp4')
    assert.deepEqual(
      preview.tags.map((tag) => tag.label),
      ['#tag-one', '#tag-two'],
    )
    assert.equal(preview.blocks.some((block) => block.type === 'embed'), true)
    assert.equal(preview.blocks.some((block) => block.type === 'chips'), true)
  })

  it('extracts Obsidian image embeds with caption or size modifiers', () => {
    const captionPreview = buildStructuredNotePreview(`![[assets/cover image.png|封面图]]`, '/vault/notes/demo.md')
    const sizedPreview = buildStructuredNotePreview(`![[assets/cover image.png|400]]`, '/vault/notes/demo.md')

    assert.equal(captionPreview.embeds[0]?.kind, 'image')
    assert.equal(captionPreview.embeds[0]?.localPath, '/vault/notes/assets/cover image.png')
    assert.equal(captionPreview.embeds[0]?.alt, '封面图')
    assert.equal(sizedPreview.embeds[0]?.kind, 'image')
    assert.equal(sizedPreview.embeds[0]?.localPath, '/vault/notes/assets/cover image.png')
    assert.equal(sizedPreview.embeds[0]?.alt, 'cover image.png')
  })

  it('unwraps markdown image destinations wrapped with angle brackets', () => {
    const preview = buildStructuredNotePreview(
      '![概念 MV 感知建筑图](<gQlMMD8auMs_audiovisual_structure.png>)',
      '/Users/demo/project/gQlMMD8auMs_audiovisual_analysis.md',
    )

    assert.equal(preview.embeds[0]?.kind, 'image')
    assert.equal(
      preview.embeds[0]?.localPath,
      '/Users/demo/project/gQlMMD8auMs_audiovisual_structure.png',
    )
    assert.equal(
      preview.embeds[0]?.url,
      'local-file:///Users/demo/project/gQlMMD8auMs_audiovisual_structure.png',
    )
    assert.equal(preview.embeds[0]?.displayUrl, 'gQlMMD8auMs_audiovisual_structure.png')
  })

  it('keeps angle-wrapped image paths with parentheses intact', () => {
    const preview = buildStructuredNotePreview(
      '![](<assets/hero (draft).png>)',
      '/vault/notes/demo.md',
    )

    assert.equal(preview.embeds[0]?.kind, 'image')
    assert.equal(preview.embeds[0]?.localPath, '/vault/notes/assets/hero (draft).png')
  })

  it('does not promote ebook inline image markers into standalone embeds', () => {
    const preview = buildStructuredNotePreview(
      `![](<assets/glyph.png> "${EBOOK_INLINE_IMAGE_TITLE}")`,
      '/vault/notes/demo.md',
    )

    assert.equal(preview.embeds.length, 0)
    assert.equal(preview.blocks[0]?.type, 'markdown')
  })

  it('normalizes inline Obsidian image embeds inside markdown blocks', () => {
    const preview = buildStructuredNotePreview(`封面： ![[assets/cover.png|插图]]`, '/vault/notes/demo.md')

    assert.match(preview.bodyMarkdown, /!\[插图\]\(<assets\/cover\.png>\)/)
    assert.doesNotMatch(preview.bodyMarkdown, /!\[\[/)
  })

  it('recovers malformed frontmatter with loose parsing instead of warning', () => {
    const preview = buildStructuredNotePreview(`---
title: "Broken quote
url: https://www.youtube.com/watch?v=VIXBLhoZbl4
tags:
  - "#奥术"
---

Description

Body text.
`, '/notes/broken.md')

    assert.equal(preview.warnings.length, 0)
    assert.equal(preview.heroEmbed?.kind, 'youtube')
    assert.equal(preview.properties.find((property) => property.key === 'title')?.displayValue, '"Broken quote')
    assert.deepEqual(preview.tags.map((tag) => tag.label), ['#奥术'])
  })
})

describe('buildStructuredNotePreview · bilibili iframe + metadata-leak fix', () => {
  it('renders b 站 player iframe as a `bilibili` embed (not raw HTML)', () => {
    const md = [
      '---',
      'title: "面包科普"',
      'source: "https://www.bilibili.com/video/BV1Uu5k6TETr/"',
      '---',
      '',
      '<iframe src="https://player.bilibili.com/player.html?isOutside=true&bvid=BV1Uu5k6TETr&p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" style="width:100%; height:500px;"></iframe>',
      '',
    ].join('\n')
    const out = buildStructuredNotePreview(md)
    const bilibili = out.embeds.find((e) => e.kind === 'bilibili')
    assert.ok(bilibili, 'bilibili embed should be detected')
    assert.equal(bilibili!.videoId, 'BV1Uu5k6TETr')
    assert.equal(
      bilibili!.embedUrl,
      'https://player.bilibili.com/player.html?isOutside=true&bvid=BV1Uu5k6TETr&p=1&autoplay=0',
    )
    // No markdown block should still contain the raw iframe tag — it must be
    // consumed by the embed pipeline.
    const markdownBlocks = out.blocks.filter((b) => b.type === 'markdown')
    for (const block of markdownBlocks) {
      assert.equal(
        (block as { markdown: string }).markdown.includes('<iframe'),
        false,
        'iframe must not leak into a markdown block',
      )
    }
  })

  it('canonicalizes b 站 player iframe URLs so tracked og:url values do not black-screen the preview', () => {
    const md = [
      '---',
      'title: "演示"',
      'source: "https://www.bilibili.com/video/BV1XX1XXXXX1/?spm_id_from=333.999.0.0"',
      '---',
      '',
      '<iframe src="https://player.bilibili.com/player.html?isOutside=true&bvid=BV1XX1XXXXX1?spm_id_from=333.999.0.0&p=2" style="width:100%; height:500px;"></iframe>',
      '',
    ].join('\n')
    const out = buildStructuredNotePreview(md)
    const bilibili = out.embeds.find((e) => e.kind === 'bilibili')
    assert.ok(bilibili, 'bilibili embed should be detected')
    assert.equal(bilibili!.videoId, 'BV1XX1XXXXX1')
    assert.equal(
      bilibili!.embedUrl,
      'https://player.bilibili.com/player.html?isOutside=true&bvid=BV1XX1XXXXX1&p=2&autoplay=0',
    )
  })

  it('inline iframe attributes do NOT donate spurious metadata keys (height / src)', () => {
    // Regression: the chained-metadata heuristic used to scan ALL header
    // lines for `key: value` tokens. An inline `<iframe ... style="width:100%;
    // height:500px;"></iframe>` would inject a phantom `height` property,
    // which is what users saw in the b 站 preview (a "height: 500px;"></iframe>"
    // row in the frontmatter table).
    const md = [
      '---',
      'title: "演示"',
      'source: "https://www.bilibili.com/video/BV1XX1XXXXX1/"',
      '---',
      '',
      '<iframe src="https://player.bilibili.com/player.html?bvid=BV1XX1XXXXX1" style="width:100%; height:500px;"></iframe>',
      '',
    ].join('\n')
    const out = buildStructuredNotePreview(md)
    const keys = out.properties.map((p) => p.key.toLowerCase())
    assert.equal(keys.includes('height'), false, `height must not appear in metadata, got: ${keys.join(', ')}`)
    assert.equal(keys.includes('src'), false, `src must not appear in metadata, got: ${keys.join(', ')}`)
    assert.equal(keys.includes('style'), false, `style must not appear in metadata, got: ${keys.join(', ')}`)
    // The legitimate `source` from frontmatter is still preserved.
    assert.ok(keys.includes('source'), 'source from frontmatter should survive')
    assert.ok(keys.includes('title'), 'title from frontmatter should survive')
  })

  it('rejects iframe with non-whitelisted src (only player.bilibili.com is trusted)', () => {
    const md = [
      '<iframe src="https://evil.example.com/player.html?bvid=BV1XX1XXXXX1" style="width:100%; height:500px;"></iframe>',
    ].join('\n')
    const out = buildStructuredNotePreview(md)
    const bilibili = out.embeds.find((e) => e.kind === 'bilibili')
    assert.equal(bilibili, undefined, 'untrusted iframe src must not produce a bilibili embed')
  })

  it('rejects iframe without bvid query parameter', () => {
    const md = [
      '<iframe src="https://player.bilibili.com/player.html?aid=123456" style="width:100%; height:500px;"></iframe>',
    ].join('\n')
    const out = buildStructuredNotePreview(md)
    const bilibili = out.embeds.find((e) => e.kind === 'bilibili')
    assert.equal(bilibili, undefined, 'iframe without bvid must not become a bilibili embed')
  })
})
