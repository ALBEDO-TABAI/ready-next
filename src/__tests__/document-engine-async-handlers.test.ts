import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('document engine async handlers', () => {
  it('keeps the main document read and parse handlers on async fs APIs', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/document-engine/ipc-handler.ts'),
      'utf8',
    )

    assert.match(source, /import \{ readFile, readdir, stat \} from 'fs\/promises'/)
    assert.match(source, /ipcMain\.handle\('document:read'[\s\S]*const content = await readFile\(path, 'utf-8'\)/)
    assert.match(source, /ipcMain\.handle\('document:read'[\s\S]*data\.bytes = new Uint8Array\(await readFile\(path\)\)/)
    assert.match(source, /ipcMain\.handle\('document:list'[\s\S]*const items = \(await readdir\(dir\)\)/)
    assert.match(source, /ipcMain\.handle\('document:list'[\s\S]*const stats = await stat\(filePath\)/)
    assert.match(source, /ipcMain\.handle\('document:parseDocx'[\s\S]*const buffer = await readFile\(path\)/)
    assert.match(source, /ipcMain\.handle\('document:parseXlsx'[\s\S]*const buffer = await readFile\(path\)/)
  })
})
