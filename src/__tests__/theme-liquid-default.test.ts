import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const storage = new Map<string, string>()
const documentAttributes = new Map<string, string>()
const queuedAnimationFrames: FrameRequestCallback[] = []
const queuedTimeouts: Array<{ id: number; delay: number | undefined; callback: () => void }> = []
const nativeThemeCalls: string[] = []

const localStorageMock = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
  clear: () => {
    storage.clear()
  },
}

const matchMediaMock = (query: string) => ({
  get matches() {
    return query === '(prefers-color-scheme: dark)' ? false : false
  },
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
})

const documentMock = {
  documentElement: {
    setAttribute: (name: string, value: string) => {
      documentAttributes.set(name, value)
    },
    getAttribute: (name: string) => documentAttributes.get(name) ?? null,
    removeAttribute: (name: string) => {
      documentAttributes.delete(name)
    },
  },
}

type TestWindow = typeof globalThis & {
  localStorage: typeof localStorageMock
  document: typeof documentMock
  window: TestWindow
  matchMedia: typeof matchMediaMock
  electronAPI?: {
    theme: {
      set: (theme: string) => Promise<void>
    }
  }
}

const testWindow = globalThis as TestWindow
testWindow.localStorage = localStorageMock
testWindow.document = documentMock
if (typeof testWindow.window === 'undefined') {
  testWindow.window = testWindow
}
testWindow.window.matchMedia = matchMediaMock
testWindow.window.electronAPI = {
  theme: {
    set: async (theme: string) => {
      nativeThemeCalls.push(theme)
    },
  },
}
testWindow.matchMedia = matchMediaMock
testWindow.window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
  queuedAnimationFrames.push(callback)
  return queuedAnimationFrames.length
}) as typeof requestAnimationFrame
testWindow.window.cancelAnimationFrame = ((id: number) => {
  queuedAnimationFrames.splice(id - 1, 1)
}) as typeof cancelAnimationFrame
testWindow.requestAnimationFrame = testWindow.window.requestAnimationFrame
testWindow.cancelAnimationFrame = testWindow.window.cancelAnimationFrame
testWindow.window.setTimeout = ((callback: () => void, delay?: number) => {
  const id = queuedTimeouts.length + 1
  queuedTimeouts.push({ id, delay, callback })
  return id as unknown as ReturnType<typeof setTimeout>
}) as typeof setTimeout
testWindow.window.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
  const index = queuedTimeouts.findIndex((entry) => entry.id === Number(id))
  if (index >= 0) queuedTimeouts.splice(index, 1)
}) as typeof clearTimeout

const { useTheme } = await import('../renderer/stores/useTheme')
const { useRitualOverlayStore, __testing__: ritualOverlayTesting } = await import('../renderer/modules/overlay/useRitualOverlay')

function flushAnimationFrame() {
  const callback = queuedAnimationFrames.shift()
  callback?.(0)
}

function flushTimeout() {
  const entry = queuedTimeouts.shift()
  entry?.callback()
}

function flushTimeoutByDelay(delay: number) {
  const index = queuedTimeouts.findIndex((entry) => entry.delay === delay)
  if (index < 0) {
    throw new Error(`No queued timeout with delay ${delay}`)
  }
  const [entry] = queuedTimeouts.splice(index, 1)
  entry.callback()
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('useTheme liquid default', () => {
  beforeEach(async () => {
    ritualOverlayTesting.resetRitualOverlay()
    await flushMicrotasks()
    storage.clear()
    documentAttributes.clear()
    queuedAnimationFrames.length = 0
    queuedTimeouts.length = 0
    nativeThemeCalls.length = 0
    documentAttributes.set('data-theme', 'light')
    useTheme.setState({
      theme: 'light',
      resolvedTheme: 'light',
      skin: 'liquid-glass',
    })
  })

  it('keeps liquid-glass as the default skin', () => {
    assert.strictEqual(useTheme.getState().skin, 'liquid-glass')
    useTheme.getState().toggleSkin()
    assert.strictEqual(useTheme.getState().skin, 'liquid-glass')
    assert.strictEqual(storage.get('ready-theme-skin'), 'liquid-glass')
    assert.strictEqual(documentAttributes.get('data-skin'), 'liquid-glass')
  })

  it('persists liquid-glass when set explicitly', () => {
    useTheme.getState().setSkin('liquid-glass')
    assert.strictEqual(useTheme.getState().skin, 'liquid-glass')
    assert.strictEqual(storage.get('ready-theme-skin'), 'liquid-glass')
  })

  it('updates the store immediately when setTheme is called; DOM swap is staged by the ritual overlay', () => {
    useTheme.getState().setTheme('dark')
    // Store updates synchronously; the DOM attribute is swapped inside withRitual's holding phase.
    assert.strictEqual(useTheme.getState().theme, 'dark')
    assert.strictEqual(useTheme.getState().resolvedTheme, 'dark')
    assert.strictEqual(storage.get('ready-theme'), 'dark')
    // The legacy transition flag is no longer set — transitions live on the overlay, not the <html> element.
    assert.strictEqual(documentAttributes.get('data-theme-transitioning'), undefined)
  })

  it('defers native theme sync until the renderer-side hold finishes in the non-reduced-motion path', async () => {
    useTheme.getState().setTheme('dark')

    assert.strictEqual(useRitualOverlayStore.getState().session?.phase, 'entering')
    assert.deepStrictEqual(nativeThemeCalls, [])

    flushTimeoutByDelay(160)
    await flushMicrotasks()
    assert.strictEqual(useRitualOverlayStore.getState().session?.phase, 'holding')

    flushAnimationFrame()
    await flushMicrotasks()

    assert.strictEqual(documentAttributes.get('data-theme'), 'dark')
    assert.deepStrictEqual(nativeThemeCalls, [])

    flushTimeoutByDelay(440)
    await flushMicrotasks()

    assert.deepStrictEqual(nativeThemeCalls, ['dark'])
  })
})
