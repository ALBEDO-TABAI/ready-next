import assert from 'node:assert/strict'
import test from 'node:test'

// Motion language M2: a toast's time stands still while the pointer or focus is on it; one with actions stays longer.
test('toasts pause under the pointer and resume after; toasts with actions get at least six seconds', async t => {
  const timers = new Map<number, { at: number; fn: () => void }>()
  let now = 0, seq = 0
  const fakeWindow = {
    setTimeout: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
  }
  const realNow = Date.now
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true, writable: true })
  Date.now = () => now
  t.after(() => { Reflect.deleteProperty(globalThis, 'window'); Date.now = realNow })
  const advance = (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
  }
  const store = await import('../renderer/components/ui/toast-store')

  const id = store.showToast('已保存')
  advance(2000)
  store.pauseToast(id)
  advance(10_000)
  assert.equal(store.getToasts().length, 1, 'held while hovered')
  store.resumeToast(id)
  advance(1999)
  assert.equal(store.getToasts().length, 1, 'the remaining two seconds run after')
  advance(2)
  assert.equal(store.getToasts().length, 0)

  store.showToast('已移到回收站', { actions: [{ label: '撤销', onClick: () => {} }] })
  advance(5_000)
  assert.equal(store.getToasts().length, 1, 'a toast with an action stays at least six seconds')
  advance(1_001)
  assert.equal(store.getToasts().length, 0)
})
