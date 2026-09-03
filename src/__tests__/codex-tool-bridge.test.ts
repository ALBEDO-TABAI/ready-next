import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { z } from 'zod'

import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  clearLastReferenceSkill,
  rememberLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { createToolExecutionOutput, type ToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolContext } from '../main/modules/tools/tool-executor'
import type {
  CodexToolBridgeExecutionBinding,
  CodexToolCallBindingRead,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import {
  defaultToolRegistry,
} from '../main/modules/agent-control/tools-runtime/tool-registry'
import {
  CodexReadyToolBridge,
  CodexToolBridgeError,
  createCodexReadyToolBridge,
  mapReadyToolOutput,
  validateCodexFrozenToolExecution,
  type CodexToolBridgePersistencePort,
} from '../main/modules/agent-control/codex-runtime/codex-tool-bridge'
import type {
  ReadyToolActionReceiptPort,
  ReadyToolActionReceiptRead,
} from '../main/modules/agent-control/codex-runtime/codex-tool-action-journal'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  buildCodexToolResponseDeliveryAttemptId,
  type CodexToolResponseDeliveryAttemptIdentity,
  type CodexToolResponseDeliveryAttemptRead,
} from '../main/modules/agent-control/codex-runtime/codex-tool-response-delivery'
import {
  CodexAppServerClient,
  type CodexJsonLineTransport,
  type CodexStartDispatchPort,
} from '../main/modules/agent-control/codex-runtime/codex-app-server-client'
import { CodexProvisionalInboundBuffer } from '../main/modules/agent-control/codex-runtime/codex-provisional-inbound-buffer'
import {
  buildReadyToolSurface,
  buildReadyBoundTurnToolAuthorization,
  buildReadyTurnToolAuthorization,
  type ReadyToolSurfaceEntry,
  type ReadyTurnToolAuthorization,
} from '../main/modules/agent-control/codex-runtime/codex-tool-surface'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})
after(() => __setScopeContextEpochDatabaseForTests(null))

function definition(
  name: string,
  executionTimeoutMs?: number,
  timeoutProfile: ToolDefinition['timeoutProfile'] = 'default',
): ToolDefinition {
  return {
    name,
    groupId: 'agent_interaction',
    domain: 'document',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile,
    supportsTextBridge: true,
    projectionHint: null,
    description: `Read with ${name}`,
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    executionTimeoutMs,
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function binding(
  allowedToolNames?: string[],
  executionTimeoutMs?: number,
  definitionOverride?: ToolDefinition,
  skillAuthorization: SkillToolAuthorization = buildExplicitNoSkillAuthorization('no_skill_signal'),
): CodexToolBridgeExecutionBinding {
  const toolDefinition = definitionOverride || definition('document_read', executionTimeoutMs)
  const toolSurface = buildReadyToolSurface({
    surfaceId: 'surface-1',
    toolDefinitions: [toolDefinition],
  })
  const built = buildReadyTurnToolAuthorization({
    authorizationId: 'authorization-1',
    authorization: skillAuthorization,
    toolSurface,
  })
  let authorization: ReadyTurnToolAuthorization = built
  if (allowedToolNames) {
    const unsigned = {
      authorizationId: built.authorizationId,
      allowedToolNames,
      skillAuthorization: built.skillAuthorization,
    }
    authorization = { ...unsigned, authorizationDigest: digestCanonicalJson(unsigned) }
  }
  return {
    bindingId: 'run-1',
    readyAliasId: 'alias-1',
    readyScopeId: 'scope-1',
    readyTaskId: 'task-1',
    readyRunId: 'run-1',
    codexSessionId: 'session-1',
    codexThreadId: 'thread-1',
    codexTurnId: 'turn-1',
    turnContractDigest: 'turn-contract-1',
    productBudgetSeed: {
      maxIterations: 8,
      maxToolCalls: 4,
      maxParallelToolGroups: 1,
      lanes: {
        ordinary: { maxIterations: 7, maxToolCalls: 4, maxParallelToolGroups: 1 },
        delivery: { maxIterations: 0, maxToolCalls: 0, maxParallelToolGroups: 0 },
        final: { maxIterations: 1 },
      },
    },
    toolSurface,
    authorization: buildReadyBoundTurnToolAuthorization({
      authorization,
      readySessionKey: 'alias-1',
      readyTaskId: 'task-1',
      readyRunId: 'run-1',
      scopeId: 'scope-1',
      toolSurfaceDigest: toolSurface.toolSurfaceDigest,
      turnContractDigest: 'turn-contract-1',
      resourceAnchorDigest: 'resource-anchor-1',
      createdAt: '2026-08-07T00:00:00.000Z',
    }),
  }
}

class FakePersistence implements CodexToolBridgePersistencePort {
  call: CodexToolCallBindingRead | null = null
  readonly attempts: CodexToolResponseDeliveryAttemptRead[] = []
  readonly requestRpcClaims = new Set<string>()
  get deliveryCount(): number { return this.attempts.length }
  constructor(public executionBinding: CodexToolBridgeExecutionBinding = binding()) {}
  readToolBridgeExecutionBinding(bindingId: string): CodexToolBridgeExecutionBinding {
    assert.equal(bindingId, this.executionBinding.bindingId)
    return this.executionBinding
  }
  bindToolCall(input: Parameters<CodexToolBridgePersistencePort['bindToolCall']>[0]): { duplicate: boolean } {
    const rpcClaim = `${input.requestConnectionEpoch}\0${input.requestRpcId.trim()}`
    if (this.requestRpcClaims.has(rpcClaim)) throw new Error('tool_request_rpc_reused')
    this.requestRpcClaims.add(rpcClaim)
    if (this.call) {
      assert.equal(this.call.readyActionId, input.readyActionId)
      return { duplicate: true }
    }
    this.call = {
      readyActionId: input.readyActionId,
      receiptId: null,
      resultDigest: null,
      requestConnectionEpoch: input.requestConnectionEpoch,
      requestRpcId: input.requestRpcId,
      deliveredConnectionEpoch: null,
      deliveredRpcId: null,
      toolResponseDigest: null,
    }
    return { duplicate: false }
  }
  readToolCallBinding(): CodexToolCallBindingRead | null { return this.call }
  completeToolCall(input: Parameters<CodexToolBridgePersistencePort['completeToolCall']>[0]): void {
    assert.ok(this.call)
    if (this.call.receiptId) {
      assert.equal(this.call.receiptId, input.receiptId)
      assert.equal(this.call.resultDigest, input.resultDigest)
      return
    }
    this.call = {
      ...this.call,
      receiptId: input.receiptId,
      resultDigest: input.resultDigest,
    }
  }
  markToolCallDeliveryIntent(
    input: Parameters<CodexToolBridgePersistencePort['markToolCallDeliveryIntent']>[0],
  ): void {
    assert.equal(this.call?.requestConnectionEpoch, input.connectionEpoch)
    assert.equal(this.call?.requestRpcId, input.requestRpcId)
    assert.ok(this.call?.receiptId)
    if (this.call.deliveredConnectionEpoch) {
      assert.equal(this.call.deliveredConnectionEpoch, input.connectionEpoch)
      assert.equal(this.call.deliveredRpcId, input.requestRpcId)
      assert.equal(this.call.toolResponseDigest, input.toolResponseDigest)
      return
    }
    this.call = {
      ...this.call,
      deliveredConnectionEpoch: input.connectionEpoch,
      deliveredRpcId: input.requestRpcId,
      toolResponseDigest: input.toolResponseDigest,
    }
  }
  beginToolCallDeliveryAttempt(
    input: Parameters<CodexToolBridgePersistencePort['beginToolCallDeliveryAttempt']>[0],
  ): { attempt: CodexToolResponseDeliveryAttemptIdentity; duplicate: boolean } {
    assert.ok(this.call?.receiptId)
    assert.equal(digestCanonicalJson(input.toolResponse), input.toolResponseDigest)
    const identity = {
      codexThreadId: input.codexThreadId,
      codexTurnId: input.codexTurnId,
      codexCallId: input.codexCallId,
      readyActionId: this.call.readyActionId,
      connectionEpoch: input.connectionEpoch,
      requestRpcId: input.requestRpcId,
      toolResponseDigest: input.toolResponseDigest,
    }
    const attempt: CodexToolResponseDeliveryAttemptIdentity = {
      attemptId: buildCodexToolResponseDeliveryAttemptId(identity),
      ...identity,
    }
    const prior = this.attempts.find((candidate) => (
      candidate.connectionEpoch === input.connectionEpoch
      && candidate.requestRpcId === input.requestRpcId
    ))
    if (prior) {
      assert.deepEqual(prior, {
        ...attempt,
        toolResponse: input.toolResponse,
        transportWriteConfirmedAt: prior.transportWriteConfirmedAt,
        createdAt: prior.createdAt,
      })
      return { attempt, duplicate: true }
    }
    this.attempts.push({
      ...attempt,
      toolResponse: input.toolResponse,
      transportWriteConfirmedAt: null,
      createdAt: input.at,
    })
    if (!this.call.deliveredConnectionEpoch) {
      this.call = {
        ...this.call,
        deliveredConnectionEpoch: input.connectionEpoch,
        deliveredRpcId: input.requestRpcId,
        toolResponseDigest: input.toolResponseDigest,
      }
    }
    return { attempt, duplicate: false }
  }
  readToolCallDeliveryAttempts(): CodexToolResponseDeliveryAttemptRead[] {
    return this.attempts.map((attempt) => ({ ...attempt }))
  }
  confirmToolCallDeliveryTransportWrite(
    input: Parameters<CodexToolBridgePersistencePort['confirmToolCallDeliveryTransportWrite']>[0],
  ): void {
    const index = this.attempts.findIndex((attempt) => attempt.attemptId === input.attemptId)
    assert.notEqual(index, -1)
    const existing = this.attempts[index]
    assert.equal(existing.codexThreadId, input.codexThreadId)
    assert.equal(existing.codexTurnId, input.codexTurnId)
    assert.equal(existing.codexCallId, input.codexCallId)
    assert.equal(existing.readyActionId, input.readyActionId)
    assert.equal(existing.connectionEpoch, input.connectionEpoch)
    assert.equal(existing.requestRpcId, input.requestRpcId)
    assert.equal(existing.toolResponseDigest, input.toolResponseDigest)
    this.attempts[index] = {
      ...existing,
      transportWriteConfirmedAt: existing.transportWriteConfirmedAt || input.at,
    }
  }
}

class ReplayTransport implements CodexJsonLineTransport {
  readonly writes: string[] = []
  closedReason: string | null = null
  failNextWrite = false
  private lineListener: ((line: string) => void) | null = null
  private closeListener: ((error: Error | null) => void) | null = null

  write(line: string, callback: (error: Error | null) => void): void {
    this.writes.push(line)
    const error = this.failNextWrite ? new Error('fixture_transport_write_failed') : null
    this.failNextWrite = false
    queueMicrotask(() => callback(error))
  }
  onLine(listener: (line: string) => void): () => void {
    this.lineListener = listener
    return () => { if (this.lineListener === listener) this.lineListener = null }
  }
  onClose(listener: (error: Error | null) => void): () => void {
    this.closeListener = listener
    return () => { if (this.closeListener === listener) this.closeListener = null }
  }
  close(reason: string): void { this.closedReason = reason }
  emit(frame: unknown): void { this.lineListener?.(JSON.stringify(frame)) }
}

function replayStartPort(onClosed: (connectionEpoch: string) => void): CodexStartDispatchPort {
  return {
    async activate() { throw new Error('unexpected_start_activation') },
    async markChildWriteConfirmed() { throw new Error('unexpected_start_write') },
    async markUnresolved() { throw new Error('unexpected_start_unresolved') },
    async reconcileAccepted() { throw new Error('unexpected_start_response') },
    async reconcileRejected() { throw new Error('unexpected_start_rejection') },
    async consumeLateResponse() { return false },
    async markConnectionClosed(connectionEpoch) { onClosed(connectionEpoch) },
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture_condition_timeout')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function bindReplayTurn(
  buffer: CodexProvisionalInboundBuffer,
  connectionEpoch: string,
): Promise<void> {
  buffer.registerProvisionalTurn({
    bindingId: 'run-1',
    connectionEpoch,
    threadId: 'thread-1',
    clientUserMessageId: 'ready-message-1',
    deadlineAtMs: Date.now() + 1_000,
  })
  const userMessage = {
    method: 'item/started' as const,
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        type: 'userMessage' as const,
        id: 'user-item-1',
        clientId: 'ready-message-1',
        content: [{ type: 'text' as const, text: 'hello', text_elements: [] }],
      },
      startedAtMs: 1,
    },
  }
  await buffer.routeNotification({ connectionEpoch, frame: userMessage, notification: userMessage })
  assert.equal(await buffer.reconcileTurn({
    bindingId: 'run-1',
    connectionEpoch,
    threadId: 'thread-1',
    nativeTurnId: 'turn-1',
  }), 'released')
}

class FakeReceipts implements ReadyToolActionReceiptPort {
  readonly records = new Map<string, Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>>()
  readonly pending = new Set<string>()
  readonly absent = new Map<string, Extract<ReadyToolActionReceiptRead, { state: 'proven_absent' }>>()
  onCommit: (() => void) | null = null
  indeterminate = false
  failBegin = false
  async begin(input: {
    readyActionId: string
    actionIdentityDigest: string
    at: string
  }): Promise<{ fresh: boolean }> {
    assert.ok(input.actionIdentityDigest)
    assert.ok(input.at)
    if (this.failBegin) throw new Error('fixture_begin_crash')
    if (this.indeterminate || this.pending.has(input.readyActionId) || this.records.has(input.readyActionId)) {
      return { fresh: false }
    }
    this.pending.add(input.readyActionId)
    return { fresh: true }
  }
  async read(readyActionId: string): Promise<ReadyToolActionReceiptRead> {
    const absent = this.absent.get(readyActionId)
    if (absent) return absent
    if (this.indeterminate || this.pending.has(readyActionId)) {
      return { state: 'indeterminate', reason: 'fixture_unknown', evidenceDigest: 'fixture-evidence' }
    }
    return this.records.get(readyActionId) || { state: 'absent' }
  }
  async commit(input: {
    readyActionId: string
    actionIdentityDigest: string
    resultDigest: string
    output: ToolExecutionOutput
    at: string
  }): Promise<Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>> {
    this.onCommit?.()
    const existing = this.records.get(input.readyActionId)
    if (existing) return existing
    assert.ok(this.pending.delete(input.readyActionId))
    const receipt = {
      state: 'confirmed' as const,
      receiptId: `receipt-${this.records.size + 1}`,
      resultDigest: input.resultDigest,
      output: input.output,
    }
    this.records.set(input.readyActionId, receipt)
    return receipt
  }
  markProvenAbsent(input: {
    readyActionId: string
    actionIdentityDigest: string
    reason: string
    evidenceDigest: string
    at: string
  }): void {
    assert.ok(input.actionIdentityDigest)
    assert.ok(input.at)
    assert.ok(this.pending.delete(input.readyActionId))
    this.absent.set(input.readyActionId, {
      state: 'proven_absent',
      reason: input.reason,
      evidenceDigest: input.evidenceDigest,
    })
  }
  markIndeterminate(input: {
    readyActionId: string
    actionIdentityDigest: string
    reason: string
    evidenceDigest: string
    at: string
  }): void {
    assert.ok(input.actionIdentityDigest)
    assert.ok(input.at)
    this.pending.delete(input.readyActionId)
    this.indeterminate = true
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: 'run-1',
    connectionEpoch: 'connection-1',
    requestId: 7,
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      callId: 'call-1',
      namespace: null,
      tool: 'document_read',
      arguments: { id: 'doc-1' },
      ...overrides,
    },
  }
}

function fixture(options: {
  executionBinding?: CodexToolBridgeExecutionBinding
  execute?: (signal: AbortSignal) => Promise<ToolExecutionOutput>
  executeWithContext?: (context: ToolContext) => Promise<ToolExecutionOutput>
  executeControlsEffectLifecycle?: boolean
  abortSignal?: AbortSignal | null
  connectionAbortSignal?: AbortSignal | null
  sensitiveValues?: readonly string[]
  validate?: (
    toolName: string,
    args: Record<string, unknown>,
    frozenEntry: ReadyToolSurfaceEntry,
    call: number,
  ) => void
  resolveInteraction?: (input: {
    waitingOutput: ToolExecutionOutput
    abortSignal: AbortSignal
  }) => Promise<ToolExecutionOutput>
  onLoad?: () => void | Promise<void>
  live?: (connectionEpoch: string) => boolean
  timeoutMs?: number
} = {}) {
  const persistence = new FakePersistence(options.executionBinding)
  const receipts = new FakeReceipts()
  const defaultAbortSignal = new AbortController().signal
  const defaultConnectionAbortSignal = new AbortController().signal
  let executions = 0
  let validations = 0
  const bridge = new CodexReadyToolBridge({
    persistence,
    receipts,
    validateToolArguments: (_binding, toolName, args, frozenEntry) => {
      validations += 1
      if (options.validate) return options.validate(toolName, args, frozenEntry, validations)
      if (typeof args.id !== 'string') throw new CodexToolBridgeError('tool_call_arguments_invalid')
    },
    loadToolExecutor: async () => {
      await options.onLoad?.()
      return async (_name, _args, context) => {
        if (!options.executeControlsEffectLifecycle) context.onToolEffectStart?.()
        try {
          executions += 1
          return options.executeWithContext
            ? await options.executeWithContext(context)
            : options.execute
            ? await options.execute(context.abortSignal as AbortSignal)
            : createToolExecutionOutput('done', { data: { value: 1 } })
        } finally {
          if (!options.executeControlsEffectLifecycle) context.onToolEffectEnd?.()
        }
      }
    },
    buildToolContext: () => ({}),
    getAbortSignal: () => options.abortSignal === undefined
      ? defaultAbortSignal
      : options.abortSignal,
    getSensitiveValues: () => options.sensitiveValues || [],
    awaitInteractionResolution: async ({ waitingOutput, abortSignal }) => {
      if (!options.resolveInteraction) {
        throw new CodexToolBridgeError('tool_interaction_resolution_unavailable')
      }
      return options.resolveInteraction({ waitingOutput, abortSignal })
    },
    isConnectionLive: options.live || (() => true),
    getConnectionAbortSignal: () => options.connectionAbortSignal === undefined
      ? defaultConnectionAbortSignal
      : options.connectionAbortSignal,
    now: () => '2026-08-07T00:00:00.000Z',
    timeoutMs: options.timeoutMs || 1_000,
  })
  return {
    bridge,
    persistence,
    receipts,
    executions: () => executions,
    validations: () => validations,
  }
}

test('authorized call binds, executes once through Ready, receipts, and responds exactly', async () => {
  const f = fixture()
  const result = await f.bridge.execute(request())
  assert.deepEqual(Object.keys(result).sort(), ['contentItems', 'success'])
  assert.equal(result.success, true)
  assert.equal(result.contentItems[0].type, 'inputText')
  assert.equal(f.executions(), 1)
  assert.equal(f.receipts.records.size, 1)
  assert.equal(f.persistence.deliveryCount, 1)
  assert.match(f.persistence.call?.readyActionId || '', /^codex-action-[a-f0-9]{64}$/)
})

test('production bridge executes the real completion declaration from the live failed-turn shape', async () => {
  const toolDefinition = defaultToolRegistry.getToolDefinitionForExecution('declare_completion_criteria')
  assert.ok(toolDefinition)
  const persistence = new FakePersistence(binding(undefined, undefined, toolDefinition))
  const receipts = new FakeReceipts()
  const updates: Array<{ taskId: string; patch: unknown }> = []
  const bridge = createCodexReadyToolBridge({
    persistence,
    receipts,
    buildToolContext: () => ({
      runtime: {
        getTaskProjectionStoreForFinalize: () => ({
          update(taskId: string, patch: unknown) { updates.push({ taskId, patch }) },
        }),
      } as unknown as ToolContext['runtime'],
    }),
    getAbortSignal: () => new AbortController().signal,
    getSensitiveValues: () => [],
    async awaitInteractionResolution() {
      throw new CodexToolBridgeError('tool_interaction_resolution_unavailable')
    },
    isConnectionLive: () => true,
    getConnectionAbortSignal: () => new AbortController().signal,
    now: () => '2026-08-09T10:04:35.647Z',
    timeoutMs: 1_000,
  })

  const result = await bridge.execute(request({
    tool: 'declare_completion_criteria',
    arguments: {
      criteria: [
        '成功定位并读取名为“测试 0807”的飞书文档',
        '在“测试 0807”中新增一列并写入示例内容',
        '成功定位并润色“第二季度工作总结”文档',
        '仅在 CLI 返回成功后报告文档修改结果',
      ],
      expected_outputs: [],
    },
  }))

  assert.equal(result.success, true)
  assert.equal(receipts.records.size, 1)
  assert.deepEqual(updates, [{
    taskId: 'task-1',
    patch: {
      modelCriteria: [
        '成功定位并读取名为“测试 0807”的飞书文档',
        '在“测试 0807”中新增一列并写入示例内容',
        '成功定位并润色“第二季度工作总结”文档',
        '仅在 CLI 返回成功后报告文档修改结果',
      ],
      expectedOutputs: [],
    },
  }])
})

test('production bridge resolves the current selected-skill wire schema before binding skill_run_shell', async (t) => {
  const sessionId = 'alias-1'
  rememberLastReferenceSkill(sessionId, { id: 'lark-cli', name: 'lark-cli' })
  t.after(() => clearLastReferenceSkill(sessionId))
  const skillAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'lark-cli',
    allowedTypedActions: [],
    allowedPrimitives: ['skill_run_shell'],
    source: 'explicit',
    reason: 'test_selected_lark_cli',
  })
  const resolvedDefinition = defaultToolRegistry.getToolDefinitionsForGroup(
    'skills',
    sessionId,
    skillAuthorization,
    'scope-1',
  ).find((definition) => definition.name === 'skill_run_shell')
  assert.ok(resolvedDefinition)
  assert.ok(resolvedDefinition.schema)
  const frozenDefinition = { ...resolvedDefinition, codexExecutionSafe: true }
  const persistence = new FakePersistence(binding(
    ['skill_run_shell'],
    undefined,
    frozenDefinition,
    skillAuthorization,
  ))
  const bridge = new CodexReadyToolBridge({
    persistence,
    receipts: new FakeReceipts(),
    validateToolArguments: (binding, toolName, args, frozenEntry) => {
      validateCodexFrozenToolExecution(
        { binding, toolName, args, frozenEntry },
        {
          getToolDefinitionForExecution: () => frozenDefinition,
          getToolDefinitionsForGroup: () => [frozenDefinition],
        },
      )
    },
    loadToolExecutor: async () => {
      const { executeToolCall } = await import('../main/modules/tools/tool-executor')
      return executeToolCall
    },
    buildToolContext: () => ({}),
    getAbortSignal: () => new AbortController().signal,
    getSensitiveValues: () => [],
    async awaitInteractionResolution() {
      throw new CodexToolBridgeError('tool_interaction_resolution_unavailable')
    },
    isConnectionLive: () => true,
    getConnectionAbortSignal: () => new AbortController().signal,
    now: () => '2026-08-09T10:30:25.168Z',
    timeoutMs: 1_000,
  })

  const result = await bridge.execute(request({
    tool: 'skill_run_shell',
    arguments: {
      command: "pwd; printf '\\n-- files --\\n'; rg --files | head -80",
      timeoutMs: 20_000,
    },
  }))
  assert.equal(result.success, false)
  assert.ok(persistence.call)
})

test('frozen host artifact delivery primitives remain executable without selecting a skill', () => {
  const candidateAuthorization = buildExplicitNoSkillAuthorization('no_skill_signal', {
    candidateSkillPrimitives: {
      skillId: 'lark-cli',
      primitives: ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    },
  })
  for (const toolName of [
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_export_artifact',
  ]) {
    const frozenDefinition = defaultToolRegistry.getToolDefinition(toolName)
    assert.ok(frozenDefinition)
    const executionBinding = binding(
      [toolName],
      undefined,
      frozenDefinition,
      candidateAuthorization,
    )
    const frozenEntry = executionBinding.toolSurface.entries[0]
    assert.ok(frozenEntry)
    const args = toolName === 'skill_write_artifact'
      ? { relativePath: 'artifact.md', content: 'artifact' }
      : { relativePath: 'artifact.md' }
    assert.doesNotThrow(() => validateCodexFrozenToolExecution(
      {
        binding: executionBinding,
        toolName,
        args,
        frozenEntry,
      },
      defaultToolRegistry,
    ))
  }
})

test('candidate skill_ask_user remains executable for a follow-up question', () => {
  const sessionId = 'alias-ask-user'
  const candidateAuthorization = buildExplicitNoSkillAuthorization('no_skill_signal', {
    candidateSkillPrimitives: {
      skillId: 'lark-cli',
      primitives: ['skill_ask_user', 'skill_read_artifact', 'skill_run_shell'],
    },
  })
  const currentDefinition = defaultToolRegistry.getToolDefinitionsForGroup(
    'skills',
    sessionId,
    candidateAuthorization,
    'scope-1',
  ).find((definition) => definition.name === 'skill_ask_user')
  assert.ok(currentDefinition)
  const frozenDefinition = { ...currentDefinition, codexExecutionSafe: true }
  const executionBinding = binding(
    ['skill_ask_user'],
    undefined,
    frozenDefinition,
    candidateAuthorization,
  )
  const frozenEntry = executionBinding.toolSurface.entries[0]
  assert.ok(frozenEntry)

  assert.doesNotThrow(() => validateCodexFrozenToolExecution(
    {
      binding: executionBinding,
      toolName: 'skill_ask_user',
      args: {
        question: '你想查广州花都哪一天或哪个具体时段的降雨概率？',
        placeholder: '例如：8月22日下午、这周六 8:00–18:00',
      },
      frozenEntry,
    },
    {
      getToolDefinitionForExecution: () => frozenDefinition,
      getToolDefinitionsForGroup: () => [frozenDefinition],
    },
  ))
})

test('current skill schema drift rejects old admitted arguments before bind or effect', async () => {
  const toolName = 'skill_run_shell'
  const frozenDefinition: ToolDefinition = {
    ...definition(toolName),
    groupId: 'skills',
    domain: 'skill',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'skill',
    projectionHint: { mutating: true, emitsProjectionPatch: true },
    description: 'Preview a fixture write',
    codexExecutionSafe: true,
    schema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
        dryRun: { type: 'boolean' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    resultShape: 'projection_patch',
  }
  const currentDefinition: ToolDefinition = {
    ...frozenDefinition,
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  }
  const skillAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'fixture',
    allowedTypedActions: [],
    allowedPrimitives: [toolName],
    source: 'explicit',
    reason: 'test_schema_drift',
  })
  const executionBinding = binding(
    [toolName],
    undefined,
    frozenDefinition,
    skillAuthorization,
  )
  const f = fixture({
    executionBinding,
    validate: (name, args, frozenEntry) => validateCodexFrozenToolExecution(
      { binding: executionBinding, toolName: name, args, frozenEntry },
      {
        getToolDefinitionForExecution: () => currentDefinition,
        getToolDefinitionsForGroup: () => [currentDefinition],
      },
      () => null,
    ),
  })

  await assert.rejects(
    () => f.bridge.execute(request({
      tool: toolName,
      arguments: { value: 'preview', dryRun: true },
    })),
    (error) => error instanceof CodexToolBridgeError
      && error.code === 'tool_execution_surface_drift',
  )
  assert.equal(f.persistence.call, null)
  assert.equal(f.receipts.records.size, 0)
  assert.equal(f.executions(), 0)
})

test('current input parsing cannot strip or transform the admitted arguments', async () => {
  const toolName = 'skill_run_shell'
  const currentDefinition: ToolDefinition = {
    ...definition(toolName),
    groupId: 'skills',
    domain: 'skill',
    codexExecutionSafe: true,
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  }
  const skillAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'fixture',
    allowedTypedActions: [],
    allowedPrimitives: [toolName],
    source: 'explicit',
    reason: 'test_parse_identity',
  })
  const executionBinding = binding(
    [toolName],
    undefined,
    currentDefinition,
    skillAuthorization,
  )
  const f = fixture({
    executionBinding,
    validate: (name, args, frozenEntry) => validateCodexFrozenToolExecution(
      { binding: executionBinding, toolName: name, args, frozenEntry },
      {
        getToolDefinitionForExecution: () => currentDefinition,
        getToolDefinitionsForGroup: () => [currentDefinition],
      },
      () => z.object({ value: z.string() }),
    ),
  })

  await assert.rejects(
    () => f.bridge.execute(request({
      tool: toolName,
      arguments: { value: 'kept', dryRun: true },
    })),
    (error) => error instanceof CodexToolBridgeError
      && error.code === 'tool_call_arguments_invalid',
  )
  assert.equal(f.persistence.call, null)
  assert.equal(f.receipts.records.size, 0)
  assert.equal(f.executions(), 0)
})

test('mutable selected-skill programs are unsupported before bind or effect', async () => {
  const toolName = 'skill_run_shell'
  const frozenDefinition: ToolDefinition = {
    ...definition(toolName),
    groupId: 'skills',
    domain: 'skill',
    kind: 'write',
    concurrency: 'serialized',
    timeoutProfile: 'skill',
    codexExecutionSafe: true,
  }
  const currentDefinition = {
    ...frozenDefinition,
    codexExecutionSafe: false,
  }
  const skillAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'fixture',
    allowedTypedActions: [],
    allowedPrimitives: [toolName],
    source: 'explicit',
    reason: 'test_entry_drift',
  })
  const executionBinding = binding(
    [toolName],
    undefined,
    frozenDefinition,
    skillAuthorization,
  )
  const f = fixture({
    executionBinding,
    validate: (name, args, frozenEntry) => validateCodexFrozenToolExecution(
      { binding: executionBinding, toolName: name, args, frozenEntry },
      {
        getToolDefinitionForExecution: () => currentDefinition,
        getToolDefinitionsForGroup: () => [currentDefinition],
      },
      () => null,
    ),
  })

  await assert.rejects(
    () => f.bridge.execute(request({ tool: toolName, arguments: { id: 'fixture' } })),
    (error) => error instanceof CodexToolBridgeError
      && error.code === 'tool_execution_authority_unsupported',
  )
  assert.equal(f.persistence.call, null)
  assert.equal(f.receipts.records.size, 0)
  assert.equal(f.executions(), 0)
})

test('state-patch skill tools are rejected before bind or effect', async () => {
  const toolName = 'skill_start_detached'
  const toolDefinition: ToolDefinition = {
    ...definition(toolName),
    groupId: 'skills',
    domain: 'skill',
    kind: 'job',
    concurrency: 'serialized',
    timeoutProfile: 'skill',
    codexExecutionSafe: true,
  }
  const skillAuthorization = buildSelectedSkillToolAuthorization({
    skillId: 'fixture',
    allowedTypedActions: [],
    allowedPrimitives: [toolName],
    source: 'explicit',
    reason: 'test_state_patch_rejection',
  })
  const executionBinding = binding(
    [toolName],
    undefined,
    toolDefinition,
    skillAuthorization,
  )
  const f = fixture({
    executionBinding,
    validate: (name, args, frozenEntry) => validateCodexFrozenToolExecution(
      { binding: executionBinding, toolName: name, args, frozenEntry },
      {
        getToolDefinitionForExecution: () => toolDefinition,
        getToolDefinitionsForGroup: () => [toolDefinition],
      },
      () => null,
    ),
  })
  await assert.rejects(
    () => f.bridge.execute(request({ tool: toolName, arguments: { id: 'fixture' } })),
    (error) => error instanceof CodexToolBridgeError
      && error.code === 'tool_result_state_unsupported',
  )
  assert.equal(f.persistence.call, null)
  assert.equal(f.receipts.records.size, 0)
  assert.equal(f.executions(), 0)
})

test('missing run or connection abort authority rejects before binding, journal, and effect', async (t) => {
  for (const [name, options, code] of [
    ['run', { abortSignal: null }, 'tool_abort_authority_missing'],
    ['connection', { connectionAbortSignal: null }, 'connection_abort_authority_missing'],
  ] as const) {
    await t.test(name, async () => {
      const f = fixture(options)
      await assert.rejects(
        () => f.bridge.execute(request()),
        (error) => error instanceof CodexToolBridgeError && error.code === code,
      )
      assert.equal(f.persistence.call, null)
      assert.equal(f.receipts.pending.size, 0)
      assert.equal(f.receipts.records.size, 0)
      assert.equal(f.executions(), 0)
    })
  }
})

test('identity, namespace, arguments, registration, and authorization failures have zero effects', async (t) => {
  const cases: Array<[string, Record<string, unknown>, string, CodexToolBridgeExecutionBinding?]> = [
    ['namespace', { namespace: 'builtin' }, 'codex_builtin_tool_forbidden'],
    ['thread', { threadId: 'wrong' }, 'tool_call_thread_identity_mismatch'],
    ['turn', { turnId: 'wrong' }, 'tool_call_turn_identity_mismatch'],
    ['arguments', { arguments: [] }, 'tool_call_arguments_invalid'],
    ['argument schema', { arguments: { id: 1 } }, 'tool_call_arguments_invalid'],
    ['unknown', { tool: 'shell' }, 'tool_not_registered'],
    ['unauthorized', {}, 'authorization_denied', binding([])],
  ]
  for (const [name, overrides, code, executionBinding] of cases) {
    await t.test(name, async () => {
      const f = fixture({ executionBinding })
      await assert.rejects(
        () => f.bridge.execute(request(overrides)),
        (error) => error instanceof CodexToolBridgeError && error.code === code,
      )
      assert.equal(f.executions(), 0)
      assert.equal(f.persistence.call, null)
      assert.equal(f.receipts.records.size, 0)
    })
  }
})

test('concurrent duplicate on the same live RPC never receives a second response', async () => {
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const f = fixture({
    execute: async () => {
      await blocked
      return createToolExecutionOutput('once')
    },
  })
  const first = f.bridge.execute(request())
  const second = assert.rejects(
    f.bridge.execute(request()),
    /tool_request_rpc_reused/,
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.executions(), 1)
  release()
  await first
  await second
  assert.equal(f.persistence.deliveryCount, 1)
})

test('completed duplicate is never replayed or re-executed', async () => {
  const f = fixture()
  await f.bridge.execute(request())
  await assert.rejects(
    () => f.bridge.execute(request()),
    /tool_request_rpc_reused/,
  )
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.deliveryCount, 1)
})

test('canonical RPC aliases and old ids are rejected before a second tool effect', async () => {
  const f = fixture()
  await f.bridge.execute(request())
  for (const requestId of ['7', ' 7 ']) {
    await assert.rejects(
      () => f.bridge.execute({ ...request(), requestId }),
      /tool_request_rpc_reused/,
    )
  }
  await assert.rejects(
    () => f.bridge.execute({
      ...request(),
      requestId: ' 7 ',
      params: { ...request().params, callId: 'different-call' },
    }),
    /tool_request_rpc_reused/,
  )
  for (let index = 0; index < 2_048; index += 1) {
    await assert.rejects(
      () => f.bridge.execute({ ...request(), requestId: 10_000 + index }),
      /tool_result_replay_forbidden/,
    )
  }
  await assert.rejects(() => f.bridge.execute(request()), /tool_request_rpc_reused/)
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.deliveryCount, 1)
})

test('confirmed result is replayed on a replacement connection without executing the action again', async () => {
  const liveConnections = new Set(['connection-1'])
  const f = fixture({ live: (connectionEpoch) => liveConnections.has(connectionEpoch) })
  const first = await f.bridge.execute(request())
  liveConnections.delete('connection-1')
  liveConnections.add('connection-2')

  const recovered = await f.bridge.execute({
    ...request(),
    connectionEpoch: 'connection-2',
    requestId: 8,
  })

  assert.deepEqual(recovered, first)
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.deliveryCount, 2)
})

test('app-server write failure recovers on a new connection and the turn continues without re-execution', async () => {
  const liveConnections = new Set(['connection-1'])
  const f = fixture({ live: (connectionEpoch) => liveConnections.has(connectionEpoch) })
  const firstBuffer = new CodexProvisionalInboundBuffer({
    maxFramesPerOwner: 16,
    maxBytesPerOwner: 64 * 1024,
    nowMs: Date.now,
    serverRequestExecutor: f.bridge,
    startInboundQuarantinePort: { quarantine() {} },
  })
  const firstTransport = new ReplayTransport()
  firstTransport.failNextWrite = true
  const firstClient = new CodexAppServerClient({
    transport: firstTransport,
    connectionEpoch: 'connection-1',
    requestTimeoutMs: 1_000,
    startDispatchPort: replayStartPort((epoch) => liveConnections.delete(epoch)),
    inboundFramePort: firstBuffer,
    threadArchiveAuthorizationPort: { assertEligible() {} },
  })
  await bindReplayTurn(firstBuffer, 'connection-1')
  firstTransport.emit({
    id: 7,
    method: 'item/tool/call',
    params: request().params,
  })
  await waitUntil(() => firstTransport.closedReason !== null && !liveConnections.has('connection-1'))
  assert.equal(firstTransport.closedReason, 'protocol_failure')
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.attempts.length, 1)
  assert.equal(f.persistence.attempts[0].transportWriteConfirmedAt, null)
  firstClient.dispose()

  liveConnections.add('connection-2')
  const secondBuffer = new CodexProvisionalInboundBuffer({
    maxFramesPerOwner: 16,
    maxBytesPerOwner: 64 * 1024,
    nowMs: Date.now,
    serverRequestExecutor: f.bridge,
    startInboundQuarantinePort: { quarantine() {} },
  })
  const secondTransport = new ReplayTransport()
  const secondClient = new CodexAppServerClient({
    transport: secondTransport,
    connectionEpoch: 'connection-2',
    requestTimeoutMs: 1_000,
    startDispatchPort: replayStartPort((epoch) => liveConnections.delete(epoch)),
    inboundFramePort: secondBuffer,
    threadArchiveAuthorizationPort: { assertEligible() {} },
  })
  const observed: string[] = []
  secondClient.subscribe((notification) => observed.push(notification.method))
  await bindReplayTurn(secondBuffer, 'connection-2')
  observed.length = 0
  secondTransport.emit({
    id: 8,
    method: 'item/tool/call',
    params: request().params,
  })
  await waitUntil(() => (
    secondTransport.writes.length === 1
    && f.persistence.attempts[1]?.transportWriteConfirmedAt !== null
  ))
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.attempts.length, 2)
  assert.equal(f.persistence.call?.requestConnectionEpoch, 'connection-1')
  assert.equal(f.persistence.call?.deliveredConnectionEpoch, 'connection-1')
  assert.deepEqual(JSON.parse(secondTransport.writes[0]), {
    id: 8,
    result: JSON.parse(firstTransport.writes[0]).result,
  })

  secondTransport.emit({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'completed', error: null },
    },
  })
  await waitUntil(() => observed.includes('turn/completed'))
  secondClient.dispose()
})

test('replacement connection cannot replay while an earlier delivery connection is still live', async () => {
  const liveConnections = new Set(['connection-1', 'connection-2'])
  const f = fixture({ live: (connectionEpoch) => liveConnections.has(connectionEpoch) })
  await f.bridge.execute(request())

  await assert.rejects(
    () => f.bridge.execute({
      ...request(),
      connectionEpoch: 'connection-2',
      requestId: 8,
    }),
    (error) => error instanceof CodexToolBridgeError
      && error.code === 'tool_result_replay_previous_connection_live',
  )
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.deliveryCount, 1)
})

test('known dead connection is rejected before call binding, journaling, or execution', async () => {
  const f = fixture({ live: () => false })
  await assert.rejects(
    () => f.bridge.execute(request()),
    (error) => error instanceof CodexToolBridgeError && error.code === 'sidecar_disconnected_before_effect',
  )
  assert.equal(f.executions(), 0)
  assert.equal(f.persistence.call, null)
  assert.equal(f.receipts.records.size, 0)
  assert.equal(f.receipts.pending.size, 0)
})

test('connection death after binding but before execution is proven absent', async () => {
  let live = true
  const f = fixture({
    live: () => live,
    onLoad: () => { live = false },
  })
  await assert.rejects(
    () => f.bridge.execute(request()),
    (error) => error instanceof CodexToolBridgeError && error.code === 'sidecar_disconnected_before_effect',
  )
  assert.equal(f.executions(), 0)
  assert.ok(f.persistence.call)
  assert.equal(f.receipts.pending.size, 0)
  assert.equal(f.receipts.absent.size, 1)
})

test('disconnect after effect persists the receipt but never marks a dead RPC for replay', async () => {
  let live = true
  const f = fixture({
    live: () => live,
    execute: async () => {
      live = false
      return createToolExecutionOutput('done after disconnect')
    },
  })
  await assert.rejects(
    () => f.bridge.execute(request()),
    (error) => error instanceof CodexToolBridgeError && error.code === 'sidecar_disconnected_after_effect',
  )
  assert.equal(f.executions(), 1)
  assert.equal(f.receipts.records.size, 1)
  assert.equal(f.persistence.deliveryCount, 0)
  await assert.rejects(
    () => f.bridge.execute(request()),
    (error) => error instanceof CodexToolBridgeError && error.code === 'sidecar_disconnected_before_effect',
  )
  assert.equal(f.executions(), 1)
})

test('proven-absent, indeterminate, and timeout branches are typed and do not retry', async (t) => {
  await t.test('already-aborted turn is rejected before journaling or execution', async () => {
    const controller = new AbortController()
    controller.abort(new Error('fixture already interrupted'))
    const f = fixture({ abortSignal: controller.signal })
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_abort_before_action',
    )
    assert.equal(f.executions(), 0)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.records.size, 0)
  })
  await t.test('executor failure stays effect unknown without independent readback', async () => {
    const f = fixture({ execute: async () => { throw new Error('fixture failure') } })
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_effect_unknown',
    )
    assert.equal(f.executions(), 1)
  })
  await t.test('crash before durable action begin is proven absent and never executed', async () => {
    const f = fixture()
    f.receipts.failBegin = true
    await assert.rejects(() => f.bridge.execute(request()), /fixture_begin_crash/)
    f.receipts.failBegin = false
    await assert.rejects(
      () => f.bridge.execute({ ...request(), requestId: 8 }),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_effect_proven_absent',
    )
    assert.equal(f.executions(), 0)
  })
  await t.test('indeterminate before execution', async () => {
    const f = fixture()
    f.receipts.indeterminate = true
    await assert.rejects(
      () => f.bridge.execute({ ...request(), requestId: 8 }),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_effect_unknown',
    )
    assert.equal(f.executions(), 0)
  })
  await t.test('surface drift at the post-journal readback is proven absent', async () => {
    const f = fixture({
      validate: (_name, args, _entry, call) => {
        assert.equal(typeof args.id, 'string')
        if (call === 2) throw new CodexToolBridgeError('tool_execution_surface_drift')
      },
    })
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_execution_surface_drift',
    )
    assert.equal(f.validations(), 2)
    assert.equal(f.executions(), 0)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.absent.size, 1)
  })
  await t.test('surface drift after lazy executor load is proven absent', async () => {
    const f = fixture({
      validate: (_name, args, _entry, call) => {
        assert.equal(typeof args.id, 'string')
        if (call === 3) throw new CodexToolBridgeError('tool_execution_surface_drift')
      },
    })
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError
        && error.code === 'tool_execution_surface_drift_after_load',
    )
    assert.equal(f.validations(), 3)
    assert.equal(f.executions(), 0)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.absent.size, 1)
  })
  await t.test('owner drift during lazy executor load is proven absent', async () => {
    let f!: ReturnType<typeof fixture>
    f = fixture({
      onLoad: () => {
        f.persistence.executionBinding = {
          ...f.persistence.executionBinding,
          readyScopeId: 'scope-replaced',
        }
      },
    })
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError
        && error.code === 'tool_execution_authority_drift_after_load',
    )
    assert.equal(f.executions(), 0)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.absent.size, 1)
  })
  await t.test('user_interaction wait is not killed by the host effect deadline', async () => {
    const f = fixture({
      timeoutMs: 5,
      executionBinding: binding(
        ['ask_user_questions'],
        5,
        definition('ask_user_questions', 5, 'user_interaction'),
      ),
      execute: async () => new Promise((resolve) => {
        setTimeout(() => resolve(createToolExecutionOutput('answered')), 20)
      }),
    })
    const response = await f.bridge.execute(request({ tool: 'ask_user_questions' }))
    assert.equal(response.success, true)
    assert.match(JSON.stringify(response), /answered/)
    assert.equal(f.receipts.records.size, 1)
    assert.equal(f.persistence.deliveryCount, 1)
  })
  await t.test('timeout abort', async () => {
    const f = fixture({
      timeoutMs: 5,
      execute: async (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    })
    const response = await f.bridge.execute(request())
    assert.equal(response.success, false)
    assert.match(JSON.stringify(response), /tool_execution_timeout/)
    assert.equal(f.receipts.records.size, 1)
    assert.equal(f.persistence.deliveryCount, 1)
    assert.equal(f.executions(), 1)
  })
  await t.test('confirmation wait is outside the frozen tool effect deadline', async () => {
    const f = fixture({
      executionBinding: binding(undefined, 5),
      timeoutMs: 100,
      executeControlsEffectLifecycle: true,
      execute: async () => new Promise((resolve) => {
        setTimeout(() => resolve(createToolExecutionOutput('confirmation expired', {
          data: { errorKind: 'confirmation_expired' },
        })), 20)
      }),
    })
    const response = await f.bridge.execute(request())
    assert.equal(response.success, false)
    assert.match(JSON.stringify(response), /confirmation_expired/)
    assert.equal(f.receipts.records.size, 1)
  })
  await t.test('a tool can pause its effect deadline for review and resume for the confirmed write', async () => {
    const phases: string[] = []
    const f = fixture({
      timeoutMs: 8,
      executeControlsEffectLifecycle: true,
      executeWithContext: async (context) => {
        context.onToolEffectStart?.()
        phases.push('initial-effect')
        await new Promise((resolve) => setTimeout(resolve, 2))
        context.onToolEffectEnd?.()
        phases.push('review-wait')
        await new Promise((resolve) => setTimeout(resolve, 20))
        context.onToolEffectStart?.()
        phases.push('confirmed-effect')
        try {
          await new Promise((resolve) => setTimeout(resolve, 2))
          return createToolExecutionOutput('reviewed write complete')
        } finally {
          context.onToolEffectEnd?.()
        }
      },
    })
    const response = await f.bridge.execute(request())
    assert.equal(response.success, true)
    assert.deepEqual(phases, ['initial-effect', 'review-wait', 'confirmed-effect'])
    assert.match(JSON.stringify(response), /reviewed write complete/)
  })
  await t.test('connection close during confirmation wait aborts before any tool effect', async () => {
    const connection = new AbortController()
    let effectReached = false
    const f = fixture({
      connectionAbortSignal: connection.signal,
      executeControlsEffectLifecycle: true,
      execute: async (signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve(createToolExecutionOutput('confirmation cancelled', {
            data: { errorKind: 'confirmation_expired' },
          }))
        }, { once: true })
        void effectReached
      }),
    })
    const execution = f.bridge.execute(request())
    await new Promise((resolve) => setImmediate(resolve))
    connection.abort(new Error('fixture connection closed'))
    await assert.rejects(
      () => execution,
      (error) => error instanceof CodexToolBridgeError
        && error.code === 'sidecar_disconnected_before_effect',
    )
    assert.equal(effectReached, false)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.absent.size, 1)
    assert.equal(f.persistence.deliveryCount, 0)
  })
  await t.test('owner drift during confirmation wait is rejected at effect start', async () => {
    let releaseConfirmation!: () => void
    const confirmation = new Promise<void>((resolve) => { releaseConfirmation = resolve })
    let domainEffects = 0
    let f!: ReturnType<typeof fixture>
    f = fixture({
      executeControlsEffectLifecycle: true,
      executeWithContext: async (context) => {
        await confirmation
        context.onToolEffectStart?.()
        domainEffects += 1
        try {
          return createToolExecutionOutput('must not execute')
        } finally {
          context.onToolEffectEnd?.()
        }
      },
    })
    const execution = f.bridge.execute(request())
    await new Promise((resolve) => setImmediate(resolve))
    f.persistence.executionBinding = {
      ...f.persistence.executionBinding,
      readyScopeId: 'scope-replaced-during-confirmation',
    }
    releaseConfirmation()
    await assert.rejects(
      () => execution,
      (error) => error instanceof CodexToolBridgeError
        && error.code === 'tool_execution_authority_drift_after_load',
    )
    assert.equal(domainEffects, 0)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.absent.size, 1)
  })
  await t.test('surface drift during confirmation wait is rejected at effect start', async () => {
    let releaseConfirmation!: () => void
    const confirmation = new Promise<void>((resolve) => { releaseConfirmation = resolve })
    let domainEffects = 0
    const f = fixture({
      executeControlsEffectLifecycle: true,
      validate: (_name, args, _entry, call) => {
        assert.equal(typeof args.id, 'string')
        if (call === 4) throw new CodexToolBridgeError('tool_execution_surface_drift')
      },
      executeWithContext: async (context) => {
        await confirmation
        context.onToolEffectStart?.()
        domainEffects += 1
        try {
          return createToolExecutionOutput('must not execute')
        } finally {
          context.onToolEffectEnd?.()
        }
      },
    })
    const execution = f.bridge.execute(request())
    await new Promise((resolve) => setImmediate(resolve))
    releaseConfirmation()
    await assert.rejects(
      () => execution,
      (error) => error instanceof CodexToolBridgeError
        && error.code === 'tool_execution_surface_drift_after_load',
    )
    assert.equal(domainEffects, 0)
    assert.equal(f.validations(), 4)
    assert.equal(f.receipts.pending.size, 0)
    assert.equal(f.receipts.absent.size, 1)
  })
  await t.test('timeout does not wait for an executor that ignores abort', async () => {
    let release!: (output: ToolExecutionOutput) => void
    const f = fixture({
      timeoutMs: 5,
      execute: async () => new Promise<ToolExecutionOutput>((resolve) => { release = resolve }),
    })
    const response = await f.bridge.execute(request())
    assert.equal(response.success, false)
    assert.match(JSON.stringify(response), /tool_execution_timeout/)
    release(createToolExecutionOutput('late result'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.receipts.records.size, 1)
    assert.equal(f.persistence.deliveryCount, 1)
    await assert.rejects(
      () => f.bridge.execute({ ...request(), requestId: 8 }),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_result_replay_forbidden',
    )
    assert.equal(f.executions(), 1)
  })
  await t.test('external abort does not wait for an executor that ignores abort', async () => {
    const controller = new AbortController()
    let release!: (output: ToolExecutionOutput) => void
    const f = fixture({
      abortSignal: controller.signal,
      execute: async () => new Promise<ToolExecutionOutput>((resolve) => { release = resolve }),
    })
    const execution = f.bridge.execute(request())
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort(new Error('fixture user interrupt'))
    await assert.rejects(
      () => execution,
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_abort_effect_unknown',
    )
    release(createToolExecutionOutput('late after abort'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.receipts.records.size, 1)
    assert.equal(f.persistence.deliveryCount, 0)
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_abort_before_action',
    )
    assert.equal(f.executions(), 1)
  })
  await t.test('abort after execution confirms the receipt but suppresses delivery', async () => {
    const controller = new AbortController()
    const f = fixture({ abortSignal: controller.signal })
    f.receipts.onCommit = () => controller.abort(new Error('fixture abort before delivery'))
    await assert.rejects(
      () => f.bridge.execute(request()),
      (error) => error instanceof CodexToolBridgeError && error.code === 'tool_abort_after_effect',
    )
    assert.equal(f.receipts.records.size, 1)
    assert.equal(f.persistence.deliveryCount, 0)
    assert.equal(f.executions(), 1)
  })
})

test('frozen per-tool timeout controls execution under the host hard cap', async () => {
  const writeDefinition: ToolDefinition = {
    ...definition('document_read', 5),
    kind: 'write',
    concurrency: 'serialized',
  }
  const fastDeadline = fixture({
    executionBinding: binding(undefined, 5, writeDefinition),
    timeoutMs: 100,
    execute: async () => new Promise((resolve) => {
      setTimeout(() => resolve(createToolExecutionOutput('too late')), 20)
    }),
  })
  await assert.rejects(
    () => fastDeadline.bridge.execute(request()),
    (error) => error instanceof CodexToolBridgeError && error.code === 'tool_timeout_effect_unknown',
  )

  const longDeadline = fixture({
    executionBinding: binding(undefined, 50),
    timeoutMs: 100,
    execute: async () => new Promise((resolve) => {
      setTimeout(() => resolve(createToolExecutionOutput('within deadline')), 20)
    }),
  })
  assert.equal((await longDeadline.bridge.execute(request())).success, true)
})

test('interaction waiting keeps the original RPC and action pending until Ready resolves it', async () => {
  let resolve!: (output: ToolExecutionOutput) => void
  const resolved = new Promise<ToolExecutionOutput>((accept) => { resolve = accept })
  const f = fixture({
    execute: async () => createToolExecutionOutput('Waiting for confirmation', {
      interactionHint: 'awaiting_confirmation',
    }),
    resolveInteraction: async ({ waitingOutput, abortSignal }) => {
      assert.equal(waitingOutput.interactionHint, 'awaiting_confirmation')
      assert.equal(abortSignal.aborted, false)
      return resolved
    },
  })
  const execution = f.bridge.execute(request())
  await new Promise((accept) => setImmediate(accept))
  assert.equal(f.executions(), 1)
  assert.equal(f.receipts.pending.size, 1)
  assert.equal(f.receipts.records.size, 0)
  assert.equal(f.persistence.deliveryCount, 0)
  resolve(createToolExecutionOutput('confirmed and complete'))
  const response = await execution
  assert.equal(response.success, true)
  assert.equal(f.receipts.pending.size, 0)
  assert.equal(f.receipts.records.size, 1)
  assert.equal(f.persistence.deliveryCount, 1)
})

test('denied and expired Ready interactions close the original RPC once without execution retry', async (t) => {
  for (const errorKind of ['confirmation_denied_by_user', 'confirmation_expired'] as const) {
    await t.test(errorKind, async () => {
      const f = fixture({
        execute: async () => createToolExecutionOutput('Waiting for confirmation', {
          interactionHint: 'awaiting_confirmation',
        }),
        resolveInteraction: async () => createToolExecutionOutput(errorKind, {
          data: { errorKind },
        }),
      })
      const response = await f.bridge.execute(request())
      assert.equal(response.success, false)
      assert.match(JSON.stringify(response), new RegExp(errorKind))
      assert.equal(f.executions(), 1)
      assert.equal(f.receipts.pending.size, 0)
      assert.equal(f.receipts.records.size, 1)
      assert.equal(f.persistence.deliveryCount, 1)
      await assert.rejects(
        () => f.bridge.execute({ ...request(), requestId: 8 }),
        (error) => error instanceof CodexToolBridgeError
          && error.code === 'tool_result_replay_forbidden',
      )
      assert.equal(f.executions(), 1)
    })
  }
})

test('verified receipt recovered inside the original live RPC can produce its one response', async () => {
  const f = fixture({
    execute: async () => {
      const readyActionId = f.persistence.call?.readyActionId
      assert.ok(readyActionId)
      const output = createToolExecutionOutput('recovered')
      f.receipts.records.set(readyActionId, {
        state: 'confirmed',
        receiptId: 'receipt-recovered',
        resultDigest: digestCanonicalJson(output),
        output,
      })
      f.receipts.pending.delete(readyActionId)
      throw new Error('crash after effect')
    },
  })
  const result = await f.bridge.execute(request())
  assert.equal(result.success, true)
  assert.equal(f.executions(), 1)
  assert.equal(f.persistence.deliveryCount, 1)
})

test('result mapping preserves structured errors and media, and rejects raw host paths', () => {
  const mapped = mapReadyToolOutput(createToolExecutionOutput('denied', {
    data: { errorKind: 'authorization_denied', hint: 'ask the user' },
    content: [
      { type: 'image', data: 'aW1hZ2U=', mediaType: 'image/png' },
      { type: 'audio', data: 'YXVkaW8=', mediaType: 'audio/wav' },
    ],
  }))
  assert.equal(mapped.success, false)
  assert.deepEqual(mapped.contentItems.slice(0, 2), [
    { type: 'inputImage', imageUrl: 'data:image/png;base64,aW1hZ2U=' },
    { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,YXVkaW8=' },
  ])
  assert.match((mapped.contentItems[2] as { text: string }).text, /authorization_denied/)
  assert.equal(mapReadyToolOutput(createToolExecutionOutput('conflicting failure', {
    data: { errorKind: 'authorization_denied' },
    envelope: { ok: true, kind: 'ok' },
  })).success, false)
  assert.equal(mapReadyToolOutput(createToolExecutionOutput('legacy failure', {
    data: { ok: false },
  })).success, false)
  const redacted = mapReadyToolOutput(createToolExecutionOutput(
    'Read `/Users/user/private.txt` {/Volumes/Secret/file.txt} /private/key /etc/hosts C:\\secrets\\key.txt file:///private/uri-key file://localhost/Volumes/Secret/localhost-key file:%2F%2F%2FVolumes%2FSecret%2Fencoded with token=ready-secret-canary',
    {
      data: {
        path: '/Users/user/private.txt',
        volume: '/Volumes/Secret/file.txt',
        privateLocation: '/private/key',
        systemLocation: '/etc/hosts',
        windowsLocation: 'D:\\private\\credential.txt',
        uri: 'file:///Volumes/Secret/from-uri',
        encodedUri: 'file:%2F%2F%2Fprivate%2Fencoded-key',
        publicUrl: 'https://example.com/public/reference',
        nested: {
          apiKey: 'sk-ready-canary',
          token: 'unlisted-token-canary',
          idToken: 'unlisted-id-token-canary',
          auth_token: 'unlisted-auth-token-canary',
          clientSecret: 'unlisted-client-secret-canary',
          session_cookie: 'unlisted-session-cookie-canary',
          authorization: 'Bearer ready-secret-canary',
          message: 'credential ready-secret-canary',
        },
      },
    },
  ), ['ready-secret-canary'])
  assert.doesNotMatch(
    JSON.stringify(redacted),
    /\/Users\/bai|\/Volumes\/Secret|\/private\/key|\/etc\/hosts|[CD]:\\\\(?:secrets|private)|file:(?:\/|%2f)/i,
  )
  assert.doesNotMatch(
    JSON.stringify(redacted),
    /ready-secret-canary|sk-ready-canary|unlisted-(?:token|id-token|auth-token|client-secret|session-cookie)-canary/,
  )
  assert.match(JSON.stringify(redacted), /https:\/\/example\.com\/public\/reference/)
  assert.match(JSON.stringify(redacted), /\[REDACTED\]/)
  for (const unavailable of [
    createToolExecutionOutput('remote media', {
      content: [{ type: 'image', data: 'https://example.com/private.png', mediaType: 'image/png' }],
    }),
    createToolExecutionOutput('artifact', {
      content: [{ type: 'artifact', path: '/private/secret.txt' }],
    }),
    createToolExecutionOutput('Waiting for confirmation', {
      interactionHint: 'awaiting_confirmation',
    }),
  ]) {
    const mapped = mapReadyToolOutput(unavailable)
    assert.equal(mapped.success, true)
    assert.match(
      (mapped.contentItems[0] as { text: string }).text,
      /tool_result_payload_omitted/,
    )
  }
  const projectionPatch = mapReadyToolOutput(createToolExecutionOutput('state patch', {
    projectionPatch: {
      status: 'done',
      nested: {
        token: 'secret-token-value',
        outputDir: '/private/secret-output',
        note: 'Bearer secret-token-value',
      },
    },
  }), ['secret-token-value'])
  assert.deepEqual(JSON.parse((projectionPatch.contentItems[0] as { text: string }).text), {
    projectionPatch: {
      status: 'done',
      nested: {
        token: '[REDACTED]',
        outputDir: '[REDACTED]',
        note: 'Bearer [REDACTED]',
      },
    },
    text: 'state patch',
  })
  for (const runtimeState of [
    createToolExecutionOutput('frame patch', { framePatch: { status: 'done' } }),
    createToolExecutionOutput('context modifier', { contextModifier: { status: 'done' } }),
  ]) {
    const mapped = mapReadyToolOutput(runtimeState)
    assert.equal(mapped.success, true)
    assert.equal((mapped.contentItems[0] as { text: string }).text, runtimeState.text)
  }
})

test('an unsupported post-effect payload becomes one safe delivered result', async () => {
  const f = fixture({
    execute: async () => createToolExecutionOutput('artifact', {
      content: [{ type: 'artifact', path: '/private/secret.txt' }],
    }),
  })
  const result = await f.bridge.execute(request())
  assert.equal(result.success, true)
  assert.match(
    (result.contentItems[0] as { text: string }).text,
    /tool_result_payload_omitted/,
  )
  assert.equal(f.executions(), 1)
  assert.equal(f.receipts.records.size, 1)
  assert.equal(f.persistence.deliveryCount, 1)
})

test('a non-serializable post-effect output is replaced before receipt and delivered once', async () => {
  const malformed = createToolExecutionOutput('malformed', {
    shape: 'json',
    data: { value: 'done' },
  })
  malformed.data!.self = malformed.data
  const f = fixture({ execute: async () => malformed })

  const result = await f.bridge.execute(request())
  assert.equal(result.success, false)
  assert.match(
    (result.contentItems[0] as { text: string }).text,
    /tool_result_not_serializable/,
  )
  assert.equal(f.executions(), 1)
  assert.equal(f.receipts.records.size, 1)
  assert.equal(f.persistence.deliveryCount, 1)
  const receipt = [...f.receipts.records.values()][0]
  assert.equal(receipt?.output.data?.errorKind, 'tool_result_not_serializable')
})
