import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { BookSourceJobs } from '../main/modules/library-engine/source-jobs'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection

test('C11 durable tasks import through the library, cancel, retry, and clear interrupted work on restart', async t => {
  if (skipIfSqliteUnavailable(t, 'Book source tasks')) return
  const dir = await mkdtemp(join(tmpdir(), 'ready-source-jobs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'vault'); await mkdir(root)
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root, defaultSuggestion: root }) })
  let db = new Database(join(dir, 'ready.db')); runMigrations(db)
  const cache = join(dir, 'work')
  let fail = true
  const jobs = new BookSourceJobs(db, cache, async (_job, folder, signal) => {
    if (_job.ref === 'wait') await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    if (_job.ref === 'retry' && fail) throw new Error('download failed')
    const path = join(folder, 'book.txt'); await writeFile(path, '书籍正文'); return path
  }, async path => {
    const result = await engine.importFiles([path]); assert.equal(result.failed.length, 0); return result.imported[0].id
  }, () => {})
  await jobs.initialize()
  const good = jobs.start({ source: 'zlib', ref: 'one' }); await jobs.idle()
  assert.equal(jobs.get(good.id).status, 'done'); assert.ok(jobs.get(good.id).book_id)
  assert.deepEqual(await readdir(cache), [])
  const bad = jobs.start({ source: 'zlib', ref: 'retry' }); await jobs.idle()
  assert.equal(jobs.get(bad.id).status, 'failed'); fail = false
  jobs.retry(bad.id); await jobs.idle(); assert.equal(jobs.get(bad.id).status, 'done')
  assert.throws(() => jobs.retry(good.id))
  const wait = jobs.start({ source: 'zlib', ref: 'wait' })
  await jobs.cancel(wait.id); await jobs.idle(); assert.equal(jobs.get(wait.id).status, 'cancelled')
  db.prepare("UPDATE library_source_jobs SET status = 'downloading', book_id = NULL WHERE id = ?").run(wait.id)
  await mkdir(join(cache, wait.id)); await writeFile(join(cache, wait.id, 'partial'), 'incomplete')
  db.close(); db = new Database(join(dir, 'ready.db')); runMigrations(db)
  t.after(() => db.close())
  const restarted = new BookSourceJobs(db, cache, async () => { throw new Error('must not resume implicitly') }, async () => '', () => {})
  await restarted.initialize()
  assert.equal(restarted.get(wait.id).status, 'failed')
  assert.equal(restarted.get(wait.id).error, '应用退出时中断')
  assert.equal(restarted.get(good.id).status, 'done')
  assert.deepEqual(await readdir(cache), [])
})

test('C11 captcha is bound to the current challenge; active cancel cleans files; committed imports cannot duplicate', async t => {
  if (skipIfSqliteUnavailable(t, 'Book source captcha/import')) return
  const dir = await mkdtemp(join(tmpdir(), 'ready-source-captcha-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const db = new Database(':memory:'); t.after(() => db.close()); runMigrations(db)
  const root = join(dir, 'vault'); await mkdir(root)
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root, defaultSuggestion: root }) })
  const work = join(dir, 'work')
  let captchaReady = () => {}, importStarted = () => {}, completeImport = () => {}
  let captchaEvent = new Promise<void>(resolve => { captchaReady = resolve })
  const importing = new Promise<void>(resolve => { importStarted = resolve })
  const releaseImport = new Promise<void>(resolve => { completeImport = resolve })
  const jobs = new BookSourceJobs(db, work, async (_job, folder, _signal, context) => {
    await writeFile(join(folder, 'partial'), 'temporary')
    const answer = await context.captcha('data:image/png;base64,AQID')
    assert.equal(answer, 'human')
    const file = join(folder, 'book.txt'); await writeFile(file, '正文'); return file
  }, async path => {
    importStarted(); await releaseImport
    return (await engine.importDownload(path, 'stable-download-id', { kind: 'zlib', ref: 'ref' }, root)).id
  }, list => { if (list.some(job => job.status === 'captcha')) captchaReady() })
  await jobs.initialize()
  const cancelled = jobs.start({ source: 'treasure', ref: 'share' }); await captchaEvent
  assert.throws(() => jobs.answer(cancelled.id, 'old-challenge', 'human'), /过期/)
  await jobs.cancel(cancelled.id)
  assert.equal(jobs.get(cancelled.id).status, 'cancelled'); assert.deepEqual(await readdir(work), [])
  captchaEvent = new Promise<void>(resolve => { captchaReady = resolve })
  const good = jobs.start({ source: 'zlib', ref: 'ref' }); await captchaEvent
  assert.equal(jobs.start({ source: 'zlib', ref: 'ref' }).id, good.id)
  jobs.answer(good.id, jobs.get(good.id).captcha!.token, 'human')
  await importing
  await assert.rejects(jobs.cancel(good.id), /正在上架/)
  completeImport(); await jobs.idle(); assert.equal(jobs.get(good.id).status, 'done')
  const another = join(dir, 'again.txt'); await writeFile(another, '正文')
  const recovered = await engine.importDownload(another, 'stable-download-id', { kind: 'zlib', ref: 'ref' }, root)
  assert.equal(recovered.id, jobs.get(good.id).book_id)
  const state = await engine.get(); assert.equal(state.status === 'ready' && state.books.length, 1)
  await assert.rejects(engine.importDownload(another, 'different-task', { kind: 'zlib' }, '/different-vault'), /资料库已切换/)
})

test('C11 shutdown settles download writers before the database can close', async t => {
  if (skipIfSqliteUnavailable(t, 'Book source shutdown')) return
  const dir = await mkdtemp(join(tmpdir(), 'ready-source-quit-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const db = new Database(':memory:'); runMigrations(db)
  let started = () => {}; const downloading = new Promise<void>(resolve => { started = resolve })
  const jobs = new BookSourceJobs(db, dir, async (_job, _folder, signal) => {
    started(); return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }))
  }, async () => { throw new Error('must not import') }, () => {})
  await jobs.initialize()
  const job = jobs.start({ source: 'zlib', ref: 'slow' }); await downloading
  await jobs.shutdown()
  assert.equal(jobs.get(job.id).status, 'failed'); assert.equal(jobs.get(job.id).error, '应用退出时中断')
  assert.throws(() => jobs.start({ source: 'zlib', ref: 'late' }))
  assert.deepEqual(await readdir(dir), []); db.close()
})

test('C11 real source IPC persists settings, validates requests and downloads through the configured executable', async t => {
  if (skipIfSqliteUnavailable(t, 'Book source service IPC')) return
  const { build } = await import('esbuild')
  const { resolve } = await import('node:path')
  const { chmod } = await import('node:fs/promises')
  const { registerBookSourceIPC } = await import('../main/modules/library-engine/source-ipc')
  const dir = await mkdtemp(resolve('node_modules/.cache/ready-l3-service-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const compiled = join(dir, 'service.cjs')
  await build({ entryPoints: ['src/main/modules/library-engine/source-service.ts'], outfile: compiled, bundle: true, platform: 'node', format: 'cjs', packages: 'external', define: { __READY_FEATURE_CTFILE__: 'false' } })
  const { BookSourceService } = createRequire(import.meta.url)(compiled) as typeof import('../main/modules/library-engine/source-service')
  const db = new Database(':memory:'); t.after(() => db.close()); runMigrations(db)
  const vault = join(dir, 'vault'); await mkdir(vault)
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root: vault, defaultSuggestion: vault }) })
  const bin = join(dir, 'zlib'); await writeFile(bin, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);
if(a[0]==='profile')console.log('{}');
if(a[0]==='download'){fs.writeFileSync(path.join(a[a.indexOf('--dir')+1],'book.txt'),'正文');console.log('{}');}
`); await chmod(bin, 0o755)
  let notifications = 0
  const service = new BookSourceService({ db, cache: join(dir, 'cache'), engine,
    settings: {
      getSetting: key => db.prepare('SELECT value FROM settings WHERE key = ?').get<{ value: string }>(key)?.value,
      setSetting: (key, value) => { db.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,?)').run(key, value, Date.now()) },
    }, changed: () => { notifications++ }, libraryChanged: async () => {}, openExternal: async () => { throw new Error('must not open') },
  })
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  registerBookSourceIPC({ handle: (name, callback) => { handlers.set(name, callback) } }, service)
  const invoke = (name: string, input?: unknown) => handlers.get(`librarySources:${name}`)!({}, input)
  const settings = { executable: bin, format: 'txt' as const, treasure: false, ctfile: false }
  assert.deepEqual(await invoke('configure', settings), { success: true, data: settings })
  assert.equal(service.settings().settings.executable, bin)
  assert.deepEqual(await invoke('status'), { success: true, data: { state: 'available' } })
  assert.partialDeepStrictEqual(await invoke('configure', { ...settings, ctfile: true }), { success: false })
  assert.partialDeepStrictEqual(await invoke('download', { source: 'treasure', ref: 'https://ctfile.com/f/one' }), { success: false })
  assert.partialDeepStrictEqual(await invoke('download', { source: 'zlib', ref: 'one' }), { success: true })
  await service.jobs.idle()
  const jobs = service.jobs.list(); assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'done')
  assert.equal((await engine.findBook(jobs[0].book_id!)).source.kind, 'zlib')
  assert.ok(notifications >= 3)
  await service.jobs.shutdown()
})
