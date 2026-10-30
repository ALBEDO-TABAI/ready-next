import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withDocumentPathLock } from '../main/modules/document-engine/document-write-service'

// C3: writes to one document apply in call order. Reaching the file through a
// symlink chain makes the first caller's realpath slower; it must still go first.
test('path lock keeps call order when an earlier caller resolves its path more slowly', async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ready-path-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'page.md')
  writeFileSync(file, 'x')
  let viaLinks = file
  for (let i = 0; i < 8; i++) {
    const next = join(dir, `link-${i}`)
    symlinkSync(viaLinks, next)
    viaLinks = next
  }
  for (let round = 0; round < 50; round++) {
    const order: string[] = []
    await Promise.all([
      withDocumentPathLock(viaLinks, async () => { order.push('first') }),
      withDocumentPathLock(file, async () => { order.push('second') }),
    ])
    assert.deepEqual(order, ['first', 'second'], `round ${round}`)
  }
})

test('a path that fails to resolve does not block later callers', async (t) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'ready-path-lock-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'page.md')
  writeFileSync(file, 'x')
  // A file nested under a regular file can never resolve; it must fail alone.
  const broken = withDocumentPathLock(join(file, 'child.md'), async () => 'never')
  const ok = withDocumentPathLock(file, async () => 'done')
  await assert.rejects(broken, { code: 'ENOTDIR' })
  assert.equal(await ok, 'done')
  // A file that does not exist yet still takes a lock, so saving a new file is serialised too.
  assert.equal(await withDocumentPathLock(join(dir, 'new.md'), async () => 'created'), 'created')
})
