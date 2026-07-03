/**
 * P1-W5 (2026-07-03, web-access W5 closeout) — media download verification is
 * byte-honest: a 200 response is not completion; the saved file must exist and
 * be non-empty. No ffprobe claim.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { verifyDownloadedMedia } from '../main/modules/browser-engine/media-verification'

function fakeStat(sizes: Record<string, number>) {
  return (path: string) => {
    if (!(path in sizes)) throw new Error('ENOENT')
    return { size: sizes[path] }
  }
}

test('verifyDownloadedMedia: all success files present + non-zero → ok, method file_bytes', () => {
  const result = verifyDownloadedMedia(
    [
      { success: true, path: '/tmp/a.mp4', url: 'https://x/a.mp4' },
      { success: true, path: '/tmp/b.mp4', url: 'https://x/b.mp4' },
    ],
    { statFn: fakeStat({ '/tmp/a.mp4': 1024, '/tmp/b.mp4': 2048 }) },
  )
  assert.equal(result.ok, true)
  assert.equal(result.method, 'file_bytes')
  assert.equal(result.checked, 2)
  assert.equal(result.nonZero, 2)
  assert.deepEqual(result.invalidPaths, [])
})

test('verifyDownloadedMedia: a zero-byte saved file fails verification', () => {
  const result = verifyDownloadedMedia(
    [
      { success: true, path: '/tmp/a.mp4' },
      { success: true, path: '/tmp/empty.mp4' },
    ],
    { statFn: fakeStat({ '/tmp/a.mp4': 4096, '/tmp/empty.mp4': 0 }) },
  )
  assert.equal(result.ok, false)
  assert.deepEqual(result.invalidPaths, ['/tmp/empty.mp4'])
  assert.equal(result.nonZero, 1)
})

test('verifyDownloadedMedia: a missing file (success reported but not on disk) fails verification', () => {
  const result = verifyDownloadedMedia(
    [{ success: true, path: '/tmp/gone.mp4' }],
    { statFn: fakeStat({}) },
  )
  assert.equal(result.ok, false)
  assert.deepEqual(result.invalidPaths, ['/tmp/gone.mp4'])
})

test('verifyDownloadedMedia: no successful files → method none, not ok', () => {
  const result = verifyDownloadedMedia([{ success: false, url: 'https://x/a.mp4', error: 'http_403' }])
  assert.equal(result.method, 'none')
  assert.equal(result.ok, false)
  assert.equal(result.checked, 0)
})

test('verifyDownloadedMedia: never claims ffprobe as the method', () => {
  const result = verifyDownloadedMedia(
    [{ success: true, path: '/tmp/a.mp4' }],
    { statFn: fakeStat({ '/tmp/a.mp4': 10 }) },
  )
  assert.notEqual((result.method as string), 'ffprobe')
})
