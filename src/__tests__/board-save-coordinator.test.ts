import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBoardSaveCoordinator } from '../renderer/modules/document/boardSaveCoordinator'
import {
  retryBoardPathSave,
  resetBoardHandleRegistryForTests,
  trackBoardPathSave,
  waitForBoardPathSave,
} from '../renderer/modules/document/boardHandleRegistry'

async function withTempFile(work: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ready-board-save-'))
  try {
    await work(join(dir, 'board.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('disposing a board editor flushes its pending debounced snapshot', async () => {
  await withTempFile(async (path) => {
    const current = { revision: 1, value: 'latest-before-unmount' }
    const coordinator = createBoardSaveCoordinator({
      delayMs: 60_000,
      getSnapshot: () => current,
      write: async (snapshot) => writeFile(path, snapshot.value, 'utf8'),
    })

    coordinator.schedule()
    await coordinator.dispose()

    assert.equal(await readFile(path, 'utf8'), 'latest-before-unmount')
  })
})

test('overlapping board saves stay ordered and the newest snapshot wins on disk', async () => {
  await withTempFile(async (path) => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    let current = { revision: 1, value: 'older' }
    const coordinator = createBoardSaveCoordinator({
      delayMs: 1500,
      getSnapshot: () => current,
      write: async (snapshot) => {
        if (snapshot.revision === 1) {
          markFirstStarted()
          await firstGate
        }
        await writeFile(path, snapshot.value, 'utf8')
      },
    })

    const olderSave = coordinator.saveNow()
    await firstStarted
    current = { revision: 2, value: 'newer' }
    const newerSave = coordinator.saveNow()
    releaseFirst()
    await Promise.all([olderSave, newerSave])

    assert.equal(await readFile(path, 'utf8'), 'newer')
  })
})

test('exit save follows a board revision produced while the first snapshot is writing', async () => {
  await withTempFile(async (path) => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
    let current = { revision: 1, value: 'before-exit' }
    let savedRevision = 0
    const writes: string[] = []
    const coordinator = createBoardSaveCoordinator({
      delayMs: 60_000,
      getSnapshot: () => current.revision > savedRevision ? current : null,
      write: async (snapshot) => {
        writes.push(snapshot.value)
        if (snapshot.revision === 1) {
          markFirstStarted()
          await firstGate
        }
        await writeFile(path, snapshot.value, 'utf8')
      },
      onSaveSuccess: (snapshot) => { savedRevision = snapshot.revision },
    })

    const exitSave = coordinator.saveNow()
    await firstStarted
    current = { revision: 2, value: 'external-change-during-exit' }
    coordinator.schedule()
    releaseFirst()
    await exitSave

    assert.deepEqual(writes, ['before-exit', 'external-change-during-exit'])
    assert.equal(savedRevision, 2)
    assert.equal(await readFile(path, 'utf8'), 'external-change-during-exit')
  })
})

test('a failed unmount save keeps its real snapshot retryable before remount can open disk state', async () => {
  resetBoardHandleRegistryForTests()
  await withTempFile(async (path) => {
    await writeFile(path, 'old', 'utf8')
    const saveError = new Error('injected board write failure')
    const observedErrors: unknown[] = []
    let attempts = 0
    const coordinator = createBoardSaveCoordinator({
      delayMs: 60_000,
      getSnapshot: () => ({ revision: 1, value: 'latest-unsaved-snapshot' }),
      write: async (snapshot) => {
        attempts += 1
        if (attempts === 1) throw saveError
        await writeFile(path, snapshot.value, 'utf8')
      },
      onSaveError: (_snapshot, error) => observedErrors.push(error),
    })

    const tracked = trackBoardPathSave(path, coordinator.dispose(), () => coordinator.dispose())
    await assert.rejects(tracked, saveError)
    await assert.rejects(waitForBoardPathSave(path), saveError)
    assert.equal(await readFile(path, 'utf8'), 'old')

    await retryBoardPathSave(path)
    await waitForBoardPathSave(path)
    assert.equal(await readFile(path, 'utf8'), 'latest-unsaved-snapshot')
    assert.equal(attempts, 2)
    assert.deepEqual(observedErrors, [saveError])
  })
  resetBoardHandleRegistryForTests()
})
