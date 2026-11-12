import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IpcMain } from 'electron'
import { setupThirdPartyNoticesIPC } from '../main/modules/app-control/third-party-notices'

test('notices IPC reads the selected root, reports absent generation, and rejects damaged data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'm8-ipc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dev = join(root, 'repo')
  const packaged = join(root, 'Resources')
  for (const dir of [dev, packaged]) await mkdir(join(dir, 'licenses/generated'), { recursive: true })
  function handler(isPackaged: boolean) {
    let listener: Parameters<IpcMain['handle']>[1] | undefined
    setupThirdPartyNoticesIPC({ handle(channel, fn) {
      assert.equal(channel, 'app:getThirdPartyNotices')
      listener = fn
    } }, { isPackaged, getAppPath: () => dev }, packaged)
    assert.ok(listener)
    // No Electron window/event is needed: this read-only handler takes no renderer input.
    return listener.bind(null)
  }
  const readDev = handler(false)
  const readPackaged = handler(true)
  assert.deepEqual(await Reflect.apply(readDev, null, []), { ok: false, reason: 'not_generated' })
  const entry = { name: 'fixture', version: '1', license: 'MIT', repository: null,
    texts: [{ path: 'LICENSE', content: 'fixture license' }], notes: [], textMissing: false, kind: 'manual' }
  const devFile = join(dev, 'licenses/generated/third-party-notices.json')
  const packagedFile = join(packaged, 'licenses/generated/third-party-notices.json')
  await writeFile(devFile, JSON.stringify([entry]))
  assert.deepEqual(await Reflect.apply(readDev, null, []), { ok: true, notices: [entry] })
  assert.deepEqual(await Reflect.apply(readPackaged, null, []), { ok: false, reason: 'not_generated' })
  await writeFile(packagedFile, JSON.stringify([{ ...entry, name: 'packaged' }]))
  assert.deepEqual(await Reflect.apply(readPackaged, null, []), { ok: true, notices: [{ ...entry, name: 'packaged' }] })
  await writeFile(devFile, '{broken')
  await assert.rejects(() => Reflect.apply(readDev, null, []), SyntaxError)
  await writeFile(devFile, JSON.stringify([{ name: 'incomplete' }]))
  await assert.rejects(() => Reflect.apply(readDev, null, []), /invalid_type/)
  await rm(devFile)
  await mkdir(devFile)
  await assert.rejects(() => Reflect.apply(readDev, null, []), { code: 'EISDIR' })
})
