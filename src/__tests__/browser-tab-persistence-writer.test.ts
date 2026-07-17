import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTabPersistenceWriter } from '../renderer/modules/browser/browserTabPersistenceWriter'

test('browser tab persistence coalesces a navigation burst into one latest-snapshot write', () => {
  let nextTimerId = 0
  const timers = new Map<number, () => void>()
  const writes: Array<{ url: string }> = []
  const writer = new BrowserTabPersistenceWriter({
    write: (value: { url: string }) => writes.push(value),
    setTimeout: (callback) => {
      const id = ++nextTimerId
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (handle) => timers.delete(handle as unknown as number),
    quietMs: 120,
    maxMs: 500,
  })

  for (let index = 0; index < 10; index += 1) writer.schedule({ url: `https://example.com/${index}` })
  assert.equal(writes.length, 0)
  writer.flush()
  assert.deepEqual(writes, [{ url: 'https://example.com/9' }])
  assert.equal(writer.hasPending(), false)
})

test('lifecycle flush writes the exact in-memory snapshot synchronously', () => {
  const writes: string[] = []
  const writer = new BrowserTabPersistenceWriter<string>({ write: (value) => writes.push(value) })
  writer.schedule('latest')
  writer.flush()
  assert.deepEqual(writes, ['latest'])
})
