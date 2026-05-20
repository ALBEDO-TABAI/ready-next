import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/agent-sdk-runtime'
import { RunCoordinator } from '../main/modules/agent-control/task-projection/run-coordinator'
import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import { runConfirmedSendScoped } from '../main/modules/agent-control/send-scoped-confirmation'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import type { ChatConversationRecord, DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import type { ProjectionTruthSnapshot } from '../main/modules/agent-control/run-contracts'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture,
  ScopeRunSummary,
} from '../main/modules/agent-control/types'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function createToolDefinition(): ToolDefinition {
  return {
    name: 'web_search',
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Search test source',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function mapScope(row: ChatConversationRecord): ConversationScope {
  return {
    id: row.id,
    agent: row.agent,
    title: row.title,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    threadKey: row.thread_key,
    userId: row.user_id || undefined,
    meta: row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.updated_at,
  }
}

test('SDK scoped run persists user message, assistant snapshot, scope run, and task projection', async (t) => {
  if (skipIfSqliteUnavailable(t, 'agent-sdk scoped run persistence')) return
  const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
  let db: DatabaseManagerInstance | null = null

  try {
    db = new DatabaseManager(true)
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      t.skip('better-sqlite3 native binding unavailable in this Node runtime')
      return
    }
    throw error
  }

  try {
    const scopeId = 'conv-sdk-scoped-proof'
    const requestId = 'run-sdk-scoped-proof'
    db.upsertConversationScope({
      id: scopeId,
      agent: 'butler',
      title: 'SDK scoped proof',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: scopeId,
      meta: {},
    })

    const scopeSummaries = new Map<string, ScopeRunSummary>()
    const scopeEvents: ScopeRunEventPayload[] = []
    const projectionSyncs: Array<Promise<void>> = []
    const taskProjectionStore = new TaskProjectionRepository(db)
    const runProjection = new RunProjection({
      getScope: (id) => {
        const row = db?.getConversationScope(id)
        return row ? mapScope(row) : null
      },
      getPrevious: (id) => scopeSummaries.get(id),
      setSummary: (id, summary) => scopeSummaries.set(id, summary),
      toChannelKey: (scope) => `${scope.sourceKind}:${scope.sourceId}:${scope.threadKey}`,
    })

    const runtime = new AgentSdkRuntime({
      loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
      listToolDefinitions: () => [createToolDefinition()],
      executeToolCall: async () => createToolExecutionOutput('found scoped proof', {
        shape: 'json',
        data: { ok: true },
        projectionPatch: {
          taskTitle: 'SDK scoped proof',
          taskSummary: 'Projection truth came from the SDK tool bridge',
          steps: [{ id: 'sdk_tool', title: 'Run SDK tool', status: 'completed' }],
          currentStepId: 'sdk_tool',
        },
      }),
      runAgent: async ({ tools, onTextDelta }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ query: 'scope persistence' }))
        onTextDelta('SDK scoped run finished')
        return { finalText: 'SDK scoped run finished' }
      },
      domainAdapters: [],
    } satisfies AgentSdkRuntimeDeps)
    runtime.newSession(`butler::${scopeId}`, 'system prompt')

    const coordinator = new RunCoordinator({
      promptAssembly: {
        buildForScopedRun: async () => ({
          systemPrompt: 'system prompt',
          bootstrapMessages: [],
          memoryRefs: [],
          triggerHits: [
            {
              id: 'sdk-research',
              label: 'SDK scoped proof',
              module: 'research',
              blocking: false,
              refs: [],
            },
          ],
          contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
        }),
        applyToMessage: (message) => message,
        recordRunOutcome: () => {},
      },
      executeAndCollect: async (request) => runtime.sendMessage(
        `butler::${scopeId}`,
        request.message as string,
        request.requestId,
        {
          publicSessionId: scopeId,
          taskId: request.taskId,
        },
      ),
      emitScopeRunEvent: (payload, projectionTruth?: ProjectionTruthSnapshot | null) => {
        scopeEvents.push(payload)
        const summary = runProjection.recordEvent(payload, projectionTruth || null)
        if (summary) {
          projectionSyncs.push(syncTaskProjection(taskProjectionStore, summary, payload, projectionTruth || null))
        }
      },
      reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
    })

    const result = await runConfirmedSendScoped({
      scopeId,
      agent: 'butler',
      userMessage: {
        id: 'user-sdk-scoped-proof',
        content: 'please prove SDK scoped persistence',
        timestamp: '2026-05-13T10:00:00.000Z',
        meta: { clientMessageId: 'client-sdk-scoped-proof' },
      },
      getScope: (id) => db!.getConversationScope(id),
      createLocalScope: (agent, id) => db!.upsertConversationScope({
        id,
        agent,
        title: 'SDK scoped proof',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: id,
        meta: {},
      }).row,
      persistUserMessage: (scopeRow, userMessage) => {
        db!.addChatMessage(
          userMessage.id,
          scopeRow.id,
          'user',
          userMessage.content,
          userMessage.timestamp || new Date().toISOString(),
          userMessage.meta,
        )
      },
      runConfirmed: async (scopeRow, persistence) => {
        const scope = mapScope(scopeRow)
        const run = await coordinator.runScoped(
          {
            scope,
            message: 'please prove SDK scoped persistence',
            requestId,
            coordinators: [],
          },
          {
            onSuccess: async (executionResult) => {
              const finalEvent = scopeEvents.at(-1)
              db!.addChatMessage(
                'assistant-sdk-scoped-proof',
                scope.id,
                'assistant',
                executionResult.finalText,
                '2026-05-13T10:00:01.000Z',
                {
                  runtime: 'sdk',
                  taskSnapshot: finalEvent,
                  usedTools: executionResult.usedTools,
                },
              )
            },
          },
        )
        return { ...run, persistence }
      },
    })
    await Promise.all(projectionSyncs)

    assert.equal(result.success, true)
    assert.equal(result.persistence?.message, 'persisted')

    const messages = db.getChatMessages(scopeId)
    assert.equal(messages.length, 2)
    assert.equal(messages[0].role, 'user')
    assert.equal(messages[0].content, 'please prove SDK scoped persistence')
    assert.equal(messages[1].role, 'assistant')
    assert.equal(messages[1].content, 'SDK scoped run finished')
    const assistantMeta = JSON.parse(messages[1].meta_json || '{}') as {
      runtime?: string
      taskSnapshot?: ScopeRunEventPayload
      usedTools?: string[]
    }
    assert.equal(assistantMeta.runtime, 'sdk')
    assert.equal(assistantMeta.taskSnapshot?.phase, 'done')
    assert.equal(assistantMeta.taskSnapshot?.terminalReason, 'done')
    assert.deepEqual(assistantMeta.usedTools, ['web_search'])

    assert.equal(scopeEvents[0]?.phase, 'planning')
    assert.equal(scopeEvents.at(-1)?.phase, 'done')
    assert.equal(scopeEvents.at(-1)?.terminalReason, 'done')
    assert.equal(scopeEvents.at(-1)?.taskTitle, 'SDK scoped proof')

    const taskId = scopeEvents.at(-1)?.taskId
    assert.ok(taskId)
    const projection = taskProjectionStore.get(taskId)
    assert.ok(projection)
    assert.equal(projection.scopeId, scopeId)
    assert.equal(projection.status, 'done')
    assert.equal(projection.taskTitle, 'SDK scoped proof')
    assert.equal(projection.taskSummary, 'Projection truth came from the SDK tool bridge')
    assert.equal(projection.currentStepId, 'sdk_tool')
  } finally {
    db?.close()
  }
})
