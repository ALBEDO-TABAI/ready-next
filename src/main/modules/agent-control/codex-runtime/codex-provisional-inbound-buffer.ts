import type {
  CodexInboundFramePort,
  CodexInboundFrameReleasePort,
} from './codex-app-server-client'
import type {
  CodexNativeNotification,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from './codex-native-runtime'

type BufferedNotification = {
  kind: 'notification'
  sequence: number
  bytes: number
  notification: CodexNativeNotification
}

type BufferedServerRequest = {
  kind: 'server_request'
  sequence: number
  bytes: number
  connectionEpoch: string
  requestId: number | string
  params: CodexToolServerRequestParams
}

type BufferedFrame = BufferedNotification | BufferedServerRequest

type ProvisionalOwner = {
  bindingId: string
  connectionEpoch: string
  deadlineAtMs: number
  state: 'provisional' | 'bound' | 'unknown'
  unknownReason: string | null
  frames: BufferedFrame[]
  bufferedBytes: number
  deadlineTimer: ReturnType<typeof setTimeout> | null
}

type ProvisionalThreadOwner = ProvisionalOwner & {
  expectedCwd: string
  expectedSource: string
  observedNativeThreadId: string | null
}

type ProvisionalTurnOwner = ProvisionalOwner & {
  identityMode: 'user_message' | 'manual_compaction'
  threadId: string
  clientUserMessageId: string | null
  observedNativeTurnId: string | null
  reconciledNativeTurnId: string | null
  candidateNativeTurnIds: Set<string>
  pendingReconciliation: {
    nativeTurnId: string
    commitAccepted: (disposition: 'bound') => void
    resolve: (disposition: 'released' | 'unknown') => void
    reject: (error: Error) => void
  } | null
}

export type CodexToolServerRequestParams = {
  threadId: string
  turnId: string
  callId: string
  namespace: string | null
  tool: string
  arguments: unknown
}

export interface CodexBoundServerRequestExecutor {
  execute(input: {
    bindingId: string
    connectionEpoch: string
    requestId: number | string
    params: CodexToolServerRequestParams
  }): Promise<unknown>
}

export interface CodexStartInboundQuarantinePort {
  quarantine(input: {
    method: 'thread/start' | 'turn/start'
    bindingId: string
    reason: string
  }): void
}

export class CodexProvisionalInboundBufferError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexProvisionalInboundBufferError'
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function parseToolServerRequest(value: unknown): CodexToolServerRequestParams {
  if (!isRecord(value) || !exactKeys(value, [
    'threadId',
    'turnId',
    'callId',
    'namespace',
    'tool',
    'arguments',
  ])) throw new CodexProvisionalInboundBufferError('server_request_params_invalid')
  if (
    !nonEmpty(value.threadId)
    || !nonEmpty(value.turnId)
    || !nonEmpty(value.callId)
    || !nonEmpty(value.tool)
    || (value.namespace !== null && typeof value.namespace !== 'string')
  ) throw new CodexProvisionalInboundBufferError('server_request_params_invalid')
  return value as CodexToolServerRequestParams
}

function threadSourceKey(source: CodexThread['source']): string {
  return typeof source === 'string' ? source : JSON.stringify(source)
}

function notificationTurnIdentity(notification: CodexNativeNotification): {
  threadId: string
  turnId: string
  turn: CodexTurn | null
  item: CodexThreadItem | null
} | null {
  if (notification.method === 'thread/started') return null
  if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
    return {
      threadId: notification.params.threadId,
      turnId: notification.params.turn.id,
      turn: notification.params.turn,
      item: null,
    }
  }
  return {
    threadId: notification.params.threadId,
    turnId: notification.params.turnId,
    turn: null,
    item: notification.method === 'item/started' || notification.method === 'item/completed'
      ? notification.params.item
      : null,
  }
}

function clientUserMessageIds(turn: CodexTurn | null, item: CodexThreadItem | null): string[] {
  const items = turn ? turn.items : item ? [item] : []
  return items.flatMap((candidate) => (
    candidate.type === 'userMessage' && nonEmpty(candidate.clientId)
      ? [candidate.clientId]
      : []
  ))
}

function isActionBearing(
  notification: CodexNativeNotification,
  identity: ReturnType<typeof notificationTurnIdentity>,
): boolean {
  if (!identity) return false
  if (identity.item?.type === 'userMessage' || identity.item?.type === 'contextCompaction') return false
  if (notification.method === 'turn/started') return false
  return true
}

function frameBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export class CodexProvisionalInboundBuffer implements CodexInboundFramePort {
  private readonly threads = new Map<string, ProvisionalThreadOwner>()
  private readonly turns = new Map<string, ProvisionalTurnOwner>()
  private readonly boundThreads = new Map<string, string>()
  private readonly boundTurns = new Map<string, {
    bindingId: string
    allowServerRequests: boolean
  }>()
  private releasePort: CodexInboundFrameReleasePort | null = null
  private sequence = 0

  constructor(private readonly deps: {
    maxFramesPerOwner: number
    maxBytesPerOwner: number
    nowMs: () => number
    serverRequestExecutor: CodexBoundServerRequestExecutor
    startInboundQuarantinePort: CodexStartInboundQuarantinePort
  }) {
    if (
      !Number.isSafeInteger(deps.maxFramesPerOwner)
      || deps.maxFramesPerOwner <= 0
      || !Number.isSafeInteger(deps.maxBytesPerOwner)
      || deps.maxBytesPerOwner <= 0
    ) throw new CodexProvisionalInboundBufferError('buffer_limits_invalid')
  }

  attachReleasePort(port: CodexInboundFrameReleasePort): () => void {
    if (this.releasePort) throw new CodexProvisionalInboundBufferError('release_port_already_attached')
    this.releasePort = port
    return () => {
      if (this.releasePort === port) this.releasePort = null
    }
  }

  registerProvisionalThread(input: {
    bindingId: string
    connectionEpoch: string
    expectedCwd: string
    expectedSource: string
    deadlineAtMs: number
  }): void {
    this.assertRegistration(input)
    if (
      this.threads.has(input.bindingId)
      || [...this.threads.values()].some((owner) => (
        owner.state === 'provisional'
        && owner.connectionEpoch === input.connectionEpoch
        && owner.expectedCwd === input.expectedCwd
        && owner.expectedSource === input.expectedSource
      ))
    ) throw new CodexProvisionalInboundBufferError('provisional_thread_identity_conflict')
    const owner: ProvisionalThreadOwner = {
      ...input,
      state: 'provisional',
      unknownReason: null,
      frames: [],
      bufferedBytes: 0,
      deadlineTimer: null,
      observedNativeThreadId: null,
    }
    this.threads.set(input.bindingId, owner)
    this.scheduleDeadline(owner)
  }

  registerProvisionalTurn(input: {
    bindingId: string
    connectionEpoch: string
    threadId: string
    clientUserMessageId: string
    deadlineAtMs: number
  }): void {
    this.assertRegistration(input)
    if (
      !nonEmpty(input.threadId)
      || !nonEmpty(input.clientUserMessageId)
      || this.turns.has(input.bindingId)
      || [...this.turns.values()].some((owner) => (
        owner.state === 'provisional'
        && owner.threadId === input.threadId
        && owner.clientUserMessageId === input.clientUserMessageId
      ))
    ) throw new CodexProvisionalInboundBufferError('provisional_turn_identity_conflict')
    const owner: ProvisionalTurnOwner = {
      ...input,
      identityMode: 'user_message',
      state: 'provisional',
      unknownReason: null,
      frames: [],
      bufferedBytes: 0,
      deadlineTimer: null,
      observedNativeTurnId: null,
      reconciledNativeTurnId: null,
      candidateNativeTurnIds: new Set(),
      pendingReconciliation: null,
    }
    this.turns.set(input.bindingId, owner)
    this.scheduleDeadline(owner)
  }

  registerProvisionalManualCompaction(input: {
    manualCompactionId: string
    connectionEpoch: string
    threadId: string
    deadlineAtMs: number
  }): void {
    this.assertRegistration({
      bindingId: input.manualCompactionId,
      connectionEpoch: input.connectionEpoch,
      deadlineAtMs: input.deadlineAtMs,
    })
    if (
      !nonEmpty(input.threadId)
      || this.turns.has(input.manualCompactionId)
      || [...this.turns.values()].some((owner) => (
        owner.state === 'provisional' && owner.threadId === input.threadId
      ))
    ) throw new CodexProvisionalInboundBufferError('provisional_manual_identity_conflict')
    const owner: ProvisionalTurnOwner = {
      bindingId: input.manualCompactionId,
      connectionEpoch: input.connectionEpoch,
      deadlineAtMs: input.deadlineAtMs,
      state: 'provisional',
      unknownReason: null,
      frames: [],
      bufferedBytes: 0,
      deadlineTimer: null,
      identityMode: 'manual_compaction',
      threadId: input.threadId,
      clientUserMessageId: null,
      observedNativeTurnId: null,
      reconciledNativeTurnId: null,
      candidateNativeTurnIds: new Set(),
      pendingReconciliation: null,
    }
    this.turns.set(input.manualCompactionId, owner)
    this.scheduleDeadline(owner)
  }

  async reconcileThread(input: {
    bindingId: string
    connectionEpoch: string
    nativeThreadId: string
  }, commitAccepted: (disposition: 'bound') => void = () => undefined): Promise<'released' | 'unknown'> {
    const owner = this.threads.get(input.bindingId)
    if (!owner || owner.connectionEpoch !== input.connectionEpoch) {
      throw new CodexProvisionalInboundBufferError('provisional_thread_not_found')
    }
    if (this.expire(owner) || owner.state === 'unknown') return 'unknown'
    if (
      !nonEmpty(input.nativeThreadId)
      || (owner.observedNativeThreadId && owner.observedNativeThreadId !== input.nativeThreadId)
    ) {
      this.markUnknown(owner, 'thread_reconciliation_identity_conflict')
      return 'unknown'
    }
    commitAccepted('bound')
    owner.observedNativeThreadId = input.nativeThreadId
    owner.state = 'bound'
    this.clearDeadline(owner)
    this.boundThreads.set(input.nativeThreadId, input.bindingId)
    await this.release(owner)
    return 'released'
  }

  async reconcileTurn(input: {
    bindingId: string
    connectionEpoch: string
    threadId: string
    nativeTurnId: string
  }, commitAccepted: (
    disposition: 'bound'
  ) => void = () => undefined): Promise<'released' | 'unknown'> {
    const owner = this.turns.get(input.bindingId)
    if (
      !owner
      || owner.connectionEpoch !== input.connectionEpoch
      || owner.threadId !== input.threadId
    ) throw new CodexProvisionalInboundBufferError('provisional_turn_not_found')
    if (this.expire(owner) || owner.state === 'unknown') return 'unknown'
    if (
      !nonEmpty(input.nativeTurnId)
      || (owner.observedNativeTurnId && owner.observedNativeTurnId !== input.nativeTurnId)
      || (owner.candidateNativeTurnIds.size > 0 && !owner.candidateNativeTurnIds.has(input.nativeTurnId))
    ) {
      this.markUnknown(owner, 'turn_reconciliation_identity_conflict')
      return 'unknown'
    }
    if (owner.pendingReconciliation) {
      throw new CodexProvisionalInboundBufferError('turn_reconciliation_already_pending')
    }
    if (!owner.observedNativeTurnId) {
      return new Promise<'released' | 'unknown'>((resolve, reject) => {
        owner.pendingReconciliation = {
          nativeTurnId: input.nativeTurnId,
          commitAccepted,
          resolve,
          reject,
        }
      })
    }
    commitAccepted('bound')
    owner.reconciledNativeTurnId = input.nativeTurnId
    await this.bindAndReleaseTurn(owner)
    return 'released'
  }

  async routeNotification(input: {
    connectionEpoch: string
    frame: unknown
    notification: CodexNativeNotification
  }): Promise<'broadcast' | 'buffered'> {
    if (input.notification.method === 'thread/started') {
      return this.routeThreadStarted(input.connectionEpoch, input.notification)
    }
    const identity = notificationTurnIdentity(input.notification)
    if (!identity) throw new CodexProvisionalInboundBufferError('notification_identity_missing')
    const bound = this.boundTurns.get(this.turnKey(identity.threadId, identity.turnId))
    if (bound) return 'broadcast'
    const pending = this.provisionalTurnsForThread(input.connectionEpoch, identity.threadId)
    if (pending.length !== 1) {
      for (const owner of pending) this.markUnknown(owner, 'turn_owner_ambiguous')
      throw new CodexProvisionalInboundBufferError('turn_owner_not_unique')
    }
    const owner = pending[0]
    if (this.expire(owner) || owner.state === 'unknown') return 'buffered'
    if (
      owner.pendingReconciliation
      && owner.pendingReconciliation.nativeTurnId !== identity.turnId
    ) {
      this.markUnknown(owner, 'turn_reconciliation_identity_conflict')
      return 'buffered'
    }
    if (owner.identityMode === 'manual_compaction') {
      owner.candidateNativeTurnIds.add(identity.turnId)
      if (owner.candidateNativeTurnIds.size > 1) {
        this.markUnknown(owner, 'manual_compaction_turn_identity_conflict')
        return 'buffered'
      }
      const item = identity.item
      if (item?.type === 'dynamicToolCall' || item?.type === 'userMessage') {
        this.markUnknown(owner, 'manual_compaction_item_forbidden')
      } else {
        owner.observedNativeTurnId = identity.turnId
      }
      this.buffer(owner, {
        kind: 'notification',
        sequence: this.nextSequence(),
        bytes: frameBytes(input.frame),
        notification: input.notification,
      })
      if (
        owner.state === 'provisional'
        && owner.observedNativeTurnId
      ) await this.finishPendingTurnReconciliation(owner)
      return 'buffered'
    }
    const clientIds = clientUserMessageIds(identity.turn, identity.item)
    if (clientIds.length > 1 || (clientIds.length === 1 && clientIds[0] !== owner.clientUserMessageId)) {
      this.markUnknown(owner, 'turn_client_identity_conflict')
      return 'buffered'
    }
    owner.candidateNativeTurnIds.add(identity.turnId)
    if (owner.candidateNativeTurnIds.size > 1) {
      this.markUnknown(owner, 'turn_native_identity_conflict')
      return 'buffered'
    }
    if (clientIds.length === 1) owner.observedNativeTurnId = identity.turnId
    else if (!owner.observedNativeTurnId && isActionBearing(input.notification, identity)) {
      this.markUnknown(owner, 'action_before_turn_identity')
    }
    this.buffer(owner, {
      kind: 'notification',
      sequence: this.nextSequence(),
      bytes: frameBytes(input.frame),
      notification: input.notification,
    })
    if (
      owner.state === 'provisional'
      && owner.observedNativeTurnId
    ) await this.finishPendingTurnReconciliation(owner)
    return 'buffered'
  }

  async routeServerRequest(input: {
    connectionEpoch: string
    requestId: number | string
    method: 'item/tool/call'
    params: unknown
  }): Promise<
    | { disposition: 'buffered' }
    | { disposition: 'respond'; result: unknown }
  > {
    const params = parseToolServerRequest(input.params)
    const bound = this.boundTurns.get(this.turnKey(params.threadId, params.turnId))
    if (bound) {
      if (!bound.allowServerRequests) {
        throw new CodexProvisionalInboundBufferError('manual_compaction_tool_forbidden')
      }
      return {
        disposition: 'respond',
        result: await this.deps.serverRequestExecutor.execute({
          bindingId: bound.bindingId,
          connectionEpoch: input.connectionEpoch,
          requestId: input.requestId,
          params,
        }),
      }
    }
    const pending = this.provisionalTurnsForThread(input.connectionEpoch, params.threadId)
    if (pending.length !== 1) {
      for (const owner of pending) this.markUnknown(owner, 'server_request_owner_ambiguous')
      throw new CodexProvisionalInboundBufferError('server_request_owner_not_unique')
    }
    const owner = pending[0]
    if (this.expire(owner) || owner.state === 'unknown') return { disposition: 'buffered' }
    if (owner.identityMode === 'manual_compaction') {
      this.markUnknown(owner, 'manual_compaction_tool_forbidden')
      return { disposition: 'buffered' }
    }
    if (owner.observedNativeTurnId !== params.turnId) {
      this.markUnknown(owner, 'server_request_before_turn_identity')
    }
    this.buffer(owner, {
      kind: 'server_request',
      sequence: this.nextSequence(),
      bytes: frameBytes(input.params),
      connectionEpoch: input.connectionEpoch,
      requestId: input.requestId,
      params,
    })
    return { disposition: 'buffered' }
  }

  markConnectionClosed(connectionEpoch: string): void {
    for (const owner of [...this.threads.values(), ...this.turns.values()]) {
      if (owner.connectionEpoch === connectionEpoch && owner.state === 'provisional') {
        this.markUnknown(owner, 'connection_closed_before_binding')
      }
    }
  }

  expireDue(): number {
    let expired = 0
    for (const owner of [...this.threads.values(), ...this.turns.values()]) {
      if (this.expire(owner)) expired += 1
    }
    return expired
  }

  readManualCompactionEvidence(manualCompactionId: string): {
    turnId: string
    contextCompactionItemId: string
    terminalStatus: CodexTurn['status']
  } | null {
    const owner = this.turns.get(manualCompactionId)
    if (!owner || owner.identityMode !== 'manual_compaction' || owner.state === 'unknown') return null
    let contextCompactionItemId: string | null = null
    let terminalStatus: CodexTurn['status'] | null = null
    for (const frame of owner.frames) {
      if (frame.kind !== 'notification') continue
      if (
        frame.notification.method === 'item/completed'
        && frame.notification.params.item.type === 'contextCompaction'
      ) contextCompactionItemId = frame.notification.params.item.id
      if (frame.notification.method === 'turn/completed') {
        terminalStatus = frame.notification.params.turn.status
      }
    }
    return owner.observedNativeTurnId && contextCompactionItemId && terminalStatus
      ? { turnId: owner.observedNativeTurnId, contextCompactionItemId, terminalStatus }
      : null
  }

  readManualCompactionDiagnostic(manualCompactionId: string): {
    observedNativeTurnId: string | null
    reconciledNativeTurnId: string | null
    candidateNativeTurnIds: string[]
    frames: Array<{
      method: CodexNativeNotification['method'] | 'server_request'
      turnId: string | null
      itemType: CodexThreadItem['type'] | null
      itemId: string | null
      status: CodexTurn['status'] | null
      errorMessage: string | null
    }>
  } | null {
    const owner = this.turns.get(manualCompactionId)
    if (!owner || owner.identityMode !== 'manual_compaction') return null
    return {
      observedNativeTurnId: owner.observedNativeTurnId,
      reconciledNativeTurnId: owner.reconciledNativeTurnId,
      candidateNativeTurnIds: [...owner.candidateNativeTurnIds],
      frames: owner.frames.map((frame) => {
        if (frame.kind === 'server_request') {
          return {
            method: 'server_request' as const,
            turnId: frame.params.turnId,
            itemType: null,
            itemId: null,
            status: null,
            errorMessage: null,
          }
        }
        const identity = notificationTurnIdentity(frame.notification)
        return {
          method: frame.notification.method,
          turnId: identity?.turnId || null,
          itemType: identity?.item?.type || null,
          itemId: identity?.item?.id || null,
          status: identity?.turn?.status || null,
          errorMessage: frame.notification.method === 'error'
            ? frame.notification.params.error.message
            : identity?.turn?.error?.message || null,
        }
      }),
    }
  }

  snapshot(): Array<{
    kind: 'thread' | 'turn'
    bindingId: string
    state: ProvisionalOwner['state']
    unknownReason: string | null
    frameCount: number
    bufferedBytes: number
  }> {
    return [
      ...[...this.threads.values()].map((owner) => ({ kind: 'thread' as const, owner })),
      ...[...this.turns.values()].map((owner) => ({ kind: 'turn' as const, owner })),
    ].map(({ kind, owner }) => ({
      kind,
      bindingId: owner.bindingId,
      state: owner.state,
      unknownReason: owner.unknownReason,
      frameCount: owner.frames.length,
      bufferedBytes: owner.bufferedBytes,
    }))
  }

  private routeThreadStarted(
    connectionEpoch: string,
    notification: Extract<CodexNativeNotification, { method: 'thread/started' }>,
  ): 'broadcast' | 'buffered' {
    if (this.boundThreads.has(notification.params.thread.id)) return 'broadcast'
    const source = threadSourceKey(notification.params.thread.source)
    const matches = [...this.threads.values()].filter((owner) => (
      owner.state === 'provisional'
      && owner.connectionEpoch === connectionEpoch
      && owner.expectedCwd === notification.params.thread.cwd
      && owner.expectedSource === source
    ))
    if (matches.length !== 1) {
      for (const owner of matches) this.markUnknown(owner, 'thread_owner_ambiguous')
      throw new CodexProvisionalInboundBufferError('thread_owner_not_unique')
    }
    const owner = matches[0]
    if (this.expire(owner) || owner.state === 'unknown') return 'buffered'
    const thread = notification.params.thread
    if (
      thread.sessionId !== thread.id
      || thread.parentThreadId !== null
      || thread.forkedFromId !== null
      || (owner.observedNativeThreadId && owner.observedNativeThreadId !== thread.id)
    ) {
      this.markUnknown(owner, 'thread_metadata_conflict')
      return 'buffered'
    }
    owner.observedNativeThreadId = thread.id
    this.buffer(owner, {
      kind: 'notification',
      sequence: this.nextSequence(),
      bytes: frameBytes(notification),
      notification,
    })
    return 'buffered'
  }

  private async bindAndReleaseTurn(owner: ProvisionalTurnOwner): Promise<void> {
    if (!owner.observedNativeTurnId || owner.reconciledNativeTurnId !== owner.observedNativeTurnId) {
      throw new CodexProvisionalInboundBufferError('turn_binding_evidence_incomplete')
    }
    owner.state = 'bound'
    this.clearDeadline(owner)
    this.boundTurns.set(this.turnKey(owner.threadId, owner.observedNativeTurnId), {
      bindingId: owner.bindingId,
      allowServerRequests: owner.identityMode === 'user_message',
    })
    await this.release(owner)
  }

  private async finishPendingTurnReconciliation(owner: ProvisionalTurnOwner): Promise<void> {
    const pending = owner.pendingReconciliation
    if (!pending || owner.observedNativeTurnId !== pending.nativeTurnId) return
    owner.pendingReconciliation = null
    try {
      pending.commitAccepted('bound')
      owner.reconciledNativeTurnId = pending.nativeTurnId
      await this.bindAndReleaseTurn(owner)
      pending.resolve('released')
    } catch (error) {
      pending.reject(
        error instanceof Error
          ? error
          : new CodexProvisionalInboundBufferError('turn_reconciliation_commit_failed'),
      )
      throw error
    }
  }

  private async release(owner: ProvisionalOwner): Promise<void> {
    const port = this.releasePort
    if (!port) throw new CodexProvisionalInboundBufferError('release_port_not_attached')
    const frames = [...owner.frames].sort((left, right) => left.sequence - right.sequence)
    owner.frames = []
    owner.bufferedBytes = 0
    for (const frame of frames) {
      if (frame.kind === 'notification') {
        port.broadcastNotification(frame.notification)
        continue
      }
      const result = await this.deps.serverRequestExecutor.execute({
        bindingId: owner.bindingId,
        connectionEpoch: frame.connectionEpoch,
        requestId: frame.requestId,
        params: frame.params,
      })
      port.respondServerRequest(frame.requestId, result)
    }
  }

  private buffer(owner: ProvisionalOwner, frame: BufferedFrame): void {
    if (owner.state === 'unknown') return
    if (
      owner.frames.length + 1 > this.deps.maxFramesPerOwner
      || owner.bufferedBytes + frame.bytes > this.deps.maxBytesPerOwner
    ) {
      this.markUnknown(owner, 'provisional_buffer_overflow')
      return
    }
    owner.frames.push(frame)
    owner.bufferedBytes += frame.bytes
  }

  private provisionalTurnsForThread(
    connectionEpoch: string,
    threadId: string,
  ): ProvisionalTurnOwner[] {
    return [...this.turns.values()].filter((owner) => (
      owner.state !== 'bound'
      && owner.connectionEpoch === connectionEpoch
      && owner.threadId === threadId
    ))
  }

  private expire(owner: ProvisionalOwner): boolean {
    if (owner.state !== 'provisional' || this.deps.nowMs() <= owner.deadlineAtMs) return false
    this.markUnknown(owner, 'provisional_buffer_deadline_exceeded')
    return true
  }

  private markUnknown(owner: ProvisionalOwner, reason: string): void {
    if (owner.state === 'bound') throw new CodexProvisionalInboundBufferError('bound_owner_cannot_be_unknown')
    if (owner.state === 'unknown') return
    const turnOwner = 'identityMode' in owner ? owner as ProvisionalTurnOwner : null
    const pending = turnOwner?.pendingReconciliation || null
    if (turnOwner) turnOwner.pendingReconciliation = null
    owner.state = 'unknown'
    owner.unknownReason = reason
    this.clearDeadline(owner)
    try {
      if ('expectedCwd' in owner) {
        this.deps.startInboundQuarantinePort.quarantine({
          method: 'thread/start',
          bindingId: owner.bindingId,
          reason,
        })
      } else if ('identityMode' in owner && owner.identityMode === 'user_message') {
        this.deps.startInboundQuarantinePort.quarantine({
          method: 'turn/start',
          bindingId: owner.bindingId,
          reason,
        })
      }
    } catch (error) {
      pending?.reject(
        error instanceof Error
          ? error
          : new CodexProvisionalInboundBufferError('turn_quarantine_failed'),
      )
      throw error
    }
    if (pending) {
      pending.resolve('unknown')
    }
  }

  private scheduleDeadline(owner: ProvisionalOwner): void {
    const delayMs = Math.max(0, owner.deadlineAtMs - this.deps.nowMs() + 1)
    owner.deadlineTimer = setTimeout(() => {
      try {
        this.expire(owner)
      } catch (error) {
        this.releasePort?.failProtocol(
          error instanceof Error ? error : new CodexProvisionalInboundBufferError('deadline_failure'),
        )
      }
    }, delayMs)
    owner.deadlineTimer.unref?.()
  }

  private clearDeadline(owner: ProvisionalOwner): void {
    if (owner.deadlineTimer) clearTimeout(owner.deadlineTimer)
    owner.deadlineTimer = null
  }

  private assertRegistration(input: {
    bindingId: string
    connectionEpoch: string
    deadlineAtMs: number
  }): void {
    if (
      !nonEmpty(input.bindingId)
      || !nonEmpty(input.connectionEpoch)
      || !Number.isSafeInteger(input.deadlineAtMs)
      || input.deadlineAtMs <= this.deps.nowMs()
    ) throw new CodexProvisionalInboundBufferError('provisional_registration_invalid')
  }

  private nextSequence(): number {
    this.sequence += 1
    return this.sequence
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}\0${turnId}`
  }
}
