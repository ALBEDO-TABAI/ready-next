import assert from 'node:assert/strict'
import test from 'node:test'
import { applyDocumentOperation } from '../shared/document-operations'
import { parseDocumentBlocks, readDocumentBytes, createPositionMap, createBlockCommand } from '../shared/document-blocks'

test('C4 positions cover original BOM and mixed newlines without splitting emoji', () => {
  const source = '\uFEFF# 中文😀\r\n\r\n正文e\u0301\n\n尾'
  const doc = parseDocumentBlocks(source)
  assert.deepEqual(Buffer.from(doc.segments.map(s => s.raw).join('')), Buffer.from(source))
  for (const b of doc.blocks) {
    assert.deepEqual(Buffer.from(source).subarray(b.byteStart, b.byteEnd), Buffer.from(b.raw))
  }
  assert.equal(doc.segments[0].kind, 'gap')
  assert.equal(doc.blocks[0].start, 1)
  const map = createPositionMap('中😀x')
  assert.equal(map.toByte(3), 7)
  assert.equal(map.toUtf16(7), 3)
  assert.throws(() => map.toByte(2), { code: 'split_surrogate' })
  assert.throws(() => map.toUtf16(4), { code: 'invalid_byte_offset' })
})

test('invalid UTF-8 stays source-only without decoding replacement bytes', () => {
  for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe4, 0xb8]]) {
    const result = readDocumentBytes(Uint8Array.from(bytes))
    assert.equal(result.capability, 'source')
    assert.ok('reason' in result)
  }
  const result = readDocumentBytes(Buffer.from('\uFEFF中😀'))
  assert.equal(result.capability, 'blocks')
  if (result.capability === 'blocks') assert.equal(result.document.source, '\uFEFF中😀')
})

test('D3 stale blocks are rejected; CRLF outside the selected block is untouched', () => {
  const content = '甲\r\n\r\n乙\n\n丙\r\n'
  const doc = parseDocumentBlocks(content)
  const block = doc.blocks.find(b => b.raw === '乙')!
  const edit = createBlockCommand({ content, version: 4 }, { type: 'replace', block, markdown: '新😀' })
  const after = applyDocumentOperation(content, edit.operation, 4)
  assert.deepEqual(Buffer.from(after), Buffer.from('甲\r\n\r\n新😀\n\n丙\r\n'))
  assert.equal(applyDocumentOperation(after, edit.inverse, 5), content)
  assert.throws(() => createBlockCommand({ content: 'X' + content, version: 5 }, { type: 'replace', block, markdown: '错' }), { code: 'stale_range' })
  assert.throws(() => applyDocumentOperation(content, edit.operation, 5), { code: 'version_conflict' })
})

test('unsupported inline content and fence interiors cannot enter rich block edits', () => {
  const unsupported = parseDocumentBlocks('text <kbd>x</kbd>').blocks[0]
  assert.equal(unsupported.capability, 'source')
  const content = '```mermaid\nA-->B\n```'
  assert.throws(() => createBlockCommand({ content, version: 0 }, { type: 'paste', at: 12, markdown: 'bad', prefix: '', suffix: '' }), { code: 'source_required' })
})
