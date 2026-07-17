import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  resetDocumentEditableTextWriteQueueForTests,
  writeDocumentEditableText,
} from '../main/modules/document-engine/document-editable-text'

test('Agent and Renderer writes to the same canonical path stay ordered', async () => {
  resetDocumentEditableTextWriteQueueForTests()
  const directory = await mkdtemp(join(tmpdir(), 'ready-document-main-write-'))
  try {
    const path = join(directory, 'shared.md')
    const aliasDirectory = join(directory, 'alias')
    const aliasPath = join(aliasDirectory, '..', 'shared.md')
    await mkdir(aliasDirectory)
    await writeFile(path, 'disk-old', 'utf8')
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    const started: string[] = []
    const publish = async (targetPath: string, data: string | Uint8Array) => {
      const content = String(data)
      started.push(content)
      if (content === 'exit-old-snapshot') {
        markFirstStarted()
        await firstGate
      }
      await writeFile(targetPath, data)
    }

    const exitWrite = writeDocumentEditableText(aliasPath, 'exit-old-snapshot', { publish })
    await firstStarted
    const agentWrite = writeDocumentEditableText(path, 'agent-new-snapshot', { publish })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(started, ['exit-old-snapshot'])

    releaseFirst()
    assert.deepEqual(await Promise.all([exitWrite, agentWrite]), [
      { success: true },
      { success: true },
    ])
    assert.deepEqual(started, ['exit-old-snapshot', 'agent-new-snapshot'])
    assert.equal(await readFile(path, 'utf8'), 'agent-new-snapshot')
  } finally {
    resetDocumentEditableTextWriteQueueForTests()
    await rm(directory, { recursive: true, force: true })
  }
})
