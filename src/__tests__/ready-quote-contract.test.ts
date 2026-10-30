import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStructuredNotePreview } from '../renderer/components/document/note-preview-parser'
import { readQuoteCard } from '../renderer/components/document/library-quote'
import { parseBookLocation, resolveBookLocation } from '../renderer/modules/library/reader/location'
import { JSDOM } from 'jsdom'
import { paginate } from '../renderer/modules/library/reader/paginate'

const raw = '![[山海#^hl-one]]'
const source = '---\nready_id: bk-one\n作者: 白\n---\n# 山海\n\n## 标注\n\n> [!quote|blue] 第一章 · [原文](ready://read/book/bk-one#c0:2+3)\n> 丙丁戊\n>\n> 我的批注\n\n^hl-one\n'
test('quote embeds preserve source bytes and ranges; code fences stay code', () => {
  const content = `前文\n\n${raw}\n\n\`\`\`md\n${raw}\n\`\`\``
  const preview = buildStructuredNotePreview(content, '/vault/note.md')
  assert.equal(preview.embeds.filter(e => e.kind === 'library-quote').length, 1)
  const block = preview.blocks.find(b => b.type === 'embed')!
  assert.equal(content.slice(block.source!.start, block.source!.end).trim(), raw)
  assert.ok(preview.bodyMarkdown.includes(raw), 'the fenced source remains literal')
})
test('quote card reads exactly the selected source block, including later edits and invalidation', () => {
  const card = readQuoteCard(source, 'bk-one', '山海', 'hl-one')
  assert.deepEqual(card, { title: '山海', author: '白', chapter: '第一章', color: 'blue', text: '丙丁戊', note: '我的批注', uri: 'ready://read/book/bk-one#c0:2+3' })
  assert.equal(readQuoteCard(source.replace('我的批注', '新的批注'), 'bk-one', '山海', 'hl-one')?.note, '新的批注')
  assert.equal(readQuoteCard(source, 'bk-one', '山海', 'hl-gone'), null)
  assert.equal(readQuoteCard(source + '\n' + source.slice(source.indexOf('> [!quote')), 'bk-one', '山海', 'hl-one'), null)
})
test('book locations use real pagination and non-space offsets, rejecting missing chapters and ranges', async () => {
  const dom = new JSDOM('<main></main>')
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  try {
    const book = { title: '山海', lang: 'zh', chapters: [{ title: '一', file: '1', html: '<p>甲 乙 丙 丁 戊</p>' }, { title: '二', file: '2', html: '<p>春 夏 秋 冬</p>' }], toc: [], chars: 9, urls: [] }
    for (const size of [14, 28]) {
      const layout = await paginate(book, { size, lead: 1.8, font: 'song', paper: 'cream' }, { container: dom.window.document.querySelector('main')!, latin: false, tocRows: 0 })
      const location = parseBookLocation('c1:1+2')
      const page = resolveBookLocation(layout, location)
      assert.equal(layout.pages[page - 1].chapter, 1)
      assert.throws(() => resolveBookLocation(layout, parseBookLocation('c2:0+1')), /位置不存在/)
      assert.throws(() => resolveBookLocation(layout, parseBookLocation('c1:3+2')), /位置不存在/)
    }
    for (const loc of ['c-1:0+1', 'c0:0+0', 'c0:9007199254740992+1']) assert.throws(() => parseBookLocation(loc), /位置无效/)
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else Reflect.deleteProperty(globalThis, 'document')
    dom.window.close()
  }
})
