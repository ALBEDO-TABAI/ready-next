import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

// The real store is imported once after browser setup; no module-cache reset or lifecycle bypass.
const dom = new JSDOM('<!doctype html><html></html>', { url: 'https://ready.test' })
const previous = new Map<string, PropertyDescriptor | undefined>()
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage })) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}
Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {} }) })
type Snapshot = { option: string; resolved: 'light' | 'dark'; transparency: 'normal' | 'reduced'; reduceTransparency: boolean }
let changed: (snapshot: Snapshot) => void = () => { throw new Error('theme listener was not registered') }
const calls: boolean[] = []
let reply: ((snapshot: Snapshot) => void) | undefined
Object.defineProperty(dom.window, 'electronAPI', { value: { theme: {
  set: async () => {},
  onChanged: (listener: typeof changed) => { changed = listener; return () => {} },
  setReduceTransparency: (enabled: boolean) => {
    calls.push(enabled)
    return new Promise<Snapshot>((resolve) => { reply = resolve })
  },
} } })
localStorage.setItem('ready-theme', 'dark')
localStorage.setItem('ready-transparency', 'reduced')
localStorage.setItem('ready-reduce-transparency', 'false')
const { useTheme } = await import('../renderer/stores/useTheme')
const { useRitualOverlayStore } = await import('../renderer/modules/overlay/useRitualOverlay')
const { removeRetiredThemeStorage } = await import('../renderer/stores/theme-legacy-storage')
const snapshot = (transparency: 'normal' | 'reduced', reduceTransparency: boolean): Snapshot => ({
  option: 'light', resolved: 'light', transparency, reduceTransparency,
})

after(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
  dom.window.close()
})

test('initialization applies the cached effective transparency independently of the user switch', () => {
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')
  assert.equal(useTheme.getState().transparency, 'reduced')
  assert.equal(useTheme.getState().reduceTransparency, false)
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
})

test('enabling is immediate and calls Main without a theme ritual', async () => {
  changed(snapshot('normal', false))
  calls.length = 0
  const ritual = useRitualOverlayStore.getState().session
  useTheme.getState().setReduceTransparency(true)
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')
  assert.equal(useTheme.getState().transparency, 'reduced')
  assert.equal(useTheme.getState().reduceTransparency, true)
  assert.equal(localStorage.getItem('ready-transparency'), 'reduced')
  assert.deepEqual(calls, [true])
  assert.equal(useRitualOverlayStore.getState().session, ritual)
  assert.ok(reply)
  reply(snapshot('reduced', true))
  await Promise.resolve()
  assert.equal(localStorage.getItem('ready-reduce-transparency'), 'true')
})

test('disabling waits for Main and retains reduced transparency when the system requires it', async () => {
  calls.length = 0
  useTheme.getState().setReduceTransparency(false)
  assert.equal(useTheme.getState().reduceTransparency, false)
  assert.equal(useTheme.getState().transparency, 'reduced')
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')
  assert.deepEqual(calls, [false])
  assert.ok(reply)
  reply(snapshot('reduced', false))
  await Promise.resolve()
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')
  assert.equal(useTheme.getState().transparency, 'reduced')
  assert.equal(localStorage.getItem('ready-reduce-transparency'), 'false')

  useTheme.getState().setReduceTransparency(false)
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')
  reply(snapshot('normal', false))
  await Promise.resolve()
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'normal')
  assert.equal(useTheme.getState().transparency, 'normal')
  assert.equal(localStorage.getItem('ready-transparency'), 'normal')
})

test('Main push updates transparency and its cache without changing light/dark or starting a ritual', () => {
  const ritual = useRitualOverlayStore.getState().session
  changed(snapshot('reduced', true))
  assert.equal(useTheme.getState().transparency, 'reduced')
  assert.equal(useTheme.getState().reduceTransparency, true)
  assert.equal(document.documentElement.getAttribute('data-transparency'), 'reduced')
  assert.equal(localStorage.getItem('ready-transparency'), 'reduced')
  assert.equal(localStorage.getItem('ready-reduce-transparency'), 'true')
  assert.equal(useTheme.getState().theme, 'dark')
  assert.equal(useTheme.getState().resolvedTheme, 'dark')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
  assert.equal(localStorage.getItem('ready-theme'), 'dark')
  assert.equal(useRitualOverlayStore.getState().session, ritual)
})

test('retired storage cleanup deletes exactly the two old keys and is repeatable', () => {
  localStorage.setItem('ready-theme-skin', 'solid-blue-glass')
  localStorage.setItem('ready-theme-accent', 'purple')
  localStorage.setItem('other', 'keep')
  const expected = Object.fromEntries(Object.entries(localStorage).filter(([key]) => !['ready-theme-skin', 'ready-theme-accent'].includes(key)))
  removeRetiredThemeStorage()
  assert.deepEqual(Object.fromEntries(Object.entries(localStorage)), expected)
  removeRetiredThemeStorage()
  assert.deepEqual(Object.fromEntries(Object.entries(localStorage)), expected)
})
