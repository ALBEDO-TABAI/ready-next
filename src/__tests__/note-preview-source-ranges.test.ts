import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStructuredNotePreview,
  normalizePreviewNoteText,
  type PreviewBlock,
  type PreviewBlockSourceRange,
} from '../renderer/components/document/note-preview-parser'

/**
 * 合同：每个 PreviewBlock 的 source 区间指向归一化全文中它对应的源码片段；
 * 区间严格递增且互不重叠；无法可靠映射时必须为 null（宁缺毋错）。
 * 预览内编辑（preview-edit）的替换/移动都建立在这份合同上。
 */

function sliceOf(content: string, range: PreviewBlockSourceRange | null): string {
  assert.ok(range, 'expected a non-null source range')
  return normalizePreviewNoteText(content).slice(range.start, range.end)
}

function assertRangesOrdered(blocks: PreviewBlock[]): void {
  const ranged = blocks.filter((block) => block.source !== null)
  for (let index = 1; index < ranged.length; index += 1) {
    const prev = ranged[index - 1].source as PreviewBlockSourceRange
    const next = ranged[index].source as PreviewBlockSourceRange
    assert.ok(next.start >= prev.end, `ranges must be ascending and non-overlapping (${prev.end} -> ${next.start})`)
  }
}

describe('note preview block source ranges', () => {
  it('maps plain paragraphs back to their verbatim source slices', () => {
    const content = '# 标题\n\n第一段内容。\n\n第二段内容，稍微长一点。\n'
    const preview = buildStructuredNotePreview(content, null)
    const markdownBlocks = preview.blocks.filter((block) => block.type === 'markdown')
    assert.ok(markdownBlocks.length >= 2)
    assert.equal(sliceOf(content, markdownBlocks[0].source), '# 标题')
    assert.ok(markdownBlocks.some((block) => sliceOf(content, block.source) === '第一段内容。'))
    assert.ok(markdownBlocks.some((block) => sliceOf(content, block.source) === '第二段内容，稍微长一点。'))
    assertRangesOrdered(preview.blocks)
  })

  it('keeps ranges correct across frontmatter and extra blank lines', () => {
    const content = '---\ntitle: demo\ntags:\n  - a\n---\n\n开头一段。\n\n\n\n结尾一段。\n'
    const preview = buildStructuredNotePreview(content, null)
    const markdownBlocks = preview.blocks.filter((block) => block.type === 'markdown')
    assert.ok(markdownBlocks.some((block) => sliceOf(content, block.source) === '开头一段。'))
    assert.ok(markdownBlocks.some((block) => sliceOf(content, block.source) === '结尾一段。'))
    assertRangesOrdered(preview.blocks)
  })

  it('maps a standalone image line to exactly that line', () => {
    const content = '上文。\n\n![截图](assets/shot.png)\n\n下文。\n'
    const preview = buildStructuredNotePreview(content, '/tmp/note.md')
    const embedBlock = preview.blocks.find((block) => block.type === 'embed')
    assert.ok(embedBlock)
    assert.equal(sliceOf(content, embedBlock.source), '![截图](assets/shot.png)')
  })

  it('keeps a code fence with interior blank lines as one block with a full-fence range', () => {
    const content = '前文。\n\n```js\nconst a = 1\n\n\nconst b = 2\n```\n\n后文。\n'
    const preview = buildStructuredNotePreview(content, null)
    const fenceBlock = preview.blocks.find((block) => block.type === 'markdown' && block.markdown.includes('const a = 1'))
    assert.ok(fenceBlock)
    const slice = sliceOf(content, fenceBlock.source)
    assert.ok(slice.startsWith('```js'))
    assert.ok(slice.endsWith('```'))
    assert.ok(slice.includes('const a = 1\n\n\nconst b = 2'))
  })

  it('maps show-widget fences and the markdown around them', () => {
    const fence = '```show-widget\n{"title":"chart","widget_code":"<div>Chart</div>"}\n```'
    const content = `之前的文字。\n\n${fence}\n\n之后的文字。\n`
    const preview = buildStructuredNotePreview(content, null)
    const widgetBlock = preview.blocks.find((block) => block.type === 'widget')
    assert.ok(widgetBlock)
    assert.equal(sliceOf(content, widgetBlock.source), fence)
    const after = preview.blocks.find((block) => block.type === 'markdown' && block.markdown.includes('之后的文字'))
    assert.ok(after)
    assert.equal(sliceOf(content, after.source), '之后的文字。')
    assertRangesOrdered(preview.blocks)
  })

  it('maps details blocks to the whole <details> span', () => {
    const content = '开头。\n\n<details>\n<summary>展开</summary>\n里面的内容。\n</details>\n\n结束。\n'
    const preview = buildStructuredNotePreview(content, null)
    const details = preview.blocks.find((block) => block.type === 'details')
    assert.ok(details)
    const slice = sliceOf(content, details.source)
    assert.ok(slice.startsWith('<details>'))
    assert.ok(slice.endsWith('</details>'))
  })

  it('records the raw line for promoted section headings (about -> ## about)', () => {
    const content = '正文第一段。\n\nabout\n\n关于内容。\n'
    const preview = buildStructuredNotePreview(content, null)
    const promoted = preview.blocks.find((block) => block.type === 'markdown' && block.markdown.startsWith('## about'))
    assert.ok(promoted)
    assert.equal(sliceOf(content, promoted.source), 'about')
  })

  it('normalizes CRLF input so ranges line up with the normalized text', () => {
    const content = '第一段。\r\n\r\n第二段。\r\n'
    const preview = buildStructuredNotePreview(content, null)
    const markdownBlocks = preview.blocks.filter((block) => block.type === 'markdown')
    assert.ok(markdownBlocks.some((block) => sliceOf(content, block.source) === '第一段。'))
    assert.ok(markdownBlocks.some((block) => sliceOf(content, block.source) === '第二段。'))
  })

  it('maps standalone tag lines (chips) to their line', () => {
    const content = '前面。\n\n#tag1 #tag2\n\n后面。\n'
    const preview = buildStructuredNotePreview(content, null)
    const chips = preview.blocks.find((block) => block.type === 'chips')
    assert.ok(chips)
    assert.equal(sliceOf(content, chips.source), '#tag1 #tag2')
  })

  it('keeps header-metadata offsets intact (body is a suffix)', () => {
    const content = 'created: 2026-07-11\nurl: https://example.com/x\n\n正文开始。\n'
    const preview = buildStructuredNotePreview(content, null)
    const markdown = preview.blocks.find((block) => block.type === 'markdown')
    assert.ok(markdown)
    assert.equal(sliceOf(content, markdown.source), '正文开始。')
  })
})
