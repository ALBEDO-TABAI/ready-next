import assert from 'node:assert/strict'
import test from 'node:test'
import { createAnchor, relocateAnchor, anchoredBlocks, explicitBlockId, markBlock } from '../shared/document-anchors'
import { expandTemplate } from '../shared/document-anchors/template'

test('M5-D unique blocks follow moves; rewritten, removed and duplicated blocks explicitly lose their position', () => {
  const source = '甲\r\n\r\n原文😀\r\n\r\n乙', block = anchoredBlocks(source)[1]
  const anchor = createAnchor(source, block.start, block.end, 'v1', 'a')
  assert.deepEqual(relocateAnchor('原文😀\n\n乙\n\n甲', anchor), { state: 'located', start: 0, end: 4 })
  for (const changed of ['甲\n\n改写\n\n乙', '甲\n\n乙', '原文😀\n\n原文😀']) assert.equal(relocateAnchor(changed, anchor).state, 'lost')
  assert.equal(relocateAnchor(source, anchor).state, 'located')
})

test('M5-D explicit anchors survive rewriting and containers own their marker; fenced literals are not anchors', () => {
  const source = '> old ^quoted\n\n```\nnot an anchor ^fake\n```\n\n^code'
  const blocks = anchoredBlocks(source), quote = blocks[0], code = blocks.find(b => b.type === 'code')!
  const anchor = createAnchor(source, quote.start, quote.end, 'v1', 'a')
  assert.deepEqual(relocateAnchor('> rewritten ^quoted', anchor), { state: 'located', start: 0, end: 19 })
  assert.equal(explicitBlockId(source, code), 'code')
  assert.equal(relocateAnchor(source, { ...anchor, explicitId: 'fake' }).state, 'lost')
  assert.equal(markBlock('text', anchoredBlocks('text')[0], 'id'), 'text ^id')
})

test('M5-D template variables and internal anchors regenerate while external references survive', () => {
  const source = '---\nready_id: old\ncustom: keep\n---\n{{title}} {{date}} {{time}}\n\nbody ^old\n\n![[#^old]]\n\n![[other#^old]]'
  const result = expandTemplate(source, 'Meeting', new Date(2026, 9, 31, 9, 5), () => 'new')
  assert.match(result, /Meeting 2026-10-31 09:05/)
  assert.ok(!result.includes('ready_id'))
  assert.match(result, /custom: keep/)
  assert.match(result, /body \^block-new/)
  assert.match(result, /!\[\[#\^block-new\]\]/)
  assert.match(result, /!\[\[other#\^old\]\]/)
})

test('M5-D template remapping preserves code literals and converts named self references', () => {
  const result = expandTemplate('原块 ^id\n\n![[模板#^id]]\n\n`[[#^id]]`\n\n```\nnot a marker ^id\n[[#^id]]\n```', 'new', new Date(2026, 0, 1), () => 'fresh', '模板')
  assert.match(result, /原块 \^block-fresh/)
  assert.match(result, /!\[\[#\^block-fresh\]\]/)
  assert.match(result, /`\[\[#\^id\]\]`/)
  assert.match(result, /not a marker \^id\n\[\[#\^id\]\]/)
})
