import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInlineBlock, serializeInlineBlock, type InlineSpan } from '../shared/document-blocks/inline'

function output(source: string, spans: InlineSpan[]) {
  const model = parseInlineBlock(source)
  assert.equal(model.capability, 'rich')
  if (model.capability !== 'rich') throw new Error(model.reason)
  const result = serializeInlineBlock(model, spans)
  assert.equal(result.capability, 'rich', 'reason' in result ? result.reason : '')
  if (result.capability !== 'rich') throw new Error(result.reason)
  return result.markdown
}

test('unchanged inline meaning preserves exact markers, entities and heading decoration', () => {
  for (const raw of ['__粗__ 与 &amp; *斜*', '# 标题 **粗** #', 'a\r\nb', '<u>下划线</u>', '[[目录/页#锚|别名]]']) {
    const model = parseInlineBlock(raw)
    assert.equal(model.capability, 'rich')
    if (model.capability === 'rich') assert.deepEqual(serializeInlineBlock(model, structuredClone(model.spans)), { capability: 'rich', markdown: raw })
  }
})

test('inline serializer escapes literal syntax and chooses safe code fences', () => {
  const spans: InlineSpan[] = [{ text: '# *literal* [link] <tag> &amp; 1. x', marks: {} }]
  const raw = output('old', spans)
  assert.deepEqual(parseInlineBlock(raw).capability, 'rich')
  const parsed = parseInlineBlock(raw)
  if (parsed.capability === 'rich') assert.equal(parsed.spans.map(s => s.text).join(''), spans[0].text)
  assert.equal(output('old', [{ text: 'a``b`', marks: { code: true } }]), '``` a``b` ```')
  assert.equal(output('old', [{ text: ' x ', marks: { code: true } }]), '`  x  `')
})

test('nested marks, restricted HTML, Wiki and Ready references survive actual Markdown parsing', () => {
  const spans: InlineSpan[] = [
    { text: '粗', marks: { bold: true } }, { text: '又斜', marks: { bold: true, italic: true } },
    { text: '删', marks: { strike: true } }, { text: '下', marks: { underline: true, color: 'red', background: 'yellow' } },
    { text: '网页', marks: { reference: { kind: 'link', href: '../a b.md#x', title: 'A "title"' } } },
    { text: '页面', marks: { reference: { kind: 'wiki', target: '路径/页#^块' } } },
    { text: '卡片', marks: { reference: { kind: 'ready', ref: { kind: 'fastcard', id: 'abc' } } } },
  ]
  const raw = output('old', spans)
  assert.match(raw, /<u>/)
  assert.match(raw, /color: red/)
  assert.match(raw, /background-color: yellow/)
  assert.match(raw, /\[\[路径\/页#\^块\|页面\]\]/)
  assert.match(raw, /ready:\/\/fastcard\/abc/)
})

test('unsupported inline structures keep source and require source editing', () => {
  for (const raw of ['a ![image](x)', 'text <kbd>x</kbd>', '<span style="color: #fff">x</span>', 'a  \nb', '<u>unclosed', '[x][ref]', 'a ![[embed]]']) {
    const result = parseInlineBlock(raw)
    assert.equal(result.capability, 'source', raw)
    assert.equal(result.source, raw)
  }
})

test('clearing inline contents produces an empty block without losing surrounding source trivia', () => {
  assert.equal(output('text', []), '')
  assert.equal(output('## title ##\r\n', []), '##  ##\r\n')
})

test('inline text uses Markdown whitespace meaning while no-op retains original indentation', () => {
  const source = '  a \r\n  b [[页]]'
  const model = parseInlineBlock(source)
  assert.equal(model.capability, 'rich')
  if (model.capability !== 'rich') throw new Error(model.reason)
  assert.equal(model.spans.map(s => s.text).join(''), 'a\nb 页')
  assert.deepEqual(serializeInlineBlock(model, model.spans), { capability: 'rich', markdown: source })
})
