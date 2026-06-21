import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveBrowserOwnershipStatus } from '../renderer/modules/browser/browserOwnershipStatus'

test('browser ownership defaults to user-controlled visible page', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-1', owner: 'manual' },
    agentTabId: null,
    activeAgentTaskCount: 0,
    controlState: 'active',
  })
  assert.equal(status.kind, 'user-view')
  assert.equal(status.label, '用户浏览')
  assert.equal(status.detail, '当前可见页由你控制')
  assert.equal(status.tone, 'neutral')
})

test('browser ownership surfaces agent control of the visible page', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-agent', owner: 'agent', activity: 'running' },
    agentTabId: 'tab-agent',
    activeAgentTaskCount: 1,
    controlState: 'active',
  })
  assert.equal(status.kind, 'agent-current')
  assert.equal(status.label, 'Agent 协作当前页')
  assert.equal(status.detail, 'Agent 正在使用可见浏览器')
  assert.equal(status.tone, 'agent')
})

test('browser ownership surfaces background agent browser work', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-user', owner: 'manual' },
    agentTabId: 'tab-agent',
    activeAgentTaskCount: 2,
    controlState: 'active',
  })
  assert.equal(status.kind, 'agent-background')
  assert.equal(status.label, 'Agent 后台页')
  assert.equal(status.detail, '2 个后台 Agent 浏览任务')
  assert.equal(status.tone, 'agent')
})

test('browser ownership surfaces a real user-view write lease', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-user', owner: 'manual' },
    agentTabId: null,
    activeAgentTaskCount: 0,
    controlState: 'active',
    activeWriteSurface: 'user-view',
    surfaces: {
      'user-view': {
        surface: 'user-view',
        state: 'held',
        heldBy: 'task-user',
        runId: 'run-user',
        tabId: 'tab-user',
        leaseId: 'lease-user',
      },
      'agent-view': {
        surface: 'agent-view',
        state: 'idle',
        heldBy: null,
        runId: null,
        tabId: null,
        leaseId: null,
      },
    },
  })
  assert.equal(status.kind, 'agent-current')
  assert.equal(status.label, 'Agent 协作当前页')
  assert.equal(status.detail, '当前可见页写锁：task-user')
  assert.equal(status.tone, 'agent')
})

test('browser ownership surfaces a real agent-view write lease', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-user', owner: 'manual' },
    agentTabId: null,
    activeAgentTaskCount: 0,
    controlState: 'active',
    activeWriteSurface: 'agent-view',
    surfaces: {
      'user-view': {
        surface: 'user-view',
        state: 'idle',
        heldBy: null,
        runId: null,
        tabId: null,
        leaseId: null,
      },
      'agent-view': {
        surface: 'agent-view',
        state: 'held',
        heldBy: 'task-agent',
        runId: 'run-agent',
        tabId: 'tab-agent',
        leaseId: 'lease-agent',
      },
    },
  })
  assert.equal(status.kind, 'agent-background')
  assert.equal(status.label, 'Agent 后台页')
  assert.equal(status.detail, '后台 Agent 页写锁：task-agent')
  assert.equal(status.tone, 'agent')
})

test('browser ownership prioritizes takeover lease state over active write surface', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-user', owner: 'manual' },
    agentTabId: null,
    activeAgentTaskCount: 0,
    controlState: 'active',
    activeWriteSurface: 'agent-view',
    surfaces: {
      'user-view': {
        surface: 'user-view',
        state: 'takeover',
        heldBy: null,
        runId: null,
        tabId: null,
        leaseId: null,
      },
      'agent-view': {
        surface: 'agent-view',
        state: 'held',
        heldBy: 'task-agent',
        runId: 'run-agent',
        tabId: 'tab-agent',
        leaseId: 'lease-agent',
      },
    },
  })
  assert.equal(status.kind, 'takeover')
  assert.equal(status.label, '用户接管')
  assert.equal(status.tone, 'warning')
})

test('browser ownership prioritizes pending confirmation over background task state', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-user', owner: 'manual' },
    agentTabId: 'tab-agent',
    activeAgentTaskCount: 1,
    controlState: 'pending_confirm',
  })
  assert.equal(status.kind, 'pending-confirm')
  assert.equal(status.label, '等待确认')
  assert.equal(status.tone, 'warning')
})

test('browser ownership prioritizes frozen takeover state', () => {
  const status = resolveBrowserOwnershipStatus({
    activeTab: { id: 'tab-agent', owner: 'agent' },
    agentTabId: 'tab-agent',
    activeAgentTaskCount: 1,
    controlState: 'frozen',
  })
  assert.equal(status.kind, 'frozen')
  assert.equal(status.label, '已接管')
  assert.equal(status.tone, 'warning')
})
