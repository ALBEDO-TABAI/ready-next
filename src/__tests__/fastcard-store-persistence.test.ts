import assert from 'node:assert/strict'
import test from 'node:test'
import type { FastCardItem, FastCardIPCResult, FastCardStorageAPI } from '../shared/fastcard'

// C7: exercise the store with a throwing browser-storage trap, not a source grep.
test('C7 store waits for receipts, serializes requests, reloads and reports failures without browser storage', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  let storageAccesses = 0
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() {
    storageAccesses++
    throw new Error('sessionStorage must not be accessed')
  } })
  try {
    const { createFastCardStore } = await import('../renderer/stores/useFastCard')
    const item: FastCardItem = { id: 'persisted', kind: 'text', text: 'hello', createdAt: 1 }
    let persisted: FastCardItem[] = []
    let fail: 'envelope' | 'transport' | null = null
    let confirm: (result: FastCardIPCResult<FastCardItem>) => void = () => assert.fail('add not started')
    const api: FastCardStorageAPI = {
      listFastCardItems: async () => ({ success: true, data: [...persisted] }),
      addFastCardItem: () => new Promise(resolve => { confirm = resolve }),
      removeFastCardItem: async (id) => {
        if (fail === 'transport') throw new Error('连接中断')
        if (fail === 'envelope') return { success: false, error: '磁盘只读' }
        persisted = persisted.filter(value => value.id !== id)
        return { success: true }
      },
      clearFastCardItems: async () => { persisted = []; return { success: true } },
    }
    const store = createFastCardStore(() => api)
    await store.getState().load()
    const adding = store.getState().addItem(item)
    await Promise.resolve()
    assert.deepEqual(store.getState().items, [])
    assert.equal(store.getState().syncState.kind, 'saving')
    persisted = [item]
    confirm({ success: true, data: item })
    assert.equal(await adding, true)
    assert.deepEqual(store.getState().items, [item])
    const restarted = createFastCardStore(() => api)
    await restarted.getState().open()
    assert.deepEqual(restarted.getState().items, [item])
    for (const failure of ['envelope', 'transport'] as const) {
      fail = failure
      assert.equal(await restarted.getState().removeItem(item.id), false)
      assert.deepEqual(restarted.getState().items, [item])
      assert.equal(restarted.getState().syncState.kind, 'error')
    }
    fail = null
    assert.equal(await restarted.getState().removeItem(item.id), true)
    assert.deepEqual(restarted.getState().items, [])
    const addAgain = store.getState().addItem(item)
    const clearAfter = store.getState().clear()
    await Promise.resolve()
    persisted = [item]
    confirm({ success: true, data: item })
    await Promise.all([addAgain, clearAfter])
    assert.deepEqual(store.getState().items, [])
    assert.deepEqual(persisted, [])
    const denied = store.getState().addItem(item)
    await Promise.resolve()
    confirm({ success: false, error: '写入失败' })
    assert.equal(await denied, false)
    assert.deepEqual(store.getState().items, [])
    assert.deepEqual(store.getState().syncState, { kind: 'error', message: '写入失败' })
    store.getState().collapse()
    await store.getState().open()
    assert.equal(storageAccesses, 0)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous)
    else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
})

test('C13 store keeps retry identity, reports receipt and undo, and allows reselecting an unavailable target', async () => {
  const { createFastCardStore } = await import('../renderer/stores/useFastCard')
  const item: FastCardItem = { id: 'collected', kind: 'text', text: 'keep', createdAt: 1 }
  let items = [item]
  const calls: import('../shared/fastcard').FastCardTransferRequest[] = []
  let failure: 'transport' | 'target' | null = 'transport'
  const store = createFastCardStore(() => ({
    listFastCardItems: async () => ({ success: true, data: items }),
    addFastCardItem: async value => ({ success: true, data: value }), removeFastCardItem: async () => ({ success: true }), clearFastCardItems: async () => ({ success: true }),
  }), () => ({
    targets: async () => ({ success: true, data: [] }), pending: async () => ({ success: true, data: [] }),
    transfer: async request => {
      calls.push(request)
      if (failure === 'transport') throw new Error('connection interrupted')
      if (failure === 'target') return { success: false, error: '目标画板不可用', errorCode: 'target_unavailable' }
      items = []
      return { success: true, data: { state: 'completed', operationId: request.operationId, objectId: 'board', title: '灵感', nodeIds: ['node'] } }
    },
    undo: async () => { items = [item]; return { success: true, data: { state: 'undone' } } },
  }))
  await store.getState().load()
  assert.equal(await store.getState().saveToCanvas([item.id]), false)
  assert.equal(store.getState().items.length, 1)
  failure = 'target'
  assert.equal(await store.getState().saveToCanvas([item.id]), false)
  assert.equal(calls[0].operationId, calls[1].operationId)
  failure = null
  assert.equal(await store.getState().saveToCanvas([item.id], { kind: 'existing', objectId: 'board' }), true)
  assert.notEqual(calls[1].operationId, calls[2].operationId)
  assert.equal(store.getState().items.length, 0)
  assert.equal(store.getState().transferReceipt?.title, '灵感')
  assert.equal(await store.getState().undoTransfer(), true)
  assert.deepEqual(store.getState().items, [item])
})
