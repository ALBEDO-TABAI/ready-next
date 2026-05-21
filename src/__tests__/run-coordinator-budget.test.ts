import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/task-projection/run-coordinator'
import {
  applyRunBudgetHint,
  createStepBudgetState,
  createTaskBudgetRuntime,
  canUseParallelToolGroup,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  freezeBudgetRuntime,
  getBudgetWarningLevel,
  applyLongSkillTaskBudgetSeed,
  createRunBudgetSeed,
  getBudgetUsagePercent,
  getRemainingToolCallBudget,
  refundIterationBudget,
  resumeBudgetRuntime,
} from '../main/modules/agent-control/task-projection/run-budget-policy'
import type { ConversationScope, ScopeRunEventPayload } from '../main/modules/agent-control/contracts/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-budget-1',
    agent: 'butler',
    title: '预算测试',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-budget-1',
    meta: {},
    createdAt: '2026-04-16T00:00:00.000Z',
    updatedAt: '2026-04-16T00:00:00.000Z',
    lastMessageAt: '2026-04-16T00:00:00.000Z',
  }
}

test('RunCoordinator seeds scoped runs with a bootstrap budget and rebinds it after task type resolution', async () => {
  const events: ScopeRunEventPayload[] = []
  let executionRuntime: {
    taskType: string
    bootstrapBudget: boolean
    budget: { maxIterations: number; maxToolCalls: number }
  } | null = null

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async (request) => {
      executionRuntime = request.taskBudgetRuntime
        ? {
          taskType: request.taskBudgetRuntime.taskType,
          bootstrapBudget: request.taskBudgetRuntime.bootstrapBudget,
          budget: {
            maxIterations: request.taskBudgetRuntime.budget.maxIterations,
            maxToolCalls: request.taskBudgetRuntime.budget.maxToolCalls,
          },
        }
        : null
      return {
        success: true,
        finalText: 'done',
        cancelled: false,
        usedTools: [],
        taskType: 'direct_answer',
      }
    },
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: '你好',
    requestId: 'req-budget-1',
    coordinators: []
  })

  const finalEvent = events[events.length - 1]
  assert.equal(result.success, true)
  assert.deepEqual(executionRuntime, {
    taskType: 'short_task',
    bootstrapBudget: true,
    budget: {
      maxIterations: 24,
      maxToolCalls: 24,
    },
  })
  assert.equal(finalEvent?.executionDiagnostics?.taskBudgetRuntime?.taskType, 'direct_answer')
  assert.equal(finalEvent?.executionDiagnostics?.taskBudgetRuntime?.bootstrapBudget, false)
  assert.equal(finalEvent?.executionDiagnostics?.budget?.maxIterations, 8)
  assert.equal(finalEvent?.executionDiagnostics?.budget?.maxToolCalls, 8)
})

test('RunCoordinator memory reflection event does not overwrite task summary', async () => {
  const events: ScopeRunEventPayload[] = []
  let memoryCaptured: (() => void) | null = null
  const memoryCapturedPromise = new Promise<void>((resolve) => {
    memoryCaptured = resolve
  })

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'done',
      cancelled: false,
      usedTools: ['skill_get_state'],
      taskType: 'short_task',
      projectionTruth: {
        transcriptEvents: [],
        projectionPatch: {
          taskSummary: '原任务摘要',
        },
      },
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => ({
      status: 'ready',
      createdAt: '2026-04-26T10:00:00.000Z',
      note: null,
      items: [
        {
          memoryId: 'memory-1',
          category: 'summary',
          title: '偏好',
          summary: '保持简洁',
        },
      ],
    }),
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: '记住这个偏好',
    requestId: 'req-memory-1',
    coordinators: []
  }, {
    onMemoryCapture: () => {
      memoryCaptured?.()
    },
  })
  await memoryCapturedPromise

  const memoryEvent = events.find((event) => event.memoryCapture)
  assert.ok(memoryEvent)
  assert.equal(memoryEvent.taskSummary, undefined)
  assert.equal(memoryEvent.memoryCapture?.items.length, 1)
})

test('RunCoordinator does not mark an exhausted background skill task as done', async () => {
  const events: ScopeRunEventPayload[] = []
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'background handoff',
      cancelled: false,
      usedTools: ['skill_start_detached'],
      taskType: 'multi_step_task',
      interactionState: 'suspended',
      executionDiagnostics: {
        budgetUsagePercent: 100,
        budgetWarningLevel: 'exhausted',
      },
      projectionTruth: {
        transcriptEvents: [],
        projectionPatch: {
          module: 'skill',
          taskTitle: '技能执行 · Video Expert Analyzer',
          taskSummary: '预算已耗尽，但后台视频分析仍在运行',
          steps: [{
            id: 'skill_video_expert_pipeline#1',
            title: '视频分析',
            status: 'running',
            updatedAt: '2026-04-28T01:00:00.000Z',
          }],
          currentStepId: 'skill_video_expert_pipeline#1',
          waitingFor: 'background',
          resumableActions: ['continue', 'cancel'],
          blockedReason: '预算已耗尽，但后台任务仍在运行',
          taskContinuation: {
            taskId: 'task-background',
            stepId: 'skill_video_expert_pipeline#1',
            blockerType: 'budget_exhausted',
          },
        },
      },
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => null,
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: '继续视频分析',
    requestId: 'req-budget-background',
    coordinators: []
  })

  const finalEvent = events[events.length - 1]
  assert.equal(finalEvent?.phase, 'checkpoint')
  assert.equal(finalEvent?.interactionState, 'suspended')
  assert.equal(finalEvent?.waitingFor, 'background')
  assert.deepEqual(finalEvent?.resumableActions, ['continue', 'cancel'])
})

test('RunCoordinator prioritizes lifecycle signal over a success result', async () => {
  const events: ScopeRunEventPayload[] = []
  const outcomes: Array<{ success: boolean; finalText: string }> = []
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: (payload) => {
        outcomes.push({ success: payload.success, finalText: payload.finalText })
      },
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'success text',
      cancelled: false,
      usedTools: ['skill_run_shell'],
      taskType: 'multi_step_task',
      skillTaskLifecycle: {
        state: 'budget_paused',
        reason: 'budget_exhausted',
        phase: 'checkpoint',
        interactionState: 'suspended',
        waitingFor: 'background',
        resumableActions: ['continue', 'retry', 'cancel'],
        blockedReason: '本轮预算已用完，技能任务已暂停，可继续执行',
        taskContinuation: {
          taskId: 'str-budget',
          taskRunId: 'str-budget',
          runStatePath: '/tmp/ready/run_state.json',
          pauseReason: 'budget_exhausted',
        },
      },
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => null,
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: '继续视频分析',
    requestId: 'req-lifecycle-priority',
    coordinators: []
  })

  const finalEvent = events[events.length - 1]
  assert.equal(finalEvent?.phase, 'checkpoint')
  assert.equal(finalEvent?.interactionState, 'suspended')
  assert.equal(finalEvent?.waitingFor, 'background')
  assert.deepEqual(finalEvent?.resumableActions, ['continue', 'retry', 'cancel'])
  assert.equal(finalEvent?.taskContinuation?.taskRunId, 'str-budget')
  assert.equal(outcomes[0]?.success, false)
})

test('RunCoordinator maps terminalReason checkpoint_budget to checkpoint outcome', async () => {
  const events: ScopeRunEventPayload[] = []
  const outcomes: Array<{ success: boolean; lifecyclePhase?: ScopeRunEventPayload['phase'] }> = []
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: (payload) => {
        outcomes.push({ success: payload.success, lifecyclePhase: payload.lifecyclePhase })
      },
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'checkpoint text',
      cancelled: false,
      usedTools: ['skill_run_shell'],
      taskType: 'multi_step_task',
      interactionState: 'suspended',
      terminalReason: 'checkpoint_budget',
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: '继续视频分析',
    requestId: 'req-terminal-reason',
    coordinators: []
  })

  const finalEvent = events[events.length - 1]
  assert.equal(result.success, true)
  assert.equal(finalEvent?.phase, 'checkpoint')
  assert.equal(finalEvent?.terminalReason, 'checkpoint_budget')
  assert.equal(outcomes[0]?.success, false)
  assert.equal(outcomes[0]?.lifecyclePhase, 'checkpoint')
})

test('RunCoordinator memory reflection does not convert a paused background skill task to done', async () => {
  const events: ScopeRunEventPayload[] = []
  let memoryCaptured: (() => void) | null = null
  const memoryCapturedPromise = new Promise<void>((resolve) => {
    memoryCaptured = resolve
  })
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'background handoff',
      cancelled: false,
      usedTools: ['skill_start_detached'],
      taskType: 'multi_step_task',
      interactionState: 'suspended',
      projectionTruth: {
        transcriptEvents: [],
        projectionPatch: {
          module: 'skill',
          taskSummary: '预算已耗尽，但后台视频分析仍在运行',
          waitingFor: 'background',
          resumableActions: ['continue', 'cancel'],
          blockedReason: '预算已耗尽，但后台任务仍在运行',
        },
      },
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => ({
      status: 'ready',
      createdAt: '2026-04-28T01:00:00.000Z',
      note: null,
      items: [
        {
          memoryId: 'memory-background',
          category: 'summary',
          title: '后台任务',
          summary: '视频分析后台运行中',
        },
      ],
    }),
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: '继续视频分析',
    requestId: 'req-budget-background-memory',
    coordinators: []
  }, {
    onMemoryCapture: () => {
      memoryCaptured?.()
    },
  })
  await memoryCapturedPromise

  const memoryEvent = events.find((event) => event.memoryCapture)
  assert.ok(memoryEvent)
  assert.equal(memoryEvent.phase, 'checkpoint')
  assert.equal(memoryEvent.waitingFor, 'background')
})

test('run budget policy applies hints to the active step budget instead of inflating the global task seed', () => {
  const seed = createRunBudgetSeed()
  const runtime = createTaskBudgetRuntime('short_task', {
    budget: seed,
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: seed.maxIterations,
      suggestedMaxIterations: 8,
    }),
  })
  const hinted = applyRunBudgetHint(runtime, {
    maxIterations: 12,
    reserveToolCalls: 3,
  })

  assert.equal(hinted.budget.maxIterations, seed.maxIterations)
  assert.equal(hinted.budget.maxToolCalls, seed.maxToolCalls)
  assert.equal(hinted.stepBudget?.maxIterations, 12)
  assert.equal(hinted.stepBudget?.remainingIterations, 12)
})

test('run budget policy tracks iterations, tool calls, and parallel groups independently', () => {
  let usage = {
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  }

  usage = consumeIterationBudget(usage)
  usage = consumeToolCallBudget(usage, 2)
  usage = consumeParallelGroupBudget(usage)

  assert.deepEqual(usage, {
    iterationsUsed: 1,
    toolCallsUsed: 2,
    parallelToolGroupsUsed: 1,
  })
})

test('run budget policy exposes remaining tool capacity and parallel group availability', () => {
  const seed = createRunBudgetSeed()
  const usage = {
    iterationsUsed: 2,
    toolCallsUsed: seed.maxToolCalls - 1,
    parallelToolGroupsUsed: seed.maxParallelToolGroups,
  }

  assert.equal(getRemainingToolCallBudget(seed, usage), 1)
  assert.equal(canUseParallelToolGroup(seed, usage), false)
})

test('run budget policy seeds different iteration budgets for direct, short, and multi-step tasks', () => {
  const direct = createRunBudgetSeed('direct_answer')
  const short = createRunBudgetSeed('short_task')
  const multi = createRunBudgetSeed('multi_step_task')
  const media = createRunBudgetSeed('media_task')

  assert.equal(direct.maxIterations, 8)
  assert.equal(short.maxIterations, 24)
  // skill-resume C2: multi_step_task budget reduced 60→40 to suppress runaway tool loops
  assert.equal(multi.maxIterations, 40)
  assert.equal(media.maxIterations, 60)
  assert.equal(short.maxParallelToolGroups, 5)
})

test('run budget policy grants long skill resume tasks the hard cap without changing short task preset', () => {
  const short = createRunBudgetSeed('short_task')
  const longSkill = applyLongSkillTaskBudgetSeed(short)

  assert.equal(short.maxIterations, 24)
  assert.equal(short.maxToolCalls, 24)
  assert.equal(longSkill.maxIterations, 220)
  assert.equal(longSkill.maxToolCalls, 220)
})

test('run budget policy computes a stable usage percentage from the active budget counters', () => {
  const seed = createRunBudgetSeed('multi_step_task')
  // skill-resume C2: multi_step_task budget reduced 60→40, so 20/40 = 50%
  const usage = {
    iterationsUsed: 20,
    toolCallsUsed: 10,
    parallelToolGroupsUsed: 2,
  }

  assert.equal(getBudgetUsagePercent(seed, usage), 50)
})

test('run budget policy creates and refunds step budget iterations', () => {
  const seed = createRunBudgetSeed('multi_step_task')
  let runtime = createTaskBudgetRuntime('multi_step_task', {
    budget: seed,
    stepBudget: createStepBudgetState({
      stepId: 'collect',
      totalIterations: seed.maxIterations,
      stepCount: 3,
    }),
  })

  // skill-resume C2: multi_step_task=40, stepCount=3 → ceil(40/3)=14 per step
  runtime = consumeIterationBudget(runtime)
  assert.equal(runtime.stepBudget?.remainingIterations, 13)

  runtime = refundIterationBudget(runtime)
  assert.equal(runtime.stepBudget?.remainingIterations, 14)
  assert.equal(runtime.usage.iterationsUsed, 0)
})

test('run budget policy exposes warning levels and freeze/resume state', () => {
  const seed = createRunBudgetSeed('short_task')
  let runtime = createTaskBudgetRuntime('short_task', {
    budget: seed,
    usage: {
      iterationsUsed: 22,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    },
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: seed.maxIterations,
      suggestedMaxIterations: 24,
    }),
  })

  assert.equal(getBudgetWarningLevel(getBudgetUsagePercent(runtime)), 'converge')
  runtime = freezeBudgetRuntime(runtime)
  assert.equal(runtime.frozen, true)
  runtime = resumeBudgetRuntime(runtime)
  assert.equal(runtime.frozen, false)
})
