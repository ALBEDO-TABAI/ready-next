import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { FastCardMediaCache } from '../main/modules/fastcard/media-cache'
import { FastCardCollectionService } from '../main/modules/fastcard/collection-service'
import { FastCardQuickNoteService, QUICK_NOTE_SHORTCUT, type QuickNoteStatus } from '../main/modules/fastcard/quick-note-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection

test('quick note reports shortcut failure; recording is durable and playable without a transcription model', async t => {
  if (skipIfSqliteUnavailable(t, 'FastCard quick note')) return
  const root = mkdtempSync(join(tmpdir(), 'fastcard-quick-')), db = new Database(join(root, 'ready.db'))
  try {
    runMigrations(db)
    const repository = new FastCardRepository(db), cache = new FastCardMediaCache(root)
    const collection = new FastCardCollectionService(repository, cache)
    const statuses: QuickNoteStatus[] = [], unregistered: string[] = []
    let canRegister = false
    const service = new FastCardQuickNoteService({ register: () => canRegister, unregister: key => { unregistered.push(key) },
      show: async () => undefined, hide: () => undefined, readClipboard: async () => ({ kind: 'text', text: 'clipboard text' }), notify: status => { statuses.push(status) } }, collection, repository, cache)
    assert.equal(service.start().registered, false)
    assert.match(JSON.stringify(statuses), /注册失败/)
    service.stop(); assert.deepEqual(unregistered, [])
    canRegister = true; service.start(); service.stop(); service.stop()
    assert.deepEqual(unregistered, [QUICK_NOTE_SHORTCUT])
    const text = await service.clipboard('clipboard')
    assert.deepEqual(await service.clipboard('clipboard'), text)
    const wav = Buffer.alloc(46); wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVE', 8)
    const saved = service.recording(wav, 'audio/wav', 'recording')
    assert.equal(saved.media?.status, 'cached')
    assert.equal(saved.transcription?.status, 'unavailable')
    assert.deepEqual(service.recording(wav, 'audio/wav', 'recording'), saved)
    assert.equal((await service.transcribe('recording')).transcription?.status, 'unavailable')
    assert.deepEqual(Buffer.from(service.playback('recording').split(',')[1], 'base64'), wav)
    const brokenConfig = new FastCardQuickNoteService({ register: () => false, unregister: () => undefined,
      show: async () => undefined, hide: () => undefined, readClipboard: async () => ({ kind: 'text', text: '' }), notify: () => undefined }, collection, repository, cache,
      { configuredModels: () => { throw new Error('model configuration unavailable') }, transcribe: async () => assert.fail('unverified model must not be called') })
    assert.equal(brokenConfig.recording(wav, 'audio/wav', 'config-failure').transcription?.status, 'failed')
    assert.deepEqual(Buffer.from(brokenConfig.playback('config-failure').split(',')[1], 'base64'), wav)
    repository.update({ ...saved, transcription: { status: 'running', attemptId: 'interrupted' } })
    service.start()
    assert.equal(repository.list().find(item => item.id === 'recording')?.transcription?.status, 'failed')
    assert.deepEqual(Buffer.from(service.playback('recording').split(',')[1], 'base64'), wav)
    service.stop()
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

test('FastCard IPC validates recordings and keeps persistence separate from transcription', async t => {
  if (skipIfSqliteUnavailable(t, 'FastCard quick note IPC')) return
  const { registerFastCardServicesIPC } = await import('../main/modules/fastcard/ipc')
  const root = mkdtempSync(join(tmpdir(), 'fastcard-quick-ipc-')), db = new Database(join(root, 'ready.db'))
  try {
    runMigrations(db)
    const repository = new FastCardRepository(db), cache = new FastCardMediaCache(root)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    const service = new FastCardQuickNoteService({ register: () => false, unregister: () => assert.fail('not owned'), show: async () => undefined, hide: () => undefined,
      readClipboard: async () => ({ kind: 'image', bytes: png }), notify: () => undefined }, new FastCardCollectionService(repository, cache), repository, cache)
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
    registerFastCardServicesIPC({ handle(channel, listener) { handlers.set(channel, listener) } }, { quickNote: service, transfer: () => { throw new Error('B not connected') } })
    const invoke = async (name: string, input?: unknown) => {
      const handler = handlers.get(name); assert.ok(handler); return handler({}, input)
    }
    assert.partialDeepStrictEqual(await invoke('fastcard:quickRecording', { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/wav', itemId: 'invalid' }), { success: false })
    assert.deepEqual(repository.list(), [])
    assert.partialDeepStrictEqual(await invoke('fastcard:quickClipboard', 'image'), { success: true, data: { kind: 'image', media: { status: 'cached' } } })
    const media = repository.list()[0].media; assert.ok(media?.status === 'cached'); assert.deepEqual(cache.read(media), png)
    service.start()
    assert.partialDeepStrictEqual(await invoke('fastcard:quickStatus'), { success: true, data: { registered: false } })
    assert.partialDeepStrictEqual(await invoke('fastcard:transfer', {}), { success: false, error: 'B not connected' })
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
