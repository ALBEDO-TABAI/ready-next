export type CodexAdditionalContextEntry = {
  kind: 'application' | 'untrusted'
  value: string
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string; detail: 'auto' | 'low' | 'high' | 'original' | null }
  | { type: 'audio'; url: string }

export type CodexDynamicToolSpec = {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
  deferLoading?: boolean
}

export type CodexThreadStartParams = {
  model: string
  modelProvider: 'ready_gateway'
  allowProviderModelFallback: false
  cwd: string
  approvalPolicy: 'never'
  sandbox: 'read-only'
  runtimeWorkspaceRoots: []
  environments: []
  dynamicTools: CodexDynamicToolSpec[]
  developerInstructions: string
}

export type CodexTurnStartParams = {
  threadId: string
  clientUserMessageId: string
  input: CodexUserInput[]
  additionalContext: Record<string, CodexAdditionalContextEntry>
  responsesapiClientMetadata: {
    readyRunId: string
    toolSurfaceDigest: string
    turnContractDigest: string
    upstreamProfileSnapshotDigest: string
  }
}

export type CodexSubAgentSource =
  | 'review'
  | 'compact'
  | 'memory_consolidation'
  | {
      thread_spawn: {
        depth: number
        parent_thread_id: string
        agent_nickname?: string | null
        agent_path?: string | null
        agent_role?: string | null
      }
    }
  | { other: string }

export type CodexSessionSource =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown'
  | { custom: string }
  | { subAgent: CodexSubAgentSource }

export type CodexThreadSource = string

export type CodexThread = {
  id: string
  sessionId: string
  parentThreadId: string | null
  forkedFromId: string | null
  cwd: string
  source: CodexSessionSource
  threadSource: CodexThreadSource | null
  modelProvider: string
  cliVersion: string
  createdAt: number
  ephemeral: boolean
  preview: string
  status:
    | { type: 'notLoaded' | 'idle' | 'systemError' }
    | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> }
  updatedAt: number
  turns: CodexTurn[]
}

export type CodexTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export type CodexAgentMessageItem = {
  type: 'agentMessage'
  id: string
  text: string
  phase: 'commentary' | 'final_answer' | null
}

export type CodexDynamicToolCallItem = {
  type: 'dynamicToolCall'
  id: string
  tool: string
  namespace: string | null
  arguments: unknown
  status: 'inProgress' | 'completed' | 'failed'
  success?: boolean | null
}

export type CodexContextCompactionItem = {
  type: 'contextCompaction'
  id: string
}

export type CodexUserMessageItem = {
  type: 'userMessage'
  id: string
  clientId: string | null
  content: CodexUserInput[]
}

export type CodexOtherItem = {
  type: 'other'
  id: string
  nativeType: 'hookPrompt' | 'plan' | 'reasoning'
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexDynamicToolCallItem
  | CodexContextCompactionItem
  | CodexUserMessageItem
  | CodexOtherItem

type CodexHttpErrorDetails = { httpStatusCode?: number | null }

export type CodexErrorInfo =
  | 'contextWindowExceeded'
  | 'sessionBudgetExceeded'
  | 'usageLimitExceeded'
  | 'serverOverloaded'
  | 'cyberPolicy'
  | 'internalServerError'
  | 'unauthorized'
  | 'badRequest'
  | 'threadRollbackFailed'
  | 'sandboxError'
  | 'other'
  | { httpConnectionFailed: CodexHttpErrorDetails }
  | { responseStreamConnectionFailed: CodexHttpErrorDetails }
  | { responseStreamDisconnected: CodexHttpErrorDetails }
  | { responseTooManyFailedAttempts: CodexHttpErrorDetails }
  | { activeTurnNotSteerable: { turnKind: 'review' | 'compact' } }

export type CodexTurnError = {
  message: string
  additionalDetails?: string | null
  codexErrorInfo?: CodexErrorInfo | null
}

export type CodexTurn = {
  id: string
  items: CodexThreadItem[]
  status: CodexTurnStatus
  error: CodexTurnError | null
}

export type CodexNativeNotification =
  | { method: 'thread/started'; params: { thread: CodexThread } }
  | { method: 'turn/started'; params: { threadId: string; turn: CodexTurn } }
  | {
      method: 'item/started'
      params: { threadId: string; turnId: string; item: CodexThreadItem; startedAtMs: number }
    }
  | {
      method: 'item/completed'
      params: { threadId: string; turnId: string; item: CodexThreadItem; completedAtMs: number }
    }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'turn/completed'; params: { threadId: string; turn: CodexTurn } }
  | {
      method: 'error'
      params: {
        error: CodexTurnError
        threadId: string
        turnId: string
        willRetry: boolean
      }
    }

export interface CodexNativeRuntime {
  initialize(): Promise<{ userAgent: string }>
  threadStart(params: CodexThreadStartParams): Promise<{
    thread: CodexThread
    instructionSources: string[]
  }>
  threadRead(params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexThread }>
  threadResume(params: { threadId: string }): Promise<{
    thread: CodexThread
    instructionSources: string[]
  }>
  threadArchive(params: { threadId: string }): Promise<Record<string, never>>
  turnStart(params: CodexTurnStartParams): Promise<{ turn: CodexTurn }>
  turnInterrupt(params: { threadId: string; turnId: string }): Promise<Record<string, never>>
  threadCompactStart(params: { threadId: string }): Promise<Record<string, never>>
  subscribe(listener: (notification: CodexNativeNotification) => void): () => void
}

export type CodexNotificationNormalizationResult =
  | { kind: 'accepted'; notification: CodexNativeNotification }
  | { kind: 'ignored'; method: string }
  | { kind: 'invalid'; code: 'not_object' | 'missing_method' | 'invalid_params' | 'unknown_method' }

const PASSIVE_NOTIFICATION_METHODS = new Set([
  'warning',
  'thread/status/changed',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'remoteControl/status/changed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === 'string' ? value[key] : null
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string'
}

function isSafeIntegerOrNullish(value: unknown): boolean {
  return value === undefined || value === null || Number.isSafeInteger(value)
}

function isGitInfo(value: unknown): boolean {
  return value === undefined
    || value === null
    || (
      isRecord(value)
      && isNullableString(value.sha)
      && isNullableString(value.branch)
      && isNullableString(value.originUrl)
    )
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function normalizeUserInput(value: unknown): CodexUserInput | null {
  if (!isRecord(value)) return null
  if (value.type === 'text') {
    if (typeof value.text !== 'string') return null
    if (
      value.text_elements !== undefined
      && (!Array.isArray(value.text_elements) || value.text_elements.length !== 0)
    ) return null
    return { type: 'text', text: value.text, text_elements: [] }
  }
  if (value.type === 'image') {
    if (typeof value.url !== 'string') return null
    const detail = value.detail === undefined ? null : value.detail
    if (
      detail !== null
      && detail !== 'auto'
      && detail !== 'low'
      && detail !== 'high'
      && detail !== 'original'
    ) return null
    return { type: 'image', url: value.url, detail }
  }
  if (value.type === 'audio') {
    return typeof value.url === 'string'
      ? { type: 'audio', url: value.url }
      : null
  }
  return null
}

function isDynamicToolContentItems(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (!isRecord(entry)) return false
    if (entry.type === 'inputText') return typeof entry.text === 'string'
    if (entry.type === 'inputImage') return typeof entry.imageUrl === 'string'
    if (entry.type === 'inputAudio') return typeof entry.audioUrl === 'string'
    return false
  })
}

function normalizeThreadStatus(value: unknown): CodexThread['status'] | null {
  if (!isRecord(value)) return null
  if (value.type === 'notLoaded' || value.type === 'idle' || value.type === 'systemError') {
    return { type: value.type }
  }
  if (
    value.type === 'active'
    && Array.isArray(value.activeFlags)
    && value.activeFlags.every((flag) => (
      flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
    ))
  ) {
    return {
      type: 'active',
      activeFlags: value.activeFlags as Array<'waitingOnApproval' | 'waitingOnUserInput'>,
    }
  }
  return null
}

function normalizeSubAgentSource(value: unknown): CodexSubAgentSource | null {
  if (value === 'review' || value === 'compact' || value === 'memory_consolidation') return value
  if (!isRecord(value)) return null
  if (hasExactKeys(value, ['other']) && typeof value.other === 'string') {
    return { other: value.other }
  }
  if (!hasExactKeys(value, ['thread_spawn']) || !isRecord(value.thread_spawn)) return null
  const details = value.thread_spawn
  if (
    !Number.isInteger(details.depth)
    || (details.depth as number) < -2_147_483_648
    || (details.depth as number) > 2_147_483_647
    || typeof details.parent_thread_id !== 'string'
    || !isNullableString(details.agent_nickname)
    || !isNullableString(details.agent_path)
    || !isNullableString(details.agent_role)
  ) return null
  const threadSpawn: Extract<CodexSubAgentSource, { thread_spawn: unknown }>['thread_spawn'] = {
    depth: details.depth as number,
    parent_thread_id: details.parent_thread_id,
  }
  if (details.agent_nickname !== undefined) threadSpawn.agent_nickname = details.agent_nickname
  if (details.agent_path !== undefined) threadSpawn.agent_path = details.agent_path
  if (details.agent_role !== undefined) threadSpawn.agent_role = details.agent_role
  return { thread_spawn: threadSpawn }
}

function normalizeSessionSource(value: unknown): CodexSessionSource | null {
  if (
    value === 'cli'
    || value === 'vscode'
    || value === 'exec'
    || value === 'appServer'
    || value === 'unknown'
  ) return value
  if (!isRecord(value)) return null
  if (hasExactKeys(value, ['custom']) && typeof value.custom === 'string') {
    return { custom: value.custom }
  }
  if (!hasExactKeys(value, ['subAgent'])) return null
  const subAgent = normalizeSubAgentSource(value.subAgent)
  return subAgent ? { subAgent } : null
}

function normalizeItem(value: unknown): CodexThreadItem | null {
  if (!isRecord(value)) return null
  const type = stringField(value, 'type')
  const id = stringField(value, 'id')
  if (!type || !id) return null
  if (type === 'agentMessage') {
    const text = stringField(value, 'text')
    const phase = value.phase === undefined ? null : value.phase
    if (
      text === null
      || (phase !== 'commentary' && phase !== 'final_answer' && phase !== null)
      || (value.memoryCitation !== undefined && value.memoryCitation !== null)
    ) return null
    return { type, id, text, phase: phase as CodexAgentMessageItem['phase'] }
  }
  if (type === 'dynamicToolCall') {
    const tool = stringField(value, 'tool')
    const status = value.status
    if (
      !tool
      || !Object.prototype.hasOwnProperty.call(value, 'arguments')
      || (status !== 'inProgress' && status !== 'completed' && status !== 'failed')
      || !isNullableString(value.namespace)
      || (value.success !== undefined && value.success !== null && typeof value.success !== 'boolean')
      || !isDynamicToolContentItems(value.contentItems)
      || (
        value.durationMs !== undefined
        && value.durationMs !== null
        && !Number.isSafeInteger(value.durationMs)
      )
    ) return null
    return {
      type,
      id,
      tool,
      namespace: typeof value.namespace === 'string' ? value.namespace : null,
      arguments: value.arguments,
      status,
      success: typeof value.success === 'boolean' ? value.success : null,
    }
  }
  if (type === 'contextCompaction') return { type, id }
  if (type === 'userMessage') {
    if (!Array.isArray(value.content)) return null
    if (!isNullableString(value.clientId)) return null
    const content = value.content.map(normalizeUserInput)
    if (content.some((entry) => !entry)) return null
    return {
      type,
      id,
      clientId: typeof value.clientId === 'string' ? value.clientId : null,
      content: content as CodexUserInput[],
    }
  }
  if (
    type === 'hookPrompt'
    && Array.isArray(value.fragments)
    && value.fragments.every((fragment) => (
      isRecord(fragment)
      && typeof fragment.hookRunId === 'string'
      && typeof fragment.text === 'string'
    ))
  ) {
    return { type: 'other', id, nativeType: type }
  }
  if (type === 'plan' && typeof value.text === 'string') {
    return { type: 'other', id, nativeType: type }
  }
  if (
    type === 'reasoning'
    && (value.content === undefined || isStringArray(value.content))
    && (value.summary === undefined || isStringArray(value.summary))
  ) {
    return { type: 'other', id, nativeType: type as CodexOtherItem['nativeType'] }
  }
  return null
}

function normalizeCodexErrorInfo(value: unknown): { ok: true; value: CodexErrorInfo | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (
    value === 'contextWindowExceeded'
    || value === 'sessionBudgetExceeded'
    || value === 'usageLimitExceeded'
    || value === 'serverOverloaded'
    || value === 'cyberPolicy'
    || value === 'internalServerError'
    || value === 'unauthorized'
    || value === 'badRequest'
    || value === 'threadRollbackFailed'
    || value === 'sandboxError'
    || value === 'other'
  ) return { ok: true, value }
  if (!isRecord(value)) return { ok: false }

  const keys = Object.keys(value)
  if (keys.length !== 1) return { ok: false }
  const variant = keys[0]
  if (variant === 'activeTurnNotSteerable') {
    const details = value[variant]
    return isRecord(details) && (details.turnKind === 'review' || details.turnKind === 'compact')
      ? { ok: true, value: { activeTurnNotSteerable: { turnKind: details.turnKind } } }
      : { ok: false }
  }
  if (
    variant !== 'httpConnectionFailed'
    && variant !== 'responseStreamConnectionFailed'
    && variant !== 'responseStreamDisconnected'
    && variant !== 'responseTooManyFailedAttempts'
  ) return { ok: false }
  const details = value[variant]
  if (!isRecord(details)) return { ok: false }
  const status = details.httpStatusCode
  if (
    status !== undefined
    && status !== null
    && (!Number.isInteger(status) || (status as number) < 0 || (status as number) > 65_535)
  ) return { ok: false }
  const normalizedDetails: CodexHttpErrorDetails = status === undefined
    ? {}
    : { httpStatusCode: status as number | null }
  if (variant === 'httpConnectionFailed') {
    return { ok: true, value: { httpConnectionFailed: normalizedDetails } }
  }
  if (variant === 'responseStreamConnectionFailed') {
    return { ok: true, value: { responseStreamConnectionFailed: normalizedDetails } }
  }
  if (variant === 'responseStreamDisconnected') {
    return { ok: true, value: { responseStreamDisconnected: normalizedDetails } }
  }
  return { ok: true, value: { responseTooManyFailedAttempts: normalizedDetails } }
}

function normalizeTurnError(value: unknown): CodexTurnError | null {
  if (!isRecord(value) || typeof value.message !== 'string') return null
  if (
    value.additionalDetails !== undefined
    && value.additionalDetails !== null
    && typeof value.additionalDetails !== 'string'
  ) return null
  const codexErrorInfo = normalizeCodexErrorInfo(value.codexErrorInfo)
  if (!codexErrorInfo.ok) return null
  return {
    message: value.message,
    additionalDetails: typeof value.additionalDetails === 'string'
      ? value.additionalDetails
      : null,
    codexErrorInfo: codexErrorInfo.value,
  }
}

function normalizeTurn(value: unknown): CodexTurn | null {
  if (!isRecord(value)) return null
  const id = stringField(value, 'id')
  const status = stringField(value, 'status')
  if (!id || !status || !['completed', 'interrupted', 'failed', 'inProgress'].includes(status)) return null
  if (!Array.isArray(value.items)) return null
  for (const key of ['startedAt', 'completedAt', 'durationMs'] as const) {
    const field = value[key]
    if (!isSafeIntegerOrNullish(field)) return null
  }
  if (
    value.itemsView !== undefined
    && value.itemsView !== 'notLoaded'
    && value.itemsView !== 'summary'
    && value.itemsView !== 'full'
  ) return null
  const items = value.items.map(normalizeItem)
  if (items.some((item) => !item)) return null
  const error = value.error === null || value.error === undefined
    ? null
    : normalizeTurnError(value.error)
  if (value.error !== null && value.error !== undefined && !error) return null
  return {
    id,
    status: status as CodexTurnStatus,
    items: items as CodexThreadItem[],
    error,
  }
}

function normalizeThread(value: unknown): CodexThread | null {
  if (!isRecord(value)) return null
  const id = stringField(value, 'id')
  const sessionId = stringField(value, 'sessionId')
  const cwd = stringField(value, 'cwd')
  const source = normalizeSessionSource(value.source)
  const modelProvider = stringField(value, 'modelProvider')
  const cliVersion = stringField(value, 'cliVersion')
  const preview = stringField(value, 'preview')
  const status = normalizeThreadStatus(value.status)
  if (
    !isNullableString(value.parentThreadId)
    || !isNullableString(value.forkedFromId)
    || !isNullableString(value.threadSource)
    || !isNullableString(value.agentNickname)
    || !isNullableString(value.agentRole)
    || !isNullableString(value.name)
    || !isNullableString(value.path)
    || !isSafeIntegerOrNullish(value.recencyAt)
    || (value.isPinned !== undefined && typeof value.isPinned !== 'boolean')
    || !isGitInfo(value.gitInfo)
  ) return null
  if (
    !id
    || !sessionId
    || !cwd
    || !source
    || !modelProvider
    || !cliVersion
    || preview === null
    || !Number.isSafeInteger(value.createdAt)
    || typeof value.ephemeral !== 'boolean'
    || !status
    || !Number.isSafeInteger(value.updatedAt)
    || !Array.isArray(value.turns)
  ) return null
  const turns = value.turns.map(normalizeTurn)
  if (turns.some((turn) => !turn)) return null
  return {
    id,
    sessionId,
    parentThreadId: typeof value.parentThreadId === 'string' ? value.parentThreadId : null,
    forkedFromId: typeof value.forkedFromId === 'string' ? value.forkedFromId : null,
    cwd,
    source,
    threadSource: typeof value.threadSource === 'string' ? value.threadSource : null,
    modelProvider,
    cliVersion,
    createdAt: value.createdAt as number,
    ephemeral: value.ephemeral,
    preview,
    status,
    updatedAt: value.updatedAt as number,
    turns: turns as CodexTurn[],
  }
}

export function normalizeCodexNativeNotification(
  value: unknown,
): CodexNotificationNormalizationResult {
  if (!isRecord(value)) return { kind: 'invalid', code: 'not_object' }
  const method = stringField(value, 'method')
  if (!method) return { kind: 'invalid', code: 'missing_method' }
  if (PASSIVE_NOTIFICATION_METHODS.has(method)) return { kind: 'ignored', method }
  if (!isRecord(value.params)) return { kind: 'invalid', code: 'invalid_params' }
  const params = value.params

  if (method === 'thread/started') {
    const thread = normalizeThread(params.thread)
    return thread
      ? { kind: 'accepted', notification: { method, params: { thread } } }
      : { kind: 'invalid', code: 'invalid_params' }
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const threadId = stringField(params, 'threadId')
    const turn = normalizeTurn(params.turn)
    if (!threadId || !turn) return { kind: 'invalid', code: 'invalid_params' }
    return { kind: 'accepted', notification: { method, params: { threadId, turn } } }
  }
  if (method === 'item/started' || method === 'item/completed') {
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const item = normalizeItem(params.item)
    const timestampKey = method === 'item/started' ? 'startedAtMs' : 'completedAtMs'
    const timestamp = params[timestampKey]
    if (!threadId || !turnId || !item || !Number.isSafeInteger(timestamp)) {
      return { kind: 'invalid', code: 'invalid_params' }
    }
    return method === 'item/started'
      ? {
          kind: 'accepted',
          notification: {
            method,
            params: { threadId, turnId, item, startedAtMs: timestamp as number },
          },
        }
      : {
          kind: 'accepted',
          notification: {
            method,
            params: { threadId, turnId, item, completedAtMs: timestamp as number },
          },
        }
  }
  if (method === 'item/agentMessage/delta') {
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const itemId = stringField(params, 'itemId')
    const delta = stringField(params, 'delta')
    if (!threadId || !turnId || !itemId || delta === null) {
      return { kind: 'invalid', code: 'invalid_params' }
    }
    return {
      kind: 'accepted',
      notification: { method, params: { threadId, turnId, itemId, delta } },
    }
  }
  if (method === 'error') {
    const error = normalizeTurnError(params.error)
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const willRetry = params.willRetry
    if (!error || !threadId || !turnId || typeof willRetry !== 'boolean') {
      return { kind: 'invalid', code: 'invalid_params' }
    }
    return {
      kind: 'accepted',
      notification: {
        method,
        params: { error, threadId, turnId, willRetry },
      },
    }
  }
  return { kind: 'invalid', code: 'unknown_method' }
}
