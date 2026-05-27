import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import FastCardOverlayWindow from '../renderer/pages/FastCardOverlayWindow'
import type { FastCardOverlaySnapshot } from '../shared/fastcard'

type TestGlobal = typeof globalThis & Record<string, unknown>

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/browser-fastcard-overlay',
    pretendToBeVisual: true,
  })
  const testGlobal = globalThis as TestGlobal
  const previous = {
    window: testGlobal.window,
    document: testGlobal.document,
    navigator: testGlobal.navigator,
    IS_REACT_ACT_ENVIRONMENT: testGlobal.IS_REACT_ACT_ENVIRONMENT,
  }

  testGlobal.window = dom.window
  testGlobal.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  })
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true

  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (key === 'navigator') {
          Object.defineProperty(globalThis, key, {
            value,
            configurable: true,
          })
        } else if (value === undefined) {
          Reflect.deleteProperty(testGlobal, key)
        } else {
          testGlobal[key] = value
        }
      }
      dom.window.close()
    },
  }
}

function makeSnapshot(text: string): FastCardOverlaySnapshot {
  return {
    mode: 'fastcard',
    items: [{
      id: 'item-1',
      kind: 'text',
      createdAt: 1,
      text,
      source: {
        pageUrl: 'https://example.com/',
        pageTitle: 'Example',
        domain: 'example.com',
      },
    }],
    resultPanel: null,
    bounds: { left: 0, top: 0, width: 384, height: 480 },
  }
}

test('FastCard overlay window pulls the current snapshot when the push event was missed', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let snapshotHandler: ((snapshot: FastCardOverlaySnapshot) => void) | null = null
    let hideCalls = 0
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        browser: {
          getFastCardOverlaySnapshot: async () => ({ success: true, data: makeSnapshot('Recovered copy') }),
          hideFastCardOverlay: async () => {
            hideCalls += 1
            return { success: true }
          },
          onFastCardOverlaySnapshot: (callback: (snapshot: FastCardOverlaySnapshot) => void) => {
            snapshotHandler = callback
            return () => {
              snapshotHandler = null
            }
          },
        },
      },
    })

    root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
    await act(async () => {
      root?.render(createElement(FastCardOverlayWindow))
    })
    await act(async () => {
      await Promise.resolve()
    })

    assert.match(handle.dom.window.document.body.textContent || '', /Recovered copy/)
    assert.equal(hideCalls, 0)

    await act(async () => {
      snapshotHandler?.(makeSnapshot('Pushed update'))
    })
    assert.match(handle.dom.window.document.body.textContent || '', /Pushed update/)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})

test('FastCard overlay window hides itself instead of staying as an empty shell without a snapshot', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let hideCalls = 0
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        browser: {
          getFastCardOverlaySnapshot: async () => ({ success: true, data: null }),
          hideFastCardOverlay: async () => {
            hideCalls += 1
            return { success: true }
          },
          onFastCardOverlaySnapshot: () => () => undefined,
        },
      },
    })

    root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
    await act(async () => {
      root?.render(createElement(FastCardOverlayWindow))
    })
    await act(async () => {
      await Promise.resolve()
    })

    assert.equal(hideCalls, 1)
    assert.doesNotMatch(handle.dom.window.document.body.textContent || '', /FastCard/)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})
