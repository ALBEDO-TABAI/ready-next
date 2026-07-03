/**
 * D5 — RunFeedbackStars 行为测试（JSDOM，模式同 run-quality-panel.test.tsx）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { RunFeedbackStars } from '../renderer/components/agent/chat-panel/task/RunFeedbackStars'

const DOM_GLOBAL_KEYS = ['window', 'document', 'HTMLElement', 'Node', 'Element', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const

function setGlobal(key: string, value: unknown): void {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

async function withDom(
  runFeedbackApi: unknown,
  fn: (root: Root, container: HTMLElement) => Promise<void>,
): Promise<void> {
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
  ;(dom.window as unknown as Record<string, unknown>).electronAPI = runFeedbackApi === undefined
    ? {}
    : { runFeedback: runFeedbackApi }

  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  try {
    await fn(root, container)
  } finally {
    await act(async () => root.unmount())
    for (const key of DOM_GLOBAL_KEYS) setGlobal(key, previous[key])
  }
}

test('hydrates the existing rating for the task from list()', async () => {
  await withDom(
    {
      list: async () => ({ success: true, data: [{ feedbackId: 'fb_run-1', runId: 'run-1', taskId: 'task-1', rating: 4, signal: null, comment: null, createdAt: 1, updatedAt: 2 }] }),
      submit: async () => { throw new Error('unused') },
    },
    async (root, container) => {
      await act(async () => {
        root.render(createElement(RunFeedbackStars, { taskId: 'task-1' }))
      })
      const host = container.querySelector('[data-ready-run-feedback]')
      assert.ok(host, 'feedback row renders')
      assert.equal(host?.getAttribute('data-ready-run-feedback-rating'), '4')
      assert.match(host?.textContent || '', /已评分/)
    },
  )
})

test('clicking a star submits taskId + rating and locks in the value', async () => {
  const submitted: unknown[] = []
  await withDom(
    {
      list: async () => ({ success: true, data: [] }),
      submit: async (payload: unknown) => {
        submitted.push(payload)
        return { success: true, data: { feedbackId: 'fb_run-9', runId: 'run-9', taskId: 'task-9', rating: 3, signal: null, comment: null, createdAt: 1, updatedAt: 1 } }
      },
    },
    async (root, container) => {
      await act(async () => {
        root.render(createElement(RunFeedbackStars, { taskId: 'task-9' }))
      })
      const host = container.querySelector('[data-ready-run-feedback]')
      assert.match(host?.textContent || '', /评价本次运行/)
      const star3 = container.querySelector('[data-ready-run-feedback-star="3"]') as HTMLButtonElement
      await act(async () => {
        star3.click()
      })
      assert.deepEqual(submitted, [{ taskId: 'task-9', rating: 3 }])
      assert.equal(host?.getAttribute('data-ready-run-feedback-rating'), '3')
      assert.match(host?.textContent || '', /已评分/)
    },
  )
})

test('failed submit surfaces a retryable error label instead of a silent drop', async () => {
  await withDom(
    {
      list: async () => ({ success: true, data: [] }),
      submit: async () => ({ success: false, error: 'run_not_found' }),
    },
    async (root, container) => {
      await act(async () => {
        root.render(createElement(RunFeedbackStars, { taskId: 'task-x' }))
      })
      const star5 = container.querySelector('[data-ready-run-feedback-star="5"]') as HTMLButtonElement
      await act(async () => {
        star5.click()
      })
      const host = container.querySelector('[data-ready-run-feedback]')
      assert.match(host?.textContent || '', /评分未保存/)
      assert.equal(host?.getAttribute('data-ready-run-feedback-rating'), null)
    },
  )
})

test('renders nothing when the runFeedback API is absent (fixture stubs, older preload)', async () => {
  await withDom(undefined, async (root, container) => {
    await act(async () => {
      root.render(createElement(RunFeedbackStars, { taskId: 'task-1' }))
    })
    assert.equal(container.querySelector('[data-ready-run-feedback]'), null)
  })
})
