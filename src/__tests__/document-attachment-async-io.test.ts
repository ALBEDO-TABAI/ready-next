import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { fileMutationGroup } from '../main/modules/document-engine/ipc/file-mutation-group'
import { ObjectMutations } from '../main/modules/object-service/mutations'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { resolve, join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * D2 perf rescue: ensure the document IPC handler does not block the main
 * thread on sync FS calls that historically stalled video playback during
 * a save / copy / move operation.
 *
 * Move and deletion tests invoke registered handlers against real temporary
 * files and object storage. Structural checks retain the blocking-API ban
 * and the saveAs contract whose host imports the Electron singleton.
 */
describe('document engine attachment async IO', () => {
  const sourcePath = resolve(process.cwd(), 'src/main/modules/document-engine/ipc-handler.ts')
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: document-engine/ipc-handler.ts registers handlers against the Electron `ipcMain` singleton on import, so saveAs remains structurally pinned here. Tracked in lint-exemption-ledger 2026-05-22.
  const source = readFileSync(sourcePath, 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: pins the async-vs-sync write contract for the pure editable-text helper; behavior tests cover result shape, this check guards the main-thread blocking regression.
  const editableTextSource = readFileSync(
    resolve(process.cwd(), 'src/main/modules/document-engine/document-editable-text.ts'),
    'utf8',
  )
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: file-io-group.ts imports `electron`'s IpcMain and registers IPC handlers at module load; the async-fs-promises migration is asserted structurally because the handlers cannot be loaded from node:test. Tracked in lint-exemption-ledger 2026-05-22.
  const fileIoSource = readFileSync(
    resolve(process.cwd(), 'src/main/modules/document-engine/ipc/file-io-group.ts'),
    'utf8',
  )
  // allow-source-grep: prohibit synchronous filesystem mutations across all handler branches; behavioral move/delete coverage below exercises the registered IPC handlers.
  const fileMutationSource = readFileSync(
    resolve(process.cwd(), 'src/main/modules/document-engine/ipc/file-mutation-group.ts'),
    'utf8',
  )

  it('mutation owners do not use synchronous file mutation APIs', () => {
    // allow-source-grep: forbid blocking mutation APIs even in error/EXDEV branches; real IPC behavior is exercised below.
    const mutations = readFileSync(resolve(process.cwd(), 'src/main/modules/object-service/mutations.ts'), 'utf8')
    assert.doesNotMatch(`${fileMutationSource}\n${mutations}`, /\b(?:renameSync|cpSync|copyFileSync|rmSync|unlinkSync|mkdirSync)\b/)
  })

  it('document:saveAs atomically publishes base64 + html branches without sync writes', () => {
    assert.match(
      source,
      /await publishFileAtomically\(saveResult\.filePath, Buffer\.from\(payload\.contentBase64, 'base64'\)\)/,
    )
    assert.match(
      source,
      /await publishFileAtomically\(saveResult\.filePath, html\)/,
    )
    // The blocking writeFileSync calls in saveAs must be gone.
    assert.doesNotMatch(
      source,
      /writeFileSync\(saveResult\.filePath, Buffer\.from\(payload\.contentBase64, 'base64'\)\)/,
    )
    assert.doesNotMatch(
      source,
      /writeFileSync\(saveResult\.filePath, html, 'utf-8'\)/,
    )
  })

  it('document:copy uses await cp / await copyFile', () => {
    assert.match(fileMutationSource, /ipcMain\.handle\('document:copy'[\s\S]*await cp\(src, dest, \{ recursive: true \}\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:copy'[\s\S]*await copyFile\(src, dest\)/)
    assert.doesNotMatch(fileMutationSource, /cpSync\(src, dest, \{ recursive: true \}\)/)
  })

  for (const channel of ['document:move', 'document:rename'] as const) {
    it(`${channel} awaits asynchronous relocation and preserves identity`, async (t) => {
      if (skipIfSqliteUnavailable(t, 'Async document mutations')) return
      const f = fixture()
      t.after(() => f.close())
      const source = join(f.root, 'source.md')
      const target = join(f.root, 'target.md')
      writeFileSync(source, '# Content')
      const id = f.registry.register(source).id
      const handlers = new Map<string, (event: IpcMainInvokeEvent, args: unknown) => Promise<{ success: boolean; error?: string }>>()
      fileMutationGroup.register({ handle: (name, handler) => handlers.set(name, handler), removeHandler() {} } as IpcMain, {
        useMock: false, getObjectMutations: () => new ObjectMutations(f.registry),
      })
      const rename = fsPromises.rename
      let released = false
      let release!: () => void
      const blocked = new Promise<void>((resolve) => { release = resolve })
      const spy = t.mock.method(fsPromises, 'rename', async (from, to) => {
        if (String(from) === source && !released) {
          await blocked
          released = true
          if (channel === 'document:move') throw Object.assign(new Error('cross device'), { code: 'EXDEV' })
        }
        return rename(from, to)
      })
      syncBuiltinESMExports()
      t.after(() => { spy.mock.restore(); syncBuiltinESMExports() })
      let settled = false
      const pending = handlers.get(channel)!({} as IpcMainInvokeEvent,
        channel === 'document:move' ? { src: source, dest: target } : { oldPath: source, newPath: target })
      void pending.then(() => { settled = true })
      try {
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(settled, false)
        assert.equal(existsSync(source), true, 'source remains while async relocation is pending')
        assert.equal(existsSync(target), false)
      } finally { release() }
      const result = await pending
      assert.equal(result.success, true, result.error)
      assert.ok(spy.mock.callCount() > 0, 'must call asynchronous rename')
      assert.equal(released, true, 'the injected asynchronous relocation must be exercised')
      assert.equal(readFileSync(target, 'utf8'), '# Content')
      assert.equal(existsSync(source), false)
      assert.equal(f.registry.find(target)!.id, id)
    })
  }

  it('document:deletePermanent awaits asynchronous removal before reporting success', async (t) => {
    if (skipIfSqliteUnavailable(t, 'Async document deletion')) return
    const f = fixture()
    t.after(() => f.close())
    const path = join(f.root, 'delete.md')
    writeFileSync(path, '# Delete')
    const id = f.registry.register(path).id
    const channels: string[] = []
    let handler: ((event: IpcMainInvokeEvent, path: string) => Promise<{ success: boolean; error?: string }>) | undefined
    fileMutationGroup.register({ handle: (name, fn) => { channels.push(name); if (name === 'document:deletePermanent') handler = fn }, removeHandler() {} } as IpcMain, {
      useMock: false, getObjectMutations: () => new ObjectMutations(f.registry),
    })
    for (const retired of ['document:delete', 'document:listTrash', 'document:restoreTrash', 'document:deleteTrashItem', 'document:clearTrash']) {
      assert.equal(channels.includes(retired), false)
    }
    const remove = fsPromises.rm
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const spy = t.mock.method(fsPromises, 'rm', async (target, options) => { await blocked; return remove(target, options) })
    syncBuiltinESMExports()
    t.after(() => { spy.mock.restore(); syncBuiltinESMExports() })
    let settled = false
    const pending = handler!({} as IpcMainInvokeEvent, path)
    void pending.then(() => { settled = true })
    try {
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(settled, false)
      assert.equal(existsSync(path), true)
      assert.equal(f.registry.get(id)!.status, 'present')
    } finally { release() }
    const result = await pending
    assert.equal(result.success, true, result.error)
    assert.equal(spy.mock.callCount(), 1)
    assert.equal(existsSync(path), false)
    assert.equal(f.registry.get(id)!.status, 'deleted')
  })

  it('document:mkdir / document:createFile use async fs/promises', () => {
    assert.match(fileMutationSource, /ipcMain\.handle\('document:mkdir'[\s\S]*await mkdir\(path, \{ recursive: true \}\)/)
    assert.match(fileIoSource, /ipcMain\.handle\('document:createFile'[\s\S]*await writeFile\(path, '', 'utf-8'\)/)
  })

  it('writeDocumentEditableText uses atomic async publish (not writeFileSync)', () => {
    // The exported helper feeds document:write — must not block the main thread
    // when the renderer commits a multi-MB markdown export.
    const helperBlockMatch = editableTextSource.match(
      /export async function writeDocumentEditableText[\s\S]*?\n\}\n/,
    )
    assert.ok(helperBlockMatch, 'writeDocumentEditableText not found')
    const helperBlock = helperBlockMatch![0]
    assert.match(helperBlock, /await \(options\.publish \?\? publishFileAtomically\)\(filePath, content\)/)
    assert.doesNotMatch(helperBlock, /writeFileSync\(filePath, content, 'utf-8'\)/)
  })
})
