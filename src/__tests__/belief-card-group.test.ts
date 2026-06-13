import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BeliefCardStore } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  beliefCardGroup,
  _beliefCardGroupChannelsForTest,
  type BeliefCardGroupDeps,
} from '../main/modules/claude-bridge/ipc/belief-card-group'

type HandlerFn = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createMockIpc() {
  const handlers = new Map<string, HandlerFn>()
  const removeHandlerCalls: string[] = []
  const ipc = {
    handle(channel: string, handler: HandlerFn) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      removeHandlerCalls.push(channel)
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  return { ipc, handlers, removeHandlerCalls }
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-belief-ipc-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function createDeps(store: BeliefCardStore): BeliefCardGroupDeps {
  let enabled = true
  return {
    getBeliefCardStore: () => store,
    getKnowledgeSystemEnabled: () => enabled,
    setKnowledgeSystemEnabled: (next) => { enabled = next },
    getLifecycleStatus: () => ({ running: true, lastMaintenanceAt: new Date('2026-06-13T12:00:00.000Z') }),
    getMaintenanceRoundStatus: () => ({
      lastRunAt: '2026-06-13T12:01:00.000Z',
      decision: 'skip',
      reason: 'no_signals',
      llmCalls: 0,
      applied: 0,
      rejected: 0,
      terminal: 'gated_skip',
    }),
  }
}

test('beliefCardGroup registers and disposes its documented channels', () => {
  const root = makeRoot()
  try {
    const { ipc, handlers, removeHandlerCalls } = createMockIpc()
    const handle = beliefCardGroup.register(ipc, createDeps(new BeliefCardStore({ memoryRoot: root })))
    assert.deepEqual([...handlers.keys()].sort(), [..._beliefCardGroupChannelsForTest].sort())
    const baselineRemoveCount = removeHandlerCalls.length
    handle.dispose()
    assert.deepEqual(removeHandlerCalls.slice(baselineRemoveCount).sort(), [..._beliefCardGroupChannelsForTest].sort())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('beliefCardGroup lists cards, flips the knowledge switch, and only confirms staged cards', async () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/staged.md',
      frontmatter: {
        title: '待确认',
        description: 'd',
        confidence: 'M',
        tag: 'knowledge',
        created: '2026-06-13',
        status: 'staged',
      },
      body: 'body',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/active.md',
      frontmatter: {
        title: '已生效',
        description: 'd',
        confidence: 'M',
        tag: 'knowledge',
        created: '2026-06-13',
        status: 'active',
      },
      body: 'body',
    }).ok)

    const { ipc, handlers } = createMockIpc()
    beliefCardGroup.register(ipc, createDeps(store))
    const invoke = async (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({} as IpcMainInvokeEvent, ...args) as Promise<{ success: boolean; data?: any; error?: string }>

    const listed = await invoke('agent:beliefCards:list')
    assert.equal(listed.success, true)
    assert.equal(listed.data.summary.staged, 1)
    assert.equal(listed.data.maintenance.llmRound.decision, 'skip')

    const disabled = await invoke('agent:beliefCards:setKnowledgeSystemEnabled', { enabled: false })
    assert.equal(disabled.data.knowledgeSystemEnabled, false)

    const rejected = await invoke('agent:beliefCards:transition', { relPath: 'knowledge/active.md', action: 'reject' })
    assert.equal(rejected.success, false)
    assert.match(rejected.error || '', /Only staged/)

    const approved = await invoke('agent:beliefCards:transition', { relPath: 'knowledge/staged.md', action: 'approve' })
    assert.equal(approved.success, true)
    assert.equal(store.readCard('knowledge/staged.md', { includeStaged: true })?.frontmatter.status, 'active')
    assert.equal(approved.data.summary.staged, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('beliefCardGroup approve merges site sidecars and resolves risk suggestions without auto-editing risk authority', async () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/sites/example.com.md',
      frontmatter: {
        title: 'example.com 站点经验',
        description: '已有经验',
        confidence: 'H',
        tag: 'knowledge',
        created: '2026-06-01',
        status: 'active',
        site: 'example.com',
      },
      body: '原始经验',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/sites/example.com-selector_missing-2026-06-13.md',
      frontmatter: {
        title: 'example.com 失败经验建议',
        description: 'selector 失效',
        confidence: 'M',
        tag: 'knowledge',
        created: '2026-06-13',
        status: 'staged',
        site: 'example.com',
        source: 'possible-update-of:knowledge/sites/example.com.md',
      },
      body: '- 2026-06-13 selector_missing: 列表项 selector 失效',
    }).ok)
    assert.ok(store.writeCard({
      relPath: 'knowledge/sites/example.com-risk_control_or_waf-2026-06-13.md',
      frontmatter: {
        title: 'example.com 风险建议',
        description: '触发风控',
        confidence: 'M',
        tag: 'knowledge',
        created: '2026-06-13',
        status: 'staged',
        site: 'example.com',
        source: 'possible-risk-update-of:knowledge/sites/example.com.md',
      },
      body: '- 2026-06-13 risk_control_or_waf: 触发风控',
    }).ok)

    const { ipc, handlers } = createMockIpc()
    beliefCardGroup.register(ipc, createDeps(store))
    const invoke = async (channel: string, ...args: unknown[]) =>
      handlers.get(channel)!({} as IpcMainInvokeEvent, ...args) as Promise<{ success: boolean; data?: any; error?: string }>

    const merged = await invoke('agent:beliefCards:transition', {
      relPath: 'knowledge/sites/example.com-selector_missing-2026-06-13.md',
      action: 'approve',
    })
    assert.equal(merged.success, true)
    const base = store.readCard('knowledge/sites/example.com.md', { includeStaged: true })
    assert.ok(base?.body.includes('selector_missing'), 'confirmed sidecar evidence is merged into the original card')
    assert.equal(
      store.readCard('knowledge/sites/example.com-selector_missing-2026-06-13.md', { includeStaged: true })?.frontmatter.status,
      'rejected',
      'merged sidecar is no longer pending',
    )

    const beforeRiskBody = store.readCard('knowledge/sites/example.com.md', { includeStaged: true })?.body
    const risk = await invoke('agent:beliefCards:transition', {
      relPath: 'knowledge/sites/example.com-risk_control_or_waf-2026-06-13.md',
      action: 'approve',
    })
    assert.equal(risk.success, true)
    assert.equal(store.readCard('knowledge/sites/example.com.md', { includeStaged: true })?.body, beforeRiskBody)
    assert.equal(
      store.readCard('knowledge/sites/example.com-risk_control_or_waf-2026-06-13.md', { includeStaged: true })?.frontmatter.status,
      'rejected',
      'risk suggestion is acknowledged without mutating the code-authority risk rule',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
