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
  const source = readFileSync(sourcePath, 'utf8')

  it('imports the async fs/promises helpers used by the migrated handlers', () => {
    assert.match(
      source,
      /from 'fs\/promises'/,
    )
    assert.match(source, /\breadFile\b/)
    assert.match(source, /\bwriteFile\b/)
    assert.match(source, /\brename\b/)
    assert.match(source, /\bcp\b/)
    assert.match(source, /\bmkdir\b/)
    assert.match(source, /\bunlink\b/)
    assert.match(source, /\brm\b/)
    assert.match(source, /\bcopyFile\b/)
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
    assert.match(source, /ipcMain\.handle\('document:copy'[\s\S]*await cp\(src, dest, \{ recursive: true \}\)/)
    assert.match(source, /ipcMain\.handle\('document:copy'[\s\S]*await copyFile\(src, dest\)/)
    assert.doesNotMatch(source, /cpSync\(src, dest, \{ recursive: true \}\)/)
  })

  it('document:move uses await rename', () => {
    assert.match(source, /ipcMain\.handle\('document:move'[\s\S]*await rename\(src, dest\)/)
  })

  it('document:rename uses await rename instead of renameSync', () => {
    assert.match(
      source,
      /ipcMain\.handle\('document:rename'[\s\S]*await rename\(oldPath, newPath\)/,
    )
  })

  it('document:delete uses await stat / await rm / await unlink', () => {
    assert.match(source, /ipcMain\.handle\('document:delete'[\s\S]*const stats = await stat\(path\)/)
    assert.match(source, /ipcMain\.handle\('document:delete'[\s\S]*await rm\(path, \{ recursive: true, force: true \}\)/)
    assert.match(source, /ipcMain\.handle\('document:delete'[\s\S]*await unlink\(path\)/)
  })

  it('document:mkdir / document:createFile use async fs/promises', () => {
    assert.match(source, /ipcMain\.handle\('document:mkdir'[\s\S]*await mkdir\(path, \{ recursive: true \}\)/)
    assert.match(source, /ipcMain\.handle\('document:createFile'[\s\S]*await writeFile\(path, '', 'utf-8'\)/)
  })

  it('writeDocumentEditableText uses await writeFile (not writeFileSync)', () => {
    // The exported helper feeds document:write — must not block the main thread
    // when the renderer commits a multi-MB markdown export.
    const helperBlockMatch = source.match(
      /export async function writeDocumentEditableText[\s\S]*?\n\}\n/,
    )
    assert.ok(helperBlockMatch, 'writeDocumentEditableText not found')
    const helperBlock = helperBlockMatch![0]
    assert.match(helperBlock, /await writeFile\(filePath, content, 'utf-8'\)/)
    assert.doesNotMatch(helperBlock, /writeFileSync\(filePath, content, 'utf-8'\)/)
  })
})
