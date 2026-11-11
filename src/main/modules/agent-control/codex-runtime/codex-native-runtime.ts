import type { AIReasoningEffort } from '../../../../shared/ai-providers'
import {
  normalizeCodexUserInput,
  type CodexUserInput,
} from './codex-user-input'
import {
  normalizeCodexThreadTokenUsage,
  type CodexThreadTokenUsage,
} from './codex-context-usage'

export type { CodexUserInput } from './codex-user-input'

export type CodexAdditionalContextEntry = {
  kind: 'application' | 'untrusted'
  value: string
}

export type CodexDynamicToolSpec = {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
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
  config: { model_context_window: number } | null
  dynamicTools: CodexDynamicToolSpec[]
  developerInstructions: string
}

export type CodexThreadListParams = {
  limit: number
  cwd: string
  sourceKinds: ['vscode']
  archived?: boolean
  cursor?: string | null
  useStateDbOnly?: true
}

export type CodexThreadForkParams = {
  threadId: string
  lastTurnId: string
  cwd: string
  model: string
  modelProvider: 'ready_gateway'
  approvalPolicy: 'never'
  sandbox: 'read-only'
  /** Ready's thread instructions; Codex drops them when it rebuilds a compacted history without them. */
  developerInstructions: string
}

/** Resuming rebuilds the thread's context; Ready re-declares its instructions so a compacted history keeps them. */
export type CodexThreadResumeParams = {
  threadId: string
  developerInstructions?: string
}

export type CodexThreadEffectiveSettings = {
  thread: CodexThread
  cwd: string
  model: string
  modelProvider: string
  approvalPolicy: unknown
  approvalsReviewer: unknown
  sandbox: unknown
  reasoningEffort: string | null
  serviceTier: string | null
  instructionSources: string[]
}

export type CodexTurnStartParams = {
  threadId: string
  clientUserMessageId: string
  collaborationMode: {
    mode: 'default'
    settings: {
      model: 'ready-e0-model'
      reasoning_effort: AIReasoningEffort | null
      developer_instructions: null
    }
  }
  environments: []
  input: CodexUserInput[]
  additionalContext: Record<string, CodexAdditionalContextEntry>
  responsesapiClientMetadata: {
    readyRunId: string
    toolSurfaceDigest: string
    turnContractDigest: string
    upstreamProfileSnapshotDigest: string
  }
}

export type CodexServerDiagnostics = {
  process: {
    id: number
    residentMemoryBytes: number | null
    physicalFootprintBytes: number | null
  }
  gauges: Array<{
    name: string
    value: number
  }>
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
  /** Fixed when the thread was created: 0.160.1 starts `paginated` threads; older and forked-from-older stay `legacy`. */
  historyMode: 'legacy' | 'paginated'
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
  contentItems?: Array<
    | { type: 'inputText'; text: string }
    | { type: 'inputImage'; imageUrl: string }
    | { type: 'inputAudio'; audioUrl: string }
  > | null
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

/** Every string `CodexErrorInfo` of the pinned runtime; a turn error with any other value is a protocol violation. */
export const CODEX_ERROR_INFO_STRING_VARIANTS = [
  'contextWindowExceeded',
  'sessionBudgetExceeded',
  'usageLimitExceeded',
  'rateLimitExceeded',
  'flexUnavailable',
  'serverOverloaded',
  'cyberPolicy',
  'misalignmentPolicyViolation',
  'tooManyDenials',
  'internalServerError',
  'unauthorized',
  'badRequest',
  'threadRollbackFailed',
  'sandboxError',
  'other',
] as const

const CODEX_ERROR_INFO_STRINGS = new Set<string>(CODEX_ERROR_INFO_STRING_VARIANTS)

export type CodexErrorInfo =
  | typeof CODEX_ERROR_INFO_STRING_VARIANTS[number]
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
  | {
      method: 'item/reasoning/summaryPartAdded'
      params: { threadId: string; turnId: string; itemId: string; summaryIndex: number }
    }
  | {
      method: 'item/reasoning/summaryTextDelta'
      params: { threadId: string; turnId: string; itemId: string; summaryIndex: number; delta: string }
    }
  | { method: 'turn/completed'; params: { threadId: string; turn: CodexTurn } }
  | {
      method: 'thread/tokenUsage/updated'
      params: { threadId: string; turnId: string; tokenUsage: CodexThreadTokenUsage }
    }
  | {
      method: 'error'
      params: {
        error: CodexTurnError
        threadId: string
        turnId: string
        willRetry: boolean
      }
    }
  | {
      method: 'model/rerouted'
      params: {
        threadId: string
        turnId: string
        fromModel: string
        toModel: string
        reason: 'highRiskCyberActivity'
      }
    }

export const CODEX_PROJECTED_NOTIFICATION_METHODS = [
  'error',
  'thread/started',
  'turn/started',
  'turn/completed',
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'thread/tokenUsage/updated',
] as const

export const CODEX_PASSIVE_NOTIFICATION_METHODS = [
  'warning',
  'thread/status/changed',
  'thread/settings/updated',
  'item/reasoning/textDelta',
  'account/rateLimits/updated',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'thread/compacted',
  'thread/archived',
] as const

export const CODEX_OPT_OUT_NOTIFICATION_METHODS = [
  'thread/deleted',
  'thread/unarchived',
  'thread/closed',
  'skills/changed',
  'thread/name/updated',
  'thread/goal/updated',
  'thread/goal/cleared',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'hook/started',
  'hook/completed',
  'turn/diff/updated',
  'turn/plan/updated',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'item/plan/delta',
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'account/updated',
  'app/list/updated',
  'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed',
  'fs/changed',
  'model/verification',
  'turn/moderationMetadata',
  'model/safetyBuffering/updated',
  'guardianWarning',
  'deprecationNotice',
  'configWarning',
  'fuzzyFileSearch/sessionUpdated',
  'fuzzyFileSearch/sessionCompleted',
  'thread/realtime/started',
  'thread/realtime/itemAdded',
  'thread/realtime/transcript/delta',
  'thread/realtime/transcript/done',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp',
  'thread/realtime/error',
  'thread/realtime/closed',
  'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted',
  'account/login/completed',
  'autoApprovalReview/strictReviewRequired',
  'project/changed',
  'thread/project/updated',
  'thread/queue/changed',
  'thread/reverted',
  'account/gatewayOAuth/changed',
  'mcpServer/event/stream/notification',
  'modelProvider/authRecoveryStarted',
  'modelProvider/authRecoveryCompleted',
  'thread/attachment/updated',
  'thread/realtime/item/started',
  'thread/realtime/item/completed',
  'thread/realtime/item/transcript/delta',
] as const

export interface CodexNativeRuntime {
  initialize(): Promise<{ userAgent: string }>
  serverDiagnostics(): Promise<CodexServerDiagnostics>
  threadStart(params: CodexThreadStartParams): Promise<{
    thread: CodexThread
    instructionSources: string[]
  }>
  threadRead(params: { threadId: string; includeTurns: true }): Promise<{ thread: CodexThread }>
  threadFork(params: CodexThreadForkParams, bindingId: string): Promise<CodexThreadEffectiveSettings>
  threadList(params: CodexThreadListParams): Promise<{
    data: CodexThread[]
    nextCursor: string | null
  }>
  threadResume(params: CodexThreadResumeParams): Promise<CodexThreadEffectiveSettings>
  threadArchive(params: { threadId: string }): Promise<Record<string, never>>
  turnStart(params: CodexTurnStartParams): Promise<{ turn: CodexTurn }>
  turnInterrupt(params: { threadId: string; turnId: string }): Promise<Record<string, never>>
  threadCompactStart(params: { threadId: string }): Promise<Record<string, never>>
  subscribe(listener: (notification: CodexNativeNotification) => void): () => void
  subscribeConnectionClosed?(listener: (error: Error) => void): () => void
}

export type CodexNotificationNormalizationResult =
  | { kind: 'accepted'; notification: CodexNativeNotification }
  | { kind: 'ignored'; method: string }
  | {
      kind: 'invalid'
      code: 'not_object' | 'missing_method' | 'invalid_params' | 'opted_out_method' | 'unknown_method'
    }

const PASSIVE_NOTIFICATION_METHODS = new Set<string>(CODEX_PASSIVE_NOTIFICATION_METHODS)
const OPT_OUT_NOTIFICATION_METHODS = new Set<string>(CODEX_OPT_OUT_NOTIFICATION_METHODS)

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

function normalizeDynamicToolContentItems(
  value: unknown,
): CodexDynamicToolCallItem['contentItems'] | undefined {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) return undefined
  const normalized: NonNullable<CodexDynamicToolCallItem['contentItems']> = []
  for (const entry of value) {
    if (!isRecord(entry)) return undefined
    if (entry.type === 'inputText' && typeof entry.text === 'string') {
      normalized.push({ type: 'inputText', text: entry.text })
    } else if (entry.type === 'inputImage' && typeof entry.imageUrl === 'string') {
      normalized.push({ type: 'inputImage', imageUrl: entry.imageUrl })
    } else if (entry.type === 'inputAudio' && typeof entry.audioUrl === 'string') {
      normalized.push({ type: 'inputAudio', audioUrl: entry.audioUrl })
    } else {
      return undefined
    }
  }
  return normalized
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
    const contentItems = normalizeDynamicToolContentItems(value.contentItems)
    if (
      !tool
      || !Object.prototype.hasOwnProperty.call(value, 'arguments')
      || (status !== 'inProgress' && status !== 'completed' && status !== 'failed')
      || !isNullableString(value.namespace)
      || (value.success !== undefined && value.success !== null && typeof value.success !== 'boolean')
      || contentItems === undefined
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
      contentItems,
    }
  }
  if (type === 'contextCompaction') return { type, id }
  if (type === 'userMessage') {
    if (!Array.isArray(value.content)) return null
    if (!isNullableString(value.clientId)) return null
    const content = value.content.map(normalizeCodexUserInput)
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
  if (typeof value === 'string' && CODEX_ERROR_INFO_STRINGS.has(value)) {
    return { ok: true, value: value as CodexErrorInfo }
  }
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

export function normalizeCodexTurn(value: unknown): CodexTurn | null {
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

const CODEX_THREAD_HISTORY_MODES: ReadonlySet<CodexThread['historyMode']> = new Set(['legacy', 'paginated'])

export function normalizeCodexThread(value: unknown): CodexThread | null {
  if (!isRecord(value)) return null
  const id = stringField(value, 'id')
  const sessionId = stringField(value, 'sessionId')
  const cwd = stringField(value, 'cwd')
  const source = normalizeSessionSource(value.source)
  const modelProvider = stringField(value, 'modelProvider')
  const cliVersion = stringField(value, 'cliVersion')
  const preview = stringField(value, 'preview')
  const status = normalizeThreadStatus(value.status)
  // The pinned schema defaults an absent historyMode to legacy.
  const historyMode = value.historyMode === undefined ? 'legacy' : value.historyMode
  if (!CODEX_THREAD_HISTORY_MODES.has(historyMode as CodexThread['historyMode'])) return null
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
  const turns = value.turns.map(normalizeCodexTurn)
  if (turns.some((turn) => !turn)) return null
  return {
    id,
    sessionId,
    historyMode: historyMode as CodexThread['historyMode'],
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
  if (OPT_OUT_NOTIFICATION_METHODS.has(method)) {
    return { kind: 'invalid', code: 'opted_out_method' }
  }
  if (PASSIVE_NOTIFICATION_METHODS.has(method)) return { kind: 'ignored', method }
  if (!isRecord(value.params)) return { kind: 'invalid', code: 'invalid_params' }
  const params = value.params

  if (method === 'thread/started') {
    const thread = normalizeCodexThread(params.thread)
    return thread
      ? { kind: 'accepted', notification: { method, params: { thread } } }
      : { kind: 'invalid', code: 'invalid_params' }
  }
  if (method === 'turn/started' || method === 'turn/completed') {
    const threadId = stringField(params, 'threadId')
    const turn = normalizeCodexTurn(params.turn)
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
  if (method === 'item/reasoning/summaryPartAdded') {
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const itemId = stringField(params, 'itemId')
    const summaryIndex = params.summaryIndex
    if (!threadId || !turnId || !itemId || !Number.isSafeInteger(summaryIndex)) {
      return { kind: 'invalid', code: 'invalid_params' }
    }
    return {
      kind: 'accepted',
      notification: {
        method,
        params: { threadId, turnId, itemId, summaryIndex: summaryIndex as number },
      },
    }
  }
  if (method === 'item/reasoning/summaryTextDelta') {
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const itemId = stringField(params, 'itemId')
    const summaryIndex = params.summaryIndex
    const delta = stringField(params, 'delta')
    if (
      !threadId
      || !turnId
      || !itemId
      || !Number.isSafeInteger(summaryIndex)
      || delta === null
    ) {
      return { kind: 'invalid', code: 'invalid_params' }
    }
    return {
      kind: 'accepted',
      notification: {
        method,
        params: { threadId, turnId, itemId, summaryIndex: summaryIndex as number, delta },
      },
    }
  }
  if (method === 'thread/tokenUsage/updated') {
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const tokenUsage = normalizeCodexThreadTokenUsage(params.tokenUsage)
    if (
      !hasExactKeys(params, ['threadId', 'turnId', 'tokenUsage'])
      || !threadId
      || !turnId
      || !tokenUsage
    ) return { kind: 'invalid', code: 'invalid_params' }
    return {
      kind: 'accepted',
      notification: { method, params: { threadId, turnId, tokenUsage } },
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
  if (method === 'model/rerouted') {
    const threadId = stringField(params, 'threadId')
    const turnId = stringField(params, 'turnId')
    const fromModel = stringField(params, 'fromModel')
    const toModel = stringField(params, 'toModel')
    if (
      !threadId
      || !turnId
      || !fromModel
      || !toModel
      || params.reason !== 'highRiskCyberActivity'
    ) return { kind: 'invalid', code: 'invalid_params' }
    return {
      kind: 'accepted',
      notification: {
        method,
        params: { threadId, turnId, fromModel, toModel, reason: params.reason },
      },
    }
  }
  return { kind: 'invalid', code: 'unknown_method' }
}
