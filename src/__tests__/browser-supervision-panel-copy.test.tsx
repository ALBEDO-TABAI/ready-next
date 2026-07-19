import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AgentBrowserSupervisionPanel } from '../renderer/components/browser/AgentBrowserSupervisionPanel'
import type { AgentBrowserCollectionTask, BrowserLeaseSurfaceSnapshot } from '../renderer/modules/browser/useAgentBrowserSupervision'

const noop = async () => {}

function task(): AgentBrowserCollectionTask {
  return {
    taskId: 'task-1',
    kind: 'collect',
    status: 'running',
    progress: { total: 3, completed: 1, failed: 0, currentLabel: '采集页面' },
  }
}

function surfaces(active: 'user-view' | 'agent-view'): Record<'user-view' | 'agent-view', BrowserLeaseSurfaceSnapshot> {
  return {
    'user-view': {
      surface: 'user-view',
      state: active === 'user-view' ? 'held' : 'idle',
      heldBy: active === 'user-view' ? 'task-user' : null,
      runId: active === 'user-view' ? 'run-user' : null,
      tabId: active === 'user-view' ? 'tab-user' : null,
      leaseId: active === 'user-view' ? 'lease-user' : null,
    },
    'agent-view': {
      surface: 'agent-view',
      state: active === 'agent-view' ? 'held' : 'idle',
      heldBy: active === 'agent-view' ? 'task-agent' : null,
      runId: active === 'agent-view' ? 'run-agent' : null,
      tabId: active === 'agent-view' ? 'tab-agent' : null,
      leaseId: active === 'agent-view' ? 'lease-agent' : null,
    },
  }
}

test('AgentBrowserSupervisionPanel renders visible co-driving copy for user-view writes', () => {
  const html = renderToStaticMarkup(createElement(AgentBrowserSupervisionPanel, {
    controlState: 'active',
    tasks: [task()],
    requestInterruption: noop,
    surfaces: surfaces('user-view'),
    activeWriteSurface: 'user-view',
  }))

  assert.match(html, /Agent 正在协作当前页/)
  assert.match(html, /当前可见页协作写锁/)
  assert.doesNotMatch(html, /隔离/)
})

test('AgentBrowserSupervisionPanel renders background agent page copy for agent-view writes', () => {
  const html = renderToStaticMarkup(createElement(AgentBrowserSupervisionPanel, {
    controlState: 'active',
    tasks: [task()],
    requestInterruption: noop,
    surfaces: surfaces('agent-view'),
    activeWriteSurface: 'agent-view',
  }))

  assert.match(html, /Agent 正在后台页工作/)
  assert.match(html, /后台 Agent 页写锁/)
  assert.doesNotMatch(html, /隔离/)
})

test('AgentBrowserSupervisionPanel keeps waiting_human tasks visible as verification waits', () => {
  const waitingTask: AgentBrowserCollectionTask = {
    ...task(),
    status: 'waiting_human',
    progress: { total: 3, completed: 2, failed: 0, currentLabel: '等待人工确认' },
  }
  const html = renderToStaticMarkup(createElement(AgentBrowserSupervisionPanel, {
    controlState: 'active',
    tasks: [waitingTask],
    requestInterruption: noop,
    surfaces: surfaces('agent-view'),
    activeWriteSurface: 'agent-view',
  }))

  assert.match(html, /等待确认/)
  assert.match(html, /等待人工确认/)
  assert.doesNotMatch(html, /2\/3/)
})

test('AgentBrowserSupervisionPanel offers one-step takeover without a confirmation branch', () => {
  const html = renderToStaticMarkup(createElement(AgentBrowserSupervisionPanel, {
    controlState: 'active',
    tasks: [task()],
    requestInterruption: noop,
    surfaces: surfaces('agent-view'),
    activeWriteSurface: 'agent-view',
  }))

  assert.match(html, /立即接管浏览器/)
  assert.doesNotMatch(html, /确认中断/)
  assert.doesNotMatch(html, /取消/)
})

test('pane supervision history cannot consume the browser surface', () => {
  const tasks = Array.from({ length: 12 }, (_, index) => ({
    ...task(),
    taskId: `task-${index}`,
  }))
  const html = renderToStaticMarkup(createElement(AgentBrowserSupervisionPanel, {
    controlState: 'active',
    tasks,
    requestInterruption: noop,
    surfaces: surfaces('agent-view'),
    activeWriteSurface: 'agent-view',
    variant: 'pane',
  }))

  assert.match(html, /max-height:40%/)
  assert.match(html, /overflow-y-auto/)
})
