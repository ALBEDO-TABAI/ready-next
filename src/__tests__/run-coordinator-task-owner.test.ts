import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/task-projection/run-coordinator'
import type { AgentExecutionProfile } from '../shared/agent-execution-profile'
import type { ConversationScope, ScopeRunEventPayload } from '../main/modules/agent-control/contracts/types'

function scope(activeAgentId: string): ConversationScope {
  return {
    id: 'scope-1', agent: 'butler', activeAgentId, handoffGeneration: 0,
    title: '会话', sourceKind: 'local', sourceId: 'app', threadKey: 'scope-1', meta: {},
    createdAt: 'now', updatedAt: 'now',
  }
}

function profile(id: string): AgentExecutionProfile {
  return {
    requestedAgentId: id, effectiveAgentId: id, personaRef: id, name: id,
    charter: '', personality: '', rules: '', knowledgeIndex: '', allowedKnowledgeRefs: [],
    knowledgeWriteOwnerAgentId: id, knowledgeWriteNamespace: `agents/${id}/knowledge`,
    executionMaterialHash: `hash:${id}`, readinessRevision: `ready:${id}`, redirectChain: [],
    readiness: { conversationReady: true, handoffReady: false, autoRoutable: false, collaborationReady: false, reasons: [] },
  }
}

function makeCoordinator(options: { existing?: { scopeId: string; ownerAgentId: string; taskOrigin: 'user_root' } | null } = {}) {
  const resolved: string[] = []
  const events: ScopeRunEventPayload[] = []
  const executionRequests: Array<Record<string, unknown>> = []
  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({ systemPrompt: '', bootstrapMessages: [], memoryRefs: [], triggerHits: [], contextBudget: null }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async (request) => {
      executionRequests.push(request as unknown as Record<string, unknown>)
      return { success: true, finalText: 'ok', cancelled: false, usedTools: [], terminalReason: 'done' }
    },
    emitScopeRunEvent: (event) => { events.push(event) },
    reflectOnConversation: async () => null,
    getTaskProjection: () => options.existing ?? null,
    resolveExecutionProfile: async (id) => { resolved.push(id); return profile(id) },
  })
  return { coordinator, resolved, events, executionRequests }
}

test('new tasks bind to conversation active agent, while continuations bind only to the target task owner', async () => {
  const fresh = makeCoordinator()
  await fresh.coordinator.runScoped({ scope: scope('copywriter'), message: '新任务', coordinators: [] })
  assert.deepEqual(fresh.resolved, ['copywriter'])
  assert.equal(fresh.events[0]?.ownerAgentId, 'copywriter')
  assert.equal(fresh.events[0]?.taskOrigin, 'user_root')

  const continuation = makeCoordinator({ existing: { scopeId: 'scope-1', ownerAgentId: 'analyst', taskOrigin: 'user_root' } })
  await continuation.coordinator.runScoped({ scope: scope('copywriter'), message: '继续', taskId: 'task-1', coordinators: [] })
  assert.deepEqual(continuation.resolved, ['analyst'])
  assert.equal(continuation.events[0]?.ownerAgentId, 'analyst')
  assert.equal(continuation.events[0]?.executionBinding?.runOrigin, 'continuation')
  assert.equal(continuation.events[0]?.taskOrigin, 'user_root')
})

test('scheduled occurrences enter the production run as system background work with explicit source identity', async () => {
  const harness = makeCoordinator()
  const occurrence = {
    occurrenceId: 'occ-1',
    scheduleId: 'schedule-1',
    scheduledFor: '2026-07-13T09:00:00.000Z',
    triggerSource: 'timer' as const,
  }
  await harness.coordinator.runScoped({
    scope: scope('copywriter'),
    message: 'write the daily note',
    coordinators: [],
    taskOrigin: 'system_background',
    runOrigin: 'scheduled_task',
    scheduledTaskOccurrence: occurrence,
  })

  assert.equal(harness.events[0]?.taskOrigin, 'system_background')
  assert.equal(harness.events[0]?.executionBinding?.runOrigin, 'scheduled_task')
  assert.equal(harness.events[0]?.executionBinding?.ownerAssignmentSource, 'scheduled_task')
  assert.deepEqual(harness.executionRequests[0]?.scheduledTaskOccurrence, occurrence)
})

test('scheduled occurrence source cannot be detached from its background origins', async () => {
  const harness = makeCoordinator()
  await assert.rejects(harness.coordinator.runScoped({
    scope: scope('copywriter'), message: 'invalid', coordinators: [],
    runOrigin: 'scheduled_task',
    taskOrigin: 'user_root',
    scheduledTaskOccurrence: {
      occurrenceId: 'occ-1', scheduleId: 'schedule-1',
      scheduledFor: '2026-07-13T09:00:00.000Z', triggerSource: 'timer',
    },
  }), /requires system_background/)
  assert.deepEqual(harness.resolved, [])
})

test('a continuation target from another scope fails before prompt or provider execution', async () => {
  const { coordinator, resolved, events } = makeCoordinator({ existing: { scopeId: 'scope-other', ownerAgentId: 'analyst', taskOrigin: 'user_root' } })
  await assert.rejects(
    coordinator.runScoped({ scope: scope('copywriter'), message: '继续', taskId: 'foreign-task', coordinators: [] }),
    /does not belong to scope/,
  )
  assert.deepEqual(resolved, [])
  assert.deepEqual(events, [])
})
