import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem } from '@openai/agents'
import type {
  BrowserResearchAssessment,
  BrowserResearchWorkItem,
} from '../main/modules/browser-engine/browser-workflow-evidence'
import { applyPerCallSystemReminders } from '../main/modules/agent-control/runtime-core/agent-sdk-per-call-reminders'
import {
  browserResearchProgressDigest,
  registerBrowserResearchProgressReminder,
} from '../main/modules/agent-control/system-reminders/browser-research-progress-reminder'
import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminders/system-reminder-registry'

function workItem(id: string, evidence: string[]): BrowserResearchWorkItem {
  return {
    workItemId: id,
    goalRefs: [],
    requirement: null,
    query: `查询-${id}`,
    url: null,
    fieldGoals: [],
    required: true,
    evidenceRefIds: evidence,
    createdAt: '2026-07-23T03:13:11.000Z',
  }
}

function assessment(input: {
  items: BrowserResearchWorkItem[]
  missing: string[]
}): BrowserResearchAssessment {
  return {
    taskId: 'browser-task-test',
    satisfied: input.missing.length === 0,
    missingWorkItemIds: input.missing,
    workItems: input.items,
    evidenceRefs: [],
  }
}

test('研究进度账本提醒携带 required/completed/missing 的持久真值', () => {
  const registry = createSystemReminderRegistry()
  registerBrowserResearchProgressReminder(registry, assessment({
    items: [workItem('q01', ['ev-1']), workItem('q02', ['ev-2']), workItem('q03', [])],
    missing: ['q03'],
  }))
  const text = registry.compose()
  assert.ok(text, 'reminder must compose')
  assert.match(text, /研究进度账本/)
  assert.match(text, /"required":3/)
  assert.match(text, /"completed":2/)
  assert.match(text, /"missingWorkItemIds":\["q03"\]/)
  assert.match(text, /"completedWorkItemIds":\["q01","q02"\]/)
})

test('进度 digest 对 missing 顺序不敏感，对完成度变化敏感', () => {
  const base = assessment({
    items: [workItem('q01', ['ev-1']), workItem('q02', [])],
    missing: ['q02'],
  })
  const reordered = assessment({
    items: [workItem('q02', []), workItem('q01', ['ev-1'])],
    missing: ['q02'],
  })
  assert.equal(browserResearchProgressDigest(base), browserResearchProgressDigest(reordered))
  const progressed = assessment({
    items: [workItem('q01', ['ev-1']), workItem('q02', ['ev-2'])],
    missing: [],
  })
  assert.notEqual(browserResearchProgressDigest(base), browserResearchProgressDigest(progressed))
})

function loopState(nextInput: string | AgentInputItem[]) {
  return {
    criteriaSelfCheckInjected: true,
    liveTaskBudgetRuntime: null,
    nextInput,
    sessionRestoreNotice: null,
  }
}

function reminderTextsOf(nextInput: string | AgentInputItem[]): string[] {
  if (typeof nextInput === 'string') return []
  return nextInput
    .map((item) => item as { role?: string; content?: unknown })
    .filter((item) => item.role === 'system' && typeof item.content === 'string')
    .map((item) => item.content as string)
}

test('applyPerCallSystemReminders 注入账本；digest 不变时冷却，第 3 次调用重注', () => {
  const runScopeKey = {}
  const current = assessment({
    items: [workItem('q01', ['ev-1']), workItem('q02', [])],
    missing: ['q02'],
  })
  const host = {
    readVerifiedBrowserWorkflowEvidence: () => ({ researchAssessment: current }),
  } as never
  const callOnce = () => {
    const state = loopState('继续任务')
    applyPerCallSystemReminders({
      state,
      runScopeKey,
      sessionId: undefined,
      turnTaskType: 'research',
      host,
      browserWorkflowRoute: { browserTaskId: 'browser-task-test' },
    })
    return reminderTextsOf(state.nextInput).filter((text) => text.includes('研究进度账本'))
  }
  assert.equal(callOnce().length, 1, '首次调用必须注入账本')
  assert.equal(callOnce().length, 0, 'digest 未变时第 2 次调用处于冷却')
  assert.equal(callOnce().length, 0, 'digest 未变时第 3 次调用仍处于冷却')
  assert.equal(callOnce().length, 1, '冷却耗尽后重注，保证压缩挤掉旧提醒也会周期性重对齐')
})

test('applyPerCallSystemReminders：digest 变化立即重注，证据读取异常不阻断', () => {
  const runScopeKey = {}
  let current = assessment({
    items: [workItem('q01', [])],
    missing: ['q01'],
  })
  let shouldThrow = false
  const host = {
    readVerifiedBrowserWorkflowEvidence: () => {
      if (shouldThrow) throw new Error('journal busy')
      return { researchAssessment: current }
    },
  } as never
  const callOnce = () => {
    const state = loopState('继续任务')
    applyPerCallSystemReminders({
      state,
      runScopeKey,
      sessionId: undefined,
      turnTaskType: 'research',
      host,
      browserWorkflowRoute: { browserTaskId: 'browser-task-test' },
    })
    return { texts: reminderTextsOf(state.nextInput), state }
  }
  assert.equal(callOnce().texts.filter((text) => text.includes('研究进度账本')).length, 1)
  current = assessment({ items: [workItem('q01', ['ev-1'])], missing: [] })
  const progressed = callOnce()
  assert.equal(progressed.texts.filter((text) => text.includes('"completed":1')).length, 1, '进度变化立即重注')
  shouldThrow = true
  const failed = callOnce()
  assert.equal(failed.texts.filter((text) => text.includes('研究进度账本')).length, 0)
  assert.ok(failed.state.nextInput, '证据读取失败时模型调用输入保持可用')
})

test('applyPerCallSystemReminders 无浏览器工作流路由时不读证据也不注入账本', () => {
  const state = loopState('普通任务')
  applyPerCallSystemReminders({
    state,
    runScopeKey: {},
    sessionId: undefined,
    turnTaskType: 'direct_answer',
    host: {
      readVerifiedBrowserWorkflowEvidence: () => {
        throw new Error('must not be called')
      },
    } as never,
    browserWorkflowRoute: null,
  })
  assert.equal(reminderTextsOf(state.nextInput).filter((text) => text.includes('研究进度账本')).length, 0)
})
