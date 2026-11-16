import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createIngressImagePreparer,
  INGRESS_IMAGE_MAX_EDGE,
  type IngressImageCodec,
} from '../main/modules/agent-control/codex-runtime/composition/ingress-image'

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'ready-ingress-image-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sizes = new Map<string, { width: number; height: number }>()
  const encodes: string[] = []
  const codec: IngressImageCodec = {
    size: (path) => sizes.get(path) ?? null,
    encode(path, maxEdge) {
      encodes.push(`${path}@${maxEdge}`)
      return { bytes: Buffer.from('fitted'), extension: '.jpg' }
    },
  }
  const image = (name: string, bytes: number, width: number, height: number): string => {
    const path = join(root, name)
    writeFileSync(path, Buffer.alloc(bytes, 1))
    sizes.set(path, { width, height })
    return path
  }
  return { root, image, encodes, prepare: createIngressImagePreparer(join(root, 'prepared'), async () => codec) }
}

test('a small image, an unknown format and an undecodable file are handed over as they are', async (t) => {
  const f = fixture(t)
  const small = f.image('small.png', 2000, 800, 600)
  const webp = f.image('photo.webp', 5_000_000, 4000, 3000)
  const broken = join(f.root, 'broken.jpg')
  writeFileSync(broken, Buffer.alloc(3_000_000, 1))
  for (const path of [small, webp, broken]) assert.equal(await f.prepare(path), path)
  assert.deepEqual(f.encodes, [])
})

test('a large image is handed over as a fitted copy, made once, and the original is untouched', async (t) => {
  const f = fixture(t)
  const photo = f.image('photo.png', 5_000_000, 4032, 3024)
  const before = readFileSync(photo)
  const prepared = await f.prepare(photo)
  assert.notEqual(prepared, photo)
  assert.match(prepared, /prepared\/[0-9a-f]{64}\.jpg$/)
  assert.equal(readFileSync(prepared, 'utf8'), 'fitted')
  assert.deepEqual(readFileSync(photo), before)
  assert.equal(await f.prepare(photo), prepared)
  assert.deepEqual(f.encodes, [`${photo}@${INGRESS_IMAGE_MAX_EDGE}`])
  // Small on disk but wider than a model uses: still fitted.
  const wide = f.image('wide.jpg', 200_000, 6000, 400)
  assert.notEqual(await f.prepare(wide), wide)
  // The file changed: a new copy, not the stale one.
  writeFileSync(photo, Buffer.alloc(6_000_000, 2))
  assert.notEqual(await f.prepare(photo), prepared)
})

test('a copy that would not be smaller is not used, and old copies are cleared', async (t) => {
  const f = fixture(t)
  const tiny = f.image('tiny-but-wide.png', 4, 5000, 10)
  assert.equal(await f.prepare(tiny), tiny)

  const old = await f.prepare(f.image('old.png', 2_000_000, 3000, 3000))
  const past = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
  utimesSync(old, past, past)
  const fresh = createIngressImagePreparer(join(f.root, 'prepared'), async () => ({
    size: () => ({ width: 3000, height: 3000 }),
    encode: () => ({ bytes: Buffer.from('fitted'), extension: '.png' }),
  }))
  const next = await fresh(f.image('next.png', 2_000_000, 3000, 3000))
  assert.match(next, /\.png$/)
  assert.throws(() => statSync(old), /ENOENT/)
})
