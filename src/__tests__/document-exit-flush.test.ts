import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  flushDirtyDocumentTabsForExit,
  type DocumentExitFlushPort,
} from '../renderer/modules/document/documentExitFlush'
import {
  getDocumentSaveSerializationKey,
  registerDocumentSaveHandler,
  resetDocumentSaveRegistryForTests,
  runRegisteredDocumentSave,
  runSerializedDocumentSave,
} from '../renderer/modules/document/documentSaveRegistry'
import type { DocTab } from '../renderer/stores/useDocTabs'

function createPort(
  getTabs: () => DocTab[],
  overrides: Partial<DocumentExitFlushPort> = {},
): DocumentExitFlushPort {
  return {
    getTabs,
    runSerialized: async (_tabId, _path, operation) => operation(),
    writeFile: async (path, content) => {
      await writeFile(path, content, 'utf8')
      return { success: true }
    },
    commitTabSaveSnapshot: (tabId, expectedContent, writtenContent) => {
      const tab = getTabs().find((candidate) => candidate.id === tabId)
      if (!tab || tab.content !== expectedContent) return false
      tab.content = writtenContent
      tab.isDirty = false
      return true
    },
    flushDraftPersistence: () => undefined,
    now: () => Date.now(),
    ...overrides,
  }
}

test('exit flush writes the latest text snapshot when content changes during the first write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-document-exit-flush-'))
  try {
    const path = join(directory, 'note.md')
    await writeFile(path, 'disk-old', 'utf8')
    const tabs: DocTab[] = [{
      id: 'doc-1', path, title: 'note.md', content: 'first snapshot', isDirty: true,
    }]
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    let writes = 0
    const port = createPort(() => tabs, {
      writeFile: async (targetPath, content) => {
        writes += 1
        if (writes === 1) {
          markFirstStarted()
          await firstGate
        }
        await writeFile(targetPath, content, 'utf8')
        return { success: true }
      },
    })

    const flushing = flushDirtyDocumentTabsForExit(port)
    await firstStarted
    tabs[0].content = 'latest typing during flush'
    tabs[0].isDirty = true
    releaseFirst()
    await flushing

    assert.equal(writes, 2)
    assert.equal(await readFile(path, 'utf8'), 'latest typing during flush')
    assert.equal(tabs[0].isDirty, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('exit flush waits for every text save before aggregating a sibling failure', async () => {
  const tabs: DocTab[] = [
    { id: 'failed', path: '/tmp/failed.md', title: 'failed.md', content: 'a', isDirty: true },
    { id: 'slow', path: '/tmp/slow.md', title: 'slow.md', content: 'b', isDirty: true },
  ]
  let releaseSlow!: () => void
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
  let settled = false
  const flushing = flushDirtyDocumentTabsForExit(createPort(() => tabs, {
    writeFile: async (path) => {
      if (path.includes('failed')) return { success: false, error: 'disk full' }
      await slow
      return { success: true }
    },
  })).finally(() => { settled = true })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  releaseSlow()
  await assert.rejects(flushing, /disk full/)
})

test('untitled dirty documents flush recoverable draft storage without opening save-as', async () => {
  const tabs: DocTab[] = [{
    id: 'draft', path: null, title: '新文档', content: 'recoverable draft', isDirty: true,
  }]
  let draftFlushes = 0
  let writes = 0
  await flushDirtyDocumentTabsForExit(createPort(() => tabs, {
    flushDraftPersistence: () => { draftFlushes += 1 },
    writeFile: async () => { writes += 1; return { success: true } },
  }))
  assert.equal(draftFlushes, 1)
  assert.equal(writes, 0)
  assert.equal(tabs[0].isDirty, true)
})

test('draft storage failure does not skip dirty path writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-document-exit-storage-failure-'))
  try {
    const path = join(directory, 'note.md')
    await writeFile(path, 'old', 'utf8')
    const tabs: DocTab[] = [{
      id: 'doc-path', path, title: 'note.md', content: 'latest-on-disk', isDirty: true,
    }]
    let writes = 0
    const flushing = flushDirtyDocumentTabsForExit(createPort(() => tabs, {
      flushDraftPersistence: () => { throw new Error('localStorage quota exceeded') },
      writeFile: async (targetPath, content) => {
        writes += 1
        await writeFile(targetPath, content, 'utf8')
        return { success: true }
      },
    }))

    await assert.rejects(flushing, /localStorage quota exceeded/)
    assert.equal(writes, 1)
    assert.equal(await readFile(path, 'utf8'), 'latest-on-disk')
    assert.equal(tabs[0].isDirty, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a timed-out old tab write cannot overwrite a reopened tab saving the same path', async () => {
  resetDocumentSaveRegistryForTests()
  const directory = await mkdtemp(join(tmpdir(), 'ready-document-exit-reopen-race-'))
  try {
    const path = join(directory, 'shared.md')
    await writeFile(path, 'disk-old', 'utf8')
    let tabs: DocTab[] = [{
      id: 'old-tab', path, title: 'shared.md', content: 'old-snapshot', isDirty: true,
    }]
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    let markOldStarted!: () => void
    const oldStarted = new Promise<void>((resolve) => { markOldStarted = resolve })
    const writes: string[] = []
    const writeSnapshot = async (content: string) => {
      writes.push(content)
      if (content === 'old-snapshot') {
        markOldStarted()
        await oldGate
      }
      await writeFile(path, content, 'utf8')
    }
    const port = createPort(() => tabs, {
      runSerialized: (tabId, targetPath, operation) => runSerializedDocumentSave(
        getDocumentSaveSerializationKey(tabId, targetPath),
        operation,
      ),
      writeFile: async (_targetPath, content) => {
        await writeSnapshot(content)
        return { success: true }
      },
    })

    const oldFlush = flushDirtyDocumentTabsForExit(port)
    await oldStarted
    tabs = [{
      id: 'reopened-tab', path, title: 'shared.md', content: 'new-snapshot', isDirty: true,
    }]
    const unregister = registerDocumentSaveHandler(
      'reopened-tab',
      async () => {
        const snapshot = tabs[0].content
        await writeSnapshot(snapshot)
        port.commitTabSaveSnapshot('reopened-tab', snapshot, snapshot)
      },
      getDocumentSaveSerializationKey('reopened-tab', path),
    )
    const reopenedSave = runRegisteredDocumentSave('reopened-tab')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(writes, ['old-snapshot'], 'the reopened tab must queue behind the old path write')

    releaseOld()
    await Promise.all([oldFlush, reopenedSave])
    unregister()

    assert.equal(await readFile(path, 'utf8'), 'new-snapshot')
    assert.equal(tabs[0].isDirty, false)
    assert.equal(writes.at(-1), 'new-snapshot')
  } finally {
    resetDocumentSaveRegistryForTests()
    await rm(directory, { recursive: true, force: true })
  }
})
