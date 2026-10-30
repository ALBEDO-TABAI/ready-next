import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentHistory, createRangeEdit, createBlockCommand, parseDocumentBlocks, type HistoryKind } from '../shared/document-blocks'

function type(history: DocumentHistory, text: string, group: string, kind: HistoryKind = 'typing') {
  const buffer = history.snapshot
  const at = buffer.content.length
  return history.apply(createRangeEdit(buffer, [{ start: at, end: at, expectedText: '', replacement: text }],
    { anchor: at, focus: at }, { anchor: at + text.length, focus: at + text.length }), { kind, group })
}

test('continuous typing and one IME composition each undo as one buffer record', () => {
  const history = new DocumentHistory('原\r\n')
  type(history, 'a', 'typing-1'); type(history, 'b', 'typing-1')
  type(history, '中', 'ime-1', 'composition'); type(history, '文', 'ime-1', 'composition')
  assert.equal(history.entries.length, 2)
  assert.equal(history.undo(4).ok, true)
  assert.equal(history.snapshot.content, '原\r\nab')
  assert.equal(history.undo(5).ok, true)
  assert.deepEqual(Buffer.from(history.snapshot.content), Buffer.from('原\r\n'))
  assert.equal(history.redo(6).ok, true)
  assert.equal(history.snapshot.content, '原\r\nab')
  assert.equal(history.redo(7).ok, true)
  assert.equal(history.snapshot.content, '原\r\nab中文')
  const old = history.snapshot
  assert.deepEqual(history.undo(7), { ok: false, code: 'version_conflict', message: '历史与当前缓冲版本不一致，内容未改变' })
  assert.deepEqual(history.snapshot, old)
})

test('composition replacement, external changes and branch edits share the same owner', () => {
  const history = new DocumentHistory('A')
  type(history, 'ni', 'ime', 'composition')
  const replacement = createRangeEdit(history.snapshot, [{ start: 1, end: 3, expectedText: 'ni', replacement: '你' }], { anchor: 3, focus: 3 }, { anchor: 2, focus: 2 })
  history.apply(replacement, { kind: 'composition', group: 'ime' })
  assert.equal(history.entries.length, 1)
  const operation = { type: 'replaceRanges' as const, expectedVersion: 2, ranges: [{ start: 0, end: 1, expectedText: 'A', replacement: '外部' }] }
  assert.equal(history.applyExternal(operation, { anchor: 3, focus: 3 }).ok, true)
  assert.equal(history.entries.length, 2)
  assert.equal(history.applyExternal(operation, { anchor: 3, focus: 3 }).ok, false)
  assert.equal(history.undo(3).ok, true)
  assert.equal(history.snapshot.content, 'A你')
  assert.equal(history.undo(4).ok, true)
  assert.equal(history.snapshot.content, 'A')
  type(history, '新', 'new')
  assert.equal(history.redo(6).ok, false)
  assert.equal(history.snapshot.content, 'A新')
})

test('drag, split and paste stay separate records even with a reused group', () => {
  const history = new DocumentHistory('甲\r\n\r\n乙')
  const blocks = parseDocumentBlocks(history.snapshot.content).blocks
  const move = createBlockCommand(history.snapshot, { type: 'move', block: blocks[1], target: blocks[0], placement: 'before', prefix: '', suffix: '\r\n\r\n' })
  history.apply(move, { kind: 'drag', group: 'same' })
  const first = parseDocumentBlocks(history.snapshot.content).blocks[0]
  history.apply(createBlockCommand(history.snapshot, { type: 'split', block: first, offset: 1, separator: '\r\n\r\n新增' }), { kind: 'split', group: 'same' })
  history.apply(createBlockCommand(history.snapshot, { type: 'paste', at: 0, prefix: '', markdown: '# 贴\n\n另一块', suffix: '\n\n' }), { kind: 'paste', group: 'same' })
  assert.equal(history.entries.length, 3)
  for (let i = 0; i < 3; i++) assert.equal(history.undo(history.snapshot.version).ok, true)
  assert.deepEqual(Buffer.from(history.snapshot.content), Buffer.from('甲\r\n\r\n乙'))
})

test('history owns its ranges even if the caller later reuses an input array', () => {
  const history = new DocumentHistory('a')
  const ranges = [{ start: 0, end: 1, expectedText: 'a', replacement: 'b' }]
  const edit = createRangeEdit(history.snapshot, ranges, { anchor: 0, focus: 0 })
  history.apply(edit, { kind: 'edit' })
  ranges[0].replacement = 'corrupted'
  assert.equal(history.undo(1).ok, true)
  assert.equal(history.redo(2).ok, true)
  assert.equal(history.snapshot.content, 'b')
})
