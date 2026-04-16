import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

describe('document engine async read path', () => {
  it('uses async file reads in the editable document hot path', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/document-engine/ipc-handler.ts'),
      'utf8',
    )

    assert.match(source, /async function readDocxRawText\(path: string\): Promise<string>/)
    assert.match(source, /const buffer = await readFile\(path\)/)
    assert.match(source, /export async function readDocumentEditableText\(/)
    assert.match(source, /const content = await readFile\(filePath, 'utf-8'\)/)
    assert.doesNotMatch(
      source,
      /export async function readDocumentEditableText[\s\S]*readFileSync\(filePath, 'utf-8'\)/,
    )
  })
})
