import assert from 'node:assert/strict'
import test from 'node:test'

import { DocumentDomainAdapter } from '../main/modules/agent-control/document-domain-adapter'
import { createToolExecutionOutput } from '../main/modules/agent-control/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'
import type { ToolRegistryReader } from '../main/modules/agent-control/tool-registry'

function createRoute() {
  return {
    taskId: 'task-1',
    taskType: 'short_task' as const,
    chain: 'domain_executor' as const,
    executor: 'document' as const,
    steps: [],
    continuation: null,
  }
}

function createDefinition(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: overrides.name || 'document_insert_widget',
    groupId: 'document' as never,
    domain: 'document',
    kind: 'write',
    concurrency: 'serialized',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'document_write',
    supportsTextBridge: true,
    projectionHint: overrides.projectionHint ?? { mutating: true, emitsProjectionPatch: true },
    description: overrides.name || 'document_insert_widget',
    schema: null,
    resultShape: 'projection_patch',
  } as ToolDefinition
}

function createRegistry(definitions: Record<string, ToolDefinition | null>): ToolRegistryReader {
  return {
    hasDynamicSource: () => false,
    getToolDefinition: (name: string) => definitions[name] || null,
    listToolDefinitions: () => Object.values(definitions).filter((d): d is ToolDefinition => Boolean(d)),
    getToolDefinitionsForGroup: () => [],
    getToolSchemasForGroup: () => [],
  }
}

function createApplyParams(overrides: {
  domainState: unknown
  executedTools: Array<{ id: string; name: string; input: Record<string, unknown>; result: ReturnType<typeof createToolExecutionOutput> }>
}) {
  return {
    route: createRoute(),
    request: {
      sessionId: 'scope-1',
      runId: 'run-1',
      taskId: 'task-1',
      agentName: 'ready',
      abortSignal: new AbortController().signal,
      emitters: {
        emitOutput: () => undefined,
        emitStatus: () => undefined,
        emitRuntimeError: () => undefined,
        emitToolAction: () => undefined,
      },
    } as never,
    host: { providerContext: {}, log: () => undefined } as never,
    session: { messages: [] } as never,
    userText: 'doc task',
    pureUserInput: 'doc task',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: { forceDocumentTool: false } as never,
    allowedToolNames: ['document_insert_widget', 'document_update_widget'],
    emitStructuredTaskPayload: () => undefined,
    domainState: overrides.domainState,
    phase: 'tool_batch' as const,
    toolBatch: {
      executedTools: overrides.executedTools,
      executedDocActionCount: overrides.executedTools.length,
      executedMutatingDocActionCount: overrides.executedTools.length,
      executedInspectionDocActionCount: 0,
      executedSaveDocActionCount: 0,
      documentToolResultsThisIteration: [],
      documentToolInspections: [],
    },
  } as never
}

test('DocumentDomainAdapter accumulates projection steps from emitsProjectionPatch hints', async () => {
  const registry = createRegistry({
    document_insert_widget: createDefinition({ name: 'document_insert_widget' }),
    document_update_widget: createDefinition({ name: 'document_update_widget' }),
  })

  const adapter = new DocumentDomainAdapter({
    orchestrator: {} as never,
    toolLoopOrchestrator: {
      createState: () => ({ stepId: null }),
      applyToolInspection: (state: unknown) => state,
      handleNoToolCall: () => ({ state: { stepId: null } }),
      handleIterationResult: () => ({ state: { stepId: null } }),
      buildStructuredTaskPayload: () => ({
        module: 'document',
        message: 'done',
        taskTitle: '文档修改',
        taskSummary: 'done',
        steps: [{ id: 'execute', title: '文档修改', status: 'done', updatedAt: 'x' }],
        currentStepId: 'execute',
        waitingFor: 'none',
        resumableActions: ['cancel'],
      }),
      getBudgetHint: () => null,
    } as never,
    toolRegistry: registry,
  })

  const initial = {
    toolLoopState: { stepId: null },
    taskTitle: '文档修改',
    projectionSteps: [],
    currentStepId: null,
  }

  const afterFirst = await adapter.applyResult(createApplyParams({
    domainState: initial,
    executedTools: [{
      id: 'call-1',
      name: 'document_insert_widget',
      input: { widgetId: 'w-1' },
      result: createToolExecutionOutput('已插入 widget w-1'),
    }],
  }))

  const state1 = afterFirst.domainState as typeof initial
  assert.equal(state1.projectionSteps.length, 1, 'first tool adds a projection step')
  assert.equal(state1.projectionSteps[0]!.id, 'document_insert_widget')
  assert.equal(state1.projectionSteps[0]!.status, 'done')
  assert.equal(state1.currentStepId, 'document_insert_widget')
  assert.equal(afterFirst.projection, undefined, 'tool_batch phase does not finalize')

  const afterSecond = await adapter.applyResult(createApplyParams({
    domainState: state1,
    executedTools: [{
      id: 'call-2',
      name: 'document_update_widget',
      input: { widgetId: 'w-1' },
      result: createToolExecutionOutput('已更新 widget w-1'),
    }],
  }))

  const state2 = afterSecond.domainState as typeof initial
  assert.equal(state2.projectionSteps.length, 2, 'second tool appends another step')
  assert.equal(state2.projectionSteps[1]!.id, 'document_update_widget')
  assert.equal(state2.currentStepId, 'document_update_widget')

  const patch = adapter.buildProjectionPatch({
    route: createRoute(),
    request: { sessionId: 'scope-1' } as never,
    executionIntentContext: {} as never,
    toolPolicy: {} as never,
    domainState: state2,
    projection: { phase: 'done', summary: 'done' },
  })
  assert.ok(patch, 'builds projection patch')
  const steps = (patch as { steps?: Array<{ id: string }> }).steps || []
  assert.equal(steps.length, 2, 'projection patch surfaces accumulated steps')
  assert.equal((patch as { currentStepId?: string }).currentStepId, 'document_update_widget')
})

test('DocumentDomainAdapter ignores tools without emitsProjectionPatch hint', async () => {
  const registry = createRegistry({
    document_set_content: createDefinition({ name: 'document_set_content', projectionHint: { mutating: true } }),
  })

  const adapter = new DocumentDomainAdapter({
    orchestrator: {} as never,
    toolLoopOrchestrator: {
      createState: () => ({ stepId: null }),
      applyToolInspection: (state: unknown) => state,
      handleNoToolCall: () => ({ state: { stepId: null } }),
      handleIterationResult: () => ({ state: { stepId: null } }),
      buildStructuredTaskPayload: () => ({ steps: [], currentStepId: 'execute' }),
      getBudgetHint: () => null,
    } as never,
    toolRegistry: registry,
  })

  const initial = {
    toolLoopState: { stepId: null },
    taskTitle: '文档修改',
    projectionSteps: [],
    currentStepId: null,
  }

  const result = await adapter.applyResult(createApplyParams({
    domainState: initial,
    executedTools: [{
      id: 'call-1',
      name: 'document_set_content',
      input: {},
      result: createToolExecutionOutput('ok'),
    }],
  }))

  const state = result.domainState as typeof initial
  assert.equal(state.projectionSteps.length, 0, 'no hint → no step accumulation')
  assert.equal(state.currentStepId, null)
})

test('DocumentDomainAdapter marks failed tool runs as error status', async () => {
  const registry = createRegistry({
    document_insert_widget: createDefinition({ name: 'document_insert_widget' }),
  })

  const adapter = new DocumentDomainAdapter({
    orchestrator: {} as never,
    toolLoopOrchestrator: {
      createState: () => ({ stepId: null }),
      applyToolInspection: (state: unknown) => state,
      handleNoToolCall: () => ({ state: { stepId: null } }),
      handleIterationResult: () => ({ state: { stepId: null } }),
      buildStructuredTaskPayload: () => ({ steps: [], currentStepId: null }),
      getBudgetHint: () => null,
    } as never,
    toolRegistry: registry,
  })

  const initial = {
    toolLoopState: { stepId: null },
    taskTitle: '文档修改',
    projectionSteps: [],
    currentStepId: null,
  }

  const result = await adapter.applyResult(createApplyParams({
    domainState: initial,
    executedTools: [{
      id: 'call-1',
      name: 'document_insert_widget',
      input: {},
      result: createToolExecutionOutput('错误：widget 已存在'),
    }],
  }))

  const state = result.domainState as typeof initial
  assert.equal(state.projectionSteps.length, 1)
  assert.equal(state.projectionSteps[0]!.status, 'error')
})
