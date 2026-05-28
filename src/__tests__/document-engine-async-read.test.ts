import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { readDocumentEditableText } from '../main/modules/document-engine/document-editable-text'

describe('document engine editable text read path', () => {
  it('reads editable text through the electron-free helper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ready-doc-read-'))
    try {
      const path = join(dir, 'note.md')
      await writeFile(path, '# Note\n正文', 'utf8')

      const result = await readDocumentEditableText(path)

      assert.equal(result.success, true)
      assert.equal(result.content, '# Note\n正文')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects binary files from the editable text path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ready-doc-read-'))
    try {
      const path = join(dir, 'image.png')
      await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

      const result = await readDocumentEditableText(path)

      assert.equal(result.success, false)
      assert.match(result.error || '', /不支持直接编辑二进制文件/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
