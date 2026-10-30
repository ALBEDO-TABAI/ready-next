import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, rename, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import JSZip from 'jszip'
import { watchLibrary } from '../main/modules/library-engine/changes'
import type { LibraryState } from '../shared/library'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { decodeBookText } from '../main/modules/library-engine/book-metadata'
import { applyDocumentOperation } from '../main/modules/document-engine/document-write-service'
import { publishFileAtomically } from '../main/modules/document-engine/atomic-file-publish'
import { readDocumentSource } from '../shared/document-operations'
import type { VaultState } from '../shared/vault'

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ready-library-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'vault')
  await mkdir(root)
  let vault: VaultState = { status: 'ready', root, defaultSuggestion: root }
  const indexed: string[] = []
  const engine = new LibraryEngine({
    vault: () => vault,
    write: (input) => applyDocumentOperation(input, { index: async (path) => { indexed.push(path) } }),
  })
  const txt = join(dir, '科学.txt')
  await writeFile(txt, '科学 世界\n你好')
  return { dir, root, txt, engine, indexed, setVault: (value: VaultState) => { vault = value } }
}

// C6: source notes own metadata; each import is complete or leaves no book artifacts.
test('EPUB metadata, classification, cover and source/database pages round trip', async (t) => {
  const { dir, root, engine } = await fixture(t)
  const zip = new JSZip()
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
  zip.file('OPS/book.opf', `<package><metadata><dc:title>三体 &amp; 宇宙</dc:title><dc:creator>刘慈欣</dc:creator><dc:publisher>出版社</dc:publisher><dc:language>zh</dc:language><dc:date>2008-01-01</dc:date><dc:subject>科幻</dc:subject></metadata><manifest><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest></package>`)
  const cover = Buffer.alloc(600, 1)
  zip.file('OPS/cover.png', cover)
  const path = join(dir, 'test.epub')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  assert.deepEqual(await readdir(root), [])
  const result = await engine.importFiles([path])
  assert.deepEqual(result.failed, [])
  const [book] = result.imported
  assert.equal(book.title, '三体 & 宇宙')
  assert.equal(book.author, '刘慈欣')
  assert.equal(book.publisher, '出版社')
  assert.equal(book.language, 'zh')
  assert.equal(book.year, 2008)
  assert.equal(book.topic, 'scifi')
  assert.deepEqual(book.tags, ['科幻'])
  assert.match(book.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(await readFile(book.filePath), await readFile(path))
  assert.deepEqual(await readFile(book.coverPath!), cover)
  const note = readDocumentSource(await readFile(book.notePath, 'utf8'))
  assert.equal(note.frontmatter.ready_id, book.id)
  assert.equal(note.frontmatter.类型, '书')
  assert.equal(note.frontmatter.状态, '想读')
  // Frontmatter is portable and human-facing: a readable local date-time, no machine paths.
  assert.match(String(note.frontmatter.加入), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  assert.deepEqual(note.frontmatter.来源, { kind: 'local' })
  assert.equal(note.body, '\n## 标注\n\n## 我的笔记\n')
  const dbPage = readDocumentSource(await readFile(join(root, '阅读.md'), 'utf8')).frontmatter.ready_database as {
    version: number; source: string; fields: Record<string, { id: string; name: string; type: string; options?: string[] }>; views: { id: string; name: string; type: string; dateField?: string }[]
  }
  // M5 database format: versioned, typed fields with stable ids, the library's shelf/table/calendar views kept.
  assert.equal(dbPage.version, 1)
  assert.equal(dbPage.source, '阅读')
  assert.deepEqual(dbPage.fields.状态.options, ['想读', '在读', '读完'])
  assert.equal(dbPage.fields.读完.type, 'date')
  assert.equal(dbPage.fields.来源说明.type, 'text')
  assert.deepEqual(dbPage.views.map((view) => [view.name, view.type, view.dateField ?? null]), [['书架', 'bookshelf', null], ['表格', 'table', null], ['日历', 'calendar', '读完']])
  assert.ok(dbPage.views.every((view) => view.id))
  assert.deepEqual(await engine.get(), { status: 'ready', vaultRoot: root, books: [book], issues: [] })
})

test('TXT UTF-8/GB18030, concurrent same-name imports, malformed notes and missing assets', async (t) => {
  const { root, txt, engine } = await fixture(t)
  assert.equal(decodeBookText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文')
  assert.equal(decodeBookText(Buffer.from('中文')), '中文')
  const [first, second] = await Promise.all([engine.importFiles([txt]), engine.importFiles([txt])])
  assert.equal(first.imported[0].words, 6)
  assert.equal(first.imported[0].topic, 'science')
  assert.equal(basename(first.imported[0].notePath), '科学.md')
  assert.equal(basename(second.imported[0].notePath), '科学 (2).md')
  assert.notEqual(first.imported[0].id, second.imported[0].id)
  await writeFile(join(root, '阅读', 'bad.md'), '---\n类型: [\n---\n')
  await writeFile(join(root, '阅读', 'ordinary.md'), '# 普通笔记')
  await rm(first.imported[0].filePath)
  const state = await engine.get()
  assert.equal(state.status, 'ready')
  if (state.status !== 'ready') throw new Error('expected ready')
  assert.deepEqual(state.books.map(book => book.id), [second.imported[0].id])
  assert.equal(state.issues.length, 2)
  assert.ok(state.issues.every(issue => issue.reason.length > 0))
})

test('per-book failure rolls back already published assets and does not stop the next book', async (t) => {
  const { root, txt, dir } = await fixture(t)
  const broken = join(dir, 'bad.epub')
  await writeFile(broken, 'not a zip')
  let failNote = true
  const engine = new LibraryEngine({
    vault: () => ({ status: 'ready', root, defaultSuggestion: root }),
    publish: async (path, data) => {
      await publishFileAtomically(path, data)
      if (path.endsWith('科学.md') && failNote) { failNote = false; throw new Error('injected publication failure') }
    },
  })
  const result = await engine.importFiles([broken, txt, txt])
  assert.equal(result.failed.length, 2)
  assert.equal(result.imported.length, 1)
  assert.equal(basename(result.imported[0].notePath), '科学.md')
  assert.deepEqual((await readdir(join(root, '阅读'))).sort(), ['科学.assets', '科学.md'])
  assert.deepEqual(await readdir(join(root, '阅读', '科学.assets')), ['科学.txt'])
})

test('update goes through document writing, preserves body, stamps finish date and rejects renaming', async (t) => {
  const { engine, txt, indexed } = await fixture(t)
  const book = (await engine.importFiles([txt])).imported[0]
  const before = await readFile(book.notePath, 'utf8')
  const updated = await engine.updateBook({ id: book.id, patch: { author: '新作者', topic: 'tech', tags: ['笔记'], status: '读完' } })
  assert.equal(updated.author, '新作者')
  assert.equal(updated.topic, 'tech')
  assert.equal(updated.status, '读完')
  assert.ok(updated.finishedAt! > 0)
  assert.deepEqual(indexed, [await realpath(book.notePath)])
  assert.equal(readDocumentSource(await readFile(book.notePath, 'utf8')).body, readDocumentSource(before).body)
  const finished = updated.finishedAt
  assert.equal((await engine.updateBook({ id: book.id, patch: { status: '读完' } })).finishedAt, finished)
  await assert.rejects(engine.updateBook({ id: book.id, patch: { title: '别的书名' } }), /改书名/)
  const moved = book.notePath.replace('科学.md', '移动.md')
  await rename(book.notePath, moved)
  assert.equal((await engine.findBook(book.id)).notePath, moved)
})

test('no vault is explicit; links escaping the vault are issues and cannot be imported into', async (t) => {
  const { dir, root, engine, txt, setVault } = await fixture(t)
  setVault({ status: 'unconfigured', defaultSuggestion: root })
  assert.deepEqual(await engine.get(), { status: 'no_vault' })
  await assert.rejects(engine.importFiles([txt]), { code: 'no_vault' })
  setVault({ status: 'missing', root, defaultSuggestion: root })
  assert.deepEqual(await engine.get(), { status: 'no_vault' })
  setVault({ status: 'ready', root, defaultSuggestion: root })
  await symlink(dir, join(root, '阅读'))
  const state = await engine.get()
  assert.equal(state.status, 'ready')
  if (state.status === 'ready') assert.equal(state.issues.length, 1)
  await assert.rejects(engine.importFiles([txt]), /资料库|符号链接/)
})


test('vault changes and external note edits publish current state and stop on disposal', async (t) => {
  const { engine, root, txt, setVault } = await fixture(t)
  setVault({ status: 'unconfigured', defaultSuggestion: root })
  const events: LibraryState[] = []
  const errors: unknown[] = []
  const waiters = new Set<() => void>()
  const stop = watchLibrary(engine, state => { events.push(state); for (const wake of waiters) wake() }, error => errors.push(error))
  t.after(stop)
  const until = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(wake); reject(new Error(`change notification timed out: ${JSON.stringify({ events, errors })}`)) }, 5000)
    const wake = () => { if (predicate()) { clearTimeout(timer); waiters.delete(wake); resolve() } }
    waiters.add(wake)
    wake()
  })
  await until(() => events.at(-1)?.status === 'no_vault')
  setVault({ status: 'ready', root, defaultSuggestion: root })
  await until(() => events.at(-1)?.status === 'ready')
  const book = (await engine.importFiles([txt])).imported[0]
  await until(() => { const state = events.at(-1); return state?.status === 'ready' && state.books.length === 1 })
  await writeFile(book.notePath, '---\n类型: [\n---\n')
  await until(() => { const state = events.at(-1); return state?.status === 'ready' && state.issues.length === 1 })
  setVault({ status: 'missing', root, defaultSuggestion: root })
  await until(() => events.at(-1)?.status === 'no_vault')
  await stop()
  assert.deepEqual(errors, [])
})

test('all local formats are copied, GB18030 is counted, and failed writer preserves source', async (t) => {
  const { dir, root, engine } = await fixture(t)
  const paths: string[] = []
  for (const ext of ['txt', 'md', 'pdf', 'mobi', 'azw3', 'fb2', 'cbz', 'djvu']) {
    const path = join(dir, `book.${ext}`)
    await writeFile(path, ext === 'txt' ? Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) : 'fixture')
    paths.push(path)
  }
  const imported = await engine.importFiles(paths)
  assert.deepEqual(imported.failed, [])
  assert.equal(imported.imported.length, 8)
  assert.equal(imported.imported[0].words, 2)
  for (let i = 0; i < paths.length; i++) assert.deepEqual(await readFile(imported.imported[i].filePath), await readFile(paths[i]))
  const book = imported.imported[0]
  const before = await readFile(book.notePath, 'utf8')
  const failing = new LibraryEngine({
    vault: () => ({ status: 'ready', root, defaultSuggestion: root }),
    write: input => applyDocumentOperation(input, { index: async () => { throw new Error('index unavailable') } }),
  })
  await assert.rejects(failing.updateBook({ id: book.id, patch: { author: '拒绝写入' } }), /index unavailable/)
  assert.equal(await readFile(book.notePath, 'utf8'), before)
  await writeFile(join(root, '阅读', 'duplicate.md'), before)
  const state = await engine.get()
  if (state.status !== 'ready') throw new Error('expected ready')
  assert.equal(state.books.length, 7)
  assert.equal(state.issues.length, 2)
  assert.ok(state.issues.every(issue => issue.reason.includes('ready_id')))
})
