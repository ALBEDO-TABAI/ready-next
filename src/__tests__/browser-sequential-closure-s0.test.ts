import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserTurnLease } from '../main/modules/browser-engine/agent-browser-turn-lease'
import { isAgentBrowserError } from '../main/modules/browser-engine/agent-browser-errors'
import { BrowserWriteLeaseService } from '../main/modules/browser-engine/browser-write-lease'
import { BrowserTabShellService, type BrowserShellTabRecord } from '../main/modules/browser-engine/tab-shell-service'
import { closeBrowserTabAndNotify } from '../main/modules/browser-engine/tab-close-notifier'
import { recoverPendingHandoffTakeovers } from '../main/modules/agent-control/agents/handoff-takeover-recovery'
import { executeToolCall } from '../main/modules/tools/tool-executor'
import { finalizeRunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import {
  isUserViewKeyboardTakeoverInput,
  shouldRecordUserViewTabSwitch,
} from '../main/modules/browser-engine/user-view-takeover-bridge'

test('S0 R1a: takeover on tab A does not block a fresh run on unrelated tab B', () => {
  const service = new BrowserWriteLeaseService()
  const oldLease = service.acquire({
    surface: 'user-view',
    taskId: 'task-old',
    runId: 'run-old',
    tabId: 'tab-a',
  })
  if (isAgentBrowserError(oldLease)) throw new Error(oldLease.message)

  service.recordUserSignal({ surface: 'user-view', source: 'tab-switch' })
  service.release(oldLease.leaseId)

  const next = service.acquire({
    surface: 'user-view',
    taskId: 'task-new',
    runId: 'run-new',
    tabId: 'tab-b',
  })
  assert.ok(!isAgentBrowserError(next), 'a target fence on tab A must not spill onto tab B')
})

test('S0 R1b: the same turn acquires tab B after target A takeover is resolved', () => {
  const service = new BrowserWriteLeaseService()
  const turn = new BrowserTurnLease(
    { taskId: 'task-research', runId: 'run-research' },
    'user-view',
    service,
  )
  const first = turn.ensureGateForSurface('user-view', 'tab-a')
  assert.ok(!isAgentBrowserError(first))

  service.recordUserSignal({ surface: 'user-view', source: 'explicit-button' })
  service.clearTakeover('user-view')

  const second = turn.ensureGateForSurface('user-view', 'tab-b')
  assert.ok(!isAgentBrowserError(second), 'tab B must not heartbeat the stale tab A owner')
})

test('S0 R1c: one turn uses distinct target ownership for tab A and tab B', () => {
  const service = new BrowserWriteLeaseService()
  const turn = new BrowserTurnLease(
    { taskId: 'task-research', runId: 'run-research' },
    'user-view',
    service,
  )
  const first = turn.ensureGateForSurface('user-view', 'tab-a')
  const second = turn.ensureGateForSurface('user-view', 'tab-b')
  assert.ok(!isAgentBrowserError(first))
  assert.ok(!isAgentBrowserError(second))
  if (isAgentBrowserError(first) || isAgentBrowserError(second)) return

  assert.notEqual(first.leaseId, second.leaseId, 'tab B must not reuse tab A ownership')
})

test('S0 ownership signals: presentation-only tab switching does not take over the page left behind', () => {
  assert.equal(shouldRecordUserViewTabSwitch({
    previousActiveTabId: 'tab-a',
    nextActiveTabId: 'tab-b',
    leaseTabId: 'tab-a',
  }), false)
})

test('S0 ownership signals: trusted pointer input on the target is recognized as user takeover input', () => {
  assert.equal(isUserViewKeyboardTakeoverInput({ type: 'mouseDown' }), true)
})

function createShellTab(id: string): BrowserShellTabRecord {
  return {
    id,
    url: `https://${id}.example/`,
    title: id,
    domain: `${id}.example`,
    favicon: null,
    owner: 'manual',
    required: false,
    activity: 'idle',
    lastAuditedAt: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    view: {
      webContents: {
        loadURL: async () => undefined,
        reload: () => undefined,
        navigationHistory: {
          canGoBack: () => false,
          canGoForward: () => false,
          goBack: () => undefined,
          goForward: () => undefined,
        },
      },
    } as BrowserShellTabRecord['view'],
  }
}

test('S0 ownership signals: chrome navigation fences only the claimed target', async () => {
  const leaseService = new BrowserWriteLeaseService({ actionGraceMs: 0 })
  const lease = leaseService.acquire({
    surface: 'user-view',
    taskId: 'task-navigation',
    runId: 'run-navigation',
    tabId: 'tab-a',
  })
  if (isAgentBrowserError(lease)) throw new Error(lease.message)

  const tabs = new Map([['tab-a', createShellTab('tab-a')]])
  const shell = new BrowserTabShellService({
    tabs,
    getActiveTabId: () => 'tab-a',
    setActiveTabId: () => undefined,
    getSplitTabId: () => null,
    setSplitTabId: () => undefined,
    getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setViewBounds: () => undefined,
    getSplitViewBounds: () => ({ x: 0, y: 0, width: 400, height: 600 }),
    setSplitViewBounds: () => undefined,
    shouldPresentHosts: () => true,
    isAllowedUrl: () => true,
    createTab: async () => ({ success: false, error: 'not used' }),
    detachHost: () => undefined,
    showHost: () => undefined,
    applyBounds: () => undefined,
    hideHost: () => undefined,
    detachPreviewView: () => undefined,
    restoreActiveTabHost: () => undefined,
  })

  assert.deepEqual(await shell.navigate('tab-a', 'https://next.example/'), { success: true })
  assert.equal(
    leaseService.getState('user-view'),
    'takeover',
    'a user chrome navigation must settle the exact target instead of staying silently held',
  )
})

test('S0 ownership signals: closing a claimed tab settles ownership immediately', () => {
  const leaseService = new BrowserWriteLeaseService()
  const lease = leaseService.acquire({
    surface: 'user-view',
    taskId: 'task-close',
    runId: 'run-close',
    tabId: 'tab-a',
  })
  if (isAgentBrowserError(lease)) throw new Error(lease.message)

  const closed: string[] = []
  const result = closeBrowserTabAndNotify({
    closeTab: () => ({ success: true }),
    notifyTabClosed: (tabId) => closed.push(tabId),
  }, 'tab-a')

  assert.deepEqual(result, { success: true })
  assert.deepEqual(closed, ['tab-a'])
  assert.notEqual(
    leaseService.getState('user-view'),
    'held',
    'a closed physical target must not leave an invisible live owner behind',
  )
})

test('S0 R8: completion criteria use the Browser workflow write boundary', async () => {
  const output = await executeToolCall(
    'declare_completion_criteria',
    { criteria: ['18 个研究项全部有可回读证据'] },
    {
      taskId: 'browser-parent-r8',
      sessionId: 'scope-r8',
      allowedToolNames: ['declare_completion_criteria'],
      runtime: {
        getTaskProjectionStoreForFinalize: () => ({
          update: () => {
            throw new Error('[task-projection-repository] bound Browser Parent requires workflow unit-of-work')
          },
        }),
      } as never,
    },
  )

  assert.equal(output.data?.ok, true, 'a bound Browser Parent must not use the ordinary projection writer')
})

test('S0 R9: exhausted handoff startup recovery writes one terminal receipt instead of retrying', async () => {
  let attempts = 0
  let terminalReceipts = 0
  const deps = {
    listPending: () => [{
      taskId: 'task-r9',
      scopeId: 'scope-r9',
      continuationRef: {
        kind: 'handoff_takeover',
        consumed: false,
        targetAgentId: 'collector',
        handoffGeneration: 1,
        userRequestVerbatim: '继续原任务',
        contextRefIds: [],
        startupRecoveryAttempts: 3,
      },
    }],
    getScope: () => ({
      id: 'scope-r9',
      agent: 'butler',
      activeAgentId: 'collector',
      handoffGeneration: 1,
      title: '会话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'scope-r9',
      meta: {},
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    } as never),
    runTakeover: async () => {
      attempts += 1
      return { success: false, error: 'core_closeout_owner_mismatch' }
    },
    markConsumed: () => undefined,
    markRecoveryTerminal: () => {
      terminalReceipts += 1
    },
    log: () => undefined,
  } as Parameters<typeof recoverPendingHandoffTakeovers>[0] & {
    markRecoveryTerminal: (taskId: string, handoffGeneration: number, error: string) => void
  }

  await recoverPendingHandoffTakeovers(deps)
  assert.equal(attempts, 0, 'an exhausted recovery must not launch the same takeover again')
  assert.equal(terminalReceipts, 1, 'the exhausted recovery must become a durable terminal fact')
})

test('S0 R6 proof: checkpoint closeout cannot preserve a stale short-task projection over research runtime truth', async () => {
  let projection = {
    taskId: 'task-r6',
    scopeId: 'scope-r6',
    runId: 'run-r6',
    taskType: 'short_task',
    module: 'browser',
  } as Record<string, unknown>
  let runMeta: Record<string, unknown> | null = null
  let closeTaskType: string | null = null
  const researchBudget = createTaskBudgetRuntime('research', {
    usage: { iterationsUsed: 34, toolCallsUsed: 37, parallelToolGroupsUsed: 0 },
  })

  await finalizeRunOutcome({
    kind: 'checkpoint',
    runId: 'run-r6',
    taskId: 'task-r6',
    scopeId: 'scope-r6',
    continuationHandle: 'checkpoint-r6',
    terminalReason: 'checkpoint_incomplete',
    durationMs: 1,
    toolCallsUsed: 37,
    initiator: 'incomplete',
    taskBudgetRuntime: researchBudget,
    projectionPatch: {
      status: 'recoverable_paused',
      interactionState: 'suspended',
      resumableActions: ['continue', 'cancel'],
    },
  }, {
    runMetaRepository: {
      get: () => runMeta,
      create: (input) => {
        runMeta = { ...input }
        return input
      },
      update: (_runId, patch) => {
        runMeta = { ...(runMeta || {}), ...patch }
        return runMeta
      },
    },
    taskProjectionStore: {
      get: () => projection as never,
      update: (_taskId, patch) => {
        projection = { ...projection, ...patch }
      },
    },
    writeProjectionTerminalPatch: (patch) => {
      projection = { ...projection, ...(patch || {}) }
    },
    writeRunCloseMetric: (metric) => {
      closeTaskType = metric.taskType ?? null
    },
  })

  assert.equal(projection.taskType, 'research')
  assert.equal(runMeta?.taskType, 'research')
  assert.equal((runMeta?.budget as { maxIterations?: number } | null)?.maxIterations, 220)
  assert.equal(closeTaskType, 'research')
})
