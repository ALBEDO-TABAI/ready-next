import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStructuredNotePreview, type PreviewBlock } from '../renderer/components/document/note-preview-parser'
import {
  appendPreviewParagraph,
  getPreviewBlockSourceText,
  movePreviewBlockSource,
  replacePreviewBlockSource,
} from '../renderer/modules/document/previewEditOperations'

/**
 * 行为合同：预览内编辑的替换 / 移动 / 追加操作产出的全文，重新解析后
 * 结构必须符合预期；无有效区间时操作必须拒绝（返回 null）。
 */

function blockBySlice(content: string, predicate: (block: PreviewBlock) => boolean): PreviewBlock {
  const preview = buildStructuredNotePreview(content, null)
  const found = preview.blocks.find(predicate)
  assert.ok(found, 'expected block not found')
  return found
}

describe('preview edit operations', () => {
  it('replaces a paragraph in place and leaves the rest untouched', () => {
    const content = '# 标题\n\n旧的段落。\n\n结尾段。\n'
    const target = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '旧的段落。')
    const next = replacePreviewBlockSource(content, target, '新的段落，加了更多文字。')
    assert.ok(next)
    assert.equal(next, '# 标题\n\n新的段落，加了更多文字。\n\n结尾段。\n')
  })

  it('reads the raw source text as the editing seed', () => {
    const content = '正文第一段。\n\nabout\n\n关于内容。\n'
    const promoted = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown.startsWith('## about'))
    assert.equal(getPreviewBlockSourceText(content, promoted), 'about')
  })

  it('removes the block when replacement is empty, collapsing the seam', () => {
    const content = '第一段。\n\n要删除的段。\n\n第三段。\n'
    const target = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '要删除的段。')
    const next = replacePreviewBlockSource(content, target, '   \n  ')
    assert.ok(next)
    assert.equal(next, '第一段。\n\n第三段。\n')
  })

  it('moves a standalone image before another block', () => {
    const content = '第一段。\n\n第二段。\n\n![图](a.png)\n'
    const image = blockBySlice(content, (block) => block.type === 'embed')
    const first = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '第一段。')
    const next = movePreviewBlockSource(content, image, first, 'before')
    assert.ok(next)
    assert.equal(next, '![图](a.png)\n\n第一段。\n\n第二段。\n')
    const reparsed = buildStructuredNotePreview(next, null)
    assert.equal(reparsed.blocks[0].type, 'embed')
  })

  it('moves a standalone image after another block', () => {
    const content = '![图](a.png)\n\n第一段。\n\n第二段。\n'
    const image = blockBySlice(content, (block) => block.type === 'embed')
    const second = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '第二段。')
    const next = movePreviewBlockSource(content, image, second, 'after')
    assert.ok(next)
    assert.equal(next, '第一段。\n\n第二段。\n\n![图](a.png)\n')
    const reparsed = buildStructuredNotePreview(next, null)
    const last = reparsed.blocks[reparsed.blocks.length - 1]
    assert.equal(last.type, 'embed')
  })

  it('keeps tight single-newline context tight when removing from it', () => {
    const content = '上一行\n![图](a.png)\n下一行\n\n尾段。\n'
    const image = blockBySlice(content, (block) => block.type === 'embed')
    const tail = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '尾段。')
    const next = movePreviewBlockSource(content, image, tail, 'after')
    assert.ok(next)
    assert.ok(next.includes('上一行\n下一行'))
    assert.ok(next.trimEnd().endsWith('![图](a.png)'))
  })

  it('never touches code-fence interiors when splicing around them', () => {
    const fence = '```js\nconst a = 1\n\n\nconst b = 2\n```'
    const content = `${fence}\n\n![图](a.png)\n\n结尾。\n`
    const image = blockBySlice(content, (block) => block.type === 'embed')
    const tail = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '结尾。')
    const next = movePreviewBlockSource(content, image, tail, 'after')
    assert.ok(next)
    assert.ok(next.includes('const a = 1\n\n\nconst b = 2'), 'fence interior must stay verbatim')
  })

  it('refuses to operate on blocks without a source range', () => {
    const content = '一段文字。\n'
    const block = blockBySlice(content, (candidate) => candidate.type === 'markdown')
    const orphan = { ...block, source: null }
    assert.equal(replacePreviewBlockSource(content, orphan, '替换'), null)
    assert.equal(movePreviewBlockSource(content, orphan, block, 'before'), null)
    assert.equal(getPreviewBlockSourceText(content, orphan), null)
  })

  it('appends a paragraph at the end of the document', () => {
    assert.equal(appendPreviewParagraph('已有内容。\n', '新增的一段'), '已有内容。\n\n新增的一段\n')
    assert.equal(appendPreviewParagraph('', '第一段'), '第一段\n')
    assert.equal(appendPreviewParagraph('已有内容。\n', '   '), null)
  })

  it('round-trips an edit: replace then reparse finds the new text with a valid range', () => {
    const content = '第一段。\n\n第二段。\n'
    const target = blockBySlice(content, (block) => block.type === 'markdown' && block.markdown === '第二段。')
    const next = replacePreviewBlockSource(content, target, '第二段改写了。\n\n还追加了一段。')
    assert.ok(next)
    const reparsed = buildStructuredNotePreview(next, null)
    const added = reparsed.blocks.find((block) => block.type === 'markdown' && block.markdown === '还追加了一段。')
    assert.ok(added)
    assert.ok(added.source)
  })
})
