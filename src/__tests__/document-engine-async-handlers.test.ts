import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('document engine async handlers', () => {
  it('keeps the main document read and parse handlers on async fs APIs', () => {
    // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: file-io-group.ts imports `electron`'s IpcMain and registers document:read / document:list handlers at module load; node:test cannot import the module to assert async-fs usage at runtime. Tracked in lint-exemption-ledger 2026-05-22.
    const fileIoSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/document-engine/ipc/file-io-group.ts'),
      'utf8',
    )
    // eslint-disable-next-line ready/no-source-grep-test -- W1.1 exempt: parser-group.ts imports `electron`'s IpcMain and registers document:parseDocx / document:parseXlsx handlers at module load; node:test cannot import the module to assert async readFile usage at runtime. Tracked in lint-exemption-ledger 2026-05-22.
    const parserSource = readFileSync(
      resolve(process.cwd(), 'src/main/modules/document-engine/ipc/parser-group.ts'),
      'utf8',
    )

    assert.match(fileIoSource, /import \{[^}]*\breadFile\b[^}]*\breaddir\b[^}]*\bstat\b[^}]*\} from 'fs\/promises'/)
    assert.match(fileIoSource, /ipcMain\.handle\('document:read'[\s\S]*const content = await readFile\(path, 'utf-8'\)/)
    assert.match(fileIoSource, /ipcMain\.handle\('document:read'[\s\S]*data\.bytes = new Uint8Array\(await readFile\(path\)\)/)
    assert.match(fileIoSource, /ipcMain\.handle\('document:list'[\s\S]*const items = \(await readdir\(dir\)\)/)
    assert.match(fileIoSource, /ipcMain\.handle\('document:list'[\s\S]*const stats = await stat\(filePath\)/)
    assert.match(parserSource, /ipcMain\.handle\('document:parseDocx'[\s\S]*const buffer = await readFile\(path\)/)
    assert.match(parserSource, /ipcMain\.handle\('document:parseXlsx'[\s\S]*const buffer = await readFile\(path\)/)
  })
})
