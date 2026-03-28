import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

const storage = new Map<string, string>()
const documentAttributes = new Map<string, string>()

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
  },
}

type TestWindow = typeof globalThis & {
  localStorage: typeof localStorageMock
  document: typeof documentMock
  window: TestWindow
  matchMedia: typeof matchMediaMock
  electronAPI?: unknown
}

const testWindow = globalThis as TestWindow
testWindow.localStorage = localStorageMock
testWindow.document = documentMock
if (typeof testWindow.window === 'undefined') {
  testWindow.window = testWindow
}
testWindow.window.matchMedia = matchMediaMock
testWindow.window.electronAPI = undefined
testWindow.matchMedia = matchMediaMock

const { useTheme } = await import('../renderer/stores/useTheme')

describe('useTheme liquid default', () => {
  beforeEach(() => {
    storage.clear()
    documentAttributes.clear()
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
})
