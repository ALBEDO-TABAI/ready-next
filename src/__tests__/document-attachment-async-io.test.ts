import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

/**
 * D2 perf rescue: ensure the document IPC handler does not block the main
 * thread on sync FS calls that historically stalled video playback during
 * a save / copy / move operation.
 *
 * We use a static source check because the handler registers against the
 * Electron `ipcMain` singleton on import, which is not loadable from a
 * raw node test runner. The asserts below pin every sync call we
 * intentionally migrated to the async fs/promises form.
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
  // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: file-mutation-group.ts imports `electron`'s IpcMain and registers IPC handlers at module load; the async-fs-promises migration on copy/move/delete/mkdir is asserted structurally because the handlers cannot be loaded from node:test. Tracked in lint-exemption-ledger 2026-05-22.
  const fileMutationSource = readFileSync(
    resolve(process.cwd(), 'src/main/modules/document-engine/ipc/file-mutation-group.ts'),
    'utf8',
  )

  it('imports the async fs/promises helpers used by the migrated handlers', () => {
    assert.match(
      `${fileIoSource}\n${fileMutationSource}`,
      /from 'fs\/promises'/,
    )
    assert.match(fileIoSource, /\breadFile\b/)
    assert.match(fileIoSource, /\bwriteFile\b/)
    assert.match(fileMutationSource, /\brename\b/)
    assert.match(fileMutationSource, /\bcp\b/)
    assert.match(fileMutationSource, /\bmkdir\b/)
    assert.match(fileMutationSource, /\bunlink\b/)
    assert.match(fileMutationSource, /\brm\b/)
    assert.match(fileMutationSource, /\bcopyFile\b/)
  })

  it('document:saveAs uses async writeFile for base64 + html branches', () => {
    assert.match(
      source,
      /await writeFile\(saveResult\.filePath, Buffer\.from\(payload\.contentBase64, 'base64'\)\)/,
    )
    assert.match(
      source,
      /await writeFile\(saveResult\.filePath, html, 'utf-8'\)/,
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

  it('document:move uses async movePath so cross-device moves can fall back to copy/remove', () => {
    assert.match(fileMutationSource, /ipcMain\.handle\('document:move'[\s\S]*if \(!existsSync\(src\)\)[\s\S]*if \(existsSync\(dest\)\) return \{ success: false, error: 'Target already exists' \}[\s\S]*await stat\(src\)[\s\S]*await movePath\(src, dest, stats\.isDirectory\(\)\)/)
  })

  it('document:rename uses await rename instead of renameSync', () => {
    assert.match(
      fileMutationSource,
      /ipcMain\.handle\('document:rename'[\s\S]*await rename\(oldPath, newPath\)/,
    )
  })

  it('document:delete moves into Ready trash with async filesystem operations', () => {
    assert.match(fileMutationSource, /ipcMain\.handle\('document:delete'[\s\S]*const stats = await stat\(path\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:delete'[\s\S]*const trashRoot = deps\.getDocumentTrashRoot\(\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:delete'[\s\S]*await movePath\(path, entry\.trashPath, entry\.isDirectory\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:delete'[\s\S]*await writeTrashIndex\(trashRoot, index\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:delete'[\s\S]*return \{ success: true, trashEntry: entry \}/)
    assert.match(fileMutationSource, /async function movePath[\s\S]*await rm\(src, \{ recursive: true, force: true \}\)/)
    assert.match(fileMutationSource, /async function movePath[\s\S]*await unlink\(src\)/)
  })

  it('document:restoreTrash uses async movePath to restore the original path', () => {
    assert.match(fileMutationSource, /ipcMain\.handle\('document:restoreTrash'[\s\S]*const trashRoot = deps\.getDocumentTrashRoot\(\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:restoreTrash'[\s\S]*await mkdir\(dirname\(entry\.originalPath\), \{ recursive: true \}\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:restoreTrash'[\s\S]*await movePath\(entry\.trashPath, entry\.originalPath, entry\.isDirectory\)/)
    assert.match(fileMutationSource, /ipcMain\.handle\('document:restoreTrash'[\s\S]*return \{ success: true, path: entry\.originalPath, trashEntry: entry \}/)
  })

  it('document:mkdir / document:createFile use async fs/promises', () => {
    assert.match(fileMutationSource, /ipcMain\.handle\('document:mkdir'[\s\S]*await mkdir\(path, \{ recursive: true \}\)/)
    assert.match(fileIoSource, /ipcMain\.handle\('document:createFile'[\s\S]*await writeFile\(path, '', 'utf-8'\)/)
  })

  it('writeDocumentEditableText uses await writeFile (not writeFileSync)', () => {
    // The exported helper feeds document:write — must not block the main thread
    // when the renderer commits a multi-MB markdown export.
    const helperBlockMatch = editableTextSource.match(
      /export async function writeDocumentEditableText[\s\S]*?\n\}\n/,
    )
    assert.ok(helperBlockMatch, 'writeDocumentEditableText not found')
    const helperBlock = helperBlockMatch![0]
    assert.match(helperBlock, /await writeFile\(filePath, content, 'utf-8'\)/)
    assert.doesNotMatch(helperBlock, /writeFileSync\(filePath, content, 'utf-8'\)/)
  })
})
