import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { AgentScheduleDefinition, AgentScheduleOccurrence, ScheduledTasksAPI } from '../shared/scheduled-tasks'

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost', pretendToBeVisual: true,
  })
  const keys = ['window', 'document', 'HTMLElement', 'SVGElement', 'Node', 'Element', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'navigator', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map<string, unknown>(keys.map((key) => [key, (globalThis as unknown as Record<string, unknown>)[key]]))
  const values: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement, Node: dom.window.Node, Element: dom.window.Element,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore: () => {
      for (const key of keys) {
        const value = previous.get(key)
        if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      dom.window.close()
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.getElementById('root')!
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  await flush()
  return { root, container }
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount())
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text))
  assert.ok(button, `button not found: ${text}`)
  return button as HTMLButtonElement
}

function taskFixture(): AgentScheduleDefinition {
  return {
    id: 'schedule-1', name: '晨间简报', instruction: '整理今天的重点', scheduleSpecVersion: 1,
    scheduleSpec: { kind: 'calendar', frequency: 'daily', localTime: '09:00' }, timezone: 'Asia/Singapore',
    scopeId: 'scope-1', scopeMode: 'existing', agentId: 'butler', workspaceRoots: [], enabled: true,
    nextRunAt: '2026-07-14T01:00:00.000Z', lastOccurrenceAt: null, missedPolicy: 'coalesce_latest',
    blockedReason: null, migrationState: null, createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z',
  }
}

function apiStub(tasks: AgentScheduleDefinition[] = []): ScheduledTasksAPI & { changed?: (id?: string) => void } {
  const listeners = new Set<(id?: string) => void>()
  return {
    list: async () => ({ success: true, data: tasks }),
    get: async () => ({ success: true, data: tasks[0] }),
    preview: async () => ({ success: true, data: { occurrences: ['2026-07-14T01:00:00.000Z'], nextRunAt: '2026-07-14T01:00:00.000Z', blockedReason: null } }),
    create: async () => ({ success: true, data: taskFixture() }),
    update: async () => ({ success: true, data: taskFixture() }),
    pause: async () => ({ success: true, data: { ...taskFixture(), enabled: false } }),
    resume: async () => ({ success: true, data: taskFixture() }),
    delete: async (id) => ({ success: true, data: { id } }),
    runNow: async () => ({ success: true, data: {} as AgentScheduleOccurrence }),
    listOccurrences: async () => ({ success: true, data: [] }),
    onChanged: (callback) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    changed: (id) => { for (const listener of listeners) listener(id) },
  }
}

test('scheduled task entry exposes attention state and the panel opens every schedule mode', async () => {
  const handle = installDom()
  try {
    const [{ ScheduledTasksButton }, { ScheduledTasksPanel }] = await Promise.all([
      import('../renderer/components/agent/scheduled-tasks/ScheduledTasksButton'),
      import('../renderer/components/agent/scheduled-tasks/ScheduledTasksPanel'),
    ])
    const api = apiStub()
    Object.defineProperty(handle.dom.window, 'electronAPI', { value: { scheduledTasks: api }, configurable: true })
    const button = await mount(createElement(ScheduledTasksButton, { attentionCount: 2, onClick: () => undefined }))
    assert.equal(button.container.querySelector('button')?.getAttribute('aria-label'), '定时任务，2 项需要处理')
    await unmount(button.root)

    const panel = await mount(createElement(ScheduledTasksPanel, {
      open: true, onClose: () => undefined, currentScopeId: 'scope-1', currentAgentId: 'butler', workspaceRoots: [],
    }))
    try {
      assert.match(panel.container.textContent || '', /让 Agent 按时开始/)
      await act(async () => findButton(panel.container, '新建定时任务').click())
      const frequency = [...panel.container.querySelectorAll('select')].find((select) =>
        [...select.options].some((option) => option.value === 'custom'))
      assert.ok(frequency)
      assert.deepEqual([...frequency.options].map((option) => option.value), ['once', 'daily', 'workday', 'weekly', 'monthly', 'yearly', 'interval', 'custom'])
      await act(async () => {
        frequency.value = 'custom'
        frequency.dispatchEvent(new handle.dom.window.Event('change', { bubbles: true }))
      })
      assert.equal(
        panel.container.querySelectorAll('.scheduled-task-editor__choice-grid.is-weekdays button[data-selected="true"]').length,
        0,
        'custom rules must not silently restrict new tasks to Monday',
      )
    } finally {
      await unmount(panel.root)
    }
  } finally {
    handle.restore()
  }
})

test('panel actions read back durable state and history refreshes on background changes', async () => {
  const handle = installDom()
  try {
    const { ScheduledTasksPanel } = await import('../renderer/components/agent/scheduled-tasks/ScheduledTasksPanel')
    const task = taskFixture()
    let pauseCalls = 0
    let listCalls = 0
    const api = apiStub([task])
    api.list = async () => { listCalls += 1; return { success: true, data: [task] } }
    api.pause = async () => { pauseCalls += 1; return { success: true, data: { ...task, enabled: false } } }
    api.listOccurrences = async () => ({ success: true, data: [{
      id: 'occ-1', scheduleId: task.id, scheduledFor: task.nextRunAt!, triggeredAt: task.nextRunAt!, triggerSource: 'timer',
      claimStatus: 'dispatching', attempt: 1, runId: 'run-1', taskId: 'task-1', delayMs: 0,
      startedAt: task.nextRunAt, finishedAt: null, errorKind: null, errorMessage: null,
      interactionState: 'awaiting_confirmation', createdAt: task.nextRunAt!, updatedAt: task.nextRunAt!,
    }] })
    Object.defineProperty(handle.dom.window, 'electronAPI', { value: { scheduledTasks: api }, configurable: true })
    const panel = await mount(createElement(ScheduledTasksPanel, {
      open: true, onClose: () => undefined, currentScopeId: 'scope-1', currentAgentId: 'butler', workspaceRoots: [],
      onOpenOccurrence: () => undefined,
    }))
    try {
      await act(async () => findButton(panel.container, '暂停').click())
      await flush()
      assert.equal(pauseCalls, 1)
      assert.ok(listCalls >= 2, 'mutation must read back the authoritative list')

      await act(async () => (panel.container.querySelector('[aria-label^="更多操作"]') as HTMLButtonElement).click())
      await act(async () => findButton(panel.container, '执行历史').click())
      await flush()
      assert.match(panel.container.textContent || '', /等待确认/)
      assert.match(panel.container.textContent || '', /去处理/)
      const beforeChange = listCalls
      await act(async () => api.changed?.(task.id))
      await flush()
      assert.ok(listCalls > beforeChange, 'runtime invalidation must refresh the visible schedule state')
    } finally {
      await unmount(panel.root)
    }
  } finally {
    handle.restore()
  }
})

test('scheduled tasks workspace owns the central canvas and keeps BrowserView masked until close', async () => {
  const handle = installDom()
  try {
    const { ScheduledTasksWorkspace } = await import('../renderer/components/agent/scheduled-tasks/ScheduledTasksWorkspace')
    const api = apiStub()
    Object.defineProperty(handle.dom.window, 'electronAPI', { value: { scheduledTasks: api }, configurable: true })
    const lockEvents: Array<{ locked?: boolean; persistent?: boolean }> = []
    handle.dom.window.addEventListener('ready:browser-overlay-lock', ((event: CustomEvent) => {
      lockEvents.push(event.detail)
    }) as EventListener)

    const workspace = await mount(createElement(ScheduledTasksWorkspace, {
      open: true,
      onClose: () => undefined,
      currentScopeId: 'scope-1',
      currentAgentId: 'butler',
      workspaceRoots: [],
      agentOptions: [],
      onSummaryChange: () => undefined,
      onOpenOccurrence: () => undefined,
    }))
    assert.ok(workspace.container.querySelector('[data-scheduled-tasks-workspace="true"]'))
    assert.ok(workspace.container.querySelector('.scheduled-tasks-panel.is-workspace'))
    assert.deepEqual(lockEvents[0], { locked: true, persistent: true })

    await unmount(workspace.root)
    await flush()
    assert.deepEqual(lockEvents.at(-1), { locked: false, persistent: true })
  } finally {
    handle.restore()
  }
})

test('workspace panel overrides the shared liquid panel lift shadow', () => {
  const handle = installDom()
  try {
    const style = handle.dom.window.document.createElement('style')
    style.textContent = [
      readFileSync(new URL('../renderer/styles/flat-chrome.css', import.meta.url), 'utf8'),
      readFileSync(new URL('../renderer/styles/scheduled-tasks.css', import.meta.url), 'utf8'),
    ].join('\n')
    handle.dom.window.document.head.append(style)
    handle.dom.window.document.documentElement.dataset.skin = 'liquid-glass'
    const panel = handle.dom.window.document.createElement('div')
    panel.className = 'ready-app-liquid-panel scheduled-tasks-panel is-workspace'
    handle.dom.window.document.body.append(panel)

    const computed = handle.dom.window.getComputedStyle(panel)
    assert.equal(computed.getPropertyValue('--ready-app-panel-glass-shadow').trim(), 'none')
    assert.equal(computed.boxShadow, 'none')
  } finally {
    handle.restore()
  }
})
