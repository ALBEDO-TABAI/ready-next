import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMainInvokeEvent } from 'electron'
import { registerCanvasIPC } from '../main/modules/board-engine/ipc'
import { createCanvasResolver } from '../main/modules/board-engine/resolver'

const event = {} as IpcMainInvokeEvent
function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  let root: string | null = '/a', release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const recovered: string[] = [], reads: string[] = []
  const resolve = createCanvasResolver({ ready, root: () => root,
    create: path => ({ root: path, recover: async () => { recovered.push(path) }, read: (id: string) => { reads.push(path); return `${path}/${id}` } }),
  })
  return { handlers, resolve, release, recovered, reads, switch: (next: string | null) => { root = next } }
}
test('resolver waits for library readiness, rejects missing library, and never returns a previous library', async () => {
  const h = harness()
  let done = false
  const pending = h.resolve().then(value => { done = true; return value })
  await Promise.resolve(); assert.equal(done, false); assert.deepEqual(h.recovered, [])
  h.switch('/b'); h.release()
  assert.equal((await pending).root, '/b')
  h.switch(null); await assert.rejects(h.resolve(), /资料库/)
  h.switch('/c'); assert.equal((await h.resolve()).root, '/c')
  assert.deepEqual(h.recovered, ['/b', '/c'])
})
test('IPC resolves the library on each invocation and returns recovery failures', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  let root: string | null = '/a'
  // The fake replaces IO only; the production registration and resolver run unchanged.
  const service = createCanvasResolver({ ready: Promise.resolve(), root: () => root, create: path => ({ root: path,
    recover: async () => { if (path === '/broken') throw new Error('recovery failed') },
    canvas: { read: (id: string) => `${path}/${id}` }, imports: {},
  }) })
  registerCanvasIPC({ handle: (name, fn) => { handlers.set(name, fn) } }, service as Parameters<typeof registerCanvasIPC>[1], () => {})
  const read = () => handlers.get('canvas:read')!(event, 'handle')
  assert.deepEqual(await read(), { ok: true, value: '/a/handle' })
  root = '/b'; assert.deepEqual(await read(), { ok: true, value: '/b/handle' })
  root = null; assert.equal((await read() as { ok: boolean }).ok, false)
  root = '/broken'; assert.match((await read() as { error: string }).error, /recovery failed/)
})

test('switching libraries while recovery is pending does not return the recovered old library', async () => {
  let root = '/a', unblock!: () => void
  const pending = new Promise<void>(resolve => { unblock = resolve })
  const resolve = createCanvasResolver({ ready: Promise.resolve(), root: () => root,
    create: path => ({ root: path, recover: () => path === '/a' ? pending : Promise.resolve() }) })
  const opening = resolve()
  await Promise.resolve(); root = '/b'; unblock()
  assert.equal((await opening).root, '/b')
})

test('exit waits for unmounted canvas writes and reports write failure', async () => {
  const { trackCanvasWrite, flushCanvasWrites } = await import('../renderer/modules/canvas/pending-writes')
  let complete!: () => void, fail!: (error: Error) => void
  const slow = trackCanvasWrite(new Promise<void>(resolve => { complete = resolve }))
  const failed = trackCanvasWrite(new Promise<void>((_, reject) => { fail = reject }))
  let done = false
  const flushed = flushCanvasWrites().finally(() => { done = true })
  const check = assert.rejects(flushed, /画板保存失败/)
  fail(new Error('disk failure')); await failed.catch(() => {})
  assert.equal(done, false)
  complete(); await slow; await check
})
