import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'

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
