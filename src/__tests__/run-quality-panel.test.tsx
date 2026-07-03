/**
 * P0-4 (2026-07-02 P0 visibility batch) — RunQualityPanel renders the key
 * quality numbers from the stats IPC.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { RunQualityPanel } from '../renderer/components/memory/RunQualityPanel'

const STATS = {
  windowDays: 14,
  sampleSize: 10,
  days: [
    { date: '2026-07-01', total: 6, done: 3, proofGap: 2, degraded: 1, unconfirmed: 0 },
    { date: '2026-07-02', total: 4, done: 4, proofGap: 0, degraded: 0, unconfirmed: 0 },
  ],
  divergenceCount: 3,
  firstDelta: { count: 5, p50Ms: 860, avgMs: 1100 },
  streamFallbacks: { non_sse_response: 2 },
}

const DOM_GLOBAL_KEYS = ['window', 'document', 'HTMLElement', 'Node', 'Element', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

test('RunQualityPanel: renders sample size, proof_gap share, latency, and daily rows', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.fromEntries(
    DOM_GLOBAL_KEYS.map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
  )
  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;(dom.window as unknown as Record<string, unknown>).electronAPI = {
    runQuality: {
      stats: async () => ({ success: true, data: STATS }),
    },
  }
  const container = dom.window.document.getElementById('root') as HTMLElement
  let root: Root | null = null
  try {
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(RunQualityPanel))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const text = String(container.textContent || '')
    assert.ok(text.includes('运行质量'), text)
    assert.ok(text.includes('10'), 'sample size rendered')
    assert.ok(text.includes('20%'), `overall proof_gap share (2/10) rendered: ${text}`)
    assert.ok(text.includes('860ms'), 'first-token p50 rendered')
    assert.ok(container.querySelectorAll('[data-run-quality-days="true"] .t-meta, [data-run-quality-days="true"] [data-typography-role="meta"]').length >= 2, 'daily rows rendered')
    assert.ok(text.includes('non_sse_response×2'), 'fallback detail rendered')
  } finally {
    if (root) {
      await act(async () => {
        (root as Root).unmount()
      })
    }
    for (const key of DOM_GLOBAL_KEYS) {
      const value = previous[key]
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
      else setGlobal(key, value)
    }
    try { dom.window.close() } catch { /* best-effort */ }
  }
})
