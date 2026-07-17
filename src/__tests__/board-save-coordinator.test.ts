import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBoardSaveCoordinator } from '../renderer/modules/document/boardSaveCoordinator'

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
