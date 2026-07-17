import assert from 'node:assert/strict'
import test from 'node:test'

import { createEmptyReadyBoardState, type ReadyBoardState } from '../shared/ready-board'
import { appendExternalBoardImage } from '../renderer/modules/document/boardExternalAsset'
import { createBoardSaveCoordinator } from '../renderer/modules/document/boardSaveCoordinator'
import {
  installBoardExternalAssetBridge,
  flushBoardExternalAssetInboxForTests,
  registerBoardExternalAssetOwner,
  resetBoardExternalAssetInboxForTests,
} from '../renderer/modules/document/boardExternalAssetInbox'
import {
  releaseClosedBoardHandles,
  rememberBoardHandle,
  resetBoardHandleRegistryForTests,
  trackBoardPathSave,
  waitForBoardPathSave,
} from '../renderer/modules/document/boardHandleRegistry'

test('external browser image merges with an unsaved local board node', () => {
  const local: ReadyBoardState = {
    ...createEmptyReadyBoardState('Reference'),
    nodes: [{ id: 'local', type: 'text', text: 'draft', fontSize: 24, color: '#000', x: 0, y: 0, width: 100, height: 40 }],
  }
  const merged = appendExternalBoardImage(local, {
    src: 'assets/reference.png',
    kind: 'image',
    name: 'reference.png',
    absPath: '/tmp/reference.png',
    size: 10,
  }, 'external')

  assert.deepEqual(merged.nodes.map((node) => node.id), ['local', 'external'])
})

test('replaying a durable external receipt does not duplicate its image node', () => {
  const asset = {
    src: 'assets/reference.png',
    kind: 'image' as const,
    name: 'reference.png',
    absPath: '/tmp/reference.png',
    size: 10,
  }
  const once = appendExternalBoardImage(createEmptyReadyBoardState('Reference'), asset, 'first', 'receipt-1')
  const twice = appendExternalBoardImage(once, asset, 'second', 'receipt-1')
  assert.equal(twice, once)
  assert.deepEqual(twice.nodes.map((node) => node.id), ['first'])
})

test('external browser image queued during a local save becomes the final persisted state', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let markFirstStarted!: () => void
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve })
  let revision = 1
  let savedRevision = 0
  let state: ReadyBoardState = {
    ...createEmptyReadyBoardState('Reference'),
    nodes: [{ id: 'local', type: 'text', text: 'draft', fontSize: 24, color: '#000', x: 0, y: 0, width: 100, height: 40 }],
  }
  let persisted = createEmptyReadyBoardState('Reference')
  const coordinator = createBoardSaveCoordinator({
    delayMs: 60_000,
    getSnapshot: () => revision > savedRevision ? { revision, value: state } : null,
    write: async (snapshot) => {
      if (snapshot.revision === 1) {
        markFirstStarted()
        await firstGate
      }
      persisted = snapshot.value
      return snapshot.value
    },
    onSaveSuccess: (snapshot) => { savedRevision = Math.max(savedRevision, snapshot.revision) },
  })

  const localSave = coordinator.saveNow()
  await firstStarted
  state = appendExternalBoardImage(state, {
    src: 'assets/reference.png', kind: 'image', name: 'reference.png', absPath: '/tmp/reference.png', size: 10,
  }, 'external')
  revision += 1
  const mergedSave = coordinator.saveNow()
  releaseFirst()
  await Promise.all([localSave, mergedSave])

  assert.deepEqual(persisted.nodes.map((node) => node.id), ['local', 'external'])
})

test('external image received while the board editor is hidden is delivered with its durable receipt when that board remounts', async () => {
  resetBoardExternalAssetInboxForTests()
  let push: ((result: {
    success: boolean
    data?: { boardId: string; path: string; receiptId: string; asset: { src: string; kind: 'image'; name: string; absPath: string; size: number } }
  }) => void) | null = null
  const uninstall = installBoardExternalAssetBridge({
    onActiveBoardExternalImageAdded: (callback) => {
      push = callback
      return () => { push = null }
    },
  })
  push?.({
    success: true,
    data: {
      boardId: 'old-handle',
      path: '/workspace/reference.readyboard.html',
      receiptId: 'receipt-queued',
      asset: { src: 'assets/queued.png', kind: 'image', name: 'queued.png', absPath: '/workspace/assets/queued.png', size: 10 },
    },
  })
  const received: string[] = []
  const unregister = registerBoardExternalAssetOwner({
    boardId: 'new-handle',
    path: '/workspace/reference.readyboard.html',
    onAsset: (receipt) => { received.push(`${receipt.id}:${receipt.asset.src}`) },
    reportError: () => undefined,
  })

  await flushBoardExternalAssetInboxForTests()
  assert.deepEqual(received, ['receipt-queued:assets/queued.png'])
  unregister()
  uninstall()
  resetBoardExternalAssetInboxForTests()
})

test('failed external receipt delivery remains queued and retries after the board remounts', async () => {
  resetBoardExternalAssetInboxForTests()
  let push: ((result: {
    success: boolean
    data?: { boardId: string; path: string; receiptId: string; asset: { src: string; kind: 'image'; name: string; absPath: string; size: number } }
  }) => void) | null = null
  const uninstall = installBoardExternalAssetBridge({
    onActiveBoardExternalImageAdded: (callback) => {
      push = callback
      return () => { push = null }
    },
  })
  push?.({
    success: true,
    data: {
      boardId: 'board-a',
      path: '/workspace/reference.readyboard.html',
      receiptId: 'receipt-retry',
      asset: { src: 'assets/retry.png', kind: 'image', name: 'retry.png', absPath: '/workspace/assets/retry.png', size: 10 },
    },
  })

  const errors: string[] = []
  const unregisterFailedOwner = registerBoardExternalAssetOwner({
    boardId: 'board-a',
    path: '/workspace/reference.readyboard.html',
    onAsset: async () => { throw new Error('save failed') },
    reportError: (error) => { errors.push(error) },
  })
  await flushBoardExternalAssetInboxForTests()
  unregisterFailedOwner()

  const retried: string[] = []
  const unregisterRecoveredOwner = registerBoardExternalAssetOwner({
    boardId: 'board-b',
    path: '/workspace/reference.readyboard.html',
    onAsset: (receipt) => { retried.push(receipt.id) },
    reportError: () => undefined,
  })
  await flushBoardExternalAssetInboxForTests()

  assert.deepEqual(errors, ['save failed'])
  assert.deepEqual(retried, ['receipt-retry'])
  unregisterRecoveredOwner()
  uninstall()
  resetBoardExternalAssetInboxForTests()
})

test('closing one board only compare-clears that board handle', async () => {
  resetBoardHandleRegistryForTests()
  rememberBoardHandle('left-tab', 'left-board')
  rememberBoardHandle('right-tab', 'right-board')
  const cleared: string[] = []
  await releaseClosedBoardHandles(new Set(['right-tab']), (boardId) => { cleared.push(boardId) })
  assert.deepEqual(cleared, ['left-board'])
  resetBoardHandleRegistryForTests()
})

test('a remounted board waits for the previous editor path save to settle', async () => {
  resetBoardHandleRegistryForTests()
  let release!: () => void
  const pendingSave = new Promise<void>((resolve) => { release = resolve })
  trackBoardPathSave('/workspace/reference.readyboard', pendingSave)
  let reopened = false
  const wait = waitForBoardPathSave('/workspace/reference.readyboard').then(() => { reopened = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(reopened, false)
  release()
  await wait
  assert.equal(reopened, true)
  resetBoardHandleRegistryForTests()
})
