import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/task-projection/run-coordinator'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture
} from '../main/modules/agent-control/contracts/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-1',
    meta: {},
    createdAt: '2026-04-09T10:00:00.000Z',
    updatedAt: '2026-04-09T10:00:00.000Z',
    lastMessageAt: '2026-04-09T10:00:00.000Z'
  }
}

function canonicalCloseout(content: string) {
  return {
    canonicalMessage: {
      id: `assistant:${content.length}`,
      conversationId: 'scope-1',
      role: 'assistant' as const,
      content,
      timestamp: '2026-04-09T10:00:00.000Z',
      meta: {},
    },
    canonicalMessageDigest: `digest:${content.length}`,
  }
}

test('RunCoordinator forwards per-call coordinators into prompt assembly', async () => {
  const scopedCoordinators = [{ id: 'scoped' }] as never
  const inboundCoordinators = [{ id: 'inbound' }] as never
  const received: unknown[] = []

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async ({ coordinators }) => {
        received.push(coordinators)
        return {
          systemPrompt: 'system prompt',
          bootstrapMessages: [],
          memoryRefs: [],
          triggerHits: [],
          contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
        }
      },
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'done',
      cancelled: false,
      usedTools: [],
    }),
    emitScopeRunEvent: () => {},
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: 'hello',
    requestId: 'req-coordinators-scoped',
    coordinators: scopedCoordinators,
  })
  await coordinator.runInboundChannel({
    scope: createScope(),
    message: 'hello',
    requestId: 'req-coordinators-inbound',
    coordinators: inboundCoordinators,
  })

  assert.equal(received[0], scopedCoordinators)
  assert.equal(received[1], inboundCoordinators)
})

test('RunCoordinator assembles prompt, executes host, and emits planning metadata', async () => {
  const events: ScopeRunEventPayload[] = []
  let recordedOutcome: { success: boolean; finalText: string; usedTools: string[] } | null = null
  let reflected = false
  let executionBudget: {
    maxIterations: number
    maxToolCalls: number
    maxParallelToolGroups: number
  } | null = null
  let executionBudgetState: {
    iterationsUsed: number
    toolCallsUsed: number
    parallelToolGroupsUsed: number
  } | null = null
  let executionTaskBudgetRuntime: {
    taskType: string
    budget: {
      maxIterations: number
      maxToolCalls: number
      maxParallelToolGroups: number
    }
    usage: {
      iterationsUsed: number
      toolCallsUsed: number
      parallelToolGroupsUsed: number
    }
  } | null = null

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: ['boot'],
        memoryRefs: [
          {
            id: 'mem-1',
            layer: 'l1',
            sourceType: 'scope_memory',
            title: 'recent',
            loadedAt: '2026-04-09T10:00:00.000Z'
          }
        ],
        triggerHits: [
          {
            id: 'browser-upload',
            label: '浏览器上传流程',
            module: 'browser',
            blocking: false,
            refs: []
          }
        ],
        contextBudget: { totalChars: 100, l0Chars: 20, l1Chars: 40, l2Chars: 40, droppedRefs: [] }
      }),
      applyToMessage: () => 'boot\n\nhello',
      recordRunOutcome: (payload) => {
        recordedOutcome = {
          success: payload.success,
          finalText: payload.finalText,
          usedTools: payload.usedTools
        }
      }
    },
    executeAndCollect: async (request) => {
      executionBudget = request.budget || null
      executionBudgetState = request.budgetState || null
      executionTaskBudgetRuntime = request.taskBudgetRuntime || null
      if (request.budgetState) {
        request.budgetState.iterationsUsed = 3
        request.budgetState.toolCallsUsed = 4
        request.budgetState.parallelToolGroupsUsed = 1
      }
      return {
        success: true,
        finalText: 'done text',
        cancelled: false,
        ...canonicalCloseout('done text'),
      usedTools: ['browser_click'],
      budgetState: request.budgetState,
      taskBudgetRuntime: request.taskBudgetRuntime
        ? {
            ...request.taskBudgetRuntime,
            usage: {
              ...request.taskBudgetRuntime.usage,
              iterationsUsed: 3,
              toolCallsUsed: 4,
              parallelToolGroupsUsed: 1,
            },
          }
        : undefined,
      executionDiagnostics: {
        fallback: {
          kind: 'text_bridge',
          attempts: 1
        }
        }
      }
    },
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => {
      reflected = true
      return null
    }
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: 'hello',
    requestId: 'req-1',
    coordinators: []
  })

  assert.deepEqual(result, {
    success: true,
    responseText: 'done text',
    ...canonicalCloseout('done text'),
  })
  assert.equal(events[0]?.phase, 'planning')
  // 2026-07-04 语义更新：browser-upload 是流程知识片段，不再充当任务名/模块
  // ——planning 卡回中性占位，真实标题由 run 中的 projection 回填。
  assert.equal(events[0]?.module, undefined)
  assert.equal(events[0]?.taskTitle, '正在理解需求')
  assert.match(events[0]?.taskSummary || '', /正在整理任务边界/)
  assert.equal(
    events[0]?.executionDiagnostics?.budget?.maxIterations,
    executionBudget?.maxIterations
  )
  assert.equal(events[0]?.executionDiagnostics?.fallback?.happened, false)
  assert.equal(events[0]?.executionDiagnostics?.fallback?.kind, 'none')
  assert.equal(events[0]?.executionDiagnostics?.fallback?.attempts, 0)
  assert.equal(typeof executionBudget?.maxIterations, 'number')
  assert.equal(typeof executionBudget?.maxToolCalls, 'number')
  assert.equal(typeof executionBudget?.maxParallelToolGroups, 'number')
  assert.equal(executionTaskBudgetRuntime?.budget.maxIterations, executionBudget?.maxIterations)
  assert.equal(executionTaskBudgetRuntime?.usage.iterationsUsed, 0)
  assert.deepEqual(executionBudgetState, {
    iterationsUsed: 3,
    toolCallsUsed: 4,
    parallelToolGroupsUsed: 1
  })
  assert.equal(events[1]?.phase, 'done')
  assert.equal(events[1]?.executionDiagnostics?.budget?.iterationsUsed, 3)
  assert.equal(events[1]?.executionDiagnostics?.budget?.toolCallsUsed, 4)
  assert.equal(events[1]?.executionDiagnostics?.budget?.parallelToolGroupsUsed, 1)
  assert.equal(events[1]?.executionDiagnostics?.fallback?.happened, true)
  assert.equal(events[1]?.executionDiagnostics?.fallback?.kind, 'text_bridge')
  assert.equal(events[1]?.executionDiagnostics?.fallback?.attempts, 1)
  assert.equal(events[1]?.executionDiagnostics?.taskBudgetRuntime?.usage?.iterationsUsed, 3)
  assert.equal(recordedOutcome?.success, true)
  assert.equal(recordedOutcome?.finalText, 'done text')
  assert.deepEqual(recordedOutcome?.usedTools, ['browser_click'])
  assert.equal(reflected, true)
})

test('RunCoordinator forwards task metadata from execution results into the final scope event', async () => {
  const events: ScopeRunEventPayload[] = []

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 20, l0Chars: 10, l1Chars: 10, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async (request) => ({
      success: true,
      finalText: 'done text',
      cancelled: false,
      ...canonicalCloseout('done text'),
      usedTools: ['document_update_widget'],
      taskId: request.taskId,
      taskType: 'multi_step_task',
      interactionState: 'running',
      taskProjectionId: 'task-proj-1',
      executionDiagnostics: {
        budgetUsagePercent: 70,
        degradationReason: 'browser_host_unavailable',
      },
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: 'hello',
    requestId: 'req-2',
    coordinators: []
  })

  assert.deepEqual(result, {
    success: true,
    responseText: 'done text',
    ...canonicalCloseout('done text'),
  })
  assert.match(events[0]?.taskId || '', /^task-/)
  assert.equal(events[0]?.taskId, events.at(-1)?.taskId)
  assert.equal(events.at(-1)?.taskType, 'multi_step_task')
  assert.equal(events.at(-1)?.interactionState, 'running')
  assert.equal(events.at(-1)?.taskProjectionId, 'task-proj-1')
  assert.equal(events.at(-1)?.executionDiagnostics?.budgetUsagePercent, 70)
  assert.equal(events.at(-1)?.executionDiagnostics?.degradationReason, 'browser_host_unavailable')
})

test('RunCoordinator treats successful adjudication_degraded results as done events', async () => {
  const events: ScopeRunEventPayload[] = []
  let recordedSuccess: boolean | null = null

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 20, l0Chars: 10, l1Chars: 10, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: (payload) => {
        recordedSuccess = payload.success
      },
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: '文档已保存',
      cancelled: false,
      ...canonicalCloseout('文档已保存'),
      usedTools: ['document_save_tab'],
      terminalReason: 'adjudication_degraded',
      taskType: 'multi_step_task',
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: '保存文档',
    requestId: 'req-degraded-completion',
    coordinators: [],
  })

  assert.deepEqual(result, {
    success: true,
    responseText: '文档已保存',
    ...canonicalCloseout('文档已保存'),
  })
  assert.equal(events.at(-1)?.phase, 'done')
  assert.equal(events.at(-1)?.terminalReason, 'adjudication_degraded')
  assert.equal(recordedSuccess, true)
})

test('RunCoordinator keeps failed adjudication_degraded results as error events', async () => {
  const events: ScopeRunEventPayload[] = []
  let recordedSuccess: boolean | null = null

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 20, l0Chars: 10, l1Chars: 10, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: (payload) => {
        recordedSuccess = payload.success
      },
    },
    executeAndCollect: async () => ({
      success: false,
      error: 'criteria degraded',
      finalText: '文档已保存',
      cancelled: false,
      usedTools: ['document_save_tab'],
      terminalReason: 'adjudication_degraded',
      taskType: 'multi_step_task',
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: '保存文档',
    requestId: 'req-degraded-failure',
    coordinators: [],
  })

  assert.equal(result.success, false)
  assert.equal(result.errorKind, 'adjudication_degraded')
  assert.equal(events.at(-1)?.phase, 'error')
  assert.equal(events.at(-1)?.terminalReason, 'adjudication_degraded')
  assert.equal(recordedSuccess, false)
})

test('RunCoordinator creates a stable task id when execution host does not provide one', async () => {
  const events: ScopeRunEventPayload[] = []

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 20, l0Chars: 10, l1Chars: 10, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async (request) => ({
      success: true,
      finalText: 'done text',
      cancelled: false,
      ...canonicalCloseout('done text'),
      usedTools: [],
      taskId: request.taskId,
      executionDiagnostics: null,
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: 'hello',
    requestId: 'req-3',
    coordinators: []
  })

  assert.deepEqual(result, {
    success: true,
    responseText: 'done text',
    ...canonicalCloseout('done text'),
  })
  assert.match(events[0]?.taskId || '', /^task-/)
  assert.equal(events[0]?.taskId, events.at(-1)?.taskId)
  assert.equal(events[0]?.taskProjectionId, events[0]?.taskId)
})

test('RunCoordinator preserves typed scope run authority on failed execution', async () => {
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 20, l0Chars: 10, l1Chars: 10, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({
      success: false,
      finalText: '',
      cancelled: false,
      usedTools: [],
      error: 'newer send took ownership',
      terminalReason: 'blocked_external',
      scopeRunAuthority: {
        state: 'lost',
        reason: 'superseded_by_newer_send',
        currentRunId: 'req-new',
      },
    }),
    emitScopeRunEvent: () => {},
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: 'hello',
    requestId: 'req-old',
    coordinators: [],
  })

  assert.equal(result.success, false)
  assert.equal(result.error, 'newer send took ownership')
  assert.deepEqual(result.scopeRunAuthority, {
    state: 'lost',
    reason: 'superseded_by_newer_send',
    currentRunId: 'req-new',
  })
})

// P1 fix (2026-07-03, live regression) — cross-cutting site-experience
// fragments must NOT seed the planning task title; they are injected context,
// not task descriptors. Browser discipline no longer enters triggerHits.
function coordinatorWithTriggers(triggerHits: ScopeRunEventPayload['triggerHits']): {
  coordinator: RunCoordinator
  events: ScopeRunEventPayload[]
} {
  const events: ScopeRunEventPayload[] = []
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits,
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }) as never,
      applyToMessage: () => 'hello',
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({ success: true, finalText: 'done', cancelled: false, usedTools: [] }) as never,
    emitScopeRunEvent: (payload) => { events.push(payload) },
    reflectOnConversation: async () => null,
  })
  return { coordinator, events }
}

test('planning title skips cross-cutting fragments and uses the real task fragment', async () => {
  const { coordinator, events } = coordinatorWithTriggers([
    { id: 'site-card-xiaohongshu.com', label: '站点经验 xiaohongshu.com', module: 'browser', blocking: false, refs: [] },
    { id: 'rss-analysis', label: 'RSS 分析操作', module: 'rss', blocking: false, refs: [] },
  ] as never)
  await coordinator.runScoped({ scope: createScope(), message: 'hello', requestId: 'req-title-1', coordinators: [] })
  assert.equal(events[0]?.taskTitle, 'RSS 分析操作')
  assert.notEqual(events[0]?.taskTitle, '站点经验 xiaohongshu.com')
})

test('planning title falls back to the neutral placeholder when only cross-cutting fragments matched', async () => {
  const { coordinator, events } = coordinatorWithTriggers([
    { id: 'site-card-xiaohongshu.com', label: '站点经验 xiaohongshu.com', module: 'browser', blocking: false, refs: [] },
  ] as never)
  await coordinator.runScoped({ scope: createScope(), message: 'hello', requestId: 'req-title-2', coordinators: [] })
  assert.equal(events[0]?.taskTitle, '正在理解需求')
})

test('真机回归 2026-07-04：流程知识片段（逐篇采集/上传流程）不做任务标题', async () => {
  // 此前发布 run 顶着"浏览器逐篇采集"标题、大量浏览器任务卡长期显示
  // "浏览器上传流程"（注入指导 ≠ 任务名）。两者与 site-card
  // 同类，标题一律回中性占位，等真实任务标题回填。
  const { coordinator, events } = coordinatorWithTriggers([
    { id: 'browser-collect-notes', label: '浏览器逐篇采集', module: 'browser', blocking: false, refs: [] },
    { id: 'browser-upload', label: '浏览器上传流程', module: 'browser', blocking: false, refs: [] },
  ] as never)
  await coordinator.runScoped({ scope: createScope(), message: '帮我发一条小红书长文笔记', requestId: 'req-title-3', coordinators: [] })
  assert.equal(events[0]?.taskTitle, '正在理解需求')
})
