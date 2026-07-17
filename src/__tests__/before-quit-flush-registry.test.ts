import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBoardSaveCoordinator } from '../renderer/modules/document/boardSaveCoordinator'
import { applyPendingBoardTextEdit } from '../renderer/modules/document/boardPendingEdit'
import {
  resetBoardHandleRegistryForTests,
  trackBoardPathSave,
  waitForAllBoardPathSaves,
} from '../renderer/modules/document/boardHandleRegistry'
import { createEmptyReadyBoardState, type ReadyBoardState } from '../shared/ready-board'
import {
  installBeforeQuitFlushBridge,
  registerBeforeQuitFlushHandler,
  resetBeforeQuitFlushRegistryForTests,
} from '../renderer/modules/app/beforeQuitFlushRegistry'

test('before-quit acknowledgement waits for a pending board edit to reach disk', async () => {
  resetBeforeQuitFlushRegistryForTests()
  const directory = await mkdtemp(join(tmpdir(), 'ready-before-quit-board-'))
  try {
    const path = join(directory, 'board.json')
    await writeFile(path, 'old')
    const current = { revision: 1, value: 'latest-before-quit' }
    const coordinator = createBoardSaveCoordinator({
      delayMs: 60_000,
      getSnapshot: () => current,
      write: async (snapshot) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        await writeFile(path, snapshot.value, 'utf8')
      },
    })
    coordinator.schedule()
    const unregister = registerBeforeQuitFlushHandler('board:one', () => coordinator.saveNow())
    let requestHandler: ((requestId: string) => void) | null = null
    let acknowledge!: () => void
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve })
    const uninstall = installBeforeQuitFlushBridge({
      onBeforeQuitFlush: (handler) => {
        requestHandler = handler
        return () => { requestHandler = null }
      },
      ackBeforeQuitFlushed: (requestId) => {
        assert.equal(requestId, 'quit-1')
        acknowledge()
      },
    })

    requestHandler?.('quit-1')
    await acknowledged
    assert.equal(await readFile(path, 'utf8'), 'latest-before-quit')

    uninstall()
    unregister()
  } finally {
    resetBeforeQuitFlushRegistryForTests()
    await rm(directory, { recursive: true, force: true })
  }
})

test('before-quit commits focused board text before acknowledging the renderer flush', async () => {
  resetBeforeQuitFlushRegistryForTests()
  const directory = await mkdtemp(join(tmpdir(), 'ready-before-quit-board-text-'))
  try {
    const path = join(directory, 'board.json')
    let state: ReadyBoardState = {
      ...createEmptyReadyBoardState('Reference'),
      nodes: [{
        id: 'text-1',
        type: 'text',
        text: 'old',
        fontSize: 24,
        color: '#000',
        x: 0,
        y: 0,
        width: 120,
        height: 60,
      }],
    }
    let revision = 0
    let savedRevision = 0
    const coordinator = createBoardSaveCoordinator({
      delayMs: 60_000,
      getSnapshot: () => revision > savedRevision ? { revision, value: state } : null,
      write: async (snapshot) => {
        await writeFile(path, JSON.stringify(snapshot.value), 'utf8')
        return snapshot.value
      },
      onSaveSuccess: (snapshot) => { savedRevision = snapshot.revision },
    })
    registerBeforeQuitFlushHandler('board:focused-text', async () => {
      const next = applyPendingBoardTextEdit(state, { id: 'text-1', value: 'latest-unblurred-input' })
      if (next !== state) {
        state = next
        revision += 1
      }
      await coordinator.saveNow()
    })
    let requestHandler: ((requestId: string) => void) | null = null
    const acknowledged = new Promise<void>((resolve) => {
      installBeforeQuitFlushBridge({
        onBeforeQuitFlush: (handler) => {
          requestHandler = handler
          return () => { requestHandler = null }
        },
        ackBeforeQuitFlushed: () => resolve(),
      })
    })

    requestHandler?.('quit-focused-text')
    await acknowledged
    const persisted = JSON.parse(await readFile(path, 'utf8')) as ReadyBoardState
    assert.equal(persisted.nodes[0]?.type === 'text' ? persisted.nodes[0].text : '', 'latest-unblurred-input')
  } finally {
    resetBeforeQuitFlushRegistryForTests()
    await rm(directory, { recursive: true, force: true })
  }
})

test('before-quit waits for a board save that started during editor unmount', async () => {
  resetBeforeQuitFlushRegistryForTests()
  resetBoardHandleRegistryForTests()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  trackBoardPathSave('/workspace/hidden.readyboard', pending)
  registerBeforeQuitFlushHandler('board:unmounted-saves', waitForAllBoardPathSaves)
  let requestHandler: ((requestId: string) => void) | null = null
  let acknowledged = false
  installBeforeQuitFlushBridge({
    onBeforeQuitFlush: (handler) => {
      requestHandler = handler
      return () => { requestHandler = null }
    },
    ackBeforeQuitFlushed: () => { acknowledged = true },
  })

  requestHandler?.('quit-hidden-board')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(acknowledged, false)
  release()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(acknowledged, true)
  resetBeforeQuitFlushRegistryForTests()
  resetBoardHandleRegistryForTests()
})

test('before-quit waits for every unmounted board save before acknowledging a sibling failure', async () => {
  resetBeforeQuitFlushRegistryForTests()
  resetBoardHandleRegistryForTests()
  let fail!: (error: Error) => void
  let releaseSlow!: () => void
  const failed = new Promise<void>((_resolve, reject) => { fail = reject })
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
  trackBoardPathSave('/workspace/failed.readyboard', failed)
  trackBoardPathSave('/workspace/slow.readyboard', slow)
  registerBeforeQuitFlushHandler('board:unmounted-saves', waitForAllBoardPathSaves)
  let requestHandler: ((requestId: string) => void) | null = null
  let acknowledge!: (outcome: { success: boolean; error?: string }) => void
  let acknowledgementOutcome: { success: boolean; error?: string } | null = null
  const acknowledgement = new Promise<{ success: boolean; error?: string }>((resolve) => { acknowledge = resolve })
  installBeforeQuitFlushBridge({
    onBeforeQuitFlush: (handler) => {
      requestHandler = handler
      return () => { requestHandler = null }
    },
    ackBeforeQuitFlushed: (_requestId, outcome) => {
      acknowledgementOutcome = outcome
      acknowledge(outcome)
    },
  })

  requestHandler?.('quit-multiple-hidden-boards')
  fail(new Error('injected board save failure'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(acknowledgementOutcome, null)
  releaseSlow()
  const outcome = await acknowledgement
  assert.equal(outcome.success, false)
  assert.match(String(outcome.error), /injected board save failure/)
  resetBeforeQuitFlushRegistryForTests()
  resetBoardHandleRegistryForTests()
})

test('renderer interaction stays frozen after a successful flush until Main closes or cancels it', async () => {
  resetBeforeQuitFlushRegistryForTests()
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  registerBeforeQuitFlushHandler('document:dirty-tabs', () => pending)
  let requestHandler: ((requestId: string) => void) | null = null
  let cancelHandler: ((requestId: string) => void) | null = null
  const frozen: boolean[] = []
  let acknowledge!: (outcome: { success: boolean; error?: string }) => void
  const acknowledged = new Promise<{ success: boolean; error?: string }>((resolve) => { acknowledge = resolve })
  const uninstall = installBeforeQuitFlushBridge({
    onBeforeQuitFlush: (handler) => {
      requestHandler = handler
      return () => { requestHandler = null }
    },
    onBeforeQuitFlushCancelled: (handler) => {
      cancelHandler = handler
      return () => { cancelHandler = null }
    },
    ackBeforeQuitFlushed: (_requestId, outcome) => { acknowledge(outcome) },
  }, {
    setInteractionFrozen: (value) => { frozen.push(value) },
  })

  requestHandler?.('flush-freeze')
  assert.deepEqual(frozen, [true])
  release()
  assert.deepEqual(await acknowledged, { success: true })
  assert.deepEqual(frozen, [true])
  cancelHandler?.('flush-freeze')
  assert.deepEqual(frozen, [true, false])

  uninstall()
  resetBeforeQuitFlushRegistryForTests()
})
