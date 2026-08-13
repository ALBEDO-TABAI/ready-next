import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { TaskCardRun } from '../renderer/components/agent/task-card-from-projection'

const GLASS_OVERRIDES_CSS = readFileSync(
  new URL('../renderer/styles/glass-overrides.css', import.meta.url),
  'utf8',
)

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
const { TaskToolSnapshot } = await import('../renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot')
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

test('task card child-run exposes exact cancel without a retired continuation action', () => {
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
    onCancelChildRun: (scopeId: string, childRunId: string) => calls.push(['cancel', scopeId, childRunId]),
  })
  try {
    const card = container.querySelector('[data-ready-task-card="true"]')
    assert.equal(card?.getAttribute('data-ready-task-scope-id'), 'conv-a')
    assert.equal(card?.getAttribute('data-ready-task-id'), 'skill-child:child-a')
    assert.equal(card?.getAttribute('data-ready-task-child-run-id'), 'child-a')
    assert.equal(container.querySelector('[data-ready-task-action="continue-child-run"]'), null)
    assert.equal(container.textContent?.includes('继续生成报告'), false)
    clickButton(container, '取消')
    assert.deepEqual(calls, [['cancel', 'conv-a', 'child-a']])
  } finally {
    unmount()
  }
})

test('task card stays frameless while its interactive header shares the task content column', () => {
  document.documentElement.dataset.skin = 'liquid-glass'
  document.documentElement.dataset.glassVariant = 'solid-green'
  const style = document.createElement('style')
  style.textContent = GLASS_OVERRIDES_CSS
  document.head.append(style)
  const { container, unmount } = mountTaskCard(makeRun(), { expanded: false })
  try {
    const card = container.querySelector('[data-ready-task-card="true"]') as HTMLElement | null
    const header = card?.querySelector('button') as HTMLButtonElement | null
    assert.equal(card?.style.borderWidth, '0px')
    assert.equal(card?.style.background, 'transparent')
    assert.equal(card ? window.getComputedStyle(card).backgroundColor : null, 'rgba(0, 0, 0, 0)')
    assert.equal(header?.style.paddingLeft, '0px')
  } finally {
    unmount()
    style.remove()
    delete document.documentElement.dataset.skin
    delete document.documentElement.dataset.glassVariant
  }
})

test('collapsed fixed collection card keeps its save destination directly openable', () => {
  const opened: string[] = []
  const run = makeRun({
    module: 'browser',
    status: 'completed',
    phase: 'done',
    waitingFor: 'none',
    resumableActions: ['none'],
    canResume: false,
    recentArtifacts: [{
      id: 'collection-output',
      module: 'browser',
      kind: 'collection_output',
      label: '采集结果文件夹',
      path: '/tmp/Ready采集/profile',
      createdAt: '2026-07-15T00:00:00.000Z',
    }],
  })
  const { container, unmount } = mountTaskCard(run, {
    compact: true,
    expanded: false,
    onOpenArtifact: (path: string) => opened.push(path),
  })
  try {
    const button = container.querySelector('[data-ready-task-primary-artifact="true"]') as HTMLButtonElement | null
    assert.equal(button?.textContent?.trim(), '打开采集结果')
    assert.equal(button?.title, '/tmp/Ready采集/profile')
    button?.click()
    assert.deepEqual(opened, ['/tmp/Ready采集/profile'])
  } finally {
    unmount()
  }
})

test('task card keeps suspended history read-only while cross-scope open remains live', () => {
  const calls: Array<[string, string]> = []
  const suspendedRun = makeRun({
    scopeId: 'conv-b',
    taskId: 'task-b',
    interactionState: 'suspended',
    resumableActions: [],
  })
  const suspended = mountTaskCard(suspendedRun, {})
  try {
    assert.equal(suspended.container.textContent?.includes('继续运行'), false)
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

  assert.deepEqual(calls, [['open', 'conv-c']])
})

test('browser task history exposes no generic or collection resume controls', () => {
  const run = makeRun({
    scopeId: 'conv-browser',
    taskId: 'browser-task-visible-1',
    module: 'browser',
    phase: 'tool_running',
    status: 'running',
    interactionState: 'suspended',
    waitingFor: 'background',
    resumableActions: ['continue', 'cancel'],
    canResume: true,
    taskContinuation: {
      taskId: 'browser-task-visible-1',
      detachedTaskId: 'browser-task-card-loop-1',
      resumeKind: 'paused',
      action: 'browser_task',
    },
  })
  const { container, unmount } = mountTaskCard(run, {})
  try {
    const generic = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '继续运行')
    assert.equal(generic, undefined)
    assert.equal(container.querySelector('[data-ready-task-action="resume-browser-task"]'), null)
    assert.equal(container.querySelector('[data-ready-task-action="cancel-browser-task"]'), null)
  } finally {
    unmount()
  }
})

test('dismiss button clears only the task card presentation', () => {
  let dismissed = 0
  const { container, unmount } = mountTaskCard(makeRun(), {
    dismissible: true,
    onDismiss: () => { dismissed += 1 },
  })
  try {
    const dismiss = container.querySelector('[data-ready-task-dismiss="true"]') as HTMLButtonElement | null
    const card = container.querySelector('[data-ready-task-card="true"]') as HTMLElement | null
    const header = card?.querySelector(':scope > button') as HTMLButtonElement | null
    assert.ok(dismiss)
    assert.ok(card)
    assert.ok(header)
    assert.equal(dismiss.title, '清除任务卡（不会停止任务）')
    assert.ok(card.classList.contains('w-full'))
    assert.ok(card.classList.contains('max-w-full'))
    assert.ok(card.classList.contains('min-w-0'))
    assert.ok(header.classList.contains('box-border'))
    dismiss.dispatchEvent(new domHandle.dom.window.MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 10,
    }))
    dismiss.dispatchEvent(new domHandle.dom.window.MouseEvent('pointermove', {
      bubbles: true,
      button: 0,
      clientX: 100,
    }))
    dismiss.dispatchEvent(new domHandle.dom.window.MouseEvent('pointerup', {
      bubbles: true,
      button: 0,
      clientX: 100,
    }))
    assert.equal(dismissed, 0, 'dismiss pointer must not start the card swipe gesture')
    dismiss.click()
    assert.equal(dismissed, 1)
  } finally {
    unmount()
  }
})

test('right swipe dismisses a fixed task card without invoking task controls', () => {
  let dismissed = 0
  let cancelled = 0
  const { container, unmount } = mountTaskCard(makeRun(), {
    dismissible: true,
    onDismiss: () => { dismissed += 1 },
    onCancelDetachedTask: () => { cancelled += 1 },
  })
  try {
    const card = container.querySelector('[data-ready-task-card="true"]') as HTMLElement | null
    assert.ok(card)
    card.dispatchEvent(new domHandle.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10 }))
    card.dispatchEvent(new domHandle.dom.window.MouseEvent('pointermove', { bubbles: true, button: 0, clientX: 100 }))
    card.dispatchEvent(new domHandle.dom.window.MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 100 }))
    assert.equal(dismissed, 1)
    assert.equal(cancelled, 0)
  } finally {
    unmount()
  }
})

test('cleared fixed task cards stay cleared after the task area remounts', () => {
  domHandle.dom.window.localStorage.clear()
  const run = makeRun({
    taskId: 'browser-task-persisted-dismiss',
    module: 'browser',
    phase: 'done',
    status: 'completed',
    interactionState: 'suspended',
    waitingFor: 'none',
    resumableActions: ['none'],
    canResume: false,
    recentArtifacts: [{
      id: 'collection-output',
      module: 'browser',
      kind: 'collection_output',
      label: '采集结果文件夹',
      path: '/tmp/Ready采集/profile',
      createdAt: '2026-07-15T00:00:00.000Z',
    }],
  })
  const host = document.getElementById('root')
  assert.ok(host)

  const mountSnapshot = (): Root => {
    host.innerHTML = ''
    const root = createRoot(host)
    const noop = () => {}
    flushSync(() => {
      root.render(createElement(TaskToolSnapshot, {
        messages: [],
        currentTaskRun: null,
        backgroundTaskRuns: [run],
        liveTaskRuns: [run],
        currentScopeId: 'conv-a',
        taskDisclosureState: {},
        isStreaming: false,
        streamingMessageId: null,
        parseSerializedTaskSnapshot: () => null,
        parseSerializedToolTraceSnapshot: () => [],
        setTaskSectionExpanded: noop,
        onOpenTaskArtifact: noop,
        onDismissMemoryCapture: noop,
        onUndoMemoryCapture: noop,
        onSupplementMemoryCapture: noop,
        onOpenScope: noop,
        onCancelDetachedTask: noop,
        onCancelChildRun: noop,
      }, ({ bottomTaskCard }) => createElement('div', null, bottomTaskCard)))
    })
    return root
  }

  let root = mountSnapshot()
  try {
    const dismiss = host.querySelector('[data-ready-task-dismiss="true"]') as HTMLButtonElement | null
    assert.ok(dismiss)
    flushSync(() => dismiss.click())
    assert.equal(host.querySelector('[data-ready-task-card="true"]'), null)
    root.unmount()

    root = mountSnapshot()
    assert.equal(host.querySelector('[data-ready-task-card="true"]'), null)
  } finally {
    try { root.unmount() } catch { /* silent-catch: unmount best effort */ }
    domHandle.dom.window.localStorage.clear()
  }
})

test('historical browser confirmation stays visible but has no responder actions', () => {
  const confirmationCalls: Array<[string, boolean, string | undefined]> = []
  const run = makeRun({
    scopeId: 'conv-confirmation',
    taskId: 'task-confirmation',
    title: '',
    taskSummary: null,
    waitingFor: 'confirmation',
    interactionState: 'awaiting_confirmation',
    taskContinuation: {
      kind: 'browser_checkpoint',
      checkpointId: 'checkpoint-confirmation',
      browserTaskId: 'browser-task-confirmation',
      suspensionRequest: {
        version: 1,
        kind: 'browser_power_confirmation',
        requestId: 'confirmation-1',
        wakeKind: 'browser_power_confirmation',
        toolName: 'browser_eval',
        effects: ['page_mutation'],
        actionIntent: { objectRef: 'page', inputHash: 'input-hash' },
        target: {
          scopeId: 'conv-confirmation',
          ownerRunId: 'run-confirmation',
          browserTaskId: 'browser-task-confirmation',
          tabId: 'tab-1',
          documentKeyHash: 'document-key-hash',
          origin: 'https://example.com',
          targetDigest: 'target-digest',
        },
        purpose: '更新页面内容',
      },
    },
    resumableActions: ['continue', 'cancel'],
    canResume: true,
  })
  const host = document.getElementById('root')
  assert.ok(host)
  host.innerHTML = ''
  const root = createRoot(host)
  const noop = () => {}
  flushSync(() => {
    root.render(createElement(TaskToolSnapshot, {
      messages: [],
      currentTaskRun: run,
      backgroundTaskRuns: [],
      liveTaskRuns: [run],
      currentScopeId: 'conv-confirmation',
      taskDisclosureState: {},
      isStreaming: false,
      streamingMessageId: null,
      parseSerializedTaskSnapshot: () => null,
      parseSerializedToolTraceSnapshot: () => [],
      setTaskSectionExpanded: noop,
      onOpenTaskArtifact: noop,
      onDismissMemoryCapture: noop,
      onUndoMemoryCapture: noop,
      onSupplementMemoryCapture: noop,
      onOpenScope: noop,
      onCancelDetachedTask: noop,
      onCancelChildRun: noop,
    }, ({ bottomTaskCard }) => createElement('div', null, bottomTaskCard)))
  })

  try {
    const card = host.querySelector('[data-ready-browser-confirmation-card="browser_power_confirmation"]')
    assert.ok(card)
    const buttons = Array.from(host.querySelectorAll('button'))
    const allow = buttons.find((button) => button.textContent?.trim() === '允许并继续')
    const deny = buttons.find((button) => button.textContent?.trim() === '拒绝')
    assert.equal(allow, undefined)
    assert.equal(deny, undefined)
    assert.equal(buttons.some((button) => button.textContent?.trim() === '继续运行'), false)
    assert.deepEqual(confirmationCalls, [])
  } finally {
    root.unmount()
  }
})

test('historical browser pending-consent state exposes no live confirmation action', () => {
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
    },
  })
  const { container, unmount } = mountTaskCard(run, {})
  try {
    const generic = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '确认继续')
    assert.equal(generic, undefined)
    assert.equal(container.querySelector('[data-ready-task-action="confirm-browser-collection-consent"]'), null)
  } finally {
    unmount()
  }
})
