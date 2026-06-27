import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import {
  buildContextUsageMeterModel,
  ContextUsageMeter,
} from '../renderer/components/agent/chat-panel/ContextUsageMeter'

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    Element: (globalThis as { Element?: typeof Element }).Element,
    getComputedStyle: globalThis.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }

  function setGlobal<K extends keyof typeof previous>(key: K, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('Element', dom.window.Element)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  return {
    dom,
    restore: () => {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const previousValue = previous[key]
        if (previousValue === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key as string]
        } else {
          Object.defineProperty(globalThis, key, {
            value: previousValue,
            configurable: true,
            writable: true,
          })
        }
      }
      try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
    },
  }
}

test('context usage meter shows no-data state before the first run', () => {
  const model = buildContextUsageMeterModel(null, false)

  assert.equal(model.tone, 'unknown')
  assert.equal(model.ratio, null)
  assert.match(model.title, /暂无数据/)
})

test('context usage meter reports trusted percentage and token counts', () => {
  const model = buildContextUsageMeterModel({
    usedInputTokens: 239_000,
    windowTokens: 258_000,
    ratio: 239_000 / 258_000,
    windowSource: 'model',
    source: 'last_model_request',
    timestamp: '2026-06-27T00:00:00.000Z',
  }, false)

  assert.equal(model.tone, 'soft')
  assert.match(model.title, /93% 满/)
  assert.match(model.title, /239,000 \/ 258,000 tokens/)
  assert.match(model.ariaLabel, /239k \/ 258k tokens/)
  assert.match(model.title, /上一轮实际请求/)
})

test('context usage meter labels fallback windows as default estimates', () => {
  const model = buildContextUsageMeterModel({
    usedInputTokens: 239_000,
    windowTokens: 258_000,
    ratio: 239_000 / 258_000,
    windowSource: 'fallback',
    source: 'last_model_request',
    timestamp: '2026-06-27T00:00:00.000Z',
  }, true)

  assert.equal(model.tone, 'soft')
  assert.equal(model.ratio, 239_000 / 258_000)
  assert.equal(model.dimmed, true)
  assert.match(model.title, /约 93% · 默认估算/)
  assert.match(model.title, /239,000 \/ 258,000 tokens/)
  assert.doesNotMatch(model.title, /窗口大小未知/)
})

test('context usage meter marks full windows as hard', () => {
  const model = buildContextUsageMeterModel({
    usedInputTokens: 120,
    windowTokens: 100,
    ratio: 1.2,
    windowSource: 'explicit',
    source: 'last_model_request',
    timestamp: '2026-06-27T00:00:00.000Z',
  }, false)

  assert.equal(model.tone, 'hard')
  assert.match(model.title, /120% 满/)
})

test('context usage meter renders exact usage in a hover tooltip', async () => {
  const handle = installDomGlobals()
  let root: Root | null = null
  try {
    const host = globalThis.document.getElementById('root')
    if (!host) throw new Error('jsdom root missing')
    root = createRoot(host)
    await act(async () => {
      root?.render(createElement(ContextUsageMeter, {
        usage: {
          usedInputTokens: 239_000,
          windowTokens: 258_000,
          ratio: 239_000 / 258_000,
          windowSource: 'model',
          source: 'last_model_request',
          timestamp: '2026-06-27T00:00:00.000Z',
        },
        dimmed: false,
      }))
      await Promise.resolve()
    })

    const meter = globalThis.document.querySelector('[data-agent-context-usage-meter="true"]') as HTMLElement | null
    assert.ok(meter)
    Object.defineProperty(meter, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 200,
        top: 120,
        right: 226,
        bottom: 146,
        width: 26,
        height: 26,
        x: 200,
        y: 120,
        toJSON: () => ({}),
      }),
    })

    await act(async () => {
      meter.dispatchEvent(new handle.dom.window.MouseEvent('mouseover', {
        bubbles: true,
        relatedTarget: handle.dom.window.document.body,
      }))
      await Promise.resolve()
    })

    const tooltip = globalThis.document.querySelector('[data-agent-context-usage-tooltip="true"]')
    assert.ok(tooltip)
    assert.equal(tooltip.getAttribute('role'), 'tooltip')
    assert.match(tooltip.textContent || '', /93% 满/)
    assert.match(tooltip.textContent || '', /239,000 \/ 258,000 tokens/)
    assert.match(tooltip.textContent || '', /上一轮实际请求/)

    await act(async () => {
      meter.dispatchEvent(new handle.dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: handle.dom.window.document.body,
      }))
      await Promise.resolve()
    })
    assert.equal(globalThis.document.querySelector('[data-agent-context-usage-tooltip="true"]'), null)
  } finally {
    await act(async () => {
      try { root?.unmount() } catch { /* silent-catch: unmount best-effort */ }
    })
    handle.restore()
  }
})
