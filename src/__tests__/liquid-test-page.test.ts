import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const localStorageStore = new Map<string, string>()
const documentAttributes = new Map<string, string>()

const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, value)
  },
  removeItem: (key: string) => {
    localStorageStore.delete(key)
  },
  clear: () => {
    localStorageStore.clear()
  },
}

const documentMock = {
  documentElement: {
    setAttribute: (name: string, value: string) => {
      documentAttributes.set(name, value)
    },
    getAttribute: (name: string) => documentAttributes.get(name) ?? null,
  },
}

const matchMediaMock = (_query: string) => ({
  matches: false,
  media: _query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
})

type TestWindow = typeof globalThis & {
  localStorage: typeof localStorageMock
  document: typeof documentMock
  navigator: { userAgent: string }
  window: TestWindow
  matchMedia: typeof matchMediaMock
  addEventListener: () => void
  removeEventListener: () => void
  electronAPI?: unknown
}

const testWindow = globalThis as TestWindow

testWindow.localStorage = localStorageMock
testWindow.document = documentMock
Object.defineProperty(testWindow, 'navigator', {
  value: { userAgent: 'ready-test' },
  configurable: true,
})

if (typeof testWindow.window === 'undefined') {
  testWindow.window = testWindow
}

testWindow.window.matchMedia = matchMediaMock
testWindow.window.addEventListener = () => {}
testWindow.window.removeEventListener = () => {}
testWindow.window.electronAPI = undefined
testWindow.matchMedia = matchMediaMock

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const APP_FILE = resolve(TEST_DIR, '../renderer/App.tsx')

describe('LiquidTest preview', () => {
  it('registers an isolated liquid test route in the app shell', async () => {
    const appSource = await readFile(APP_FILE, 'utf8')

    assert.match(appSource, /path="\/liquid-test"/)
    assert.match(appSource, /path="\*" element={<Navigate to="\/workbench" replace \/>}/)
  })

  it('renders the liquid lens tuning lab', async () => {
    // 2026-06-10: 页面转型为 LiquidLens 光学调参台（拖拽镜片 + 全参数滑杆）。
    const { default: LiquidTest } = await import('../renderer/LiquidTest')
    const html = renderToStaticMarkup(React.createElement(LiquidTest))

    assert.match(html, /Liquid lens 调参台/)
    assert.match(html, /lab-lens-host/)
    assert.match(html, /折射带宽 px/)
    assert.match(html, /玻璃厚度 px/)
    assert.match(html, /色散 px/)
    assert.match(html, /backdrop-filter:blur\(/)
  })
})
