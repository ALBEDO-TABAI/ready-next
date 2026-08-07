import { createHash } from 'node:crypto'

import {
  normalizeCodexNativeNotification,
  normalizeCodexThread,
  normalizeCodexTurn,
  type CodexAdditionalContextEntry,
  type CodexDynamicToolSpec,
  type CodexNativeNotification,
  type CodexNativeRuntime,
  type CodexThread,
  type CodexThreadListParams,
  type CodexThreadStartParams,
  type CodexTurn,
  type CodexTurnStartParams,
  type CodexUserInput,
} from './codex-native-runtime'

type JsonObject = Record<string, unknown>
type StartMethod = 'thread/start' | 'turn/start'
type ClientMethod =
  | 'initialize'
  | 'thread/start'
  | 'thread/list'
  | 'thread/read'
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
    | { disposition: 'respond'; result: unknown }
  >
}

export interface CodexInboundFrameReleasePort {
  broadcastNotification(notification: CodexNativeNotification): void
  respondServerRequest(requestId: number | string, result: unknown): void
  failProtocol(error: Error): void
}

export interface CodexThreadArchiveAuthorizationPort {
  assertEligible(threadId: string): void | Promise<void>
}

export class CodexAppServerClientError extends Error {
  constructor(readonly code: string, readonly details?: unknown) {
    super(code)
    this.name = 'CodexAppServerClientError'
  }
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

function validateUserInput(value: unknown): value is CodexUserInput {
  if (!isRecord(value)) return false
  if (value.type === 'text') {
    return hasExactKeys(value, ['type', 'text', 'text_elements'])
      && typeof value.text === 'string'
      && Array.isArray(value.text_elements)
      && value.text_elements.length === 0
  }
  if (value.type === 'image') {
    return hasExactKeys(value, ['type', 'url', 'detail'])
      && nonEmptyString(value.url)
      && (
        value.detail === null
        || value.detail === 'auto'
        || value.detail === 'low'
        || value.detail === 'high'
        || value.detail === 'original'
      )
  }
  return value.type === 'audio'
    && hasExactKeys(value, ['type', 'url'])
    && nonEmptyString(value.url)
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
    || !Array.isArray(params.dynamicTools)
    || !params.dynamicTools.every(validateDynamicTool)
    || typeof params.developerInstructions !== 'string'
  ) invalidParams()
}

function validateTurnStartParams(value: unknown): asserts value is CodexTurnStartParams {
  const params = requireExactIdentityParams(value, [
    'threadId',
    'clientUserMessageId',
    'input',
    'additionalContext',
    'responsesapiClientMetadata',
  ])
  if (
    !nonEmptyString(params.threadId)
    || !nonEmptyString(params.clientUserMessageId)
    || !Array.isArray(params.input)
    || !params.input.every(validateUserInput)
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
  const params = requireExactIdentityParams(value, ['limit', 'cwd', 'sourceKinds'])
  if (
    !Number.isSafeInteger(params.limit)
    || (params.limit as number) <= 0
    || !nonEmptyString(params.cwd)
    || !Array.isArray(params.sourceKinds)
    || params.sourceKinds.length !== 1
    || params.sourceKinds[0] !== 'vscode'
  ) invalidParams()
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
  return method === 'thread/start'
    ? normalizeThreadStartResult(result).thread.id
    : normalizeTurnStartResult(result).turn.id
}

export class CodexAppServerClient implements CodexNativeRuntime {
  private readonly listeners = new Set<(notification: CodexNativeNotification) => void>()
  private readonly pending = new Map<number, PendingRequest>()
  private nextRpcId = 1
  private inboundChain: Promise<void> = Promise.resolve()
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
    inboundFramePort: CodexInboundFramePort
    threadArchiveAuthorizationPort: CodexThreadArchiveAuthorizationPort
  }) {
    if (
      !nonEmptyString(options.connectionEpoch)
      || !Number.isSafeInteger(options.requestTimeoutMs)
      || options.requestTimeoutMs <= 0
    ) throw new CodexAppServerClientError('client_options_invalid')
    this.unsubscribeLine = options.transport.onLine((line) => {
      this.inboundChain = this.inboundChain
        .then(() => this.handleLine(line))
        .catch((error) => this.closeForProtocolFailure(error))
    })
    this.unsubscribeClose = options.transport.onClose((error) => {
      void this.handleConnectionClosed(error)
    })
    this.unsubscribeInboundRelease = options.inboundFramePort.attachReleasePort?.({
      broadcastNotification: (notification) => {
        for (const listener of this.listeners) listener(notification)
      },
      respondServerRequest: (requestId, result) => {
        this.options.transport.write(`${JSON.stringify({ id: requestId, result })}\n`, (error) => {
          if (error) this.closeForProtocolFailure(error)
        })
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
          version: '0.7.5',
        },
        capabilities: {
          experimentalApi: true,
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

  async threadResume(params: { threadId: string }): Promise<{
    thread: CodexThread
    instructionSources: string[]
  }> {
    const exact = requireExactIdentityParams(params, ['threadId'])
    if (!nonEmptyString(exact.threadId)) invalidParams()
    return this.request('thread/resume', params, normalizeThreadStartResult) as Promise<{
      thread: CodexThread
      instructionSources: string[]
    }>
  }

  async threadArchive(params: { threadId: string }): Promise<Record<string, never>> {
    const exact = requireExactIdentityParams(params, ['threadId'])
    if (!nonEmptyString(exact.threadId)) invalidParams()
    await this.options.threadArchiveAuthorizationPort.assertEligible(exact.threadId)
    return this.request('thread/archive', params, normalizeEmptyResult) as Promise<Record<string, never>>
  }

  async threadCompactStart(params: { threadId: string }): Promise<Record<string, never>> {
    const exact = requireExactIdentityParams(params, ['threadId'])
    if (!nonEmptyString(exact.threadId)) invalidParams()
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

  async settleRecoveredStartAccepted(input: StartDispatchIdentity & {
    result: unknown
    responsePending: true
  }): Promise<void> {
    const request = this.requirePendingStart(input)
    if (request.startResponseKind !== 'none') {
      throw new CodexAppServerClientError('start_response_already_received')
    }
    request.startResponseKind = 'accepted'
    const normalized = request.responseNormalizer(input.result)
    const nativeId = startNativeId(input.method, input.result)
    await this.options.startDispatchPort.reconcileAccepted({
      connectionEpoch: input.connectionEpoch,
      rpcId: input.rpcId,
      method: input.method,
      bindingId: input.bindingId,
      nativeId,
      nativeResult: input.result,
      responseDigest: sha256(JSON.stringify(input.result)),
      responsePending: true,
    })
    this.finishPending(request)
    request.resolve(normalized)
  }

  async settleRecoveredStartProvenAbsent(input: StartDispatchIdentity & {
    evidenceDigest: string
  }): Promise<void> {
    if (!nonEmptyString(input.evidenceDigest)) {
      throw new CodexAppServerClientError('reconciliation_evidence_invalid')
    }
    const request = this.requirePendingStart(input)
    if (request.startResponseKind === 'accepted') {
      throw new CodexAppServerClientError('accepted_start_cannot_be_proven_absent')
    }
    this.finishPending(request)
    request.reject(new CodexAppServerClientError('start_delivery_proven_absent', {
      evidenceDigest: input.evidenceDigest,
      method: input.method,
      bindingId: input.bindingId,
    }))
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
    const startMethod = method === 'thread/start' || method === 'turn/start' ? method : null
    if (startMethod) {
      if (!bindingId) throw new CodexAppServerClientError('start_binding_identity_missing')
      const activation = await this.options.startDispatchPort.activate({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: id,
        method: startMethod,
        bindingLookupKey: bindingId,
        requestDigest,
      })
      if (!nonEmptyString(activation.bindingId)) {
        throw new CodexAppServerClientError('start_binding_identity_invalid')
      }
      bindingId = activation.bindingId
    }

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
      request.timer = setTimeout(() => void this.handleTimeout(request), this.options.requestTimeoutMs)
      this.pending.set(id, request)
    })

    try {
      this.options.transport.write(line, (error) => {
        if (startMethod && bindingId) {
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
          void update.catch((portError) => this.closeForProtocolFailure(portError))
          return
        }
        if (error) this.rejectOrdinaryRequest(id, new CodexAppServerClientError('child_write_failed'))
      })
    } catch (error) {
      if (startMethod && bindingId) {
        void this.options.startDispatchPort.markUnresolved({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: id,
          method: startMethod,
          bindingId,
          reason: 'child_write_error',
        }).catch((portError) => this.closeForProtocolFailure(portError))
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
    request.timer = null
    if (request.method === 'thread/start' || request.method === 'turn/start') {
      await this.options.startDispatchPort.markUnresolved({
        connectionEpoch: this.options.connectionEpoch,
        rpcId: request.id,
        method: request.method,
        bindingId: request.bindingId as string,
        reason: 'response_timeout',
      })
      return
    }
    this.pending.delete(request.id)
    request.reject(new CodexAppServerClientError('rpc_timeout', { method: request.method }))
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
      if (!hasExactKeys(frame, ['id', 'result'])) {
        throw new CodexAppServerClientError('unknown_response_id')
      }
      const consumed = await this.consumeLateStartResponse(id, frame)
      if (!consumed) throw new CodexAppServerClientError('unknown_response_id')
      return
    }
    if (
      !hasExactKeys(frame, ['id', 'result'])
      && !hasExactKeys(frame, ['id', 'error'])
    ) throw new CodexAppServerClientError('response_shape_invalid')

    if (request.method === 'thread/start' || request.method === 'turn/start') {
      await this.handleStartResponse(request, frame)
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
    void reconciliation.then(() => {
      if (this.pending.get(request.id) !== request) return
      this.finishPending(request)
      request.resolve(normalized)
    }).catch((error) => this.closeForProtocolFailure(error))
  }

  private async consumeLateStartResponse(id: number, frame: JsonObject): Promise<boolean> {
    const methods: StartMethod[] = ['thread/start', 'turn/start']
    for (const method of methods) {
      let nativeId: string
      try {
        nativeId = startNativeId(method, frame.result)
      } catch {
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

  private async handleNotification(frame: JsonObject): Promise<void> {
    const normalized = normalizeCodexNativeNotification(frame)
    if (normalized.kind === 'ignored') return
    if (normalized.kind !== 'accepted') {
      throw new CodexAppServerClientError(
        `notification_${normalized.code}`,
        { method: typeof frame.method === 'string' ? frame.method : null },
      )
    }
    const disposition = await this.options.inboundFramePort.routeNotification({
      connectionEpoch: this.options.connectionEpoch,
      frame,
      notification: normalized.notification,
    })
    if (disposition === 'buffered') return
    if (disposition !== 'broadcast') throw new CodexAppServerClientError('notification_route_invalid')
    for (const listener of this.listeners) listener(normalized.notification)
  }

  private async handleServerRequest(frame: JsonObject): Promise<void> {
    if (
      !hasExactKeys(frame, ['id', 'method', 'params'])
      || (typeof frame.id !== 'string' && !Number.isSafeInteger(frame.id))
      || frame.method !== 'item/tool/call'
    ) throw new CodexAppServerClientError('server_request_invalid')
    const routed = await this.options.inboundFramePort.routeServerRequest({
      connectionEpoch: this.options.connectionEpoch,
      requestId: frame.id as number | string,
      method: 'item/tool/call',
      params: frame.params,
    })
    if (routed.disposition === 'buffered') return
    if (routed.disposition !== 'respond') throw new CodexAppServerClientError('server_request_route_invalid')
    this.options.transport.write(`${JSON.stringify({ id: frame.id, result: routed.result })}\n`, (error) => {
      if (error) this.closeForProtocolFailure(error)
    })
  }

  private requirePendingStart(input: StartDispatchIdentity): PendingRequest {
    if (input.connectionEpoch !== this.options.connectionEpoch) {
      throw new CodexAppServerClientError('reconciliation_epoch_mismatch')
    }
    const request = this.pending.get(input.rpcId)
    if (
      !request
      || request.method !== input.method
      || request.bindingId !== input.bindingId
    ) throw new CodexAppServerClientError('reconciliation_identity_mismatch')
    return request
  }

  private finishPending(request: PendingRequest): void {
    if (request.timer) clearTimeout(request.timer)
    request.timer = null
    this.pending.delete(request.id)
  }

  private rejectOrdinaryRequest(id: number, error: Error): void {
    const request = this.pending.get(id)
    if (!request || request.method === 'thread/start' || request.method === 'turn/start') return
    this.finishPending(request)
    request.reject(error)
  }

  private async handleConnectionClosed(error: Error | null): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.options.startDispatchPort.markConnectionClosed(this.options.connectionEpoch)
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer)
      request.timer = null
      if (request.method === 'thread/start' || request.method === 'turn/start') {
        await this.options.startDispatchPort.markUnresolved({
          connectionEpoch: this.options.connectionEpoch,
          rpcId: request.id,
          method: request.method,
          bindingId: request.bindingId as string,
          reason: 'connection_closed',
        })
        continue
      }
      this.pending.delete(request.id)
      request.reject(error || new CodexAppServerClientError('connection_closed'))
    }
  }

  private closeForProtocolFailure(error: unknown): void {
    if (this.closed) return
    const reason = error instanceof CodexAppServerClientError
      ? error.code
      : 'protocol_failure'
    this.options.transport.close(
      reason,
      error instanceof CodexAppServerClientError ? error.details : undefined,
    )
    void this.handleConnectionClosed(
      error instanceof Error ? error : new CodexAppServerClientError(reason),
    )
  }
}
