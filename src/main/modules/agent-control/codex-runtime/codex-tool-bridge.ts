import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../tools-runtime/tool-result-types'
import {
  defaultToolRegistry,
  resolveToolInputSchemaForExecution,
  type ToolRegistryReader,
} from '../tools-runtime/tool-registry'
import type { ToolContext } from '../../tools/tool-executor'
import { isToolStatePatchEmittingToolName } from '../contracts/skill-frame-patch-tool-names'
import { resolveToolExecutionTimeoutMsForProfile } from '../../tools/tool-execution-timeout-policy'
import type {
  CodexToolBridgeExecutionBinding,
  CodexToolCallBindingRead,
} from './codex-binding-repository'
import type {
  CodexBoundServerRequestExecutor,
  CodexToolServerRequestParams,
} from './codex-provisional-inbound-buffer'
import { canonicalJson, digestCanonicalJson } from './codex-model-gateway-contract'
import {
  mapReadyToolOutput,
  type CodexDynamicToolResponse,
} from './codex-tool-output-mapper'
import {
  buildReadyToolActionAbsenceEvidenceDigest,
  type ReadyToolActionReceiptPort,
  type ReadyToolActionReceiptRead,
} from './codex-tool-action-journal'
import { buildCodexToolActionIdentity } from './codex-tool-action-identity'
import type {
  CodexServerRequestResponse,
  CodexToolResponseDeliveryAttemptIdentity,
  CodexToolResponseDeliveryAttemptRead,
} from './codex-tool-response-delivery'
import { buildReadyToolSurface, type ReadyToolSurfaceEntry } from './codex-tool-surface'
import { isHostFolderExportPrimitive } from '../../tools/skill-tool-execution-authority'

export { mapReadyToolOutput } from './codex-tool-output-mapper'
export type {
  CodexDynamicToolResponse,
  CodexDynamicToolResponseContent,
} from './codex-tool-output-mapper'

export interface CodexToolBridgePersistencePort {
  readToolBridgeExecutionBinding(bindingId: string): CodexToolBridgeExecutionBinding
  bindToolCall(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    readyRunId: string
    readyActionId: string
    readyAliasId: string
    codexSessionId: string
    readyTaskId: string
    toolName: string
    argsDigest: string
    turnContractDigest: string
    surfaceSnapshotDigest: string
    toolSurfaceDigest: string
    authorizationSnapshotDigest: string
    toolSchemaDigest: string
    requestConnectionEpoch: string
    requestRpcId: string
    at: string
  }): { duplicate: boolean }
  readToolCallBinding(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
  }): CodexToolCallBindingRead | null
  completeToolCall(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    receiptId: string
    resultDigest: string
    at: string
  }): void
  markToolCallDeliveryIntent(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    connectionEpoch: string
    requestRpcId: string
    toolResponseDigest: string
    at: string
  }): void
  beginToolCallDeliveryAttempt(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    connectionEpoch: string
    requestRpcId: string
    toolResponse: unknown
    toolResponseDigest: string
    at: string
  }): { attempt: CodexToolResponseDeliveryAttemptIdentity; duplicate: boolean }
  readToolCallDeliveryAttempts(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
  }): CodexToolResponseDeliveryAttemptRead[]
  confirmToolCallDeliveryTransportWrite(input: CodexToolResponseDeliveryAttemptIdentity & {
    at: string
  }): void
}

export class CodexToolBridgeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexToolBridgeError'
  }
}

type LoadedReadyToolCall = (
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolExecutionOutput>

export type CodexReadyToolBridgeDeps = {
  persistence: CodexToolBridgePersistencePort
  receipts: ReadyToolActionReceiptPort
  loadToolExecutor: () => Promise<LoadedReadyToolCall>
  validateToolArguments: (
    binding: CodexToolBridgeExecutionBinding,
    toolName: string,
    args: Record<string, unknown>,
    frozenEntry: ReadyToolSurfaceEntry,
  ) => void
  buildToolContext: (
    binding: CodexToolBridgeExecutionBinding,
    abortSignal: AbortSignal,
    executionIdentity: {
      executingToolName: string
      codexThreadId: string
      codexTurnId: string
      codexCallId: string
      readyActionId: string
      actionIdentityDigest: string
    },
  ) => Omit<Partial<ToolContext>, 'allowedToolNames' | 'authorization' | 'invoker'>
  getAbortSignal: (binding: CodexToolBridgeExecutionBinding) => AbortSignal | null
  getSensitiveValues: (binding: CodexToolBridgeExecutionBinding) => readonly string[]
  awaitInteractionResolution: (input: {
    binding: CodexToolBridgeExecutionBinding
    readyActionId: string
    toolName: string
    waitingOutput: ToolExecutionOutput
    abortSignal: AbortSignal
  }) => Promise<ToolExecutionOutput>
  isConnectionLive: (connectionEpoch: string) => boolean
  getConnectionAbortSignal: (connectionEpoch: string) => AbortSignal | null
  now: () => string
  timeoutMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value: string, code: string): string {
  const normalized = value.trim()
  if (!normalized) throw new CodexToolBridgeError(code)
  return normalized
}

function requestIdText(value: number | string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CodexToolBridgeError('tool_request_rpc_id_invalid')
    return String(value)
  }
  return nonEmpty(value, 'tool_request_rpc_id_invalid')
}

function authorizationOf(binding: CodexToolBridgeExecutionBinding): SkillToolAuthorization {
  const serialized = binding.authorization.skillAuthorization
  if (serialized.mode === 'none') {
    const hostPrimitives = binding.authorization.allowedToolNames.filter(isHostFolderExportPrimitive)
    const candidate = serialized.candidateSkillPrimitives
    const primitives = [...new Set([
      ...(candidate?.primitives || []),
      ...hostPrimitives,
    ])]
    return buildExplicitNoSkillAuthorization(serialized.reason, primitives.length > 0
      ? {
          candidateSkillPrimitives: {
            skillId: candidate?.skillId || 'ready-host-artifact-delivery',
            primitives,
          },
        }
      : undefined)
  }
  return buildSelectedSkillToolAuthorization({
    skillId: serialized.skillId,
    allowedTypedActions: serialized.allowedTypedActions,
    allowedPrimitives: serialized.allowedPrimitives,
    source: serialized.source,
    reason: serialized.reason,
  })
}

export function validateCodexFrozenToolExecution(
  input: {
    binding: CodexToolBridgeExecutionBinding
    toolName: string
    args: Record<string, unknown>
    frozenEntry: ReadyToolSurfaceEntry
  },
  registry: Pick<
    ToolRegistryReader,
    'getToolDefinitionForExecution' | 'getToolDefinitionsForGroup'
  > & Partial<Pick<ToolRegistryReader, 'getToolDefinition'>> = defaultToolRegistry,
  resolveInputSchema: typeof resolveToolInputSchemaForExecution = resolveToolInputSchemaForExecution,
): void {
  if (isToolStatePatchEmittingToolName(input.toolName)) {
    throw new CodexToolBridgeError('tool_result_state_unsupported')
  }
  const registeredDefinition = registry.getToolDefinitionForExecution(input.toolName)
  if (!registeredDefinition) throw new CodexToolBridgeError('tool_not_registered')
  const currentDefinition = isHostFolderExportPrimitive(input.toolName)
    ? (() => {
        const definition = registry.getToolDefinition?.(input.toolName)
        return definition ? { ...definition, codexExecutionSafe: true } : null
      })()
    : registry.getToolDefinitionsForGroup(
        input.frozenEntry.effectProfile.groupId,
        input.binding.readyAliasId,
        authorizationOf(input.binding),
        input.binding.readyScopeId,
      ).find((definition) => definition.name === input.toolName)
  if (!currentDefinition) throw new CodexToolBridgeError('tool_execution_surface_drift')
  if (currentDefinition.domain === 'skill' && currentDefinition.codexExecutionSafe !== true) {
    throw new CodexToolBridgeError('tool_execution_authority_unsupported')
  }
  const currentEntry = buildReadyToolSurface({
    surfaceId: 'tool-execution-readback',
    toolDefinitions: [currentDefinition],
  }).entries[0]
  if (!currentEntry || canonicalJson(currentEntry) !== canonicalJson(input.frozenEntry)) {
    throw new CodexToolBridgeError('tool_execution_surface_drift')
  }
  const schema = resolveInputSchema(input.toolName)
  if (!schema) {
    if (currentDefinition.schema === null && Object.keys(input.args).length === 0) return
    // The gateway already validated the frozen JSON schema and the bind below pins its args digest.
    if (currentDefinition.schema !== null) return
    throw new CodexToolBridgeError('tool_call_arguments_invalid')
  }
  const parsed = schema.safeParse(input.args)
  if (
    !parsed.success
    || canonicalJson(parsed.data) !== canonicalJson(input.args)
  ) {
    throw new CodexToolBridgeError('tool_call_arguments_invalid')
  }
}

function normalizeSensitiveValues(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new CodexToolBridgeError('tool_sensitive_values_invalid')
  const normalized = [...new Set(values)].sort((left, right) => right.length - left.length)
  if (normalized.some((value) => typeof value !== 'string' || value.length < 4)) {
    throw new CodexToolBridgeError('tool_sensitive_values_invalid')
  }
  return normalized
}

function resolveExecutionTimeoutMs(
  entry: ReadyToolSurfaceEntry,
  hostHardTimeoutMs: number,
): number {
  const frozenTimeoutMs = entry.effectProfile.executionTimeoutMs
    ?? resolveToolExecutionTimeoutMsForProfile(entry.effectProfile.timeoutProfile)
  if (!Number.isSafeInteger(frozenTimeoutMs) || frozenTimeoutMs <= 0) {
    throw new CodexToolBridgeError('tool_execution_timeout_contract_invalid')
  }
  if (entry.effectProfile.timeoutProfile === 'user_interaction') return frozenTimeoutMs
  return Math.min(frozenTimeoutMs, hostHardTimeoutMs)
}

function receiptedToolOutput(output: ToolExecutionOutput): {
  output: ToolExecutionOutput
  resultDigest: string
} {
  try {
    return { output, resultDigest: digestCanonicalJson(output) }
  } catch {
    const safeOutput = createToolExecutionOutput(
      'The tool finished, but returned an invalid result.',
      {
        shape: 'json',
        data: {
          errorKind: 'tool_result_not_serializable',
        },
      },
    )
    return { output: safeOutput, resultDigest: digestCanonicalJson(safeOutput) }
  }
}

function validateRequest(
  binding: CodexToolBridgeExecutionBinding,
  params: CodexToolServerRequestParams,
): { args: Record<string, unknown>; entry: ReadyToolSurfaceEntry } {
  if (params.namespace !== null) throw new CodexToolBridgeError('codex_builtin_tool_forbidden')
  if (params.threadId !== binding.codexThreadId) {
    throw new CodexToolBridgeError('tool_call_thread_identity_mismatch')
  }
  if (params.turnId !== binding.codexTurnId) {
    throw new CodexToolBridgeError('tool_call_turn_identity_mismatch')
  }
  if (!isRecord(params.arguments)) throw new CodexToolBridgeError('tool_call_arguments_invalid')
  const entry = binding.toolSurface.entries.find((candidate) => candidate.name === params.tool)
  if (!entry) throw new CodexToolBridgeError('tool_not_registered')
  if (!binding.authorization.allowedToolNames.includes(params.tool)) {
    throw new CodexToolBridgeError('authorization_denied')
  }
  return { args: params.arguments, entry }
}

export class CodexReadyToolBridge implements CodexBoundServerRequestExecutor {
  private readonly inFlight = new Map<string, Promise<CodexServerRequestResponse>>()

  constructor(private readonly deps: CodexReadyToolBridgeDeps) {
    if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs <= 0) {
      throw new CodexToolBridgeError('tool_bridge_timeout_invalid')
    }
  }

  async execute(input: {
    bindingId: string
    connectionEpoch: string
    requestId: number | string
    params: CodexToolServerRequestParams
  }): Promise<CodexDynamicToolResponse> {
    return (await this.executePrepared(input)).result as CodexDynamicToolResponse
  }

  async executeServerRequest(input: {
    bindingId: string
    connectionEpoch: string
    requestId: number | string
    params: CodexToolServerRequestParams
  }): Promise<CodexServerRequestResponse> {
    return this.executePrepared(input)
  }

  confirmServerResponseTransportWrite(
    attempt: CodexToolResponseDeliveryAttemptIdentity,
  ): void {
    this.deps.persistence.confirmToolCallDeliveryTransportWrite({
      ...attempt,
      at: this.deps.now(),
    })
  }

  private async executePrepared(input: {
    bindingId: string
    connectionEpoch: string
    requestId: number | string
    params: CodexToolServerRequestParams
  }): Promise<CodexServerRequestResponse> {
    const binding = this.deps.persistence.readToolBridgeExecutionBinding(
      nonEmpty(input.bindingId, 'tool_bridge_binding_id_invalid'),
    )
    const connectionEpoch = nonEmpty(input.connectionEpoch, 'tool_connection_epoch_invalid')
    const rpcId = requestIdText(input.requestId)
    const callId = nonEmpty(input.params.callId, 'tool_call_id_invalid')
    const toolName = nonEmpty(input.params.tool, 'tool_name_invalid')
    const { args, entry } = validateRequest(binding, { ...input.params, callId, tool: toolName })
    this.deps.validateToolArguments(binding, toolName, args, entry)
    const executionTimeoutMs = resolveExecutionTimeoutMs(entry, this.deps.timeoutMs)
    const schemaDigest = entry.schemaDigest
    const sensitiveValues = normalizeSensitiveValues(this.deps.getSensitiveValues(binding))
    if (!this.deps.isConnectionLive(connectionEpoch)) {
      throw new CodexToolBridgeError('sidecar_disconnected_before_effect')
    }
    const externalSignal = this.deps.getAbortSignal(binding)
    if (!externalSignal) throw new CodexToolBridgeError('tool_abort_authority_missing')
    if (externalSignal.aborted) throw new CodexToolBridgeError('tool_abort_before_action')
    const connectionSignal = this.deps.getConnectionAbortSignal(connectionEpoch)
    if (!connectionSignal) {
      throw new CodexToolBridgeError('connection_abort_authority_missing')
    }
    if (connectionSignal.aborted || !this.deps.isConnectionLive(connectionEpoch)) {
      throw new CodexToolBridgeError('sidecar_disconnected_before_effect')
    }
    const argsDigest = digestCanonicalJson(args)
    const { actionIdentityDigest, readyActionId } = buildCodexToolActionIdentity({
      readyAliasId: binding.readyAliasId,
      codexSessionId: binding.codexSessionId,
      codexThreadId: binding.codexThreadId,
      codexTurnId: binding.codexTurnId,
      codexCallId: callId,
      readyTaskId: binding.readyTaskId,
      readyRunId: binding.readyRunId,
      toolName,
      argsDigest,
      turnContractDigest: binding.turnContractDigest,
      surfaceSnapshotDigest: binding.toolSurface.surfaceSnapshotDigest,
      authorizationSnapshotDigest: binding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: schemaDigest,
    })
    const bound = this.deps.persistence.bindToolCall({
      codexThreadId: binding.codexThreadId,
      codexTurnId: binding.codexTurnId,
      codexCallId: callId,
      readyRunId: binding.readyRunId,
      readyActionId,
      readyAliasId: binding.readyAliasId,
      codexSessionId: binding.codexSessionId,
      readyTaskId: binding.readyTaskId,
      toolName,
      argsDigest,
      turnContractDigest: binding.turnContractDigest,
      surfaceSnapshotDigest: binding.toolSurface.surfaceSnapshotDigest,
      toolSurfaceDigest: binding.toolSurface.toolSurfaceDigest,
      authorizationSnapshotDigest: binding.authorization.authorizationSnapshotDigest,
      toolSchemaDigest: schemaDigest,
      requestConnectionEpoch: connectionEpoch,
      requestRpcId: rpcId,
      at: this.deps.now(),
    })
    const active = this.inFlight.get(readyActionId)
    if (active) {
      const existing = this.deps.persistence.readToolCallBinding({
        codexThreadId: binding.codexThreadId,
        codexTurnId: binding.codexTurnId,
        codexCallId: callId,
      })
      if (!existing || existing.requestConnectionEpoch === connectionEpoch) {
        throw new CodexToolBridgeError('tool_call_already_in_flight')
      }
      try {
        await active
      } catch {
        // The replacement connection decides from the durable receipt below.
      }
      if (this.inFlight.get(readyActionId) === active) this.inFlight.delete(readyActionId)
      return this.executeBound({
        binding,
        callId,
        toolName,
        args,
        readyActionId,
        connectionEpoch,
        rpcId,
        duplicate: true,
        actionIdentityDigest,
        sensitiveValues,
        frozenEntry: entry,
        executionTimeoutMs,
        externalSignal,
        connectionSignal,
      })
    }
    const execution = this.executeBound({
      binding,
      callId,
      toolName,
      args,
      readyActionId,
      connectionEpoch,
      rpcId,
      duplicate: bound.duplicate,
      actionIdentityDigest,
      sensitiveValues,
      frozenEntry: entry,
      executionTimeoutMs,
      externalSignal,
      connectionSignal,
    })
    this.inFlight.set(readyActionId, execution)
    try {
      return await execution
    } finally {
      if (this.inFlight.get(readyActionId) === execution) this.inFlight.delete(readyActionId)
    }
  }

  private async executeBound(input: {
    binding: CodexToolBridgeExecutionBinding
    callId: string
    toolName: string
    args: Record<string, unknown>
    readyActionId: string
    connectionEpoch: string
    rpcId: string
    duplicate: boolean
    actionIdentityDigest: string
    sensitiveValues: string[]
    frozenEntry: ReadyToolSurfaceEntry
    executionTimeoutMs: number
    externalSignal: AbortSignal
    connectionSignal: AbortSignal
  }): Promise<CodexServerRequestResponse> {
    if (input.duplicate) {
      const prior = await this.deps.receipts.read(input.readyActionId)
      if (prior.state === 'confirmed') {
        this.persistResult(input, prior)
        return this.prepareConfirmedReplay(input, prior)
      }
      if (prior.state === 'proven_absent' || prior.state === 'absent') {
        throw new CodexToolBridgeError('tool_effect_proven_absent')
      }
      throw new CodexToolBridgeError('tool_effect_unknown')
    }
    const { externalSignal, connectionSignal } = input
    if (externalSignal.aborted) throw new CodexToolBridgeError('tool_abort_before_action')
    if (connectionSignal.aborted) {
      throw new CodexToolBridgeError('sidecar_disconnected_before_effect')
    }
    const began = await this.deps.receipts.begin({
      readyActionId: input.readyActionId,
      actionIdentityDigest: input.actionIdentityDigest,
      at: this.deps.now(),
    })
    if (!began.fresh) {
      const prior = await this.deps.receipts.read(input.readyActionId)
      if (prior.state === 'confirmed') this.persistResult(input, prior)
      throw new CodexToolBridgeError(prior.state === 'proven_absent'
        ? 'tool_effect_proven_absent'
        : prior.state === 'confirmed'
          ? 'tool_result_replay_forbidden'
          : 'tool_effect_unknown')
    }
    if (!this.deps.isConnectionLive(input.connectionEpoch)) {
      this.deps.receipts.markProvenAbsent({
        readyActionId: input.readyActionId,
        actionIdentityDigest: input.actionIdentityDigest,
        reason: 'sidecar_disconnected_before_effect',
        evidenceDigest: buildReadyToolActionAbsenceEvidenceDigest({
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
          connectionEpoch: input.connectionEpoch,
          reason: 'sidecar_disconnected_before_effect',
        }),
        at: this.deps.now(),
      })
      throw new CodexToolBridgeError('sidecar_disconnected_before_effect')
    }
    try {
      this.deps.validateToolArguments(
        input.binding,
        input.toolName,
        input.args,
        input.frozenEntry,
      )
    } catch (error) {
      this.deps.receipts.markProvenAbsent({
        readyActionId: input.readyActionId,
        actionIdentityDigest: input.actionIdentityDigest,
        reason: 'tool_contract_drift_before_execution',
        evidenceDigest: buildReadyToolActionAbsenceEvidenceDigest({
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
          connectionEpoch: input.connectionEpoch,
          reason: 'tool_contract_drift_before_execution',
        }),
        at: this.deps.now(),
      })
      throw error
    }
    const controller = new AbortController()
    let timedOut = false
    let externallyAborted = false
    let connectionAborted = false
    let effectStarted = false
    let effectDeadlineActive = false
    let settledReadTimeout = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let rejectCancellation!: (reason: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const assertCurrentEffectAuthority = () => {
      if (externalSignal.aborted) {
        throw new CodexToolBridgeError('tool_abort_before_action')
      }
      if (connectionSignal.aborted || !this.deps.isConnectionLive(input.connectionEpoch)) {
        throw new CodexToolBridgeError('sidecar_disconnected_before_effect')
      }
      let currentBinding: CodexToolBridgeExecutionBinding
      try {
        currentBinding = this.deps.persistence.readToolBridgeExecutionBinding(input.binding.bindingId)
      } catch {
        throw new CodexToolBridgeError('tool_execution_authority_drift_after_load')
      }
      if (canonicalJson(currentBinding) !== canonicalJson(input.binding)) {
        throw new CodexToolBridgeError('tool_execution_authority_drift_after_load')
      }
      try {
        this.deps.validateToolArguments(
          input.binding,
          input.toolName,
          input.args,
          input.frozenEntry,
        )
      } catch {
        throw new CodexToolBridgeError('tool_execution_surface_drift_after_load')
      }
    }
    const startEffectDeadline = () => {
      if (effectDeadlineActive) throw new CodexToolBridgeError('tool_effect_phase_reentered')
      assertCurrentEffectAuthority()
      effectStarted = true
      effectDeadlineActive = true
      if (input.frozenEntry.effectProfile.timeoutProfile === 'user_interaction') return
      timer = setTimeout(() => {
        timedOut = true
        const error = new CodexToolBridgeError('tool_execution_timeout')
        controller.abort(error)
        rejectCancellation(error)
      }, input.executionTimeoutMs)
    }
    const endEffectDeadline = () => {
      if (timer) clearTimeout(timer)
      timer = null
      effectDeadlineActive = false
    }
    const onExternalAbort = () => {
      externallyAborted = true
      const error = new CodexToolBridgeError('tool_execution_aborted')
      controller.abort(externalSignal.reason || error)
      rejectCancellation(error)
    }
    const onConnectionAbort = () => {
      connectionAborted = true
      const error = new CodexToolBridgeError('sidecar_disconnected_during_tool_call')
      controller.abort(connectionSignal.reason || error)
      rejectCancellation(error)
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true })
    connectionSignal.addEventListener('abort', onConnectionAbort, { once: true })
    if (externalSignal.aborted && !externallyAborted) onExternalAbort()
    if (connectionSignal.aborted && !connectionAborted) onConnectionAbort()
    let output: ToolExecutionOutput
    const readyExecution = (async () => {
      const executeToolCall = await this.deps.loadToolExecutor()
      if (controller.signal.aborted) {
        throw new CodexToolBridgeError('tool_abort_before_action')
      }
      assertCurrentEffectAuthority()
      const firstOutput = await executeToolCall(input.toolName, input.args, {
        ...this.deps.buildToolContext(input.binding, controller.signal, {
          executingToolName: input.toolName,
          codexThreadId: input.binding.codexThreadId,
          codexTurnId: input.binding.codexTurnId,
          codexCallId: input.callId,
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
        }),
        sessionId: input.binding.readyAliasId,
        scopeId: input.binding.readyScopeId,
        runId: input.binding.readyRunId,
        taskId: input.binding.readyTaskId,
        allowedToolNames: new Set(input.binding.authorization.allowedToolNames),
        authorization: authorizationOf(input.binding),
        abortSignal: controller.signal,
        onToolEffectStart: startEffectDeadline,
        onToolEffectEnd: endEffectDeadline,
        codexHostPrimitiveOnly: true,
        invoker: 'model',
        allowInternal: false,
      })
      if (!firstOutput.interactionHint) return firstOutput
      const resolved = await this.deps.awaitInteractionResolution({
        binding: input.binding,
        readyActionId: input.readyActionId,
        toolName: input.toolName,
        waitingOutput: firstOutput,
        abortSignal: controller.signal,
      })
      if (resolved.interactionHint) {
        throw new CodexToolBridgeError('tool_interaction_result_unresolved')
      }
      return resolved
    })()
    try {
      output = await Promise.race([readyExecution, cancellation])
    } catch (executionError) {
      if (
        executionError instanceof CodexToolBridgeError
        && (
          executionError.code === 'tool_execution_surface_drift_after_load'
          || executionError.code === 'tool_execution_authority_drift_after_load'
          || executionError.code === 'sidecar_disconnected_before_effect'
          || executionError.code === 'tool_abort_before_action'
        )
      ) {
        this.deps.receipts.markProvenAbsent({
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
          reason: executionError.code,
          evidenceDigest: buildReadyToolActionAbsenceEvidenceDigest({
            readyActionId: input.readyActionId,
            actionIdentityDigest: input.actionIdentityDigest,
            connectionEpoch: input.connectionEpoch,
            reason: executionError.code,
          }),
          at: this.deps.now(),
        })
        throw executionError
      }
      if ((timedOut || externallyAborted || connectionAborted) && !effectStarted) {
        this.deps.receipts.markProvenAbsent({
          readyActionId: input.readyActionId,
          actionIdentityDigest: input.actionIdentityDigest,
          reason: connectionAborted
            ? 'sidecar_disconnected_before_effect'
            : timedOut ? 'tool_timeout_before_effect' : 'tool_abort_before_action',
          evidenceDigest: buildReadyToolActionAbsenceEvidenceDigest({
            readyActionId: input.readyActionId,
            actionIdentityDigest: input.actionIdentityDigest,
            connectionEpoch: input.connectionEpoch,
            reason: connectionAborted
              ? 'sidecar_disconnected_before_effect'
              : timedOut ? 'tool_timeout_before_effect' : 'tool_abort_before_action',
          }),
          at: this.deps.now(),
        })
        throw new CodexToolBridgeError(connectionAborted
          ? 'sidecar_disconnected_before_effect'
          : 'tool_effect_proven_absent')
      }
      if (
        timedOut
        && !externallyAborted
        && !connectionAborted
        && input.frozenEntry.effectProfile.kind === 'read'
        && this.deps.isConnectionLive(input.connectionEpoch)
      ) {
        settledReadTimeout = true
        void readyExecution.catch(() => undefined)
        output = createToolExecutionOutput(
          'The read operation timed out. Continue with prior evidence or use another source.',
          {
            shape: 'json',
            data: {
              errorKind: 'tool_execution_timeout',
              toolName: input.toolName,
              timeoutMs: input.executionTimeoutMs,
            },
          },
        )
      } else {
        if (timedOut || externallyAborted || connectionAborted) {
          void readyExecution.then((lateOutput) => this.persistLateResult(input, lateOutput)).catch(() => undefined)
        }
        const recovered = await this.deps.receipts.read(input.readyActionId)
        if (recovered.state === 'confirmed') {
          this.persistResult(input, recovered)
          if (timedOut) throw new CodexToolBridgeError('tool_timeout_after_effect')
          if (externallyAborted || externalSignal.aborted) {
            throw new CodexToolBridgeError('tool_abort_after_effect')
          }
          if (connectionAborted || connectionSignal.aborted) {
            throw new CodexToolBridgeError('sidecar_disconnected_after_effect')
          }
          if (this.deps.isConnectionLive(input.connectionEpoch)) {
            const response = mapReadyToolOutput(recovered.output, input.sensitiveValues)
            return this.prepareDelivery(input, response)
          }
          throw new CodexToolBridgeError('sidecar_disconnected_after_effect')
        }
        if (recovered.state === 'proven_absent') {
          throw new CodexToolBridgeError('tool_effect_proven_absent')
        }
        if (timedOut) throw new CodexToolBridgeError('tool_timeout_effect_unknown')
        if (connectionAborted) throw new CodexToolBridgeError('tool_effect_unknown')
        if (externallyAborted || controller.signal.aborted) {
          throw new CodexToolBridgeError('tool_abort_effect_unknown')
        }
        throw new CodexToolBridgeError('tool_effect_unknown')
      }
    } finally {
      if (timer) clearTimeout(timer)
      externalSignal.removeEventListener('abort', onExternalAbort)
      connectionSignal.removeEventListener('abort', onConnectionAbort)
    }
    const receipted = receiptedToolOutput(output)
    const response = mapReadyToolOutput(receipted.output, input.sensitiveValues)
    const receipt = await this.deps.receipts.commit({
      readyActionId: input.readyActionId,
      actionIdentityDigest: input.actionIdentityDigest,
      resultDigest: receipted.resultDigest,
      output: receipted.output,
      at: this.deps.now(),
    })
    if (
      receipt.resultDigest !== receipted.resultDigest
      || canonicalJson(receipt.output) !== canonicalJson(receipted.output)
    ) throw new CodexToolBridgeError('tool_receipt_commit_conflict')
    this.persistResult(input, receipt)
    if (externallyAborted || externalSignal.aborted) {
      throw new CodexToolBridgeError('tool_abort_after_effect')
    }
    if (!this.deps.isConnectionLive(input.connectionEpoch)) {
      throw new CodexToolBridgeError('sidecar_disconnected_after_effect')
    }
    if (timedOut && !settledReadTimeout) throw new CodexToolBridgeError('tool_timeout_after_effect')
    return this.prepareDelivery(input, response)
  }

  private prepareConfirmedReplay(
    input: {
      binding: CodexToolBridgeExecutionBinding
      callId: string
      readyActionId: string
      connectionEpoch: string
      rpcId: string
      sensitiveValues: string[]
    },
    receipt: Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>,
  ): CodexServerRequestResponse {
    const call = this.deps.persistence.readToolCallBinding({
      codexThreadId: input.binding.codexThreadId,
      codexTurnId: input.binding.codexTurnId,
      codexCallId: input.callId,
    })
    if (!call || call.readyActionId !== input.readyActionId) {
      throw new CodexToolBridgeError('tool_call_identity_conflict')
    }
    const attempts = this.deps.persistence.readToolCallDeliveryAttempts({
      codexThreadId: input.binding.codexThreadId,
      codexTurnId: input.binding.codexTurnId,
      codexCallId: input.callId,
    })
    const priorConnectionEpochs = new Set([
      call.requestConnectionEpoch,
      ...attempts.map((attempt) => attempt.connectionEpoch),
    ])
    if (priorConnectionEpochs.has(input.connectionEpoch)) {
      throw new CodexToolBridgeError('tool_result_replay_forbidden')
    }
    for (const connectionEpoch of priorConnectionEpochs) {
      if (this.deps.isConnectionLive(connectionEpoch)) {
        throw new CodexToolBridgeError('tool_result_replay_previous_connection_live')
      }
    }
    return this.prepareDelivery(
      input,
      mapReadyToolOutput(receipt.output, input.sensitiveValues),
    )
  }

  private prepareDelivery(input: {
    binding: CodexToolBridgeExecutionBinding
    callId: string
    connectionEpoch: string
    rpcId: string
  }, response: CodexDynamicToolResponse): CodexServerRequestResponse {
    const prepared = this.deps.persistence.beginToolCallDeliveryAttempt({
      codexThreadId: input.binding.codexThreadId,
      codexTurnId: input.binding.codexTurnId,
      codexCallId: input.callId,
      connectionEpoch: input.connectionEpoch,
      requestRpcId: input.rpcId,
      toolResponse: response,
      toolResponseDigest: digestCanonicalJson(response),
      at: this.deps.now(),
    })
    if (prepared.duplicate) {
      throw new CodexToolBridgeError('tool_result_replay_forbidden')
    }
    return { result: response, deliveryAttempt: prepared.attempt }
  }

  private persistResult(
    input: {
      binding: CodexToolBridgeExecutionBinding
      callId: string
    },
    receipt: Extract<ReadyToolActionReceiptRead, { state: 'confirmed' }>,
  ): void {
    if (digestCanonicalJson(receipt.output) !== receipt.resultDigest) {
      throw new CodexToolBridgeError('tool_receipt_digest_invalid')
    }
    this.deps.persistence.completeToolCall({
      codexThreadId: input.binding.codexThreadId,
      codexTurnId: input.binding.codexTurnId,
      codexCallId: input.callId,
      receiptId: receipt.receiptId,
      resultDigest: receipt.resultDigest,
      at: this.deps.now(),
    })
  }

  private async persistLateResult(
    input: {
      binding: CodexToolBridgeExecutionBinding
      callId: string
      readyActionId: string
      actionIdentityDigest: string
    },
    output: ToolExecutionOutput,
  ): Promise<void> {
    const receipted = receiptedToolOutput(output)
    const receipt = await this.deps.receipts.commit({
      readyActionId: input.readyActionId,
      actionIdentityDigest: input.actionIdentityDigest,
      resultDigest: receipted.resultDigest,
      output: receipted.output,
      at: this.deps.now(),
    })
    this.persistResult(input, receipt)
  }
}

export function createCodexReadyToolBridge(
  deps: Omit<CodexReadyToolBridgeDeps, 'loadToolExecutor' | 'validateToolArguments'>,
): CodexReadyToolBridge {
  return new CodexReadyToolBridge({
    ...deps,
    validateToolArguments: (binding, toolName, args, frozenEntry) => {
      validateCodexFrozenToolExecution({ binding, toolName, args, frozenEntry })
    },
    loadToolExecutor: async () => {
      const { executeToolCall } = await import('../../tools/tool-executor')
      return executeToolCall
    },
  })
}
