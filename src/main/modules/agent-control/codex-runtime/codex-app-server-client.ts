import { createHash } from 'node:crypto'

import { APP_VERSION } from '../../../../shared/app-version'

import {
  CODEX_OPT_OUT_NOTIFICATION_METHODS,
  normalizeCodexNativeNotification,
  normalizeCodexThread,
  normalizeCodexTurn,
  type CodexAdditionalContextEntry,
  type CodexDynamicToolSpec,
  type CodexNativeNotification,
  type CodexNativeRuntime,
  type CodexServerDiagnostics,
  type CodexThread,
  type CodexThreadEffectiveSettings,
  type CodexThreadForkParams,
  type CodexThreadListParams,
  type CodexThreadResumeParams,
  type CodexThreadStartParams,
  type CodexTurn,
  type CodexTurnStartParams
} from './codex-native-runtime'
import { isCodexUserInput } from './codex-user-input'
import { digestCanonicalJson } from './codex-model-gateway-contract'
import type {
  CodexServerRequestResponse,
  CodexToolResponseDeliveryAttemptIdentity,
} from './codex-tool-response-delivery'

type JsonObject = Record<string, unknown>
type StartMethod = 'thread/start' | 'thread/fork' | 'turn/start'
type ClientMethod =
  | 'initialize'
  | 'server/diagnostics'
  | 'thread/start'
  | 'thread/list'
  | 'thread/read'
  | 'thread/fork'
  | 'thread/resume'
  | 'thread/archive'
  | 'thread/compact/start'
  | 'turn/start'
  | 'turn/interrupt'

type StartDispatchIdentity = {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  bindingId: string
}

export interface CodexJsonLineTransport {
  write(line: string, callback: (error: Error | null) => void): void
  onLine(listener: (line: string) => void): () => void
  onClose(listener: (error: Error | null) => void): () => void
  close(reason: string, details?: unknown): void
}

export interface CodexStartDispatchPort {
  activate(input: Omit<StartDispatchIdentity, 'bindingId'> & {
    bindingLookupKey: string
    requestDigest: string
  }): Promise<{ bindingId: string }>
  markChildWriteConfirmed(input: StartDispatchIdentity & {
    childWriteDigest: string
  }): Promise<void>
  markUnresolved(input: StartDispatchIdentity & {
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  }): Promise<void>
  reconcileAccepted(input: StartDispatchIdentity & {
    nativeId: string
    nativeResult: unknown
    responseDigest: string
    responsePending: boolean
  }): Promise<void>
  reconcileRejected(input: StartDispatchIdentity & {
    rpcError: unknown
    responseDigest: string
  }): Promise<'unknown' | 'proven_absent'>
  consumeLateResponse(input: Omit<StartDispatchIdentity, 'bindingId'> & {
    nativeId: string
    responseDigest: string
  }): Promise<boolean>
  markConnectionClosed(connectionEpoch: string): Promise<void>
}

type ManualCompactionDispatchIdentity = {
  connectionEpoch: string
  rpcId: number
  manualCompactionId: string
}

export interface CodexManualCompactionDispatchPort {
  activate(input: Omit<ManualCompactionDispatchIdentity, 'manualCompactionId'> & {
    codexThreadId: string
    requestDigest: string
  }): Promise<{ manualCompactionId: string }>
  markWriteAttempted(input: ManualCompactionDispatchIdentity): Promise<void>
  markChildWriteConfirmed(input: ManualCompactionDispatchIdentity & {
    childWriteDigest: string
  }): Promise<void>
  markUnresolved(input: ManualCompactionDispatchIdentity & {
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  }): Promise<void>
  reconcileResponse(input: ManualCompactionDispatchIdentity & {
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<void>
  consumeLateResponse(input: Omit<ManualCompactionDispatchIdentity, 'manualCompactionId'> & {
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<boolean>
  markConnectionClosed(connectionEpoch: string): Promise<void>
}

export interface CodexInboundFramePort {
  attachReleasePort?(port: CodexInboundFrameReleasePort): () => void
  routeNotification(input: {
    connectionEpoch: string
    frame: unknown
    notification: CodexNativeNotification
  }): Promise<'broadcast' | 'buffered'>
  routeServerRequest(input: {
    connectionEpoch: string
    requestId: number | string
    method: 'item/tool/call'
    params: unknown
  }): Promise<
    | { disposition: 'buffered' }
    | ({ disposition: 'respond' } & CodexServerRequestResponse)
  >
  confirmServerResponseTransportWrite(
    attempt: CodexToolResponseDeliveryAttemptIdentity,
  ): void | PromiseLike<void>
  retireThread?(connectionEpoch: string, codexThreadId: string): void
}

export interface CodexInboundFrameReleasePort {
  broadcastNotification(notification: CodexNativeNotification): void
  respondServerRequest(
    requestId: number | string,
    result: unknown,
    deliveryAttempt: CodexToolResponseDeliveryAttemptIdentity,
  ): void
  failProtocol(error: Error): void
}

export interface CodexThreadArchiveAuthorizationPort {
  assertEligible(threadId: string): void | Promise<void>
}

export interface CodexThreadArchiveDispatchPort {
  assertReadbackListEligible(input: {
    cwd: string
    sourceKinds: ['vscode']
    archived: boolean
    cursor: string | null
    useStateDbOnly: true
  }): void | Promise<void>
  activate(input: {
    connectionEpoch: string
    rpcId: number
    codexThreadId: string
    requestDigest: string
  }): Promise<{ archiveIntentId: string }>
  markWriteAttempted(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
  }): Promise<void>
  markChildWriteConfirmed(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
    childWriteDigest: string
  }): Promise<void>
  markUnresolved(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  }): Promise<void>
  reconcileResponse(input: {
    connectionEpoch: string
    rpcId: number
    archiveIntentId: string
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<void>
  consumeLateResponse(input: {
    connectionEpoch: string
    rpcId: number
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
  }): Promise<boolean>
  reconcileArchivedNotification(input: {
    connectionEpoch: string
    codexThreadId: string
    notificationDigest: string
  }): Promise<boolean>
  markConnectionClosed(connectionEpoch: string): Promise<void>
}

export class CodexAppServerClientError extends Error {
  constructor(readonly code: string, readonly details?: unknown) {
    super(code)
    this.name = 'CodexAppServerClientError'
  }
}

export function isCodexNoActiveTurnInterruptError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerClientError) || error.code !== 'rpc_rejected') return false
  return isRecord(error.details)
    && error.details.message === 'no active turn to interrupt'
}

/** A typed JSON-RPC error: Codex received the request and refused it, as opposed to a timeout or a lost connection. */
export function isCodexTypedRpcRejection(error: unknown): boolean {
  if (!(error instanceof CodexAppServerClientError) || error.code !== 'rpc_rejected') return false
  return isRecord(error.details)
    && Number.isSafeInteger(error.details.code)
    && typeof error.details.message === 'string'
    && error.details.message.trim().length > 0
}

type PendingRequest = {
  id: number
  method: ClientMethod
  bindingId: string | null
  startResponseKind: 'none' | 'accepted' | 'rejected'
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  responseNormalizer: (value: unknown) => unknown
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function controlledProtocolErrorCode(error: unknown): string | null {
  if (!isRecord(error) || typeof error.code !== 'string') return null
  const code = error.code.trim()
  return /^[a-z][a-z0-9_]{1,127}$/.test(code) ? code : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function invalidParams(): never {
  throw new CodexAppServerClientError('rpc_params_invalid')
}

function requireExactIdentityParams(value: unknown, keys: readonly string[]): JsonObject {
  if (!isRecord(value) || !hasExactKeys(value, keys)) invalidParams()
  return value
}

function validateDynamicTool(value: unknown): value is CodexDynamicToolSpec {
  if (!isRecord(value)) return false
  const keys = value.deferLoading === undefined
    ? ['type', 'name', 'description', 'inputSchema']
    : ['type', 'name', 'description', 'inputSchema', 'deferLoading']
  return hasExactKeys(value, keys)
    && value.type === 'function'
    && nonEmptyString(value.name)
    && typeof value.description === 'string'
    && isRecord(value.inputSchema)
    && (value.deferLoading === undefined || typeof value.deferLoading === 'boolean')
}

function validateAdditionalContext(value: unknown): value is Record<string, CodexAdditionalContextEntry> {
  return isRecord(value) && Object.values(value).every((entry) => (
    isRecord(entry)
    && hasExactKeys(entry, ['kind', 'value'])
    && (entry.kind === 'application' || entry.kind === 'untrusted')
    && typeof entry.value === 'string'
  ))
}

function validateThreadStartParams(value: unknown): asserts value is CodexThreadStartParams {
  const params = requireExactIdentityParams(value, [
    'model',
    'modelProvider',
    'allowProviderModelFallback',
    'cwd',
    'approvalPolicy',
    'sandbox',
    'runtimeWorkspaceRoots',
    'environments',
    'config',
    'dynamicTools',
    'developerInstructions',
  ])
  if (
    !nonEmptyString(params.model)
    || params.modelProvider !== 'ready_gateway'
    || params.allowProviderModelFallback !== false
    || !nonEmptyString(params.cwd)
    || params.approvalPolicy !== 'never'
    || params.sandbox !== 'read-only'
    || !Array.isArray(params.runtimeWorkspaceRoots)
    || params.runtimeWorkspaceRoots.length !== 0
    || !Array.isArray(params.environments)
    || params.environments.length !== 0
    || (
      params.config !== null
      && (
        !isRecord(params.config)
        || !hasExactKeys(params.config, ['model_context_window'])
        || !Number.isSafeInteger(params.config.model_context_window)
        || Number(params.config.model_context_window) < 1
      )
    )
    || !Array.isArray(params.dynamicTools)
    || !params.dynamicTools.every(validateDynamicTool)
    || typeof params.developerInstructions !== 'string'
  ) invalidParams()
}

function validateTurnStartParams(value: unknown): asserts value is CodexTurnStartParams {
  const params = requireExactIdentityParams(value, [
    'threadId',
    'clientUserMessageId',
    'collaborationMode',
    'environments',
    'input',
    'additionalContext',
    'responsesapiClientMetadata',
  ])
  const collaborationMode = params.collaborationMode
  const collaborationSettings = isRecord(collaborationMode)
    ? collaborationMode.settings
    : null
  if (
    !nonEmptyString(params.threadId)
    || !nonEmptyString(params.clientUserMessageId)
    || !isRecord(collaborationMode)
    || !hasExactKeys(collaborationMode, ['mode', 'settings'])
    || collaborationMode.mode !== 'default'
    || !isRecord(collaborationSettings)
    || !hasExactKeys(collaborationSettings, [
      'model', 'reasoning_effort', 'developer_instructions',
    ])
    || collaborationSettings.model !== 'ready-e0-model'
    || (collaborationSettings.reasoning_effort !== null && ![
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ].includes(String(collaborationSettings.reasoning_effort)))
    || collaborationSettings.developer_instructions !== null
    || !Array.isArray(params.environments)
    || params.environments.length !== 0
    || !Array.isArray(params.input)
    || !params.input.every(isCodexUserInput)
    || !validateAdditionalContext(params.additionalContext)
    || !isRecord(params.responsesapiClientMetadata)
    || !hasExactKeys(params.responsesapiClientMetadata, [
      'readyRunId',
      'toolSurfaceDigest',
      'turnContractDigest',
      'upstreamProfileSnapshotDigest',
    ])
    || !Object.values(params.responsesapiClientMetadata).every(nonEmptyString)
  ) invalidParams()
}

function validateThreadListParams(value: unknown): asserts value is CodexThreadListParams {
  if (!isRecord(value)) invalidParams()
  const archiveReadback = Object.prototype.hasOwnProperty.call(value, 'archived')
  const params = requireExactIdentityParams(value, archiveReadback
    ? ['limit', 'cwd', 'sourceKinds', 'archived', 'cursor', 'useStateDbOnly']
    : ['limit', 'cwd', 'sourceKinds'])
  if (
    !Number.isSafeInteger(params.limit)
    || (params.limit as number) <= 0
    || !nonEmptyString(params.cwd)
    || !Array.isArray(params.sourceKinds)
    || params.sourceKinds.length !== 1
    || params.sourceKinds[0] !== 'vscode'
    || (archiveReadback && (
      typeof params.archived !== 'boolean'
      || (params.cursor !== null && typeof params.cursor !== 'string')
      || params.useStateDbOnly !== true
    ))
  ) invalidParams()
}

function validateThreadForkParams(value: unknown): asserts value is CodexThreadForkParams {
  const params = requireExactIdentityParams(value, [
    'threadId',
    'lastTurnId',
    'cwd',
    'model',
    'modelProvider',
    'approvalPolicy',
    'sandbox',
    'developerInstructions',
  ])
  if (!nonEmptyString(params.threadId)
    || !nonEmptyString(params.developerInstructions)
    || !nonEmptyString(params.lastTurnId)
    || !nonEmptyString(params.cwd)
    || !nonEmptyString(params.model)
    || params.modelProvider !== 'ready_gateway'
    || params.approvalPolicy !== 'never'
    || params.sandbox !== 'read-only') invalidParams()
}

function normalizeThreadResult(value: unknown): { thread: CodexThread } {
  if (!isRecord(value)) throw new CodexAppServerClientError('rpc_result_invalid')
  const thread = normalizeCodexThread(value.thread)
  if (!thread) throw new CodexAppServerClientError('rpc_result_invalid')
  return { thread }
}

function normalizeThreadStartResult(value: unknown): {
  thread: CodexThread
  instructionSources: string[]
} {
  if (!isRecord(value)) throw new CodexAppServerClientError('rpc_result_invalid')
  const thread = normalizeCodexThread(value.thread)
  const instructionSources = value.instructionSources === undefined ? [] : value.instructionSources
  if (
    !thread
    || !Array.isArray(instructionSources)
    || !instructionSources.every((entry) => typeof entry === 'string')
  ) throw new CodexAppServerClientError('rpc_result_invalid')
  return { thread, instructionSources }
}

function normalizeThreadEffectiveSettings(value: unknown): CodexThreadEffectiveSettings {
  if (!isRecord(value)) throw new CodexAppServerClientError('rpc_result_invalid')
  const thread = normalizeCodexThread(value.thread)
  const instructionSources = value.instructionSources === undefined ? [] : value.instructionSources
  const reasoningEffort = value.reasoningEffort === undefined ? null : value.reasoningEffort
  const serviceTier = value.serviceTier === undefined ? null : value.serviceTier
  if (!thread
    || !nonEmptyString(value.cwd)
    || !nonEmptyString(value.model)
    || !nonEmptyString(value.modelProvider)
    || !Object.prototype.hasOwnProperty.call(value, 'approvalPolicy')
    || !Object.prototype.hasOwnProperty.call(value, 'approvalsReviewer')
    || !Object.prototype.hasOwnProperty.call(value, 'sandbox')
    || (reasoningEffort !== null && typeof reasoningEffort !== 'string')
    || (serviceTier !== null && typeof serviceTier !== 'string')
    || !Array.isArray(instructionSources)
    || !instructionSources.every((entry) => typeof entry === 'string')) {
    throw new CodexAppServerClientError('rpc_result_invalid')
  }
  return {
    thread,
    cwd: value.cwd,
    model: value.model,
    modelProvider: value.modelProvider,
    approvalPolicy: value.approvalPolicy,
    approvalsReviewer: value.approvalsReviewer,
    sandbox: value.sandbox,
    reasoningEffort,
    serviceTier,
    instructionSources,
  }
}

function normalizeTurnStartResult(value: unknown): { turn: CodexTurn } {
  if (!isRecord(value)) throw new CodexAppServerClientError('rpc_result_invalid')
  const turn = normalizeCodexTurn(value.turn)
  if (!turn) throw new CodexAppServerClientError('rpc_result_invalid')
  return { turn }
}

function normalizeEmptyResult(value: unknown): Record<string, never> {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new CodexAppServerClientError('rpc_result_invalid')
  }
  return {}
}

function normalizeInitializeResult(value: unknown): { userAgent: string } {
  if (!isRecord(value) || !nonEmptyString(value.userAgent)) {
    throw new CodexAppServerClientError('rpc_result_invalid')
  }
  return { userAgent: value.userAgent }
}

function normalizeServerDiagnosticsResult(value: unknown): CodexServerDiagnostics {
  if (!isRecord(value) || !hasExactKeys(value, ['process', 'gauges'])) {
    throw new CodexAppServerClientError('rpc_result_invalid')
  }
  const process = value.process
  if (!isRecord(process)) throw new CodexAppServerClientError('rpc_result_invalid')
  const processKeys = Object.keys(process)
  if (
    !processKeys.includes('id')
    || processKeys.some((key) => ![
      'id', 'residentMemoryBytes', 'physicalFootprintBytes',
    ].includes(key))
    || !Number.isSafeInteger(process.id)
    || Number(process.id) < 0
    || Number(process.id) > 0xffff_ffff
  ) throw new CodexAppServerClientError('rpc_result_invalid')

  const normalizeBytes = (bytes: unknown): number | null => {
    if (bytes === undefined || bytes === null) return null
    if (!Number.isSafeInteger(bytes) || Number(bytes) < 0) {
      throw new CodexAppServerClientError('rpc_result_invalid')
    }
    return Number(bytes)
  }
  if (!Array.isArray(value.gauges)) throw new CodexAppServerClientError('rpc_result_invalid')
  const gauges = value.gauges.map((gauge) => {
    if (
      !isRecord(gauge)
      || !hasExactKeys(gauge, ['name', 'value'])
      || typeof gauge.name !== 'string'
      || !Number.isSafeInteger(gauge.value)
      || Number(gauge.value) < 0
    ) throw new CodexAppServerClientError('rpc_result_invalid')
    return { name: gauge.name, value: Number(gauge.value) }
  })
  return {
    process: {
      id: Number(process.id),
      residentMemoryBytes: normalizeBytes(process.residentMemoryBytes),
      physicalFootprintBytes: normalizeBytes(process.physicalFootprintBytes),
    },
    gauges,
  }
}

function normalizeThreadListResult(value: unknown): {
  data: CodexThread[]
  nextCursor: string | null
} {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new CodexAppServerClientError('rpc_result_invalid')
  }
  const data = value.data.map(normalizeCodexThread)
  if (
    data.some((thread) => !thread)
    || (value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== 'string')
  ) throw new CodexAppServerClientError('rpc_result_invalid')
  return { data: data as CodexThread[], nextCursor: value.nextCursor as string | null | undefined || null }
}

function startNativeId(method: StartMethod, result: unknown): string {
  if (method === 'thread/start') return normalizeThreadStartResult(result).thread.id
  if (method === 'thread/fork') return normalizeThreadEffectiveSettings(result).thread.id
  return normalizeTurnStartResult(result).turn.id
}

const ACTIVE_SERVER_REQUEST_LIMIT = 2_048

function canonicalServerRequestId(value: number | string): string {
  const normalized = typeof value === 'number' ? String(value) : value.trim()
  if (!normalized) throw new CodexAppServerClientError('server_request_id_invalid')
  return normalized
}

export class CodexAppServerClient implements CodexNativeRuntime {
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()
  private readonly connectionClosedListeners = new Set<(error: Error) => void>()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly serverResponseWrites = new Set<string>()
  private readonly serverRequestIdentities = new Map<string, {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
  }>()
  private readonly admissions = new Set<Promise<unknown>>()
  private readonly inboundContinuations = new Set<Promise<unknown>>()
  private nextRpcId = 1
  private inboundChain: Promise<void> = Promise.resolve()
  private closeSettlement: Promise<void> | null = null
  private closed = false
  private handshakeState: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized'
  private bootThreadListOpen = true
  private readonly unsubscribeLine: () => void
  private readonly unsubscribeClose: () => void
  private readonly unsubscribeInboundRelease: () => void

  constructor(private readonly options: {
    transport: CodexJsonLineTransport
    connectionEpoch: string
    requestTimeoutMs: number
    startDispatchPort: CodexStartDispatchPort
    manualCompactionDispatchPort?: CodexManualCompactionDispatchPort
    threadArchiveDispatchPort?: CodexThreadArchiveDispatchPort
    inboundFramePort: CodexInboundFramePort
    threadArchiveAuthorizationPort: CodexThreadArchiveAuthorizationPort
  }) {
    if (
      !nonEmptyString(options.connectionEpoch)
      || !Number.isSafeInteger(options.requestTimeoutMs)
      || options.requestTimeoutMs <= 0
    ) throw new CodexAppServerClientError('client_options_invalid')
    this.unsubscribeLine = options.transport.onLine((line) => {
      if (this.closed) return
      this.inboundChain = this.inboundChain
        .then(() => this.handleLine(line))
        .catch((error) => this.closeForProtocolFailure(error))
    })
    this.unsubscribeClose = options.transport.onClose((error) => {
      this.queueConnectionClose(error)
    })
    this.unsubscribeInboundRelease = options.inboundFramePort.attachReleasePort?.({
      broadcastNotification: (notification) => {
        this.broadcastNotification(notification)
      },
      respondServerRequest: (requestId, result, deliveryAttempt) => {
        this.writeServerRequestResponse(requestId, result, deliveryAttempt)
      },
      failProtocol: (error) => this.closeForProtocolFailure(error),
    }) || (() => undefined)
  }

  async initialize(): Promise<{ userAgent: string }> {
    if (this.handshakeState !== 'uninitialized') {
      const error = new CodexAppServerClientError('initialize_already_attempted')
      this.closeForProtocolFailure(error)
      throw error
    }
    this.handshakeState = 'initializing'
    try {
      const result = await this.request('initialize', {
        clientInfo: {
          name: 'ready_codex_experiment',
          title: 'Ready Codex Runtime',
          version: APP_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: CODEX_OPT_OUT_NOTIFICATION_METHODS,
          requestAttestation: false,
        },
      }, normalizeInitializeResult)
      this.writeNotification('initialized')
      this.handshakeState = 'initialized'
      return result as { userAgent: string }
    } catch (error) {
      this.closeForProtocolFailure(error)
      throw error
    }
  }

  async serverDiagnostics(): Promise<CodexServerDiagnostics> {
    return this.request(
      'server/diagnostics',
      {},
      normalizeServerDiagnosticsResult,
    ) as Promise<CodexServerDiagnostics>
  }

  async threadStart(params: CodexThreadStartParams): Promise<{
    thread: CodexThread
    instructionSources: string[]
  }> {
    validateThreadStartParams(params)
    return this.request(
      'thread/start',
      params,
      normalizeThreadStartResult,
      params.cwd,
    ) as Promise<{ thread: CodexThread; instructionSources: string[] }>
  }

  async threadList(params: CodexThreadListParams): Promise<{
    data: CodexThread[]
    nextCursor: string | null
  }> {
    if (!this.bootThreadListOpen) {
      throw new CodexAppServerClientError('thread_list_outside_boot_reconciliation')
    }
    validateThreadListParams(params)
    if (params.archived !== undefined) {
      if (!this.options.threadArchiveDispatchPort) {
        throw new CodexAppServerClientError('thread_archive_dispatch_port_missing')
      }
      await this.options.threadArchiveDispatchPort.assertReadbackListEligible({
        cwd: params.cwd,
        sourceKinds: params.sourceKinds,
        archived: params.archived,
        cursor: params.cursor as string | null,
        useStateDbOnly: params.useStateDbOnly as true,
      })
    }
    return this.request('thread/list', params, normalizeThreadListResult) as Promise<{
      data: CodexThread[]
      nextCursor: string | null
    }>
  }

  sealBootReconciliation(): void {
    this.bootThreadListOpen = false
  }

  async threadRead(params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexThread }> {
    const exact = requireExactIdentityParams(params, ['threadId', 'includeTurns'])
    if (!nonEmptyString(exact.threadId) || exact.includeTurns !== true) invalidParams()
    return this.request('thread/read', params, normalizeThreadResult) as Promise<{ thread: CodexThread }>
  }

  async threadFork(params: CodexThreadForkParams, bindingId: string): Promise<CodexThreadEffectiveSettings> {
    validateThreadForkParams(params)
    return this.request(
      'thread/fork',
      params,
      normalizeThreadEffectiveSettings,
      bindingId,
    ) as Promise<CodexThreadEffectiveSettings>
  }

  async threadResume(params: CodexThreadResumeParams): Promise<CodexThreadEffectiveSettings> {
    const exact = requireExactIdentityParams(params, params.developerInstructions === undefined
      ? ['threadId']
      : ['threadId', 'developerInstructions'])
    if (!nonEmptyString(exact.threadId)
      || (exact.developerInstructions !== undefined && !nonEmptyString(exact.developerInstructions))) invalidParams()
    return this.request(
      'thread/resume',
      params,
      normalizeThreadEffectiveSettings,
    ) as Promise<CodexThreadEffectiveSettings>
  }

  async threadArchive(params: { threadId: string }): Promise<Record<string, never>> {
    const exact = requireExactIdentityParams(params, ['threadId'])
    if (!nonEmptyString(exact.threadId)) invalidParams()
    if (!this.options.threadArchiveDispatchPort) {
      throw new CodexAppServerClientError('thread_archive_dispatch_port_missing')
    }
    await this.options.threadArchiveAuthorizationPort.assertEligible(exact.threadId)
    return this.request('thread/archive', params, normalizeEmptyResult) as Promise<Record<string, never>>
  }

  async threadCompactStart(params: { threadId: string }): Promise<Record<string, never>> {
    const exact = requireExactIdentityParams(params, ['threadId'])
    if (!nonEmptyString(exact.threadId)) invalidParams()
    if (!this.options.manualCompactionDispatchPort) {
      throw new CodexAppServerClientError('manual_compaction_dispatch_port_missing')
    }
    return this.request('thread/compact/start', params, normalizeEmptyResult) as Promise<Record<string, never>>
  }

  async turnStart(params: CodexTurnStartParams): Promise<{ turn: CodexTurn }> {
    validateTurnStartParams(params)
    return this.request(
      'turn/start',
      params,
      normalizeTurnStartResult,
      params.responsesapiClientMetadata.readyRunId,
    ) as Promise<{ turn: CodexTurn }>
  }

  async turnInterrupt(params: { threadId: string; turnId: string }): Promise<Record<string, never>> {
    const exact = requireExactIdentityParams(params, ['threadId', 'turnId'])
    if (!nonEmptyString(exact.threadId) || !nonEmptyString(exact.turnId)) invalidParams()
    return this.request('turn/interrupt', params, normalizeEmptyResult) as Promise<Record<string, never>>
  }

  subscribe(listener: (notification: CodexNativeNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeConnectionClosed(listener: (error: Error) => void): () => void {
    this.connectionClosedListeners.add(listener)
    return () => this.connectionClosedListeners.delete(listener)
  }

  async shutdown(error: Error = new CodexAppServerClientError('connection_closed')): Promise<void> {
    this.queueConnectionClose(error)
    const settlement = this.closeSettlement
    try {
      await settlement
    } catch (closeError) {
      if (this.closeSettlement === settlement) this.closeSettlement = null
      throw closeError
    } finally {
      this.dispose()
      this.listeners.clear()
      this.connectionClosedListeners.clear()
    }
  }

  dispose(): void {
    this.unsubscribeLine()
    this.unsubscribeClose()
    this.unsubscribeInboundRelease()
  }

  private async request(
    method: ClientMethod,
    params: unknown,
    responseNormalizer: (value: unknown) => unknown,
    bindingId: string | null = null,
  ): Promise<unknown> {
    if (this.closed) throw new CodexAppServerClientError('connection_closed')
    if (method !== 'initialize' && this.handshakeState !== 'initialized') {
      throw new CodexAppServerClientError('initialize_required')
    }
    const id = this.nextRpcId
    this.nextRpcId += 1
    const frame = { method, id, params }
    const line = `${JSON.stringify(frame)}\n`
    const requestDigest = sha256(line)
    const startMethod = method === 'thread/start' || method === 'thread/fork' || method === 'turn/start'
      ? method
      : null
    const manualMethod = method === 'thread/compact/start'
    const archiveMethod = method === 'thread/archive'
    if (startMethod) {
      if (!bindingId) throw new CodexAppServerClientError('start_binding_identity_missing')
      const bindingLookupKey = bindingId
      const activation = await this.trackAdmission(() => this.options.startDispatchPort.activate({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: id,
        method: startMethod,
        bindingLookupKey,
        requestDigest,
      }))
      if (!nonEmptyString(activation.bindingId)) {
        throw new CodexAppServerClientError('start_binding_identity_invalid')
      }
      bindingId = activation.bindingId
    } else if (manualMethod) {
      const port = this.options.manualCompactionDispatchPort
      if (!port || !isRecord(params) || !nonEmptyString(params.threadId)) {
        throw new CodexAppServerClientError('manual_compaction_dispatch_identity_missing')
      }
      const codexThreadId = params.threadId
      const activation = await this.trackAdmission(() => port.activate({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: id,
        codexThreadId,
        requestDigest,
      }))
      if (!nonEmptyString(activation.manualCompactionId)) {
        throw new CodexAppServerClientError('manual_compaction_dispatch_identity_invalid')
      }
      bindingId = activation.manualCompactionId
    } else if (archiveMethod) {
      const port = this.options.threadArchiveDispatchPort
      if (!port || !isRecord(params) || !nonEmptyString(params.threadId)) {
        throw new CodexAppServerClientError('thread_archive_dispatch_identity_missing')
      }
      const codexThreadId = params.threadId
      const activation = await this.trackAdmission(() => port.activate({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: id,
        codexThreadId,
        requestDigest,
      }))
      if (!nonEmptyString(activation.archiveIntentId)) {
        throw new CodexAppServerClientError('thread_archive_dispatch_identity_invalid')
      }
      bindingId = activation.archiveIntentId
    }

    if (this.closed) throw new CodexAppServerClientError('connection_closed')

    let trackedRequest: PendingRequest | null = null
    const result = new Promise<unknown>((resolve, reject) => {
      const request: PendingRequest = {
        id,
        method,
        bindingId,
        startResponseKind: 'none',
        resolve,
        reject,
        responseNormalizer,
        timer: null,
      }
      trackedRequest = request
      request.timer = setTimeout(() => {
        void this.handleTimeout(request).catch((error) => this.closeForProtocolFailure(error))
      }, this.options.requestTimeoutMs)
      this.pending.set(id, request)
    })

    try {
      if (manualMethod && bindingId) {
        await this.options.manualCompactionDispatchPort?.markWriteAttempted({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: id,
          manualCompactionId: bindingId,
        })
      } else if (archiveMethod && bindingId) {
        await this.options.threadArchiveDispatchPort?.markWriteAttempted({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: id,
          archiveIntentId: bindingId,
        })
      }
      if (this.closed || this.pending.get(id) !== trackedRequest) return result
      this.options.transport.write(line, (error) => {
        const request = this.pending.get(id)
        if (this.closed || request !== trackedRequest) return
        if (startMethod && bindingId) {
          if (request.startResponseKind !== 'none') return
          const update = error
            ? this.options.startDispatchPort.markUnresolved({
                connectionEpoch: this.options.connectionEpoch,
                rpcId: id,
                method: startMethod,
                bindingId,
                reason: 'child_write_error',
              })
            : this.options.startDispatchPort.markChildWriteConfirmed({
                connectionEpoch: this.options.connectionEpoch,
                rpcId: id,
                method: startMethod,
                bindingId,
                childWriteDigest: requestDigest,
              })
          void update.then(() => {
            if (error) this.closeForProtocolFailure(
              new CodexAppServerClientError('start_delivery_unknown', {
                method: startMethod,
                reason: 'child_write_error',
              }),
            )
          }).catch((portError) => this.closeForProtocolFailure(portError))
          return
        }
        if (manualMethod && bindingId) {
          const update = error
            ? this.options.manualCompactionDispatchPort?.markUnresolved({
                connectionEpoch: this.options.connectionEpoch,
                rpcId: id,
                manualCompactionId: bindingId,
                reason: 'child_write_error',
              })
            : this.options.manualCompactionDispatchPort?.markChildWriteConfirmed({
                connectionEpoch: this.options.connectionEpoch,
                rpcId: id,
                manualCompactionId: bindingId,
                childWriteDigest: requestDigest,
              })
          void update?.catch((portError) => this.closeForProtocolFailure(portError))
          if (error) this.rejectOrdinaryRequest(id, new CodexAppServerClientError('child_write_failed'))
          return
        }
        if (archiveMethod && bindingId) {
          const update = error
            ? this.options.threadArchiveDispatchPort?.markUnresolved({
                connectionEpoch: this.options.connectionEpoch,
                rpcId: id,
                archiveIntentId: bindingId,
                reason: 'child_write_error',
              })
            : this.options.threadArchiveDispatchPort?.markChildWriteConfirmed({
                connectionEpoch: this.options.connectionEpoch,
                rpcId: id,
                archiveIntentId: bindingId,
                childWriteDigest: requestDigest,
              })
          void update?.catch((portError) => this.closeForProtocolFailure(portError))
          if (error) {
            this.rejectOrdinaryRequest(id, new CodexAppServerClientError('child_write_failed'))
            this.closeForProtocolFailure(error)
          }
          return
        }
        if (error) this.rejectOrdinaryRequest(id, new CodexAppServerClientError('child_write_failed'))
      })
    } catch (error) {
      // silent-catch: a failed child write marks the dispatch binding unresolved and rejects the pending request; start and archive writes also close the connection
      if (startMethod && bindingId) {
        void this.options.startDispatchPort.markUnresolved({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: id,
          method: startMethod,
          bindingId,
          reason: 'child_write_error',
        }).then(() => this.closeForProtocolFailure(
          new CodexAppServerClientError('start_delivery_unknown', {
            method: startMethod,
            reason: 'child_write_error',
          }),
        )).catch((portError) => this.closeForProtocolFailure(portError))
      } else if (manualMethod && bindingId) {
        await this.options.manualCompactionDispatchPort?.markUnresolved({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: id,
          manualCompactionId: bindingId,
          reason: 'child_write_error',
        })
        this.rejectOrdinaryRequest(
          id,
          error instanceof Error ? error : new CodexAppServerClientError('child_write_failed'),
        )
      } else if (archiveMethod && bindingId) {
        await this.options.threadArchiveDispatchPort?.markUnresolved({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: id,
          archiveIntentId: bindingId,
          reason: 'child_write_error',
        })
        const failure = error instanceof Error
          ? error
          : new CodexAppServerClientError('child_write_failed')
        this.rejectOrdinaryRequest(id, failure)
        this.closeForProtocolFailure(failure)
      } else {
        this.rejectOrdinaryRequest(
          id,
          error instanceof Error ? error : new CodexAppServerClientError('child_write_failed'),
        )
      }
    }
    return result
  }

  private writeNotification(method: 'initialized'): void {
    if (this.closed) throw new CodexAppServerClientError('connection_closed')
    this.options.transport.write(`${JSON.stringify({ method })}\n`, (error) => {
      if (error) this.closeForProtocolFailure(error)
    })
  }

  private async handleTimeout(request: PendingRequest): Promise<void> {
    if (this.pending.get(request.id) !== request) return
    request.timer = null
    if (request.method === 'thread/start' || request.method === 'thread/fork' || request.method === 'turn/start') {
      await this.options.startDispatchPort.markUnresolved({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: request.id,
        method: request.method,
        bindingId: request.bindingId as string,
        reason: 'response_timeout',
      })
      this.closeForProtocolFailure(new CodexAppServerClientError('start_delivery_unknown', {
        method: request.method,
        reason: 'response_timeout',
      }))
      return
    }
    if (request.method === 'thread/compact/start') {
      await this.options.manualCompactionDispatchPort?.markUnresolved({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: request.id,
        manualCompactionId: request.bindingId as string,
        reason: 'response_timeout',
      })
      this.finishPending(request)
      request.reject(new CodexAppServerClientError('rpc_timeout', { method: request.method }))
      return
    }
    if (request.method === 'thread/archive') {
      await this.options.threadArchiveDispatchPort?.markUnresolved({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: request.id,
        archiveIntentId: request.bindingId as string,
        reason: 'response_timeout',
      })
      const error = new CodexAppServerClientError('rpc_timeout', { method: request.method })
      this.finishPending(request)
      request.reject(error)
      this.closeForProtocolFailure(error)
      return
    }
    const error = new CodexAppServerClientError('rpc_timeout', { method: request.method })
    this.closeForProtocolFailure(error)
  }

  private async handleLine(line: string): Promise<void> {
    let frame: unknown
    try {
      frame = JSON.parse(line) as unknown
    } catch {
      throw new CodexAppServerClientError('non_json_stdout')
    }
    if (!isRecord(frame)) throw new CodexAppServerClientError('frame_not_object')
    if (frame.method !== undefined) {
      if (frame.id !== undefined) await this.handleServerRequest(frame)
      else await this.handleNotification(frame)
      return
    }
    if (frame.id === undefined) throw new CodexAppServerClientError('frame_identity_missing')
    await this.handleResponse(frame)
  }

  private async handleResponse(frame: JsonObject): Promise<void> {
    if (!Number.isSafeInteger(frame.id) || (frame.id as number) <= 0) {
      throw new CodexAppServerClientError('response_id_invalid')
    }
    const id = frame.id as number
    const request = this.pending.get(id)
    if (!request) {
      if (!hasExactKeys(frame, ['id', 'result']) && !hasExactKeys(frame, ['id', 'error'])) {
        throw new CodexAppServerClientError('unknown_response_id')
      }
      const consumed = await this.consumeLateStartResponse(id, frame)
      if (!consumed
        && !await this.consumeLateManualCompactionResponse(id, frame)
        && !await this.consumeLateThreadArchiveResponse(id, frame)) {
        throw new CodexAppServerClientError('unknown_response_id')
      }
      return
    }
    if (
      !hasExactKeys(frame, ['id', 'result'])
      && !hasExactKeys(frame, ['id', 'error'])
    ) throw new CodexAppServerClientError('response_shape_invalid')

    if (request.method === 'thread/start' || request.method === 'thread/fork' || request.method === 'turn/start') {
      await this.handleStartResponse(request, frame)
      return
    }
    if (request.method === 'thread/compact/start') {
      const responseDigest = sha256(JSON.stringify(frame))
      const responseKind = 'error' in frame ? 'rejected' as const : 'accepted' as const
      if (responseKind === 'accepted') request.responseNormalizer(frame.result)
      await this.options.manualCompactionDispatchPort?.reconcileResponse({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: request.id,
        manualCompactionId: request.bindingId as string,
        responseKind,
        responseDigest,
      })
      if (this.closed || this.pending.get(request.id) !== request) return
      this.finishPending(request)
      if (responseKind === 'rejected') {
        request.reject(new CodexAppServerClientError('rpc_rejected', frame.error))
      } else {
        request.resolve({})
      }
      return
    }
    if (request.method === 'thread/archive') {
      const responseDigest = sha256(JSON.stringify(frame))
      const responseKind = 'error' in frame ? 'rejected' as const : 'accepted' as const
      if (responseKind === 'accepted') request.responseNormalizer(frame.result)
      await this.options.threadArchiveDispatchPort?.reconcileResponse({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: request.id,
        archiveIntentId: request.bindingId as string,
        responseKind,
        responseDigest,
      })
      if (this.closed || this.pending.get(request.id) !== request) return
      this.finishPending(request)
      if (responseKind === 'rejected') {
        request.reject(new CodexAppServerClientError('rpc_rejected', frame.error))
      } else {
        request.resolve({})
      }
      return
    }
    this.finishPending(request)
    if ('error' in frame) {
      request.reject(new CodexAppServerClientError('rpc_rejected', frame.error))
      return
    }
    try {
      request.resolve(request.responseNormalizer(frame.result))
    } catch (error) {
      // silent-catch: a result the normalizer rejects is surfaced to the caller by rejecting the pending request
      request.reject(error instanceof Error ? error : new CodexAppServerClientError('rpc_result_invalid'))
    }
  }

  private async handleStartResponse(request: PendingRequest, frame: JsonObject): Promise<void> {
    if (request.startResponseKind !== 'none') {
      throw new CodexAppServerClientError('duplicate_start_response')
    }
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    const identity: StartDispatchIdentity = {
      connectionEpoch: this.options.connectionEpoch,
      rpcId: request.id,
      method: request.method as StartMethod,
      bindingId: request.bindingId as string,
    }
    const responseDigest = sha256(JSON.stringify(frame))
    if ('error' in frame) {
      request.startResponseKind = 'rejected'
      const resolution = await this.options.startDispatchPort.reconcileRejected({
        ...identity,
        rpcError: frame.error,
        responseDigest,
      })
      if (resolution === 'proven_absent') {
        this.finishPending(request)
        request.reject(new CodexAppServerClientError('start_delivery_proven_absent', frame.error))
      } else {
        this.closeForProtocolFailure(new CodexAppServerClientError('start_delivery_unknown', {
          method: identity.method,
          reason: 'typed_rejection_unknown',
        }))
      }
      return
    }
    let normalized: unknown
    let nativeId: string
    try {
      normalized = request.responseNormalizer(frame.result)
      nativeId = startNativeId(identity.method, frame.result)
    } catch (error) {
      throw error instanceof Error ? error : new CodexAppServerClientError('rpc_result_invalid')
    }
    request.startResponseKind = 'accepted'
    const reconciliation = this.options.startDispatchPort.reconcileAccepted({
      ...identity,
      nativeId,
      nativeResult: frame.result,
      responseDigest,
      responsePending: false,
    })
    this.trackInboundContinuation(reconciliation.then(() => {
      if (this.closed || this.pending.get(request.id) !== request) return
      this.finishPending(request)
      request.resolve(normalized)
    }))
  }

  private async consumeLateStartResponse(id: number, frame: JsonObject): Promise<boolean> {
    const methods: StartMethod[] = ['thread/start', 'thread/fork', 'turn/start']
    for (const method of methods) {
      let nativeId: string
      try {
        nativeId = startNativeId(method, frame.result)
      } catch {
        // silent-catch: a result without this start method's native id is not its late response; try the next method
        continue
      }
      const consumed = await this.options.startDispatchPort.consumeLateResponse({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: id,
        method,
        nativeId,
        responseDigest: sha256(JSON.stringify(frame)),
      })
      if (consumed) return true
    }
    return false
  }

  private async consumeLateManualCompactionResponse(id: number, frame: JsonObject): Promise<boolean> {
    const port = this.options.manualCompactionDispatchPort
    if (!port) return false
    const responseKind = 'error' in frame ? 'rejected' as const : 'accepted' as const
    if (responseKind === 'accepted') {
      try {
        normalizeEmptyResult(frame.result)
      } catch {
        // silent-catch: a late compaction response with a malformed result is left unconsumed by the manual compaction port
        return false
      }
    }
    return port.consumeLateResponse({
      connectionEpoch: this.options.connectionEpoch,
      rpcId: id,
      responseKind,
      responseDigest: sha256(JSON.stringify(frame)),
    })
  }

  private async consumeLateThreadArchiveResponse(id: number, frame: JsonObject): Promise<boolean> {
    const port = this.options.threadArchiveDispatchPort
    if (!port) return false
    const responseKind = 'error' in frame ? 'rejected' as const : 'accepted' as const
    if (responseKind === 'accepted') {
      try {
        normalizeEmptyResult(frame.result)
      } catch {
        // silent-catch: a late archive response with a malformed result is left unconsumed by the thread archive port
        return false
      }
    }
    return port.consumeLateResponse({
      connectionEpoch: this.options.connectionEpoch,
      rpcId: id,
      responseKind,
      responseDigest: sha256(JSON.stringify(frame)),
    })
  }

  private async handleNotification(frame: JsonObject): Promise<void> {
    if (frame.method === 'thread/archived') {
      if (!isRecord(frame.params)
        || !nonEmptyString(frame.params.threadId)) {
        throw new CodexAppServerClientError('notification_invalid_params', {
          method: 'thread/archived',
        })
      }
      const reconciled = await this.options.threadArchiveDispatchPort?.reconcileArchivedNotification({
        connectionEpoch: this.options.connectionEpoch,
        codexThreadId: frame.params.threadId,
        notificationDigest: sha256(JSON.stringify(frame)),
      })
      if (reconciled !== true) {
        throw new CodexAppServerClientError('thread_archive_notification_unowned')
      }
      this.options.inboundFramePort.retireThread?.(
        this.options.connectionEpoch,
        frame.params.threadId,
      )
      return
    }
    const normalized = normalizeCodexNativeNotification(frame)
    if (normalized.kind === 'ignored') return
    if (normalized.kind !== 'accepted') {
      const usageDiagnostic = frame.method === 'thread/tokenUsage/updated' && isRecord(frame.params)
        ? {
            usageParamKeys: Object.keys(frame.params).sort().join(','),
            usageKeys: isRecord(frame.params.tokenUsage)
              ? Object.keys(frame.params.tokenUsage).sort().join(',')
              : null,
            usageTotal: isRecord(frame.params.tokenUsage)
              && isRecord(frame.params.tokenUsage.total)
              ? JSON.stringify(frame.params.tokenUsage.total)
              : null,
            usageLast: isRecord(frame.params.tokenUsage)
              && isRecord(frame.params.tokenUsage.last)
              ? JSON.stringify(frame.params.tokenUsage.last)
              : null,
            usageModelContextWindow: isRecord(frame.params.tokenUsage)
              ? frame.params.tokenUsage.modelContextWindow ?? null
              : null,
          }
        : null
      throw new CodexAppServerClientError(
        `notification_${normalized.code}`,
        {
          method: typeof frame.method === 'string' ? frame.method : null,
          ...(usageDiagnostic ? { usageDiagnostic } : {}),
        },
      )
    }
    const disposition = await this.options.inboundFramePort.routeNotification({
      connectionEpoch: this.options.connectionEpoch,
      frame,
      notification: normalized.notification,
    })
    if (this.closed) return
    if (disposition === 'buffered') return
    if (disposition !== 'broadcast') throw new CodexAppServerClientError('notification_route_invalid')
    this.broadcastNotification(normalized.notification)
  }

  private async handleServerRequest(frame: JsonObject): Promise<void> {
    if (
      !hasExactKeys(frame, ['id', 'method', 'params'])
      || (typeof frame.id !== 'string' && !Number.isSafeInteger(frame.id))
      || frame.method !== 'item/tool/call'
      || !isRecord(frame.params)
      || !nonEmptyString(frame.params.threadId)
      || !nonEmptyString(frame.params.turnId)
      || !nonEmptyString(frame.params.callId)
    ) throw new CodexAppServerClientError('server_request_invalid')
    const serverRequestKey = canonicalServerRequestId(frame.id as number | string)
    if (this.serverRequestIdentities.has(serverRequestKey)) {
      throw new CodexAppServerClientError('server_request_duplicate')
    }
    if (this.serverRequestIdentities.size >= ACTIVE_SERVER_REQUEST_LIMIT) {
      throw new CodexAppServerClientError('server_request_capacity_exhausted')
    }
    this.serverRequestIdentities.set(serverRequestKey, {
      codexThreadId: frame.params.threadId as string,
      codexTurnId: frame.params.turnId as string,
      codexCallId: frame.params.callId as string,
    })
    let routed: Awaited<ReturnType<CodexInboundFramePort['routeServerRequest']>>
    try {
      routed = await this.options.inboundFramePort.routeServerRequest({
        connectionEpoch: this.options.connectionEpoch,
        requestId: frame.id as number | string,
        method: 'item/tool/call',
        params: frame.params,
      })
    } catch (error) {
      if (error instanceof CodexAppServerClientError) throw error
      const code = controlledProtocolErrorCode(error)
      if (code) {
        throw new CodexAppServerClientError(code, { method: 'item/tool/call' })
      }
      throw error
    }
    if (this.closed) return
    if (routed.disposition === 'buffered') return
    if (routed.disposition !== 'respond') throw new CodexAppServerClientError('server_request_route_invalid')
    this.writeServerRequestResponse(
      frame.id as number | string,
      routed.result,
      routed.deliveryAttempt,
    )
  }

  private writeServerRequestResponse(
    requestId: number | string,
    result: unknown,
    deliveryAttempt: CodexToolResponseDeliveryAttemptIdentity,
  ): void {
    if (this.closed) return
    const responseKey = canonicalServerRequestId(requestId)
    if (this.serverResponseWrites.has(responseKey)) {
      this.closeForProtocolFailure(new CodexAppServerClientError('server_response_duplicate'))
      return
    }
    const requestIdentity = this.serverRequestIdentities.get(
      responseKey,
    )
    if (
      !requestIdentity
      || deliveryAttempt.codexThreadId !== requestIdentity.codexThreadId
      || deliveryAttempt.codexTurnId !== requestIdentity.codexTurnId
      || deliveryAttempt.codexCallId !== requestIdentity.codexCallId
      || deliveryAttempt.connectionEpoch !== this.options.connectionEpoch
      || deliveryAttempt.requestRpcId !== responseKey
      || deliveryAttempt.toolResponseDigest !== digestCanonicalJson(result)
    ) {
      this.closeForProtocolFailure(
        new CodexAppServerClientError('server_response_delivery_identity_mismatch'),
      )
      return
    }
    this.serverResponseWrites.add(responseKey)
    this.options.transport.write(`${JSON.stringify({ id: requestId, result })}\n`, (error) => {
      if (
        this.closed
        || !this.serverResponseWrites.has(responseKey)
        || this.serverRequestIdentities.get(responseKey) !== requestIdentity
      ) return
      if (error) {
        this.closeForProtocolFailure(error)
        return
      }
      let confirmation: void | PromiseLike<void>
      try {
        confirmation = this.options.inboundFramePort.confirmServerResponseTransportWrite(deliveryAttempt)
      } catch (confirmError) {
        // silent-catch: a failed write confirmation is surfaced by closing the connection as a protocol failure
        this.closeForProtocolFailure(confirmError)
        return
      }
      void Promise.resolve(confirmation).then(() => {
        if (
          this.closed
          || !this.serverResponseWrites.has(responseKey)
          || this.serverRequestIdentities.get(responseKey) !== requestIdentity
        ) return
        this.serverResponseWrites.delete(responseKey)
        this.serverRequestIdentities.delete(responseKey)
      }, (confirmError) => {
        this.closeForProtocolFailure(
          confirmError instanceof Error
            ? confirmError
            : new CodexAppServerClientError('server_response_delivery_ack_failed'),
        )
      })
    })
  }

  private finishPending(request: PendingRequest): void {
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    this.pending.delete(request.id)
  }

  private rejectOrdinaryRequest(id: number, error: Error): void {
    const request = this.pending.get(id)
    if (!request || request.method === 'thread/start' || request.method === 'thread/fork' || request.method === 'turn/start') return
    this.finishPending(request)
    request.reject(error)
  }

  private trackAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const admission = operation()
    this.admissions.add(admission)
    void admission.finally(() => this.admissions.delete(admission)).catch(() => undefined)
    return admission
  }

  private trackInboundContinuation(continuation: Promise<unknown>): void {
    this.inboundContinuations.add(continuation)
    void continuation.then(() => {
      this.inboundContinuations.delete(continuation)
    }, (error) => {
      this.inboundContinuations.delete(continuation)
      this.closeForProtocolFailure(error)
    }).catch(() => undefined)
  }

  private async handleConnectionClosed(error: Error | null): Promise<void> {
    const closeError = error || new CodexAppServerClientError('connection_closed')
    for (const listener of [...this.connectionClosedListeners]) {
      try {
        listener(closeError)
      } catch { /* silent-catch: observer failure cannot stop the durable close audit or pending-request rejection below. */ }
    }
    this.serverResponseWrites.clear()
    this.serverRequestIdentities.clear()
    await Promise.allSettled([...this.admissions])
    const audits: Promise<unknown>[] = [
      Promise.resolve().then(() => this.options.startDispatchPort.markConnectionClosed(
        this.options.connectionEpoch,
      )),
    ]
    if (this.options.manualCompactionDispatchPort) {
      audits.push(Promise.resolve().then(() => (
        this.options.manualCompactionDispatchPort?.markConnectionClosed(this.options.connectionEpoch)
      )))
    }
    if (this.options.threadArchiveDispatchPort) {
      audits.push(Promise.resolve().then(() => (
        this.options.threadArchiveDispatchPort?.markConnectionClosed(this.options.connectionEpoch)
      )))
    }
    const results = await Promise.allSettled(audits)
    await Promise.allSettled([...this.inboundContinuations])
    const requests = [...this.pending.values()]
    for (const request of requests) {
      if (request.timer) clearTimeout(request.timer)
      request.timer = null
      this.pending.delete(request.id)
      request.reject(closeError)
    }
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'connection_close_audit_failed')
  }

  private broadcastNotification(notification: CodexNativeNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        void Promise.resolve(listener(notification)).catch(() => undefined)
      } catch {
        // silent-catch: observer failures do not own the protocol; a throwing notification listener must not disturb frame handling
      }
    }
  }

  private queueConnectionClose(error: Error | null): void {
    if (this.closeSettlement) return
    this.closed = true
    this.closeSettlement = this.inboundChain
      .then(() => this.handleConnectionClosed(error))
    void this.closeSettlement.catch(() => undefined)
  }

  private closeForProtocolFailure(error: unknown): void {
    if (this.closed) return
    const reason = error instanceof CodexAppServerClientError
      ? error.code
      : 'protocol_failure'
    this.queueConnectionClose(
      error instanceof Error ? error : new CodexAppServerClientError(reason),
    )
    try {
      this.options.transport.close(
        reason,
        error instanceof CodexAppServerClientError ? error.details : undefined,
      )
    } catch {
      // silent-catch: local close ownership is authoritative; the connection close is already queued above even if the transport close throws
    }
  }
}
