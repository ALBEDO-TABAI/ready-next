import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { LibraryHighlightService } from '../main/modules/library-engine/highlight-service'
import { applyDocumentOperation } from '../main/modules/document-engine/document-write-service'
import { publishFileAtomically } from '../main/modules/document-engine/atomic-file-publish'
import type { LibraryHighlightContext } from '../shared/library'

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ready-highlights-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'vault'); await mkdir(root)
  const file = join(dir, '书.txt'); await writeFile(file, '甲乙丙丁戊己庚辛壬癸')
  let failWrite = false, failAnchor = false
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root, defaultSuggestion: root }) })
  const book = (await engine.importFiles([file])).imported[0]
  const service = new LibraryHighlightService(engine, {
    write: input => applyDocumentOperation(input, { index: async () => {}, publish: async (...args) => {
      if (failWrite) throw new Error('injected write failure')
      await publishFileAtomically(...args)
    } }),
    publish: async (...args) => { if (failAnchor) throw new Error('injected anchor failure'); await publishFileAtomically(...args) },
  })
  const context: LibraryHighlightContext = { bookId: book.id, chapters: [{ title: '第一章', text: '甲乙丙丁戊己庚辛壬癸' }, { title: '第二章', text: '春夏秋冬' }] }
  const anchorPath = join(root, '.ready', 'anchors', `${book.id}.json`)
  const list = () => service.list(context)
  const create = async (chapter: number, from: number, to: number, note = '') => service.create({ ...context, expectedVersion: (await list()).version, chapter, from, to, color: 'yellow', note })
  return { engine, service, context, book, anchorPath, list, create, failWrite: () => { failWrite = true }, failAnchor: (value: boolean) => { failAnchor = value } }
}

test('D9 creates sorted quote blocks, transitively merges overlaps and keeps notes; updates and removes', async t => {
  const f = await fixture(t)
  await f.create(1, 0, 2)
  await f.create(0, 5, 8, '后面的批注')
  await f.create(0, 1, 4, '前面的批注')
  const merged = await f.create(0, 3, 6, '新批注')
  assert.equal(merged.highlights.length, 2)
  const h = merged.highlights[0]
  assert.deepEqual(h.location, { status: 'located', chapter: 0, from: 1, to: 8 })
  assert.equal(h.text, '乙丙丁戊己庚辛')
  assert.equal(h.note, '前面的批注\n\n后面的批注\n\n新批注')
  let md = await readFile(f.book.notePath, 'utf8')
  assert.ok(md.indexOf('第一章') < md.indexOf('第二章'))
  assert.ok(md.includes(`> [!quote|yellow] 第一章 · [原文](ready://read/book/${f.book.id}#c0:1+7)\n> 乙丙丁戊己庚辛\n>\n> 前面的批注\n>\n> 后面的批注\n>\n> 新批注\n\n^${h.id}`))
  const updated = await f.service.update({ ...f.context, expectedVersion: merged.version, id: h.id, patch: { color: 'pen', note: '改过的批注' } })
  assert.equal(updated.highlights[0].color, 'pen')
  assert.equal(updated.highlights[0].note, '改过的批注')
  const removed = await f.service.remove({ ...f.context, expectedVersion: updated.version, id: h.id })
  assert.equal(removed.highlights.length, 1)
  md = await readFile(f.book.notePath, 'utf8')
  assert.ok(!md.includes(`^${h.id}`))
  assert.ok(!JSON.parse(await readFile(f.anchorPath, 'utf8')).highlights[h.id])
})

test('C6 anchors rebuild from md, follow edited text, search whole book and reject ambiguous or missing quotes', async t => {
  const f = await fixture(t)
  const created = await f.create(0, 2, 5)
  const id = created.highlights[0].id
  const disk = JSON.parse(await readFile(f.anchorPath, 'utf8'))
  assert.equal(disk.version, 1)
  assert.deepEqual(disk.highlights[id].quote, { exact: '丙丁戊', prefix: '甲乙', suffix: '己庚辛壬癸' })
  await rm(f.anchorPath)
  assert.equal((await f.list()).highlights[0].location.status, 'located')
  assert.equal(JSON.parse(await readFile(f.anchorPath, 'utf8')).highlights[id].quote.exact, '丙丁戊')
  f.context.chapters[0].text = '新增甲乙丙丁戊己庚辛壬癸'
  assert.deepEqual((await f.list()).highlights[0].location, { status: 'located', chapter: 0, from: 4, to: 7 })
  f.context.chapters[1].text = f.context.chapters[0].text
  f.context.chapters[0].text = '没有原文'
  assert.deepEqual((await f.list()).highlights[0].location, { status: 'located', chapter: 1, from: 4, to: 7 })
  f.context.chapters[1].text = '重复丙丁戊重复丙丁戊'
  assert.equal((await f.list()).highlights[0].location.status, 'unlocated')
  f.context.chapters[1].text = '再也找不到'
  assert.equal((await f.list()).highlights[0].location.status, 'unlocated')
})

test('manual note edits are read; malformed blocks survive without painting; deletion prunes anchors', async t => {
  const f = await fixture(t)
  const state = await f.create(0, 0, 2, '旧批注')
  const h = state.highlights[0]
  let md = await readFile(f.book.notePath, 'utf8')
  await writeFile(f.book.notePath, md.replace('旧批注', '用户改了批注'))
  assert.equal((await f.list()).highlights[0].note, '用户改了批注')
  md = await readFile(f.book.notePath, 'utf8')
  await writeFile(f.book.notePath, md.replace('[!quote|yellow]', '[损坏]'))
  const broken = (await f.list()).highlights[0]
  assert.equal(broken.id, h.id)
  assert.equal(broken.location.status, 'malformed')
  assert.match(broken.text, /甲乙/)
  await writeFile(f.book.notePath, md.slice(0, md.indexOf('> [!quote')) + '## 我的笔记\n')
  assert.equal((await f.list()).highlights.length, 0)
  assert.deepEqual(JSON.parse(await readFile(f.anchorPath, 'utf8')).highlights, {})
})

test('failed md write changes neither file; stale versions fail; anchor failure stays recoverable after restart', async t => {
  const f = await fixture(t)
  const initial = await f.create(0, 0, 2)
  const md = await readFile(f.book.notePath, 'utf8'), anchors = await readFile(f.anchorPath, 'utf8')
  await assert.rejects(f.service.create({ ...f.context, expectedVersion: 'stale', chapter: 0, from: 5, to: 7, color: 'blue' }), /version/i)
  f.failWrite()
  await assert.rejects(f.service.remove({ ...f.context, expectedVersion: initial.version, id: initial.highlights[0].id }), /injected write failure/)
  assert.equal(await readFile(f.book.notePath, 'utf8'), md)
  assert.equal(await readFile(f.anchorPath, 'utf8'), anchors)
  const g = await fixture(t)
  g.failAnchor(true)
  const saved = await g.create(0, 0, 2)
  assert.equal(saved.persistence, 'saved')
  assert.equal(saved.anchors, 'repair_needed')
  assert.ok((await readFile(g.book.notePath, 'utf8')).includes(`^${saved.highlights[0].id}`))
  g.failAnchor(false)
  const reopened = new LibraryHighlightService(g.engine)
  assert.equal((await reopened.list(g.context)).highlights[0].location.status, 'located')
})

test('parallel edits with one version have exactly one winner and preserve other source sections', async t => {
  const f = await fixture(t)
  const state = await f.list()
  const common = { ...f.context, expectedVersion: state.version, chapter: 0, color: 'green' as const }
  const results = await Promise.allSettled([f.service.create({ ...common, from: 0, to: 2 }), f.service.create({ ...common, from: 5, to: 7 })])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await f.list()).highlights.length, 1)
  assert.ok((await readFile(f.book.notePath, 'utf8')).endsWith('## 我的笔记\n'))
})

test('repeated quotes require context; damaged section headings keep identifiable blocks; bad sidecars rebuild', async t => {
  const f = await fixture(t)
  f.context.chapters[0].text = '甲乙目标丙丁，戊己目标庚辛'
  const state = await f.create(0, 9, 11)
  assert.equal(state.highlights[0].text, '目标')
  assert.equal(state.highlights[0].location.status, 'located')
  // Old offset now contains a different occurrence; its context must prevent a wrong landing.
  f.context.chapters[0].text = '新增甲乙目标丙丁，戊己目标庚辛'
  const relocated = await f.list()
  assert.deepEqual(relocated.highlights[0].location, { status: 'located', chapter: 0, from: 11, to: 13 })
  f.context.chapters[0].text = '新增甲乙目标丙丁，戊己已删除庚辛'
  assert.equal((await f.list()).highlights[0].location.status, 'unlocated', 'a surviving duplicate must not steal the deleted passage')
  f.context.chapters[0].text = '新增甲乙目标丙丁，戊己目标庚辛'
  const md = await readFile(f.book.notePath, 'utf8')
  await writeFile(f.book.notePath, md.replace('## 标注', '## 我改了标题'))
  const damaged = await f.list()
  assert.equal(damaged.highlights[0].id, state.highlights[0].id)
  assert.equal(damaged.highlights[0].location.status, 'malformed')
  assert.ok(JSON.parse(await readFile(f.anchorPath, 'utf8')).highlights[state.highlights[0].id])
  await writeFile(f.book.notePath, md)
  await writeFile(f.anchorPath, '{truncated')
  assert.equal((await f.list()).highlights[0].location.status, 'unlocated', 'ambiguous text is retained, never guessed after cache loss')
  assert.equal(JSON.parse(await readFile(f.anchorPath, 'utf8')).version, 1)
})

test('listing an unchanged book leaves the anchor sidecar file in place', async t => {
  const f = await fixture(t)
  await f.create(0, 1, 3)
  // Atomic publish replaces the file, so an unchanged inode means no rewrite.
  const before = await stat(f.anchorPath)
  await f.list(); await f.list()
  assert.equal((await stat(f.anchorPath)).ino, before.ino)
})
