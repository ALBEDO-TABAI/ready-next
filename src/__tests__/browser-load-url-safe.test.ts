import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { loadUrlIgnoringAbort } from '../main/modules/browser-engine/load-url-safe'

function abortError() {
  const err = new Error("ERR_ABORTED (-3) loading 'https://www.xiaohongshu.com/...'") as Error & { errno?: number; code?: string }
  err.errno = -3
  err.code = 'ERR_ABORTED'
  return err
}

describe('loadUrlIgnoringAbort', () => {
  it('returns ok on a normal load', async () => {
    const res = await loadUrlIgnoringAbort({ loadURL: async () => {} }, 'https://example.com')
    assert.deepEqual(res, { ok: true })
  })

  it('treats ERR_ABORTED (-3) as a non-failure (superseded navigation, not a crash)', async () => {
    const res = await loadUrlIgnoringAbort({ loadURL: async () => { throw abortError() } }, 'https://www.xiaohongshu.com/x')
    assert.deepEqual(res, { ok: true })
  })

  it('surfaces a real load error as a structured failure (no throw)', async () => {
    const err = new Error('ERR_NAME_NOT_RESOLVED') as Error & { errno?: number }
    err.errno = -105
    const res = await loadUrlIgnoringAbort({ loadURL: async () => { throw err } }, 'https://nope.invalid')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.match(res.error, /ERR_NAME_NOT_RESOLVED/)
  })

  it('does not reject even when loadURL throws (no unhandled rejection escapes)', async () => {
    // The whole point: callers never see a thrown/rejected promise.
    await assert.doesNotReject(
      loadUrlIgnoringAbort({ loadURL: async () => { throw abortError() } }, 'https://x'),
    )
  })
})
