import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { applyDocumentOperation } from '../shared/document-operations'
import { parseDocumentBlocks, createBlockCommand, type DocumentSegment } from '../shared/document-blocks'

const root = new URL('./fixtures/ready-markdown/', import.meta.url)
const cases: Array<{ name: string; target: string; replacement: string; occurrence: number }> = JSON.parse(readFileSync(new URL('cases.json', root), 'utf8'))
for (const fixture of cases) test(`C4 golden bytes: ${fixture.name}`, () => {
  const original = readFileSync(new URL(`${fixture.name}.before.md`, root))
  const expected = readFileSync(new URL(`${fixture.name}.after.md`, root))
  const content = original.toString('utf8')
  const doc = parseDocumentBlocks(content)
  function coverage(segments: DocumentSegment[], raw: string) {
    assert.deepEqual(Buffer.from(segments.map(s => s.raw).join('')), Buffer.from(raw))
    for (const segment of segments) if (segment.kind === 'block' && segment.children.length) coverage(segment.children, segment.raw)
  }
  coverage(doc.segments, content)
  const block = doc.blocks.filter(b => b.raw === fixture.target)[fixture.occurrence]
  assert.ok(block)
  const edit = createBlockCommand({ content, version: 11 }, { type: 'replace', block, markdown: fixture.replacement })
  const after = applyDocumentOperation(content, edit.operation, 11)
  assert.deepEqual(Buffer.from(after), expected)
  assert.deepEqual(Buffer.from(after.slice(0, block.start)), original.subarray(0, block.byteStart))
  assert.deepEqual(Buffer.from(after.slice(block.start + fixture.replacement.length)), original.subarray(block.byteEnd))
  assert.deepEqual(Buffer.from(applyDocumentOperation(after, edit.inverse, 12)), original)
  assert.throws(() => applyDocumentOperation(content, edit.operation, 12), { code: 'version_conflict' })
  assert.throws(() => applyDocumentOperation('x' + content, edit.operation, 11), { code: 'stale_range' })
  assert.throws(() => applyDocumentOperation(content, { ...edit.operation, ranges: [...edit.operation.ranges, ...edit.operation.ranges] }, 11), { code: 'overlapping_ranges' })
})

test('C4 empty document has no invented block and supports paste / undo', () => {
  assert.deepEqual(parseDocumentBlocks('').segments, [])
  const edit = createBlockCommand({ content: '', version: 0 }, { type: 'paste', at: 0, markdown: '甲\r\n\r\n乙😀', prefix: '', suffix: '' })
  assert.equal(applyDocumentOperation('', edit.operation, 0), '甲\r\n\r\n乙😀')
  assert.equal(applyDocumentOperation('甲\r\n\r\n乙😀', edit.inverse, 1), '')
})
