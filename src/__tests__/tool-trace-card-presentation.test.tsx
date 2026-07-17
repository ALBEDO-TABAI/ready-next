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
    { id: 'c1', kind: 'call', text: '调用 browser_read', timestamp: new Date(base) },
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

// 2026-07-10 activity-capsule — 展示单元从裸 call/result 行升级为「配对条目」：
// 5 个事件（c1+r1 / c2+r2 / c3 未回）派生 3 个时间线条目。

test('ToolTraceCard: pending+collapsed auto-surfaces the most recent timeline items with duration labels', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: true,
      expanded: false,
    }))
    const recent = container.querySelectorAll('[data-ready-tool-trace-recent="true"] [data-ready-tool-timeline-item]')
    assert.equal(recent.length, 3, 'the last 3 timeline items are auto-surfaced')
    const texts = Array.from(recent).map((node) => node.textContent || '')
    assert.ok(texts[0].includes('读取完成'), `done item shows result preview: ${texts[0]}`)
    assert.ok(texts[1].includes('点击完成'))
    assert.ok(texts[1].includes('1.5s'), `paired item carries duration: ${texts[1]}`)
    assert.ok(texts[2].includes('调用 browser_type'), `running item shows call text: ${texts[2]}`)
  })
})

test('ToolTraceCard: completed run auto-collapses to a single line (count + latest preview in header)', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: false,
      expanded: false,
    }))
    assert.equal(container.querySelectorAll('[data-ready-tool-trace-recent="true"]').length, 0)
    assert.equal(container.querySelectorAll('[data-ready-tool-timeline-item]').length, 0)
    const text = String(container.textContent || '')
    assert.ok(text.includes('3 个工具'), `collapsed header carries the tool count: ${text}`)
    assert.ok(text.includes('调用 browser_type'), 'collapsed header falls back to the latest event preview')
  })
})

test('ToolTraceCard: collapsed row is borderless and aligns with the message edge', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: false,
      expanded: false,
    }))
    const card = container.querySelector('[data-ready-tool-trace-card="true"]') as HTMLElement | null
    const header = card?.querySelector('button') as HTMLButtonElement | null
    assert.equal(card?.style.borderWidth, '0px')
    assert.equal(header?.style.paddingLeft, '0px')
  })
})

test('ToolTraceCard: manual expand shows the paired timeline with durations', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: false,
      expanded: true,
    }))
    const items = container.querySelectorAll('[data-ready-tool-timeline] [data-ready-tool-timeline-item]')
    assert.equal(items.length, 3, 'expanded shows every paired timeline item')
    const durations = container.querySelectorAll('[data-ready-tool-trace-duration="true"]')
    assert.equal(durations.length, 2, 'both paired results carry duration labels')
  })
})

test('ToolTraceCard: clicking a timeline item discloses the call and output detail (L3)', () => {
  withDom((render) => {
    const container = render(createElement(ToolTraceCard, {
      events: makeEvents(),
      pending: false,
      expanded: true,
    }))
    assert.equal(container.querySelectorAll('[data-ready-tool-timeline-detail="true"]').length, 0)
    const firstItemButton = container.querySelector(
      '[data-ready-tool-timeline] [data-ready-tool-timeline-item] button',
    ) as HTMLButtonElement | null
    assert.ok(firstItemButton, 'timeline item row is clickable')
    act(() => {
      firstItemButton.click()
    })
    const detail = container.querySelector('[data-ready-tool-timeline-detail="true"]')
    assert.ok(detail, 'clicking the row opens the detail block')
    const detailText = detail?.textContent || ''
    assert.ok(detailText.includes('调用 browser_read'), `detail keeps the full call line: ${detailText}`)
    assert.ok(detailText.includes('读取完成'), `detail keeps the full output text: ${detailText}`)
  })
})

test('ToolTraceCard: rich events surface toolName, args JSON, and full output in the L3 block', () => {
  withDom((render) => {
    const base = 1_780_000_000_000
    const container = render(createElement(ToolTraceCard, {
      events: [
        {
          id: 'c1',
          kind: 'call' as const,
          text: 'skill_read_artifact(relativePath)',
          timestamp: new Date(base),
          toolName: 'skill_read_artifact',
          detail: '{\n  "relativePath": "参考/mapping.md"\n}',
        },
        {
          id: 'r1',
          kind: 'result' as const,
          text: 'skill_read_artifact: 已读取',
          timestamp: new Date(base + 800),
          toolName: 'skill_read_artifact',
          detail: '# mapping\n第一节 完整正文……',
        },
      ],
      pending: false,
      expanded: true,
    }))
    const itemButton = container.querySelector(
      '[data-ready-tool-timeline] [data-ready-tool-timeline-item] button',
    ) as HTMLButtonElement | null
    assert.ok(itemButton)
    act(() => {
      itemButton.click()
    })
    const detail = container.querySelector('[data-ready-tool-timeline-detail="true"]')
    assert.ok(detail)
    const text = detail?.textContent || ''
    assert.ok(
      (detail?.querySelector('[data-ready-tool-timeline-tool-name="true"]')?.textContent || '').includes('skill_read_artifact'),
      'tool name headline present',
    )
    assert.ok(text.includes('"relativePath": "参考/mapping.md"'), `args JSON shown: ${text}`)
    assert.ok(text.includes('第一节 完整正文……'), `full output shown instead of the 240-char preview: ${text}`)
  })
})
