import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { TaskCardRun } from '../renderer/components/agent/task-card-from-projection'

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
  }

  function setGlobal(key: keyof typeof previous, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)

  return {
    dom,
    restore: () => {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const value = previous[key]
        if (value === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
        }
      }
      try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
    },
  }
}

const domHandle = installDomGlobals()
process.on('exit', () => {
  try { domHandle.restore() } catch { /* silent-catch: best-effort restore */ }
})

const { TaskCard } = await import('../renderer/components/agent/chat-panel/task/TaskCard')
const { taskProjectionToTaskCardRun } = await import('../renderer/components/agent/task-card-from-projection')

function makeRun(overrides: Partial<Omit<TaskCardRun, '__brand'>> = {}): TaskCardRun {
  const base: Omit<TaskCardRun, '__brand'> = {
    scopeId: 'conv-a',
    taskId: 'task-a',
    phase: 'checkpoint',
    title: '后台任务',
    taskSummary: '后台任务等待继续',
    waitingFor: 'background',
    resumableActions: ['continue', 'cancel'],
    canResume: true,
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  }
  return taskProjectionToTaskCardRun(base)
}

function mountTaskCard(
  run: TaskCardRun,
  props: Record<string, unknown>,
): { container: HTMLElement; root: Root; unmount: () => void } {
  const host = document.getElementById('root')
  if (!host) throw new Error('missing root')
  host.innerHTML = ''
  const container = document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(createElement(TaskCard, {
      run,
      sessionId: 'conv-a',
      expanded: true,
      ...props,
    }))
  })
  return {
    container,
    root,
    unmount: () => {
      try { root.unmount() } catch { /* silent-catch: unmount best effort */ }
      try { host.removeChild(container) } catch { /* silent-catch: detach best effort */ }
    },
  }
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === label)
  assert.ok(button, `button ${label} is rendered`)
  button.dispatchEvent(new domHandle.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

test('task card child-run buttons invoke continue and cancel handlers', () => {
  const calls: Array<[string, string, string]> = []
  const run = makeRun({
    taskId: 'skill-child:child-a',
    title: '技能子任务 · video-expert-analyzer',
    blockedReason: '/tmp/audiovisual_handoff/body/task.md',
    taskContinuation: {
      childRunId: 'child-a',
      taskId: 'skill-child:child-a',
      pauseReason: 'background_running',
      blockerType: 'background_running',
    },
  })
  const { container, unmount } = mountTaskCard(run, {
    onContinueChildRun: (scopeId: string, childRunId: string) => calls.push(['continue', scopeId, childRunId]),
    onCancelChildRun: (scopeId: string, childRunId: string) => calls.push(['cancel', scopeId, childRunId]),
  })
  try {
    const card = container.querySelector('[data-ready-task-card="true"]')
    assert.equal(card?.getAttribute('data-ready-task-scope-id'), 'conv-a')
    assert.equal(card?.getAttribute('data-ready-task-id'), 'skill-child:child-a')
    assert.equal(card?.getAttribute('data-ready-task-child-run-id'), 'child-a')
    const continueButton = container.querySelector('[data-ready-task-action="continue-child-run"]')
    assert.equal(continueButton?.getAttribute('data-ready-task-scope-id'), 'conv-a')
    assert.equal(continueButton?.getAttribute('data-ready-task-id'), 'skill-child:child-a')
    assert.equal(continueButton?.getAttribute('data-ready-task-child-run-id'), 'child-a')
    clickButton(container, '继续生成报告')
    clickButton(container, '取消')
    assert.deepEqual(calls, [
      ['continue', 'conv-a', 'child-a'],
      ['cancel', 'conv-a', 'child-a'],
    ])
  } finally {
    unmount()
  }
})

test('task card collapse row is borderless and aligns with the message edge', () => {
  const { container, unmount } = mountTaskCard(makeRun(), { expanded: false })
  try {
    const card = container.querySelector('[data-ready-task-card="true"]') as HTMLElement | null
    const header = card?.querySelector('button') as HTMLButtonElement | null
    assert.equal(card?.style.borderWidth, '0px')
    assert.equal(header?.style.paddingLeft, '0px')
  } finally {
    unmount()
  }
})

test('task card suspended and cross-scope buttons invoke resume and open handlers', () => {
  const calls: Array<[string, string]> = []
  const suspendedRun = makeRun({
    scopeId: 'conv-b',
    taskId: 'task-b',
    interactionState: 'suspended',
    resumableActions: [],
  })
  const suspended = mountTaskCard(suspendedRun, {
    onResumeRun: (scopeId: string) => calls.push(['resume', scopeId]),
  })
  try {
    clickButton(suspended.container, '继续运行')
  } finally {
    suspended.unmount()
  }

  const remoteScopeRun = makeRun({
    scopeId: 'conv-c',
    taskId: 'task-c',
    waitingFor: 'none',
    resumableActions: [],
    canResume: false,
  })
  const crossScope = mountTaskCard(remoteScopeRun, {
    compact: true,
    onOpenScope: (scopeId: string) => calls.push(['open', scopeId]),
  })
  try {
    clickButton(crossScope.container, '打开会话')
  } finally {
    crossScope.unmount()
  }

  assert.deepEqual(calls, [
    ['resume', 'conv-b'],
    ['open', 'conv-c'],
  ])
})

test('task card browser collection button invokes browser resume handler instead of generic resume', () => {
  const calls: Array<[string, string, string]> = []
  const run = makeRun({
    scopeId: 'conv-browser',
    taskId: 'browser-task-visible-1',
    module: 'browser',
    interactionState: 'suspended',
    waitingFor: 'none',
    resumableActions: ['continue', 'cancel'],
    canResume: true,
    taskContinuation: {
      taskId: 'browser-task-visible-1',
      detachedTaskId: 'browser-task-card-loop-1',
      resumeKind: 'paused',
      action: 'browser_resume_task',
    },
  })
  const { container, unmount } = mountTaskCard(run, {
    onResumeBrowserTask: (scopeId: string, taskId: string) => calls.push(['browser', scopeId, taskId]),
    onResumeRun: (scopeId: string) => calls.push(['generic', scopeId, '']),
  })
  try {
    const generic = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '继续运行')
    assert.equal(generic, undefined)
    const button = container.querySelector('[data-ready-task-action="resume-browser-task"]')
    assert.equal(button?.getAttribute('data-ready-task-id'), 'browser-task-card-loop-1')
    clickButton(container, '继续浏览器采集')
    assert.deepEqual(calls, [['browser', 'conv-browser', 'browser-task-card-loop-1']])
  } finally {
    unmount()
  }
})

test('task card pending browser collection consent invokes consent handler and hides generic confirmation', () => {
  const calls: Array<[string, string, string]> = []
  const run = makeRun({
    scopeId: 'conv-browser',
    taskId: 'browser-task-visible-consent',
    module: 'browser',
    interactionState: 'awaiting_confirmation',
    waitingFor: 'confirmation',
    resumableActions: [],
    canResume: false,
    progress: {
      stage: 'pending_consent',
      completed: 12,
      total: 31,
      coverage: 12 / 31,
      fingerprint: 'browser-consent-test-1',
      updatedAt: '2026-06-06T00:00:00.000Z',
      lastError: null,
      browserCollectionConsent: {
        requestId: 'browser-consent-test-1',
        consentKind: 'partial_collection',
        sourceTaskId: 'browser-task-visible-consent',
        message: '需要确认部分采集',
        createdAt: '2026-06-06T00:00:00.000Z',
      },
    },
  })
  const { container, unmount } = mountTaskCard(run, {
    onConfirmBrowserCollectionConsent: (scopeId: string, requestId: string) => calls.push(['consent', scopeId, requestId]),
    onSubmitConfirmation: (scopeId: string, confirmed: boolean) => calls.push(['generic', scopeId, String(confirmed)]),
  })
  try {
    const generic = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '确认继续')
    assert.equal(generic, undefined)
    const button = container.querySelector('[data-ready-task-action="confirm-browser-collection-consent"]')
    assert.equal(button?.getAttribute('data-ready-task-scope-id'), 'conv-browser')
    assert.equal(button?.getAttribute('data-ready-task-id'), 'browser-task-visible-consent')
    assert.equal(button?.getAttribute('data-ready-task-consent-kind'), 'partial_collection')
    assert.equal(button?.getAttribute('data-ready-task-consent-request-id'), 'browser-consent-test-1')
    clickButton(container, '确认部分采集')
    assert.deepEqual(calls, [['consent', 'conv-browser', 'browser-consent-test-1']])
  } finally {
    unmount()
  }
})
