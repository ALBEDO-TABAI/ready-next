import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/run-coordinator'
import { createWorkerSessionIdentity } from '../main/modules/agent-control/worker-session'
import type { ExecutionHostRequest } from '../main/modules/agent-control/run-contracts'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture,
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
    createdAt: '2026-04-17T10:00:00.000Z',
    updatedAt: '2026-04-17T10:00:00.000Z',
  }
}

test('createWorkerSessionIdentity generates a child task id and isolated worker session id', () => {
  const first = createWorkerSessionIdentity({
    scopeId: 'scope-1',
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
  })
  const second = createWorkerSessionIdentity({
    scopeId: 'scope-1',
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
  })

  assert.equal(first.parentTaskId, 'parent-1')
  assert.equal(first.parentStepId, 'job-1')
  assert.notEqual(first.taskId, 'parent-1')
  assert.notEqual(first.workerSessionId, 'scope-1')
  assert.notEqual(first.taskId, second.taskId)
  assert.notEqual(first.workerSessionId, second.workerSessionId)
  assert.match(first.workerSessionId, /worker/i)
})

test('RunCoordinator passes sessionIdOverride into the execution host while scope events stay on the original scope', async () => {
  const events: ScopeRunEventPayload[] = []
  let capturedRequest: ExecutionHostRequest | null = null

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
    executeAndCollect: async (request) => {
      capturedRequest = request
      return {
        success: true,
        finalText: 'worker done',
        cancelled: false,
        usedTools: [],
        taskId: 'child-task-1',
        taskType: 'direct_answer',
        interactionState: 'running',
        taskProjectionId: 'child-task-1',
      }
    },
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: '执行子任务',
    requestId: 'req-child',
    taskId: 'child-task-1',
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
    sessionIdOverride: 'worker-session-1',
  })

  assert.equal(capturedRequest?.sessionId, 'scope-1')
  assert.equal(capturedRequest?.sessionIdOverride, 'worker-session-1')
  assert.equal(events[0]?.scopeId, 'scope-1')
  assert.equal(events[0]?.parentTaskId, 'parent-1')
  assert.equal(events[0]?.parentStepId, 'job-1')
})
