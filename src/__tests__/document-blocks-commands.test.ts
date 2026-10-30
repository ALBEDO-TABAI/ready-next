import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDocumentOperation } from '../shared/document-operations'
import { createBlockCommand, parseDocumentBlocks, type BlockCommand } from '../shared/document-blocks'

function run(content: string, command: BlockCommand, expected: string) {
  const edit = createBlockCommand({ content, version: 0 }, command)
  const actual = applyDocumentOperation(content, edit.operation, 0)
  assert.deepEqual(Buffer.from(actual), Buffer.from(expected))
  assert.deepEqual(Buffer.from(applyDocumentOperation(actual, edit.inverse, 1)), Buffer.from(content))
  const ranges = [...edit.operation.ranges].sort((a, b) => a.start - b.start)
  let beforeCursor = 0, afterCursor = 0
  for (const range of ranges) {
    const length = range.start - beforeCursor
    assert.deepEqual(Buffer.from(actual.slice(afterCursor, afterCursor + length)), Buffer.from(content.slice(beforeCursor, range.start)))
    beforeCursor = range.end; afterCursor += length + range.replacement.length
  }
  assert.deepEqual(Buffer.from(actual.slice(afterCursor)), Buffer.from(content.slice(beforeCursor)))
}

test('split, merge, insert, delete, paste and moves touch only named ranges and undo exactly', () => {
  const source = '\uFEFF甲😀乙\r\n\r\n第二段\n\n末段'
  const [first, second, last] = parseDocumentBlocks(source).blocks
  run(source, { type: 'split', block: first, offset: 3, separator: '\r\n\r\n' }, '\uFEFF甲😀\r\n\r\n乙\r\n\r\n第二段\n\n末段')
  run(source, { type: 'merge', first, second, separator: ' ' }, '\uFEFF甲😀乙 第二段\n\n末段')
  run(source, { type: 'insertAfter', block: first, markdown: '新增', prefix: '\n\n', suffix: '' }, '\uFEFF甲😀乙\n\n新增\r\n\r\n第二段\n\n末段')
  run(source, { type: 'delete', block: second }, '\uFEFF甲😀乙\r\n\r\n\n\n末段')
  run(source, { type: 'paste', at: last.end, markdown: '# 标题\r\n\r\n- 项目', prefix: '\n\n', suffix: '' }, '\uFEFF甲😀乙\r\n\r\n第二段\n\n末段\n\n# 标题\r\n\r\n- 项目')
  run(source, { type: 'move', block: last, target: first, placement: 'before', prefix: '', suffix: '\r\n\r\n' }, '\uFEFF末段\r\n\r\n甲😀乙\r\n\r\n第二段\n\n')
  run(source, { type: 'move', block: first, target: last, placement: 'after', prefix: '\n\n', suffix: '' }, '\uFEFF\r\n\r\n第二段\n\n末段\n\n甲😀乙')
  assert.throws(() => createBlockCommand({ content: source, version: 0 }, { type: 'split', block: first, offset: 2, separator: '\n\n' }), { code: 'split_surrogate' })
  assert.throws(() => createBlockCommand({ content: source, version: 0 }, { type: 'merge', first, second: last, separator: '' }), { code: 'invalid_command' })
})

test('callout settings preserve title, decorations and body bytes', () => {
  for (const source of ['> [!note]- 自定义标题\r\n> 内容\n> 下一行', '> [!quote|yellow] 标题\n> 正文']) {
    const block = parseDocumentBlocks(source).blocks[0]
    const next = source.startsWith('> [!note]') ? '> [!tip]+ 自定义标题\r\n> 内容\n> 下一行' : '> [!tip|yellow]+ 标题\n> 正文'
    run(source, { type: 'callout', block, calloutType: 'tip', fold: '+' }, next)
  }
})

test('columns move raw blocks inside the same group without rewriting markers or neighbors', () => {
  const source = '<!-- ready:columns widths=1,2 -->\r\n甲😀\r\n\r\n<!-- ready:column -->\n乙\n\n<!-- ready:columns-end -->'
  const blocks = parseDocumentBlocks(source).blocks
  const [fromColumn, toColumn] = blocks.filter(b => b.type === 'column')
  const block = blocks.find(b => b.raw === '甲😀')!
  const target = blocks.find(b => b.raw === '乙')!
  assert.equal(block.parentId, fromColumn.id)
  assert.deepEqual(blocks[0].widths, [1, 2])
  run(source, { type: 'moveInColumns', block, fromColumn, toColumn, at: target.end, prefix: '\n\n', suffix: '' }, '<!-- ready:columns widths=1,2 -->\r\n\r\n\r\n<!-- ready:column -->\n乙\n\n甲😀\n\n<!-- ready:columns-end -->')
  assert.throws(() => createBlockCommand({ content: source, version: 0 }, { type: 'moveInColumns', block, fromColumn, toColumn, at: 0, prefix: '', suffix: '' }), { code: 'invalid_command' })
})

test('source-only and readonly blocks require explicit whole-source replacement', () => {
  for (const source of ['```mermaid\r\nA-->B\r\n```', '```show-widget\n{}\n```', '<div>html</div>']) {
    const block = parseDocumentBlocks(source).blocks[0]
    assert.equal(block.capability, source.startsWith('<') ? 'readonly' : 'source')
    assert.equal(block.sourceEditable, true)
    assert.throws(() => createBlockCommand({ content: source, version: 0 }, { type: 'replace', block, markdown: 'new' }), { code: 'source_required' })
    run(source, { type: 'replace', block, markdown: 'new', mode: 'source' }, 'new')
  }
})

test('columns recognize top-level standalone markers only and flag malformed groups without rewriting', () => {
  const valid = '<!-- ready:columns -->\n一\n\n<!-- ready:column -->\n二\n\n<!-- ready:columns-end -->'
  assert.deepEqual(parseDocumentBlocks(valid).blocks[0].widths, [1, 1])
  for (const source of [
    '<!-- ready:columns -->\n未闭合', '<!-- ready:column -->',
    valid.replace('ready:columns -->', 'ready:columns widths=1 -->'),
    valid.replace('ready:columns -->', 'ready:columns widths=0,1 -->'),
    '<!-- ready:columns -->\n\n' + valid + '\n\n<!-- ready:columns-end -->',
  ]) {
    const doc = parseDocumentBlocks(source)
    assert.ok(!doc.blocks.some(b => b.type === 'columns'))
    assert.ok(doc.blocks.some(b => b.issue === '分栏格式需修复'))
    assert.equal(doc.segments.map(s => s.raw).join(''), source)
  }
  for (const source of ['````md\n' + valid + '\n````', valid.split('\n').map(line => '> ' + line).join('\n'), '- item\n\n' + valid.split('\n').map(line => '  ' + line).join('\n')]) {
    assert.ok(!parseDocumentBlocks(source).blocks.some(b => b.type === 'columns'))
  }
})

test('BOM does not hide columns and malformed separator syntax is not accepted as a column', () => {
  const source = '\uFEFF<!-- ready:columns -->\n甲\n\n<!-- ready:column -->\n乙\n\n<!-- ready:columns-end -->'
  assert.equal(parseDocumentBlocks(source).blocks[0].type, 'columns')
  const malformed = source.replace('ready:column -->', 'ready:column extra -->')
  const doc = parseDocumentBlocks(malformed)
  assert.ok(!doc.blocks.some(b => b.type === 'columns'))
  assert.ok(doc.blocks.some(b => b.issue === '分栏格式需修复'))
})
