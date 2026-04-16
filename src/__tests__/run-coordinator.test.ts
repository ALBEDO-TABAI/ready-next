import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/run-coordinator'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture
} from '../main/modules/agent-control/types'

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
      if (request.budgetState) {
        request.budgetState.iterationsUsed = 3
        request.budgetState.toolCallsUsed = 4
        request.budgetState.parallelToolGroupsUsed = 1
      }
      return {
        success: true,
        finalText: 'done text',
        cancelled: false,
        usedTools: ['browser_click_at'],
        budgetState: request.budgetState,
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
    requestId: 'req-1'
  })

  assert.deepEqual(result, { success: true })
  assert.equal(events[0]?.phase, 'planning')
  assert.equal(events[0]?.module, 'browser')
  assert.equal(events[0]?.taskTitle, '浏览器上传流程')
  assert.match(events[0]?.taskSummary || '', /准备开始/)
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
  assert.equal(recordedOutcome?.success, true)
  assert.equal(recordedOutcome?.finalText, 'done text')
  assert.deepEqual(recordedOutcome?.usedTools, ['browser_click_at'])
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
    executeAndCollect: async () => ({
      success: true,
      finalText: 'done text',
      cancelled: false,
      usedTools: ['document_update_widget'],
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
  })

  assert.deepEqual(result, { success: true })
  assert.equal(events.at(-1)?.taskType, 'multi_step_task')
  assert.equal(events.at(-1)?.interactionState, 'running')
  assert.equal(events.at(-1)?.taskProjectionId, 'task-proj-1')
  assert.equal(events.at(-1)?.executionDiagnostics?.budgetUsagePercent, 70)
  assert.equal(events.at(-1)?.executionDiagnostics?.degradationReason, 'browser_host_unavailable')
})
