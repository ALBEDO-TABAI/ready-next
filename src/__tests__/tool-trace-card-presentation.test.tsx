/**
 * P0-2 (2026-07-02 P0 visibility batch) — ToolTraceCard presentation
 * contract: running state auto-surfaces the last 3 activity rows (with
 * duration labels), completion auto-collapses back to the compact header,
 * manual expand shows the full list.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { ToolTraceCard } from '../renderer/components/agent/chat-panel/task/TaskCard'

type TraceEvent = { id: string; kind: 'call' | 'result'; text: string; timestamp: Date }

function makeEvents(): TraceEvent[] {
  const base = 1_780_000_000_000
  return [
    { id: 'c1', kind: 'call', text: '调用 browser_read_page', timestamp: new Date(base) },
    { id: 'r1', kind: 'result', text: '读取完成', timestamp: new Date(base + 1_240) },
    { id: 'c2', kind: 'call', text: '调用 browser_click', timestamp: new Date(base + 2_000) },
    { id: 'r2', kind: 'result', text: '点击完成', timestamp: new Date(base + 3_500) },
    { id: 'c3', kind: 'call', text: '调用 browser_type', timestamp: new Date(base + 4_000) },
  ]
}

const DOM_GLOBAL_KEYS = ['window', 'document', 'HTMLElement', 'Node', 'Element', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

function withDom(run: (render: (element: ReturnType<typeof createElement>) => HTMLElement) => void): void {
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
  const container = dom.window.document.getElementById('root') as HTMLElement
  let root: Root | null = null
  try {
    run((element) => {
      root = createRoot(container)
      act(() => {
        root?.render(element)
      })
      return container
    })
  } finally {
    if (root) {
      act(() => {
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
}

test('ToolTraceCard: pending+collapsed auto-surfaces the most recent 3 rows with duration labels', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: true,
      expanded: false,
    }))
    const recent = container.querySelectorAll('[data-ready-tool-trace-recent="true"] [data-ready-tool-trace-row]')
    assert.equal(recent.length, 3, 'exactly the last 3 rows are auto-surfaced')
    const texts = Array.from(recent).map((node) => node.textContent || '')
    assert.ok(texts[0].includes('调用 browser_click'))
    assert.ok(texts[1].includes('点击完成'))
    assert.ok(texts[1].includes('1.5s'), `result row carries duration: ${texts[1]}`)
    assert.ok(texts[2].includes('调用 browser_type'))
  })
})

test('ToolTraceCard: completed run auto-collapses (no recent rows, preview back in header)', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: false,
      expanded: false,
    }))
    assert.equal(container.querySelectorAll('[data-ready-tool-trace-recent="true"]').length, 0)
    assert.equal(container.querySelectorAll('[data-ready-tool-trace-row]').length, 0)
    assert.ok(String(container.textContent || '').includes('工具调用'))
  })
})

test('ToolTraceCard: manual expand shows the full row list with durations', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: false,
      expanded: true,
    }))
    const rows = container.querySelectorAll('[data-ready-tool-trace-row]')
    assert.equal(rows.length, 5, 'expanded shows every event row')
    const durations = container.querySelectorAll('[data-ready-tool-trace-duration="true"]')
    assert.equal(durations.length, 2, 'both paired results carry duration labels')
  })
})
