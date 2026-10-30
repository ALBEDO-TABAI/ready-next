import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FastCardMediaCache } from '../main/modules/fastcard/media-cache'

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
test('C7 caches verified bytes, survives restart/offline and rejects executable media', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fastcard-cache-'))
  try {
    const cache = new FastCardMediaCache(root, async () => ({ body: png, type: 'image/png', url: 'https://example.com/a' }))
    const media = await cache.download('https://example.com/a')
    assert.equal(media.status, 'cached')
    if (media.status !== 'cached') throw new Error(media.error)
    const restarted = new FastCardMediaCache(root, async () => { throw new Error('offline') })
    assert.deepEqual(restarted.read(media), png)
    assert.deepEqual(readFileSync(join(root, 'fastcard-media', media.key)), png)
    assert.equal((await restarted.download('https://example.com/a')).status, 'missing')
    assert.throws(() => cache.save(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'), /media/)
    assert.throws(() => cache.save(Buffer.from('not a png'), 'image/png'), /media/)
    assert.throws(() => cache.read({ ...media, key: '../escape' }), /key/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('preview images persist as verified relative attachments and cache isolation rejects aliases', async () => {
  const { mkdirSync, symlinkSync } = await import('node:fs')
  const { persistLinkPreview } = await import('../main/modules/link-preview')
  const root = mkdtempSync(join(tmpdir(), 'fastcard-preview-'))
  try {
    const daily = join(root, 'Library/Application Support/Ready')
    mkdirSync(daily, { recursive: true })
    symlinkSync(daily, join(root, 'daily-alias'))
    assert.throws(() => new FastCardMediaCache(join(root, 'daily-alias/new')), /Daily Ready/)
    const cache = new FastCardMediaCache(root, async () => ({ body: png, type: 'image/png', url: 'https://example.com/image' }))
    const preview = await persistLinkPreview({ url: 'https://example.com', title: '标题', imageUrl: 'https://example.com/image', fetchedAt: '2026-10-31T00:00:00Z' }, cache,
      { libraryRoot: root, relativePath: 'board.canvas' })
    assert.ok(preview?.image?.startsWith('board.assets/'))
    assert.deepEqual(readFileSync(join(root, preview.image)), png)
    assert.equal('imageUrl' in preview, false)
    const bookmark = await persistLinkPreview({ url: 'https://example.com', imageUrl: 'https://example.com/image', fetchedAt: '2026-10-31T00:00:00Z' }, cache, { libraryRoot: root, relativePath: 'page.md' })
    assert.ok(bookmark?.image?.startsWith('page.assets/'))
    assert.deepEqual(readFileSync(join(root, bookmark.image)), png)
    const outside = join(root, 'outside'); mkdirSync(outside)
    symlinkSync(outside, join(root, 'evil.assets'))
    await assert.rejects(persistLinkPreview({ url: 'https://example.com', imageUrl: 'https://example.com/image', fetchedAt: '2026-10-31T00:00:00Z' }, cache,
      { libraryRoot: root, relativePath: 'evil.canvas' }), /Unsafe/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
