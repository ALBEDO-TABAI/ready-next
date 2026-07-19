import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { buildSmartTypeProbeJs } from '../main/modules/tools/browser-input-actions'
import { locateActionTargets } from '../main/modules/tools/browser-tool-shared'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'

type Rect = { left: number; top: number; width: number; height: number }

function setRect(element: Element, rect: Rect): void {
  ;(element as HTMLElement).getBoundingClientRect = () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  })
}

function evaluate(dom: JSDOM, code: string): unknown {
  if (!dom.window.CSS) {
    Object.defineProperty(dom.window, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') },
    })
  }
  return dom.window.Function('code', 'with (this) { return eval(code) }').call(dom.window, code)
}

function controllerFor(dom: JSDOM): BrowserController {
  return {
    executeJS: async (_tabId: string | null, code: string) => evaluate(dom, code),
    findUploadTargets: async () => [],
    getActiveTab: () => ({ id: 'tab-language', title: 'Form', url: 'https://example.test/form', active: true }) as never,
    getTabList: () => [{ id: 'tab-language', title: 'Form', url: 'https://example.test/form', active: true }] as never,
    getPhysicalTargetToken: () => 'physical-language',
    beginBrowserWorkflowAction: (input: Record<string, unknown>) => ({
      actionId: 'action-language',
      actionSeq: 1,
      identity: input.identity,
    }),
    settleBrowserWorkflowAction: (_taskId: string, actionId: string, outcome: Record<string, unknown>) => ({
      receiptId: 'receipt-language',
      actionId,
      actionSeq: 1,
      outcome,
    }),
    recordBrowserWorkflowObservation: () => ({ receiptId: 'observation-language' }),
  } as unknown as BrowserController
}

test('action candidates use focused-form geometry and preserve non-English accessible names for icon buttons', async () => {
  const dom = new JSDOM(`
    <form id="composer">
      <textarea id="draft" aria-label="消息本文"></textarea>
      <button id="icon-action" type="button" aria-label="送信する"><svg><path /></svg></button>
      <button id="secondary-action" type="button">下書きに保存</button>
    </form>
    <nav><button id="unrelated" type="button">send</button></nav>
  `, { url: 'https://example.test/editor' })
  try {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 1000 })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 800 })
    const draft = dom.window.document.querySelector('#draft') as HTMLTextAreaElement
    const icon = dom.window.document.querySelector('#icon-action') as HTMLButtonElement
    const secondary = dom.window.document.querySelector('#secondary-action') as HTMLButtonElement
    const unrelated = dom.window.document.querySelector('#unrelated') as HTMLButtonElement
    setRect(draft, { left: 120, top: 520, width: 520, height: 72 })
    setRect(icon, { left: 660, top: 532, width: 44, height: 44 })
    setRect(secondary, { left: 520, top: 620, width: 120, height: 40 })
    setRect(unrelated, { left: 20, top: 40, width: 80, height: 36 })
    draft.focus()

    const targets = await locateActionTargets(controllerFor(dom), 'tab-1', 'send')

    assert.deepEqual(targets.map((target) => target.label), ['下書きに保存', '送信する'])
    assert.equal(targets[0]?.sameFormAsActiveInput, true)
    assert.equal(targets[0]?.nearActiveInput, true)
    assert.ok(targets[0]?.evidence.includes('accessible_label_available'))
    assert.equal(targets.some((target) => target.label === 'send'), false, 'a distant English action word must not override form geometry')
  } finally {
    dom.window.close()
  }
})

test('input discovery returns every editable candidate and ranks focus without language-specific label boosts', async () => {
  const dom = new JSDOM(`
    <input id="recipient" aria-label="Empfänger" />
    <input id="destination" aria-label="Destinazione" />
  `, { url: 'https://example.test/form' })
  try {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 700 })
    const recipient = dom.window.document.querySelector('#recipient') as HTMLInputElement
    const destination = dom.window.document.querySelector('#destination') as HTMLInputElement
    setRect(recipient, { left: 80, top: 180, width: 320, height: 42 })
    setRect(destination, { left: 80, top: 260, width: 320, height: 42 })
    destination.focus()

    const targets = await locateActionTargets(controllerFor(dom), 'tab-1', 'input')

    assert.deepEqual(targets.map((target) => target.label), [
      'Destinazione destination',
      'Empfänger recipient',
    ])
    assert.equal(targets[0]?.focused, true)
    assert.ok(targets.every((target) => target.kind === 'input'))
    assert.ok(targets.every((target) => !target.evidence.includes('keyword_match')))
  } finally {
    dom.window.close()
  }
})

test('smart type returns candidate details through the public tool instead of guessing among unmatched inputs', async () => {
  const dom = new JSDOM(`
    <input id="recipient" aria-label="Empfänger" />
    <input id="destination" aria-label="Destinazione" />
  `, { url: 'https://example.test/form' })
  try {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 700 })
    for (const [index, element] of Array.from(dom.window.document.querySelectorAll('input')).entries()) {
      setRect(element, { left: 80, top: 180 + index * 80, width: 320, height: 42 })
    }

    const output = await executeBrowserTool(
      'browser_type',
      {
        target: 'input',
        text: 'Oslo',
        clear_first: true,
        submit: false,
      },
      controllerFor(dom),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        ownerRunId: 'run-language-test',
        browserTaskId: 'browser-task-language-test',
        parentTaskId: 'parent-language-test',
        inputSource: 'trusted_internal',
      },
    )
    const result = (typeof output === 'string'
      ? JSON.parse(output)
      : output.data) as {
      ok: boolean
      errorKind: string
      candidates: Array<{ label: string; target: string }>
    }
    assert.equal(result.ok, false)
    assert.equal(result.errorKind, 'ambiguous_input_target')
    assert.deepEqual(result.candidates.map((candidate) => candidate.target).sort(), ['destination', 'recipient'])
  } finally {
    dom.window.close()
  }
})

test('smart type resolves an explicit non-English accessible name without a fixed vocabulary', () => {
  const dom = new JSDOM(`
    <input id="recipient" aria-label="Empfänger" />
    <input id="destination" aria-label="Destinazione" />
  `, { url: 'https://example.test/form' })
  try {
    Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 900 })
    Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 700 })
    for (const [index, element] of Array.from(dom.window.document.querySelectorAll('input')).entries()) {
      setRect(element, { left: 80, top: 180 + index * 80, width: 320, height: 42 })
    }

    const result = evaluate(dom, buildSmartTypeProbeJs({
      target: 'Destinazione',
      text: 'Roma',
      clearFirst: true,
      submit: false,
    })) as { ok?: boolean; target?: string }
    assert.equal(result.ok, true)
    assert.equal(result.target, 'destination')
  } finally {
    dom.window.close()
  }
})
