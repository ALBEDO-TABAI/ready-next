import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  CHATGPT_OAUTH_BASE_URL,
  CHATGPT_OAUTH_PROFILE_ID,
} from '../../../../shared/chatgpt-oauth'
import {
  canonicalJson,
  classifyCodexModelGatewayRequest,
  digestCanonicalJson,
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
  currentTurnReadyAdditionalContext,
  latestReadyResourceReferences,
  responsesToolArgumentValidators,
  responsesToolNames,
  type CodexModelGatewayRequestEvidence,
  type CodexModelGatewayResponseEvidence,
  type CodexToolArgumentValidator,
  type CodexUpstreamProfileSnapshot,
  upstreamEndpoint,
} from './codex-model-gateway-contract'
import {
  ProviderCredentialFilter,
  responsesRequestToChat,
  streamChatAsResponses,
} from './codex-model-gateway-chat'
import {
  CodexModelGatewayRetryError,
  fetchCodexUpstreamWithRetry,
  prepareCodexUpstreamStreamForControlledRetry,
  waitForControlledGatewayRetry,
} from './codex-model-gateway-retry'
import type { CodexModelGatewayRequestKind } from './codex-model-gateway-contract'
import {
  CODEX_PROVIDER_RESPONSE_EVENT_TYPES,
  CodexProviderStreamPolicy,
  CodexProviderStreamPolicyError,
} from './codex-provider-stream-policy'
import { redactPriorReadyMemoryHistory } from './codex-memory-history-redaction'

type JsonObject = Record<string, unknown>

export type { CodexModelGatewayRequestKind } from './codex-model-gateway-contract'

export type CodexModelGatewayBinding = {
  kind: CodexModelGatewayRequestKind
  codexModel: string
  snapshot: CodexUpstreamProfileSnapshot
  snapshotDigest: string
  toolSurfaceDigest: string
  turnContractDigest: string | null
  instructionContractDigest: string
  additionalContextDigest: string | null
  forceToolFreeFinalization: boolean
  allowedToolNames: readonly string[] | null
}

export type CodexModelGatewayMetadata = {
  requestKind: string
  threadId: string
  turnId: string
  readyRunId: string | null
  toolSurfaceDigest: string | null
  turnContractDigest: string | null
  upstreamProfileSnapshotDigest: string | null
  raw: JsonObject
}

export type CodexModelGatewayToolResponseCall = Readonly<{
  codexCallId: string
  toolName: string
  argsDigest: string
}>

export type CodexModelGatewayPreparedRequestReceipt = Readonly<{
  requestDigest: string
  requestEvidence: CodexModelGatewayRequestEvidence
}>

export interface CodexModelGatewayAuthority {
  resolve(input: {
    metadata: CodexModelGatewayMetadata
    receivedAt: string
    validate(binding: CodexModelGatewayBinding): ReadonlySet<string>
    prepareRequestReceipt(): CodexModelGatewayPreparedRequestReceipt
  }): Promise<CodexModelGatewayBinding>
  admitToolResponse?(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    calls: readonly CodexModelGatewayToolResponseCall[]
    admittedAt: string
  }): Promise<void>
  recordResponseEvidence?(input: {
    metadata: CodexModelGatewayMetadata
    requestDigest: string
    responseEvidence: CodexModelGatewayResponseEvidence
    completedAt: string
  }): Promise<void>
}

export interface CodexModelGatewayCredentialStore {
  resolve(input: {
    credentialReferenceId: string
    snapshot: CodexUpstreamProfileSnapshot
  }): string | Promise<string>
}

export type CodexModelGatewayAddress = {
  url: string
  bearerToken: string
}

export type CodexModelGatewaySpawnCapability = CodexModelGatewayAddress & {
  sidecarSpawnInstanceId: string
}

export type CodexModelGatewayValidatedRequestCapture = {
  capturedAt: string
  requestKind: CodexModelGatewayRequestKind
  readyRunId: string | null
  threadId: string
  turnId: string
  requestDigest: string
  sidecarRequestDigest: string
  bodyBytes: number
  instructionDigest: string
  inputDigest: string
  sidecarInputDigest: string
  providerInputDigest: string
  memoryHistoryRedactionDigest: string
  memoryHistoryRedactedItemCount: number
  toolsDigest: string
  toolNames: string[]
  toolCount: number
  readyResourceReferenceCount: number
  proofSentinelDigest: string | null
  proofSentinelOccurrences: number
  proofSentinels: Array<{
    digest: string
    occurrences: number
  }>
  inputItems: Array<{
    index: number
    type: string | null
    role: string | null
    id: string | null
    stringCount: number
    totalStringCharacters: number
    maxStringCharacters: number
    digest: string
  }>
}

type CodexModelGatewayOriginalRequestCapture = Omit<
  CodexModelGatewayValidatedRequestCapture,
  | 'sidecarRequestDigest'
  | 'sidecarInputDigest'
  | 'providerInputDigest'
  | 'memoryHistoryRedactionDigest'
  | 'memoryHistoryRedactedItemCount'
>

type ActiveGatewayCapability = {
  bearerToken: string
  sidecarSpawnInstanceId: string
}

export class CodexModelGatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly responseHeaders: Readonly<Record<string, string>> = {},
    readonly responseError: Readonly<{ code: string; message: string; type: string }> = {
      code,
      message: code,
      type: 'gateway_error',
    },
  ) {
    super(code)
    this.name = 'CodexModelGatewayError'
  }
}

export function isCodexUpstreamEventStream(
  response: Pick<Response, 'headers'>,
  snapshot: Pick<CodexUpstreamProfileSnapshot, 'profileId' | 'baseUrl' | 'wireApi'>,
): boolean {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/event-stream')) return true
  return isChatGptOAuthResponsesSnapshot(snapshot)
    && contentType.includes('application/json')
}

function isChatGptOAuthResponsesSnapshot(
  snapshot: Pick<CodexUpstreamProfileSnapshot, 'profileId' | 'baseUrl' | 'wireApi'>,
): boolean {
  return snapshot.profileId === CHATGPT_OAUTH_PROFILE_ID
    && snapshot.baseUrl === CHATGPT_OAUTH_BASE_URL
    && snapshot.wireApi === 'responses'
}

const EXACT_REQUEST_KEYS = [
  'client_metadata',
  'include',
  'input',
  'instructions',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'reasoning',
  'store',
  'stream',
  'tool_choice',
  'tools',
]

const ALLOWED_NATIVE_EVENTS = new Set(CODEX_PROVIDER_RESPONSE_EVENT_TYPES)

const ALLOWED_ITEM_TYPES = new Set(['message', 'function_call', 'reasoning'])
const ALLOWED_MESSAGE_CONTENT_TYPES = new Set(['output_text', 'refusal'])

const NATIVE_EVENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'response.created': ['type', 'sequence_number', 'response'],
  'response.in_progress': ['type', 'sequence_number', 'response'],
  'response.completed': ['type', 'sequence_number', 'response'],
  'response.incomplete': ['type', 'sequence_number', 'response'],
  'response.failed': ['type', 'sequence_number', 'response'],
  'response.output_item.added': ['type', 'sequence_number', 'output_index', 'item'],
  'response.output_item.done': ['type', 'sequence_number', 'output_index', 'item'],
  'response.content_part.added': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'part',
  ],
  'response.content_part.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'part',
  ],
  'response.output_text.delta': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'delta',
  ],
  'response.output_text.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'text',
  ],
  'response.refusal.delta': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'delta',
  ],
  'response.refusal.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'refusal',
  ],
  'response.function_call_arguments.delta': [
    'type', 'sequence_number', 'item_id', 'output_index', 'delta',
  ],
  'response.function_call_arguments.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'arguments',
  ],
  'response.reasoning_summary_part.added': [
    'type', 'sequence_number', 'item_id', 'output_index', 'summary_index', 'part',
  ],
  'response.reasoning_summary_part.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'summary_index', 'part',
  ],
  'response.reasoning_summary_text.delta': [
    'type', 'sequence_number', 'item_id', 'output_index', 'summary_index', 'delta',
  ],
  'response.reasoning_summary_text.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'summary_index', 'text',
  ],
  error: ['type', 'code', 'message', 'param', 'sequence_number'],
}

type NativeItemState = {
  id: string
  type: string
  name: string | null
  callId: string | null
  identityDigest: string
  arguments: string
  argumentsDone: boolean
  messageParts: Map<number, {
    type: string; text: string; textDone: boolean; partDone: boolean; explicitPart: boolean
  }>
  reasoningParts: Map<number, {
    text: string; textDone: boolean; partDone: boolean; explicitPart: boolean
  }>
  doneItemDigest: string | null
  doneItem: JsonObject | null
  doneStatus: 'completed' | 'incomplete' | null
  done: boolean
}

type NativeResponseState = {
  responseId: string | null
  inProgressSeen: boolean
  terminal: boolean
  items: Map<number, NativeItemState>
  itemIds: Set<string>
  callIds: Set<string>
}

const DEFAULT_NATIVE_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_NATIVE_MAX_EVENTS = 4_096
const DEFAULT_NATIVE_MAX_ITEM_BYTES = 4 * 1024 * 1024
const DEFAULT_BODY_DEADLINE_MS = 10_000
const DEFAULT_HEADERS_DEADLINE_MS = 120_000
const DEFAULT_FIRST_BYTE_DEADLINE_MS = 120_000
const DEFAULT_EVENT_IDLE_MS = 120_000
const DEFAULT_POST_TERMINAL_DRAIN_MS = 1_000

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new CodexModelGatewayError(code)
  return value
}

function safeTokenEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received)
  const expectedBuffer = Buffer.from(expected)
  return receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer)
}

function parseAuthorization(request: IncomingMessage, expected: string): void {
  const authorization = request.headers.authorization || ''
  const prefix = 'Bearer '
  if (!authorization.startsWith(prefix) || !safeTokenEqual(authorization.slice(prefix.length), expected)) {
    throw new CodexModelGatewayError('gateway_bearer_invalid', 401)
  }
}

function parseMetadata(body: JsonObject): CodexModelGatewayMetadata {
  if (!isRecord(body.client_metadata)) throw new CodexModelGatewayError('gateway_client_metadata_invalid')
  const outerKeys = [
    'x-codex-installation-id',
    'session_id',
    'x-codex-window-id',
    'turn_id',
    'thread_id',
    'x-codex-turn-metadata',
  ]
  const actualOuterKeys = Object.keys(body.client_metadata).sort()
  const hasRootTurnId = actualOuterKeys.includes('root_turn_id')
  if (
    JSON.stringify(actualOuterKeys)
    !== JSON.stringify([...outerKeys, ...(hasRootTurnId ? ['root_turn_id'] : [])].sort())
  ) throw new CodexModelGatewayError('gateway_client_metadata_shape_invalid')
  const rawMetadata = body.client_metadata['x-codex-turn-metadata']
  if (typeof rawMetadata !== 'string') throw new CodexModelGatewayError('gateway_turn_metadata_missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMetadata)
  } catch {
    throw new CodexModelGatewayError('gateway_turn_metadata_invalid')
  }
  if (!isRecord(parsed)) throw new CodexModelGatewayError('gateway_turn_metadata_invalid')
  const baseInnerKeys = [
    'installation_id',
    'session_id',
    'thread_id',
    'turn_id',
    'window_id',
    'request_kind',
    'agent_name',
    'auto_review_enabled',
    'node_repl_auto_review_required',
    'node_repl_disabled',
    'sandbox',
    'sandbox_mode',
    'turn_started_at_unix_ms',
  ]
  let metadataKind: CodexModelGatewayRequestKind
  try {
    metadataKind = classifyCodexModelGatewayRequest(parsed)
  } catch {
    throw new CodexModelGatewayError('gateway_turn_metadata_shape_invalid')
  }
  const readyKeys = [
    'readyRunId',
    'toolSurfaceDigest',
    'turnContractDigest',
    'upstreamProfileSnapshotDigest',
  ]
  const expectedInnerKeys = metadataKind === 'product'
    ? [
        ...baseInnerKeys,
        ...(hasRootTurnId ? ['root_turn_id'] : []),
        ...readyKeys,
      ]
    : metadataKind === 'automatic_compaction'
      ? [...baseInnerKeys, 'root_turn_id', 'compaction', ...readyKeys]
      : [...baseInnerKeys, 'compaction']
  if (
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedInnerKeys.sort())
  ) throw new CodexModelGatewayError('gateway_turn_metadata_shape_invalid')
  const outer = body.client_metadata
  if (
    nonEmptyString(outer['x-codex-installation-id'], 'gateway_installation_id_missing')
      !== nonEmptyString(parsed.installation_id, 'gateway_installation_id_missing')
    || nonEmptyString(outer.session_id, 'gateway_session_id_missing')
      !== nonEmptyString(parsed.session_id, 'gateway_session_id_missing')
    || nonEmptyString(outer.thread_id, 'gateway_thread_id_missing')
      !== nonEmptyString(parsed.thread_id, 'gateway_thread_id_missing')
    || nonEmptyString(outer.turn_id, 'gateway_turn_id_missing')
      !== nonEmptyString(parsed.turn_id, 'gateway_turn_id_missing')
    || nonEmptyString(outer['x-codex-window-id'], 'gateway_window_id_missing')
      !== nonEmptyString(parsed.window_id, 'gateway_window_id_missing')
  ) throw new CodexModelGatewayError('gateway_metadata_identity_mismatch')
  if (hasRootTurnId && (
    nonEmptyString(outer.root_turn_id, 'gateway_root_turn_id_missing')
      !== nonEmptyString(parsed.root_turn_id, 'gateway_root_turn_id_missing')
    || parsed.root_turn_id !== parsed.turn_id
  )) throw new CodexModelGatewayError('gateway_root_turn_identity_mismatch')
  if (parsed.session_id !== parsed.thread_id) {
    throw new CodexModelGatewayError('gateway_root_session_thread_mismatch')
  }
  const windowPrefix = `${String(parsed.thread_id)}:`
  const windowId = String(parsed.window_id)
  const windowIndex = windowId.startsWith(windowPrefix) ? windowId.slice(windowPrefix.length) : ''
  if (!/^(?:0|[1-9]\d*)$/.test(windowIndex)) {
    throw new CodexModelGatewayError('gateway_root_window_thread_mismatch')
  }
  if (body.prompt_cache_key !== parsed.thread_id) {
    throw new CodexModelGatewayError('gateway_root_prompt_cache_thread_mismatch')
  }
  if (
    parsed.sandbox !== 'seatbelt'
    || parsed.sandbox_mode !== 'read-only'
    || parsed.agent_name !== '/root'
    || parsed.auto_review_enabled !== false
    || parsed.node_repl_auto_review_required !== false
    || parsed.node_repl_disabled !== false
    || !Number.isSafeInteger(parsed.turn_started_at_unix_ms)
    || Number(parsed.turn_started_at_unix_ms) < 0
  ) throw new CodexModelGatewayError('gateway_turn_metadata_value_invalid')
  return {
    requestKind: nonEmptyString(parsed.request_kind, 'gateway_request_kind_missing'),
    threadId: nonEmptyString(parsed.thread_id, 'gateway_thread_id_missing'),
    turnId: nonEmptyString(parsed.turn_id, 'gateway_turn_id_missing'),
    readyRunId: typeof parsed.readyRunId === 'string' && parsed.readyRunId ? parsed.readyRunId : null,
    toolSurfaceDigest: typeof parsed.toolSurfaceDigest === 'string' && parsed.toolSurfaceDigest
      ? parsed.toolSurfaceDigest : null,
    turnContractDigest: typeof parsed.turnContractDigest === 'string' && parsed.turnContractDigest
      ? parsed.turnContractDigest : null,
    upstreamProfileSnapshotDigest:
      typeof parsed.upstreamProfileSnapshotDigest === 'string' && parsed.upstreamProfileSnapshotDigest
        ? parsed.upstreamProfileSnapshotDigest : null,
    raw: parsed,
  }
}

function validateRequestShape(body: JsonObject): ReadonlyMap<string, CodexToolArgumentValidator> {
  const keys = Object.keys(body).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...EXACT_REQUEST_KEYS].sort())) {
    throw new CodexModelGatewayError('gateway_request_shape_invalid')
  }
  if (body.stream !== true || body.store !== false) {
    throw new CodexModelGatewayError('gateway_request_stream_contract_invalid')
  }
  if (typeof body.instructions !== 'string' || !Array.isArray(body.input)) {
    throw new CodexModelGatewayError('gateway_request_transcript_invalid')
  }
  let toolNames: Set<string>
  let toolArgumentValidators: ReadonlyMap<string, CodexToolArgumentValidator>
  try {
    toolNames = new Set(responsesToolNames(body.tools))
    toolArgumentValidators = responsesToolArgumentValidators(body.tools)
  } catch {
    throw new CodexModelGatewayError('gateway_tool_schema_invalid')
  }
  if (typeof body.parallel_tool_calls !== 'boolean') {
    throw new CodexModelGatewayError('gateway_parallel_tool_calls_invalid')
  }
  if (typeof body.tool_choice === 'string') {
    if (!['auto', 'none', 'required'].includes(body.tool_choice)) {
      throw new CodexModelGatewayError('gateway_tool_choice_invalid')
    }
  } else if (
    !isRecord(body.tool_choice)
    || body.tool_choice.type !== 'function'
    || typeof body.tool_choice.name !== 'string'
    || !toolNames.has(body.tool_choice.name)
    || Object.keys(body.tool_choice).some((key) => key !== 'type' && key !== 'name')
  ) {
    throw new CodexModelGatewayError('gateway_tool_choice_invalid')
  }
  if (
    !isRecord(body.reasoning)
    || body.reasoning.summary !== 'auto'
    || Object.keys(body.reasoning).some((key) => key !== 'summary' && key !== 'effort')
    || (body.reasoning.effort !== undefined && typeof body.reasoning.effort !== 'string')
  ) throw new CodexModelGatewayError('gateway_reasoning_shape_invalid')
  if (
    !Array.isArray(body.include)
    || body.include.length !== 1
    || body.include[0] !== 'reasoning.encrypted_content'
  ) throw new CodexModelGatewayError('gateway_include_shape_invalid')
  return toolArgumentValidators
}

function inputMediaKinds(input: unknown): { image: boolean; audio: boolean } {
  const kinds = { image: false, audio: false }
  if (!Array.isArray(input)) return kinds
  const scanParts = (parts: unknown): void => {
    if (!Array.isArray(parts)) return
    for (const part of parts) {
      if (!isRecord(part)) continue
      if (part.type === 'input_image') kinds.image = true
      if (part.type === 'input_audio') kinds.audio = true
    }
  }
  for (const item of input) {
    if (!isRecord(item)) continue
    if (item.type === 'message') scanParts(item.content)
    if (item.type === 'function_call_output') scanParts(item.output)
  }
  return kinds
}

function validateSnapshotCapabilities(
  body: JsonObject,
  binding: CodexModelGatewayBinding,
  allowedTools: ReadonlySet<string>,
): void {
  if (
    allowedTools.size > 0
    && (!binding.snapshot.supportsToolCalls || !binding.snapshot.supportsNativeToolCalls)
  ) throw new CodexModelGatewayError('gateway_tool_capability_unsupported', 409)
  const media = inputMediaKinds(body.input)
  if (media.image && !binding.snapshot.supportsVision) {
    throw new CodexModelGatewayError('gateway_vision_capability_unsupported', 409)
  }
  if (media.audio) throw new CodexModelGatewayError('gateway_audio_capability_unsupported', 409)
  const reasoning = body.reasoning as JsonObject
  const requestedEffort = typeof reasoning.effort === 'string' ? reasoning.effort : null
  if (requestedEffort !== binding.snapshot.reasoningEffort) {
    throw new CodexModelGatewayError('gateway_reasoning_effort_mismatch', 409)
  }
  if (requestedEffort && !binding.snapshot.supportsThinking) {
    throw new CodexModelGatewayError('gateway_reasoning_capability_unsupported', 409)
  }
  if (
    binding.snapshot.supportsThinking
    && (
      (binding.snapshot.wireApi === 'chat/completions'
        && binding.snapshot.multiTurnThinkingPolicy !== 'proven_safe')
      || (binding.snapshot.wireApi === 'responses'
        && !['proven_safe', 'echo_required'].includes(binding.snapshot.multiTurnThinkingPolicy))
    )
  ) throw new CodexModelGatewayError('gateway_reasoning_policy_unsupported', 409)
}

function expectedKind(metadata: CodexModelGatewayMetadata): CodexModelGatewayRequestKind {
  try {
    return classifyCodexModelGatewayRequest(metadata.raw)
  } catch {
    throw new CodexModelGatewayError('gateway_request_unclassified', 409)
  }
}

function validateBinding(input: {
  body: JsonObject
  metadata: CodexModelGatewayMetadata
  binding: CodexModelGatewayBinding
}): ReadonlySet<string> {
  const { body, metadata, binding } = input
  if (expectedKind(metadata) !== binding.kind) {
    throw new CodexModelGatewayError('gateway_binding_kind_mismatch', 409)
  }
  if (body.model !== binding.codexModel) {
    throw new CodexModelGatewayError('gateway_codex_model_mismatch', 409)
  }
  if (digestCanonicalJson(binding.snapshot) !== binding.snapshotDigest) {
    throw new CodexModelGatewayError('gateway_snapshot_digest_mismatch', 409)
  }
  let currentInstructionDigest: string
  try {
    currentInstructionDigest = instructionTranscriptDigest(body.instructions, body.input)
  } catch {
    throw new CodexModelGatewayError('gateway_instruction_transcript_invalid', 409)
  }
  if (currentInstructionDigest !== binding.instructionContractDigest) {
    throw new CodexModelGatewayError('gateway_instruction_digest_mismatch', 409)
  }
  const tools = body.tools as unknown[]
  const toolNames = responsesToolNames(tools)
  if (digestCanonicalJson(tools) !== binding.toolSurfaceDigest) {
    throw new CodexModelGatewayError('gateway_tool_surface_mismatch', 409)
  }
  if (binding.kind === 'product') {
    if (
      metadata.toolSurfaceDigest !== binding.toolSurfaceDigest
      || metadata.turnContractDigest !== binding.turnContractDigest
      || metadata.upstreamProfileSnapshotDigest !== binding.snapshotDigest
      || !metadata.readyRunId
    ) throw new CodexModelGatewayError('gateway_product_metadata_mismatch', 409)
    if (
      binding.additionalContextDigest === null
      || digestReadyAdditionalContext(currentTurnReadyAdditionalContext(body.input)) !== binding.additionalContextDigest
    ) throw new CodexModelGatewayError('gateway_additional_context_mismatch', 409)
  } else if (
    tools.length !== 0
    || binding.toolSurfaceDigest !== digestCanonicalJson([])
    || binding.allowedToolNames !== null
  ) {
    throw new CodexModelGatewayError('gateway_compaction_tool_surface_not_empty', 409)
  }
  const rootToolNames = new Set(toolNames)
  const allowedToolNames = binding.allowedToolNames
  if (
    binding.kind === 'product'
    && (
      !Array.isArray(allowedToolNames)
      || allowedToolNames.some((name) => typeof name !== 'string' || !name)
      || canonicalJson(allowedToolNames) !== canonicalJson([...new Set(allowedToolNames)].sort())
      || allowedToolNames.some((name) => !rootToolNames.has(name))
    )
  ) throw new CodexModelGatewayError('gateway_tool_authorization_invalid', 409)
  const allowedTools = new Set(binding.kind === 'product' ? allowedToolNames || [] : [])
  if (
    isRecord(body.tool_choice)
    && typeof body.tool_choice.name === 'string'
    && !allowedTools.has(body.tool_choice.name)
  ) throw new CodexModelGatewayError('gateway_tool_choice_not_authorized', 409)
  validateSnapshotCapabilities(body, binding, allowedTools)
  return allowedTools
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let offset = 0
  while (true) {
    const found = value.indexOf(needle, offset)
    if (found < 0) return count
    count += 1
    offset = found + needle.length
  }
}

function collectStringLengths(value: unknown, target: number[]): void {
  if (typeof value === 'string') {
    target.push(value.length)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStringLengths(child, target)
    return
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) collectStringLengths(child, target)
  }
}

function buildValidatedRequestCapture(input: {
  body: JsonObject
  metadata: CodexModelGatewayMetadata
  requestDigest: string
  proofSentinel?: string
  proofSentinels?: readonly string[]
}): CodexModelGatewayOriginalRequestCapture {
  const requestKind = expectedKind(input.metadata)
  const proofSentinels = Array.from(new Set([
    ...(input.proofSentinels || []),
    input.proofSentinel || '',
  ].filter((value) => value.length > 0)))
  const proofSentinel = proofSentinels[0] || ''
  const bodyText = JSON.stringify(input.body)
  const inputItems = (input.body.input as unknown[]).map((item, index) => {
    const lengths: number[] = []
    collectStringLengths(item, lengths)
    return {
      index,
      type: isRecord(item) && typeof item.type === 'string' ? item.type : null,
      role: isRecord(item) && typeof item.role === 'string' ? item.role : null,
      id: isRecord(item) && typeof item.id === 'string' ? item.id : null,
      stringCount: lengths.length,
      totalStringCharacters: lengths.reduce((total, length) => total + length, 0),
      maxStringCharacters: lengths.length > 0 ? Math.max(...lengths) : 0,
      digest: digestCanonicalJson(item),
    }
  })
  return {
    capturedAt: new Date().toISOString(),
    requestKind,
    readyRunId: input.metadata.readyRunId,
    threadId: input.metadata.threadId,
    turnId: input.metadata.turnId,
    requestDigest: input.requestDigest,
    bodyBytes: Buffer.byteLength(bodyText),
    instructionDigest: digestCanonicalJson(input.body.instructions),
    inputDigest: digestCanonicalJson(input.body.input),
    toolsDigest: digestCanonicalJson(input.body.tools),
    toolNames: responsesToolNames(input.body.tools),
    toolCount: (input.body.tools as unknown[]).length,
    readyResourceReferenceCount: latestReadyResourceReferences(input.body.input).length,
    proofSentinelDigest: proofSentinel ? digestCanonicalJson(proofSentinel) : null,
    proofSentinelOccurrences: countOccurrences(bodyText, proofSentinel),
    proofSentinels: proofSentinels.map((sentinel) => ({
      digest: digestCanonicalJson(sentinel),
      occurrences: countOccurrences(bodyText, sentinel),
    })),
    inputItems,
  }
}

function durableRequestEvidence(
  capture: CodexModelGatewayOriginalRequestCapture,
  redaction: ReturnType<typeof redactPriorReadyMemoryHistory>['evidence'],
): CodexModelGatewayRequestEvidence {
  const lengths = capture.inputItems.flatMap((item) => (
    item.stringCount > 0 ? [item.totalStringCharacters, item.maxStringCharacters] : []
  ))
  return {
    instructionDigest: capture.instructionDigest,
    inputDigest: capture.inputDigest,
    inputItems: capture.inputItems.map((item) => ({
      digest: item.digest,
      totalStringCharacters: item.totalStringCharacters,
      maxStringCharacters: item.maxStringCharacters,
    })),
    inputTotalStringCharacters: capture.inputItems.reduce(
      (total, item) => total + item.totalStringCharacters,
      0,
    ),
    inputMaxStringCharacters: lengths.length > 0 ? Math.max(...lengths) : 0,
    toolsDigest: capture.toolsDigest,
    toolCount: capture.toolCount,
    bodyBytes: capture.bodyBytes,
    memoryHistoryRedactionDigest: redaction.redactionDigest,
    memoryHistoryRedactedItemCount: redaction.redactedItemCount,
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<JsonObject> {
  const chunks: Buffer[] = []
  let size = 0
  let timedOut = false
  const onAbort = () => {
    if (!request.complete) request.destroy(new Error('gateway_request_aborted'))
  }
  const timeout = setTimeout(() => {
    timedOut = true
    if (!request.complete) request.destroy(new Error('gateway_body_deadline'))
  }, deadlineMs)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
      const buffer = Buffer.from(chunk)
      size += buffer.length
      if (size > maxBodyBytes) throw new CodexModelGatewayError('gateway_body_too_large', 413)
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof CodexModelGatewayError) throw error
    if (signal.aborted) throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
    if (timedOut) throw new CodexModelGatewayError('gateway_body_deadline', 408)
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
  let parsed: unknown
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    parsed = JSON.parse(decoded)
  } catch (error) {
    if (error instanceof TypeError) throw new CodexModelGatewayError('gateway_body_utf8_invalid')
    throw new CodexModelGatewayError('gateway_body_json_invalid')
  }
  if (!isRecord(parsed)) throw new CodexModelGatewayError('gateway_body_invalid')
  return parsed
}

async function readBoundedResponseText(input: {
  response: Response
  signal: AbortSignal
  deadlineMs: number
  maxBytes?: number
}): Promise<string> {
  const { response, signal, deadlineMs, maxBytes = 16_384 } = input
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timeout: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null
  let aborted = false
  let deadlineExpired = false
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      aborted = true
      reject(new CodexModelGatewayError('gateway_request_aborted', 499))
      void reader.cancel().catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      deadlineExpired = true
      reject(new CodexModelGatewayError('gateway_upstream_error_body_deadline', 502))
      void reader.cancel().catch(() => undefined)
    }, deadlineMs)
  })
  try {
    if (signal.aborted) throw new CodexModelGatewayError('gateway_request_aborted', 499)
    while (true) {
      const next = await Promise.race([reader.read(), interrupted])
      if (deadlineExpired) {
        throw new CodexModelGatewayError('gateway_upstream_error_body_deadline', 502)
      }
      if (aborted) throw new CodexModelGatewayError('gateway_request_aborted', 499)
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return ''
      }
      chunks.push(next.value)
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
  const combined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

function sanitizedProviderError(text: string, credential: string): {
  code: string
  message: string
  type: string
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const source = isRecord(parsed.error) ? parsed.error : parsed
  const sanitize = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value) return null
    const withoutCredential = credential ? value.split(credential).join('[REDACTED]') : value
    return withoutCredential
      .replace(/Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi, 'Bearer [REDACTED]')
      .slice(0, 512)
  }
  const code = sanitize(source.code)
  const type = sanitize(source.type)
  const message = sanitize(source.message)
  if (!code && !type && !message) return null
  return {
    code: code || 'gateway_upstream_error',
    type: type || 'upstream_error',
    message: message || code || type || 'gateway_upstream_error',
  }
}

function parseSse(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks: string[] = []
  let start = 0
  while (true) {
    const boundary = normalized.indexOf('\n\n', start)
    if (boundary < 0) break
    blocks.push(normalized.slice(start, boundary))
    start = boundary + 2
  }
  return { blocks, rest: normalized.slice(start) }
}

function nativeEventFromBlock(block: string): { raw: string; payload: JsonObject } | null {
  const lines = block.split('\n')
  const eventName = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
  const data = lines.filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart()).join('\n')
  if (!data || data === '[DONE]') return null
  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new CodexModelGatewayError('gateway_native_sse_json_invalid', 502)
  }
  if (!isRecord(payload) || typeof payload.type !== 'string' || (eventName && eventName !== payload.type)) {
    throw new CodexModelGatewayError('gateway_native_sse_event_invalid', 502)
  }
  return { raw: `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`, payload }
}

function assertExactKeys(value: JsonObject, allowed: readonly string[], code: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new CodexModelGatewayError(code, 502)
  }
}

function selectKeys(value: JsonObject, allowed: readonly string[]): JsonObject {
  return Object.fromEntries(allowed.flatMap((key) => (
    Object.prototype.hasOwnProperty.call(value, key) ? [[key, value[key]]] : []
  )))
}

function normalizeChatGptOAuthPart(value: unknown): unknown {
  if (!isRecord(value)) return value
  return selectKeys(value, value.type === 'refusal' ? ['type', 'refusal'] : ['type', 'text'])
}

function normalizeChatGptOAuthItem(value: unknown): unknown {
  if (!isRecord(value)) return value
  const allowed = value.type === 'message'
    ? ['type', 'id', 'role', 'phase', 'status', 'content']
    : value.type === 'function_call'
      ? ['type', 'id', 'call_id', 'name', 'arguments', 'status']
      : ['type', 'id', 'summary', 'content', 'encrypted_content', 'status']
  const item = selectKeys(value, allowed)
  if (Array.isArray(item.content)) item.content = item.content.map(normalizeChatGptOAuthPart)
  if (Array.isArray(item.summary)) item.summary = item.summary.map(normalizeChatGptOAuthPart)
  return item
}

function normalizeChatGptOAuthResponse(value: unknown): unknown {
  if (!isRecord(value)) return value
  const response = selectKeys(
    value,
    ['id', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details'],
  )
  if (Array.isArray(response.output)) response.output = response.output.map(normalizeChatGptOAuthItem)
  if (isRecord(response.usage)) {
    const usage = selectKeys(response.usage, [
      'input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details',
    ])
    if (isRecord(usage.input_tokens_details)) {
      usage.input_tokens_details = selectKeys(usage.input_tokens_details, ['cached_tokens'])
    }
    if (isRecord(usage.output_tokens_details)) {
      usage.output_tokens_details = selectKeys(usage.output_tokens_details, ['reasoning_tokens'])
    }
    response.usage = usage
  }
  return response
}

export function normalizeChatGptOAuthResponseEvent(
  payload: JsonObject,
  completedItems: readonly JsonObject[] = [],
): JsonObject {
  const allowed = NATIVE_EVENT_KEYS[String(payload.type)]
  if (!allowed) return payload
  const normalized = selectKeys(payload, allowed)
  if (isRecord(normalized.response)) {
    normalized.response = normalizeChatGptOAuthResponse(normalized.response)
    if (
      String(payload.type).match(/^response\.(?:completed|incomplete|failed)$/)
      && isRecord(normalized.response)
      && Array.isArray(normalized.response.output)
      && normalized.response.output.length === 0
      && completedItems.length > 0
    ) normalized.response.output = completedItems
  }
  if (isRecord(normalized.item)) normalized.item = normalizeChatGptOAuthItem(normalized.item)
  if (isRecord(normalized.part)) normalized.part = normalizeChatGptOAuthPart(normalized.part)
  return normalized
}

function validateNativeEventKeys(payload: JsonObject): void {
  const eventType = String(payload.type)
  const allowed = NATIVE_EVENT_KEYS[eventType]
  if (!allowed) throw new CodexModelGatewayError('gateway_response_event_not_allowed', 502)
  assertExactKeys(payload, allowed, 'gateway_response_event_shape_invalid')
  if (
    payload.sequence_number !== undefined
    && (!Number.isSafeInteger(payload.sequence_number) || Number(payload.sequence_number) < 0)
  ) throw new CodexModelGatewayError('gateway_response_sequence_invalid', 502)
  if (isRecord(payload.response)) {
    assertExactKeys(
      payload.response,
      ['id', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details'],
      'gateway_response_shape_invalid',
    )
  }
  if (isRecord(payload.part)) {
    const partType = String(payload.part.type)
    assertExactKeys(
      payload.part,
      partType === 'refusal' ? ['type', 'refusal'] : ['type', 'text'],
      'gateway_response_part_shape_invalid',
    )
  }
}

function validateNativeItem(item: JsonObject, allowedTools: ReadonlySet<string>): void {
  if (typeof item.type !== 'string' || !ALLOWED_ITEM_TYPES.has(item.type)) {
    throw new CodexModelGatewayError('gateway_response_item_not_allowed', 502)
  }
  const allowedKeys = item.type === 'message'
    ? ['type', 'id', 'role', 'phase', 'status', 'content']
    : item.type === 'function_call'
      ? ['type', 'id', 'call_id', 'name', 'arguments', 'status']
      : ['type', 'id', 'summary', 'content', 'encrypted_content', 'status']
  assertExactKeys(item, allowedKeys, 'gateway_response_item_shape_invalid')
  if (
    item.status !== undefined
    && item.status !== 'in_progress'
    && item.status !== 'completed'
    && item.status !== 'incomplete'
  ) throw new CodexModelGatewayError('gateway_response_item_status_invalid', 502)
  if (item.type === 'message') {
    if (item.role !== 'assistant') {
      throw new CodexModelGatewayError('gateway_response_message_role_invalid', 502)
    }
    if (
      item.phase !== undefined
      && item.phase !== null
      && item.phase !== 'commentary'
      && item.phase !== 'final_answer'
    ) throw new CodexModelGatewayError('gateway_response_message_phase_invalid', 502)
  }
  nonEmptyString(item.id, 'gateway_response_item_id_missing')
  if (item.type === 'function_call') {
    const name = nonEmptyString(item.name, 'gateway_response_tool_name_missing')
    nonEmptyString(item.call_id, 'gateway_response_tool_call_id_missing')
    if (typeof item.arguments !== 'string') {
      throw new CodexModelGatewayError('gateway_response_tool_arguments_invalid', 502)
    }
    if (!allowedTools.has(name)) {
      throw new CodexModelGatewayError('gateway_response_tool_not_authorized', 502)
    }
  }
  if (item.type === 'message' && item.content !== undefined) {
    if (!Array.isArray(item.content)) {
      throw new CodexModelGatewayError('gateway_response_message_content_invalid', 502)
    }
    for (const part of item.content) {
      if (!isRecord(part) || !ALLOWED_MESSAGE_CONTENT_TYPES.has(String(part.type))) {
        throw new CodexModelGatewayError('gateway_response_content_part_not_allowed', 502)
      }
      assertExactKeys(
        part,
        part.type === 'refusal' ? ['type', 'refusal'] : ['type', 'text'],
        'gateway_response_content_part_shape_invalid',
      )
      nativeMessagePartValue(part)
    }
  }
  if (item.type === 'reasoning' && item.summary !== undefined) {
    if (
      !Array.isArray(item.summary)
      || item.summary.some((part) => (
        !isRecord(part)
        || part.type !== 'summary_text'
        || typeof part.text !== 'string'
        || Object.keys(part).some((key) => key !== 'type' && key !== 'text')
      ))
    ) throw new CodexModelGatewayError('gateway_response_reasoning_summary_invalid', 502)
  }
  if (item.type === 'reasoning') {
    if (
      item.encrypted_content !== undefined
      && item.encrypted_content !== null
      && typeof item.encrypted_content !== 'string'
    ) throw new CodexModelGatewayError('gateway_response_reasoning_encrypted_content_invalid', 502)
    if (item.content !== undefined && item.content !== null) {
      if (
        !Array.isArray(item.content)
        || item.content.some((part) => (
          !isRecord(part)
          || !['reasoning_text', 'text'].includes(String(part.type))
          || typeof part.text !== 'string'
          || Object.keys(part).some((key) => key !== 'type' && key !== 'text')
        ))
      ) throw new CodexModelGatewayError('gateway_response_reasoning_content_invalid', 502)
    }
  }
}

function nativeMessagePartValue(part: JsonObject): string {
  const value = part.type === 'refusal' ? part.refusal : part.text
  if (typeof value !== 'string') {
    throw new CodexModelGatewayError('gateway_response_content_text_invalid', 502)
  }
  return value
}

function nativeItemIdentityDigest(item: JsonObject): string {
  const identity = Object.fromEntries(Object.entries(item).filter(([key]) => (
    key !== 'arguments'
    && key !== 'content'
    && key !== 'encrypted_content'
    && key !== 'summary'
    && key !== 'status'
  )))
  return digestCanonicalJson(identity)
}

function nativeItemState(item: JsonObject): NativeItemState {
  const messageParts = new Map<number, {
    type: string; text: string; textDone: boolean; partDone: boolean; explicitPart: boolean
  }>()
  if (item.type === 'message' && Array.isArray(item.content)) {
    item.content.forEach((part, index) => {
      if (isRecord(part)) {
        messageParts.set(index, {
          type: nonEmptyString(part.type, 'gateway_response_content_part_not_allowed'),
          text: nativeMessagePartValue(part),
          textDone: false,
          partDone: false,
          explicitPart: false,
        })
      }
    })
  }
  const reasoningParts = new Map<number, {
    text: string; textDone: boolean; partDone: boolean; explicitPart: boolean
  }>()
  if (item.type === 'reasoning' && Array.isArray(item.summary)) {
    item.summary.forEach((part, index) => {
      if (isRecord(part)) reasoningParts.set(index, {
        text: String(part.text), textDone: false, partDone: false, explicitPart: false,
      })
    })
  }
  return {
    id: nonEmptyString(item.id, 'gateway_response_item_id_missing'),
    type: nonEmptyString(item.type, 'gateway_response_item_type_missing'),
    name: item.type === 'function_call'
      ? nonEmptyString(item.name, 'gateway_response_tool_name_missing')
      : null,
    callId: item.type === 'function_call'
      ? nonEmptyString(item.call_id, 'gateway_response_tool_call_id_missing')
      : null,
    identityDigest: nativeItemIdentityDigest(item),
    arguments: item.type === 'function_call' && typeof item.arguments === 'string' ? item.arguments : '',
    argumentsDone: false,
    messageParts,
    reasoningParts,
    doneItemDigest: null,
    doneItem: null,
    doneStatus: null,
    done: false,
  }
}

function assertNativeItemMatches(
  expected: NativeItemState,
  item: JsonObject,
  requireArgumentsMatch: boolean,
): void {
  const actual = nativeItemState(item)
  if (
    actual.id !== expected.id
    || actual.type !== expected.type
    || actual.name !== expected.name
    || actual.callId !== expected.callId
    || actual.identityDigest !== expected.identityDigest
    || (requireArgumentsMatch && actual.arguments !== expected.arguments)
  ) throw new CodexModelGatewayError('gateway_response_item_identity_changed', 502)
}

function nativeOutputIndex(payload: JsonObject): number {
  if (!Number.isSafeInteger(payload.output_index) || Number(payload.output_index) < 0) {
    throw new CodexModelGatewayError('gateway_response_output_index_invalid', 502)
  }
  return Number(payload.output_index)
}

function nativePartIndex(payload: JsonObject, field: 'content_index' | 'summary_index'): number {
  const value = payload[field] === undefined && field === 'summary_index' ? 0 : payload[field]
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CodexModelGatewayError('gateway_response_part_index_invalid', 502)
  }
  return Number(value)
}

function assertNativeToolArgumentsObject(value: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexModelGatewayError('gateway_response_tool_arguments_json_invalid', 502)
  }
  if (!isRecord(parsed)) {
    throw new CodexModelGatewayError('gateway_response_tool_arguments_json_invalid', 502)
  }
  return parsed
}

function assertNativeToolArgumentsSafe(
  value: string,
  toolName: string,
  credential: string,
  validators: ReadonlyMap<string, CodexToolArgumentValidator>,
): void {
  if ((credential && value.includes(credential)) || /Bearer\s+/i.test(value)) {
    throw new CodexModelGatewayError('gateway_tool_arguments_secret_detected', 502)
  }
  const parsed = assertNativeToolArgumentsObject(value)
  if (!validators.get(toolName)?.safeParse(parsed).success) {
    throw new CodexModelGatewayError('gateway_tool_arguments_schema_invalid', 502)
  }
}

function assertNativeResponseModel(response: JsonObject, expectedModel: string): void {
  if (response.model !== expectedModel) {
    throw new CodexModelGatewayError('gateway_upstream_model_mismatch', 502)
  }
}

function assertNativeTerminalStatus(eventType: string, response: JsonObject): void {
  const expected = eventType.slice('response.'.length)
  if (response.status !== expected) {
    throw new CodexModelGatewayError('gateway_response_status_mismatch', 502)
  }
}

function nativeUsageInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CodexModelGatewayError('gateway_response_usage_invalid', 502)
  }
  return Number(value)
}

function validateNativeUsage(response: JsonObject, required: boolean): void {
  if (response.usage === undefined) {
    if (required) throw new CodexModelGatewayError('gateway_response_usage_missing', 502)
    return
  }
  if (!isRecord(response.usage)) {
    throw new CodexModelGatewayError('gateway_response_usage_invalid', 502)
  }
  assertExactKeys(
    response.usage,
    ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'],
    'gateway_response_usage_invalid',
  )
  const inputTokens = nativeUsageInteger(response.usage.input_tokens)
  const outputTokens = nativeUsageInteger(response.usage.output_tokens)
  const totalTokens = nativeUsageInteger(response.usage.total_tokens)
  if (totalTokens !== inputTokens + outputTokens) {
    throw new CodexModelGatewayError('gateway_response_usage_invalid', 502)
  }
  if (
    !isRecord(response.usage.input_tokens_details)
    || !isRecord(response.usage.output_tokens_details)
  ) throw new CodexModelGatewayError('gateway_response_usage_invalid', 502)
  assertExactKeys(
    response.usage.input_tokens_details,
    ['cached_tokens'],
    'gateway_response_usage_invalid',
  )
  assertExactKeys(
    response.usage.output_tokens_details,
    ['reasoning_tokens'],
    'gateway_response_usage_invalid',
  )
  const cachedTokens = nativeUsageInteger(response.usage.input_tokens_details.cached_tokens)
  const reasoningTokens = nativeUsageInteger(response.usage.output_tokens_details.reasoning_tokens)
  if (cachedTokens > inputTokens || reasoningTokens > outputTokens) {
    throw new CodexModelGatewayError('gateway_response_usage_invalid', 502)
  }
}

function validateNativeTerminalSemantics(eventType: string, response: JsonObject): void {
  if (eventType === 'response.incomplete') {
    if (isRecord(response.incomplete_details)) {
      assertExactKeys(
        response.incomplete_details,
        ['reason'],
        'gateway_response_incomplete_details_invalid',
      )
    }
    if (
      !isRecord(response.incomplete_details)
      || !['max_output_tokens', 'content_filter'].includes(String(response.incomplete_details.reason))
      || (response.error !== undefined && response.error !== null)
    ) throw new CodexModelGatewayError('gateway_response_incomplete_details_invalid', 502)
    return
  }
  if (eventType === 'response.failed') {
    if (isRecord(response.error)) {
      assertExactKeys(
        response.error,
        ['code', 'message', 'type', 'param'],
        'gateway_response_failure_error_invalid',
      )
    }
    if (
      !isRecord(response.error)
      || typeof response.error.code !== 'string'
      || !response.error.code
      || typeof response.error.message !== 'string'
      || !response.error.message
      || (response.error.type !== undefined && typeof response.error.type !== 'string')
      || (
        response.error.param !== undefined
        && response.error.param !== null
        && typeof response.error.param !== 'string'
      )
      || (response.incomplete_details !== undefined && response.incomplete_details !== null)
    ) throw new CodexModelGatewayError('gateway_response_failure_error_invalid', 502)
    return
  }
  if (
    (response.error !== undefined && response.error !== null)
    || (response.incomplete_details !== undefined && response.incomplete_details !== null)
  ) throw new CodexModelGatewayError('gateway_response_completed_state_invalid', 502)
}

function validateNativeEvent(
  payload: JsonObject,
  allowedTools: ReadonlySet<string>,
  toolArgumentValidators: ReadonlyMap<string, CodexToolArgumentValidator>,
  state: NativeResponseState,
  expectedModel: string,
  credential: string,
): void {
  if (!ALLOWED_NATIVE_EVENTS.has(String(payload.type))) {
    throw new CodexModelGatewayError('gateway_response_event_not_allowed', 502)
  }
  validateNativeEventKeys(payload)
  const eventType = String(payload.type)
  if (payload.item !== undefined) {
    if (!isRecord(payload.item)) {
      throw new CodexModelGatewayError('gateway_response_item_not_allowed', 502)
    }
    validateNativeItem(payload.item, allowedTools)
  }
  if (isRecord(payload.response) && payload.response.output !== undefined) {
    if (!Array.isArray(payload.response.output)) {
      throw new CodexModelGatewayError('gateway_response_output_invalid', 502)
    }
    for (const item of payload.response.output) {
      if (!isRecord(item)) throw new CodexModelGatewayError('gateway_response_item_not_allowed', 502)
      validateNativeItem(item, allowedTools)
    }
  }

  if (eventType === 'error') {
    if (
      state.terminal
      || (payload.code !== null && typeof payload.code !== 'string')
      || typeof payload.message !== 'string'
      || !payload.message
      || (payload.param !== null && typeof payload.param !== 'string')
      || !Number.isSafeInteger(payload.sequence_number)
      || Number(payload.sequence_number) < 0
    ) {
      throw new CodexModelGatewayError('gateway_response_error_event_invalid', 502)
    }
    state.terminal = true
    return
  }
  if (eventType === 'response.created') {
    if (state.responseId || state.terminal || !isRecord(payload.response)) {
      throw new CodexModelGatewayError('gateway_response_created_invalid', 502)
    }
    if (Array.isArray(payload.response.output) && payload.response.output.length > 0) {
      throw new CodexModelGatewayError('gateway_response_created_output_not_empty', 502)
    }
    assertNativeResponseModel(payload.response, expectedModel)
    if (payload.response.status !== 'in_progress') {
      throw new CodexModelGatewayError('gateway_response_status_mismatch', 502)
    }
    state.responseId = nonEmptyString(payload.response.id, 'gateway_response_id_missing')
    return
  }
  if (!state.responseId || state.terminal) {
    throw new CodexModelGatewayError('gateway_response_event_order_invalid', 502)
  }

  if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    if (!isRecord(payload.item)) throw new CodexModelGatewayError('gateway_response_item_not_allowed', 502)
    const index = nativeOutputIndex(payload)
    const existing = state.items.get(index)
    if (
      payload.item.status !== undefined
      && (
        (eventType === 'response.output_item.added' && payload.item.status !== 'in_progress')
        || (
          eventType === 'response.output_item.done'
          && payload.item.status !== 'completed'
          && payload.item.status !== 'incomplete'
        )
      )
    ) throw new CodexModelGatewayError('gateway_response_item_status_invalid', 502)
    if (eventType === 'response.output_item.added') {
      if (existing || index !== state.items.size) {
        throw new CodexModelGatewayError('gateway_response_item_duplicate', 502)
      }
      const next = nativeItemState(payload.item)
      if (state.itemIds.has(next.id) || (next.callId && state.callIds.has(next.callId))) {
        throw new CodexModelGatewayError('gateway_response_item_identity_duplicate', 502)
      }
      state.itemIds.add(next.id)
      if (next.callId) state.callIds.add(next.callId)
      state.items.set(index, next)
    } else {
      if (!existing || existing.done) {
        throw new CodexModelGatewayError('gateway_response_item_done_without_added', 502)
      }
      assertNativeItemMatches(existing, payload.item, true)
      if (existing.type === 'function_call' && !existing.argumentsDone) {
        throw new CodexModelGatewayError('gateway_response_tool_arguments_not_done', 502)
      }
      if (existing.type === 'message' && existing.messageParts.size > 0) {
        if (!Array.isArray(payload.item.content) || payload.item.content.length !== existing.messageParts.size) {
          throw new CodexModelGatewayError('gateway_response_message_content_changed', 502)
        }
        payload.item.content.forEach((part, partIndex) => {
          const expectedPart = existing.messageParts.get(partIndex)
          if (
            !expectedPart
            || !isRecord(part)
            || part.type !== expectedPart.type
            || nativeMessagePartValue(part) !== expectedPart.text
          ) throw new CodexModelGatewayError('gateway_response_message_content_changed', 502)
        })
        if ([...existing.messageParts.values()].some((part) => (
          !part.textDone || (part.explicitPart && !part.partDone)
        ))) throw new CodexModelGatewayError('gateway_response_message_lifecycle_incomplete', 502)
      }
      if (existing.type === 'reasoning' && existing.reasoningParts.size > 0) {
        if (!Array.isArray(payload.item.summary) || payload.item.summary.length !== existing.reasoningParts.size) {
          throw new CodexModelGatewayError('gateway_response_reasoning_summary_changed', 502)
        }
        payload.item.summary.forEach((part, partIndex) => {
          const expectedPart = existing.reasoningParts.get(partIndex)
          if (!expectedPart || !isRecord(part) || part.type !== 'summary_text' || part.text !== expectedPart.text) {
            throw new CodexModelGatewayError('gateway_response_reasoning_summary_changed', 502)
          }
        })
        if ([...existing.reasoningParts.values()].some((part) => (
          !part.textDone || (part.explicitPart && !part.partDone)
        ))) throw new CodexModelGatewayError('gateway_response_reasoning_lifecycle_incomplete', 502)
      }
      existing.doneItemDigest = digestCanonicalJson(payload.item)
      existing.doneItem = payload.item
      existing.doneStatus = payload.item.status === 'incomplete' ? 'incomplete' : 'completed'
      existing.done = true
    }
    return
  }

  const expectedItemType = eventType.startsWith('response.function_call_arguments.')
    ? 'function_call'
    : eventType.startsWith('response.reasoning_summary_')
      ? 'reasoning'
      : (
          eventType.startsWith('response.output_text.')
          || eventType.startsWith('response.refusal.')
          || eventType.startsWith('response.content_part.')
        ) ? 'message' : null
  if (expectedItemType) {
    const index = nativeOutputIndex(payload)
    const item = state.items.get(index)
    if (
      !item
      || item.done
      || item.type !== expectedItemType
      || payload.item_id !== item.id
    ) throw new CodexModelGatewayError('gateway_response_delta_identity_invalid', 502)
    if (eventType.startsWith('response.content_part.')) {
      const partIndex = nativePartIndex(payload, 'content_index')
      if (
        !isRecord(payload.part)
        || !ALLOWED_MESSAGE_CONTENT_TYPES.has(String(payload.part.type))
      ) throw new CodexModelGatewayError('gateway_response_content_part_not_allowed', 502)
      const partValue = nativeMessagePartValue(payload.part)
      const existingPart = item.messageParts.get(partIndex)
      if (eventType === 'response.content_part.added') {
        if (existingPart) throw new CodexModelGatewayError('gateway_response_content_part_duplicate', 502)
        item.messageParts.set(partIndex, {
          type: String(payload.part.type), text: partValue,
          textDone: false, partDone: false, explicitPart: true,
        })
      } else if (
        !existingPart
        || existingPart.partDone
        || existingPart.type !== payload.part.type
        || existingPart.text !== partValue
      ) {
        throw new CodexModelGatewayError('gateway_response_content_part_changed', 502)
      } else {
        existingPart.partDone = true
      }
      return
    }
    if (eventType.startsWith('response.reasoning_summary_part.')) {
      const partIndex = nativePartIndex(payload, 'summary_index')
      if (!isRecord(payload.part) || payload.part.type !== 'summary_text' || typeof payload.part.text !== 'string') {
        throw new CodexModelGatewayError('gateway_response_reasoning_summary_invalid', 502)
      }
      const existingPart = item.reasoningParts.get(partIndex)
      if (eventType === 'response.reasoning_summary_part.added') {
        if (existingPart) throw new CodexModelGatewayError('gateway_response_reasoning_part_duplicate', 502)
        item.reasoningParts.set(partIndex, {
          text: payload.part.text, textDone: false, partDone: false, explicitPart: true,
        })
      } else if (!existingPart || existingPart.partDone || existingPart.text !== payload.part.text) {
        throw new CodexModelGatewayError('gateway_response_reasoning_summary_changed', 502)
      } else {
        existingPart.partDone = true
      }
      return
    }
    if (eventType.startsWith('response.output_text.') || eventType.startsWith('response.refusal.')) {
      const partIndex = nativePartIndex(payload, 'content_index')
      const partType = eventType.startsWith('response.refusal.') ? 'refusal' : 'output_text'
      const existingPart = item.messageParts.get(partIndex)
        || {
          type: partType, text: '', textDone: false, partDone: false, explicitPart: false,
        }
      if (existingPart.type !== partType || existingPart.textDone || existingPart.partDone) {
        throw new CodexModelGatewayError('gateway_response_content_part_changed', 502)
      }
      item.messageParts.set(partIndex, existingPart)
      if (eventType.endsWith('.delta')) {
        if (typeof payload.delta !== 'string') {
          throw new CodexModelGatewayError('gateway_response_text_delta_invalid', 502)
        }
        existingPart.text += payload.delta
      } else {
        const value = partType === 'refusal' ? payload.refusal : payload.text
        if (typeof value !== 'string' || value !== existingPart.text) {
          throw new CodexModelGatewayError('gateway_response_text_done_changed', 502)
        }
        existingPart.textDone = true
      }
      return
    }
    if (eventType.startsWith('response.reasoning_summary_text.')) {
      const partIndex = nativePartIndex(payload, 'summary_index')
      const existingPart = item.reasoningParts.get(partIndex)
        || { text: '', textDone: false, partDone: false, explicitPart: false }
      if (existingPart.textDone || existingPart.partDone) {
        throw new CodexModelGatewayError('gateway_response_reasoning_summary_changed', 502)
      }
      item.reasoningParts.set(partIndex, existingPart)
      if (eventType.endsWith('.delta')) {
        if (typeof payload.delta !== 'string') {
          throw new CodexModelGatewayError('gateway_response_reasoning_delta_invalid', 502)
        }
        existingPart.text += payload.delta
      } else {
        if (typeof payload.text !== 'string' || payload.text !== existingPart.text) {
          throw new CodexModelGatewayError('gateway_response_reasoning_summary_changed', 502)
        }
        existingPart.textDone = true
      }
      return
    }
    if (eventType === 'response.function_call_arguments.delta') {
      if (item.argumentsDone || typeof payload.delta !== 'string') {
        throw new CodexModelGatewayError('gateway_response_tool_arguments_delta_invalid', 502)
      }
      item.arguments += payload.delta
    }
    if (eventType === 'response.function_call_arguments.done') {
      if (
        item.argumentsDone
        || typeof payload.arguments !== 'string'
        || payload.arguments !== item.arguments
      ) throw new CodexModelGatewayError('gateway_response_tool_arguments_changed', 502)
      if (!item.name) throw new CodexModelGatewayError('gateway_response_tool_name_invalid', 502)
      assertNativeToolArgumentsSafe(
        payload.arguments,
        item.name,
        credential,
        toolArgumentValidators,
      )
      item.argumentsDone = true
    }
    return
  }

  if (eventType === 'response.in_progress') {
    if (!isRecord(payload.response) || payload.response.id !== state.responseId) {
      throw new CodexModelGatewayError('gateway_response_identity_changed', 502)
    }
    if (state.inProgressSeen || state.items.size > 0) {
      throw new CodexModelGatewayError('gateway_response_in_progress_order_invalid', 502)
    }
    if (!Array.isArray(payload.response.output) || payload.response.output.length > 0) {
      throw new CodexModelGatewayError('gateway_response_in_progress_output_not_empty', 502)
    }
    assertNativeResponseModel(payload.response, expectedModel)
    assertNativeTerminalStatus(eventType, payload.response)
    state.inProgressSeen = true
    return
  }

  if (
    eventType === 'response.completed'
    || eventType === 'response.incomplete'
    || eventType === 'response.failed'
  ) {
    if (!isRecord(payload.response) || payload.response.id !== state.responseId) {
      throw new CodexModelGatewayError('gateway_response_identity_changed', 502)
    }
    assertNativeResponseModel(payload.response, expectedModel)
    assertNativeTerminalStatus(eventType, payload.response)
    validateNativeTerminalSemantics(eventType, payload.response)
    validateNativeUsage(payload.response, eventType !== 'response.failed')
    if ([...state.items.values()].some((item) => !item.done)) {
      throw new CodexModelGatewayError('gateway_response_item_not_done', 502)
    }
    if (
      eventType === 'response.completed'
      && [...state.items.values()].some((item) => item.doneStatus !== 'completed')
    ) throw new CodexModelGatewayError('gateway_response_item_terminal_status_invalid', 502)
    if (Array.isArray(payload.response.output)) {
      if (payload.response.output.length !== state.items.size) {
        throw new CodexModelGatewayError('gateway_response_output_mismatch', 502)
      }
      payload.response.output.forEach((item, index) => {
        if (!isRecord(item)) throw new CodexModelGatewayError('gateway_response_item_not_allowed', 502)
        const expected = state.items.get(index)
        if (!expected) throw new CodexModelGatewayError('gateway_response_output_mismatch', 502)
        if (!expected.doneItemDigest || digestCanonicalJson(item) !== expected.doneItemDigest) {
          throw new CodexModelGatewayError('gateway_response_output_mismatch', 502)
        }
      })
    } else throw new CodexModelGatewayError('gateway_response_output_invalid', 502)
    state.terminal = true
    return
  }

  throw new CodexModelGatewayError('gateway_response_event_state_invalid', 502)
}

function sanitizeProviderText(value: string, credential: string): string {
  const withoutCredential = credential ? value.split(credential).join('[REDACTED]') : value
  return withoutCredential.replace(
    /Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi,
    'Bearer [REDACTED]',
  )
}

function assertNativeProviderIdentitySafe(payload: JsonObject, credential: string): void {
  const assertSafe = (value: unknown): void => {
    if (typeof value !== 'string') return
    if ((credential && value.includes(credential)) || /Bearer\s+/i.test(value)) {
      throw new CodexModelGatewayError('gateway_provider_credential_in_identity', 502)
    }
  }
  assertSafe(payload.type)
  assertSafe(payload.item_id)
  const inspectItem = (item: unknown): void => {
    if (!isRecord(item)) return
    for (const key of ['type', 'id', 'name', 'call_id', 'role', 'phase', 'status']) assertSafe(item[key])
  }
  inspectItem(payload.item)
  if (isRecord(payload.response)) {
    for (const key of ['id', 'model', 'status']) assertSafe(payload.response[key])
    if (Array.isArray(payload.response.output)) payload.response.output.forEach(inspectItem)
  }
}

function assertNativeProviderCredentialAbsent(value: unknown, credential: string): void {
  if (typeof value === 'string') {
    if ((credential && value.includes(credential)) || /Bearer\s+(?!\[REDACTED\])/i.test(value)) {
      throw new CodexModelGatewayError('gateway_provider_credential_unredacted', 502)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNativeProviderCredentialAbsent(entry, credential))
    return
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, entry]) => {
      assertNativeProviderCredentialAbsent(key, credential)
      assertNativeProviderCredentialAbsent(entry, credential)
    })
  }
}

function redactNativeItem(item: JsonObject, credential: string): JsonObject {
  return {
    ...item,
    ...(typeof item.arguments === 'string'
      ? { arguments: sanitizeProviderText(item.arguments, credential) } : {}),
    ...(Array.isArray(item.content) ? {
      content: item.content.map((part) => {
        if (!isRecord(part)) return part
        if (part.type === 'refusal' && typeof part.refusal === 'string') {
          return { ...part, refusal: sanitizeProviderText(part.refusal, credential) }
        }
        return typeof part.text === 'string'
          ? { ...part, text: sanitizeProviderText(part.text, credential) }
          : part
      }),
    } : {}),
    ...(Array.isArray(item.summary) ? {
      summary: item.summary.map((part) => isRecord(part) && typeof part.text === 'string'
        ? { ...part, text: sanitizeProviderText(part.text, credential) }
        : part),
    } : {}),
  }
}

function redactNativeProviderEvent(
  payload: JsonObject,
  credential: string,
  deferDelta = false,
): JsonObject {
  if (payload.type === 'error') {
    const safeError: JsonObject = {
      type: 'error',
      code: payload.code === null
        ? null
        : sanitizeProviderText(String(payload.code), credential).slice(0, 512),
      message: sanitizeProviderText(String(payload.message), credential).slice(0, 512),
      param: payload.param === null
        ? null
        : sanitizeProviderText(String(payload.param), credential).slice(0, 512),
      sequence_number: payload.sequence_number,
    }
    assertNativeProviderCredentialAbsent(safeError, credential)
    return safeError
  }
  const safePayload: JsonObject = {
    ...payload,
    ...(typeof payload.delta === 'string'
      ? { delta: deferDelta ? '' : sanitizeProviderText(payload.delta, credential) } : {}),
    ...(typeof payload.text === 'string'
      ? { text: sanitizeProviderText(payload.text, credential) } : {}),
    ...(typeof payload.refusal === 'string'
      ? { refusal: sanitizeProviderText(payload.refusal, credential) } : {}),
    ...(typeof payload.arguments === 'string'
      ? { arguments: sanitizeProviderText(payload.arguments, credential) } : {}),
    ...(isRecord(payload.part) && typeof payload.part.text === 'string'
      ? { part: { ...payload.part, text: sanitizeProviderText(payload.part.text, credential) } }
      : isRecord(payload.part) && typeof payload.part.refusal === 'string'
        ? { part: { ...payload.part, refusal: sanitizeProviderText(payload.part.refusal, credential) } }
        : {}),
    ...(isRecord(payload.item) ? { item: redactNativeItem(payload.item, credential) } : {}),
    ...(isRecord(payload.response) ? {
      response: {
        ...payload.response,
        ...(Array.isArray(payload.response.output)
          ? { output: payload.response.output.map((item) => isRecord(item) ? redactNativeItem(item, credential) : item) }
          : {}),
      },
    } : {}),
  }
  if (payload.type === 'response.failed' && isRecord(payload.response) && isRecord(payload.response.error)) {
    const error = sanitizedProviderError(JSON.stringify({ error: payload.response.error }), credential)
    const safeResponse = safePayload.response as JsonObject
    const safeFailure = {
      ...safePayload,
      response: {
        ...safeResponse,
        error: error || {
          code: 'gateway_upstream_error',
          type: 'upstream_error',
          message: 'gateway_upstream_error',
        },
      },
    }
    assertNativeProviderCredentialAbsent(safeFailure, credential)
    return safeFailure
  }
  assertNativeProviderCredentialAbsent(safePayload, credential)
  return safePayload
}

function safeProviderHeader(
  value: string | null,
  credential: string,
  kind: 'request_id' | 'retry_after',
): string | null {
  if (!value || /[\r\n\0]/.test(value) || value.length > 256) return null
  if ((credential && value.includes(credential)) || /Bearer\s+/i.test(value)) return null
  if (kind === 'request_id') return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? value : null
  if (/^\d{1,10}$/.test(value)) return value
  return Number.isFinite(Date.parse(value)) ? value : null
}

async function streamNativeResponses(input: {
  body: ReadableStream<Uint8Array>
  response: ServerResponse
  allowedTools: ReadonlySet<string>
  toolArgumentValidators: ReadonlyMap<string, CodexToolArgumentValidator>
  expectedModel: string
  normalizeChatGptOAuth: boolean
  credential: string
  abort: () => void
  maxBytes: number
  maxEvents: number
  maxItemBytes: number
  eventIdleMs: number
  postTerminalDrainMs: number
  admitToolResponse: (calls: readonly CodexModelGatewayToolResponseCall[]) => Promise<void>
  recordCompleted: (evidence: CodexModelGatewayResponseEvidence) => Promise<void>
}): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const reader = input.body.getReader()
  const deltaFilters = new Map<string, {
    filter: ProviderCredentialFilter
    eventType: string
    itemId: string
    base: JsonObject
  }>()
  let buffer = ''
  const policy = new CodexProviderStreamPolicy({
    maxWireBytes: input.maxBytes,
    maxStructuralEvents: input.maxEvents,
    maxItemHeldBytes: input.maxItemBytes,
    eventIdleMs: input.eventIdleMs,
    terminalDrainMs: input.postTerminalDrainMs,
  })
  const state: NativeResponseState = {
    responseId: null,
    inProgressSeen: false,
    terminal: false,
    items: new Map(),
    itemIds: new Set(),
    callIds: new Set(),
  }
  let terminalEvent: string | null = null
  let terminalPayload: JsonObject | null = null
  let terminalSucceeded = false
  let holdFromFunctionCall = false
  const heldFunctionTail: JsonObject[] = []
  const encodeSafePayload = (payload: JsonObject): string => (
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  )
  const appendHeldFunctionPayload = (payload: JsonObject): void => {
    const previous = heldFunctionTail.at(-1)
    if (
      payload.type === 'response.function_call_arguments.delta'
      && previous?.type === payload.type
      && previous.item_id === payload.item_id
      && previous.output_index === payload.output_index
      && typeof previous.delta === 'string'
      && typeof payload.delta === 'string'
    ) {
      previous.delta += payload.delta
      return
    }
    heldFunctionTail.push({ ...payload })
  }
  const writeSafePayload = (payload: JsonObject): void => {
    if (holdFromFunctionCall) appendHeldFunctionPayload(payload)
    else input.response.write(encodeSafePayload(payload))
  }
  const deltaFamily = (eventType: string): string | null => {
    if (eventType === 'response.function_call_arguments.delta') return 'arguments'
    if (eventType === 'response.reasoning_summary_text.delta') return 'reasoning'
    if (eventType === 'response.output_text.delta') return 'output_text'
    if (eventType === 'response.refusal.delta') return 'refusal'
    return null
  }
  const flushDeltaFilters = (predicate: (entry: {
    eventType: string; itemId: string
  }) => boolean): void => {
    for (const [key, entry] of deltaFilters) {
      if (!predicate(entry)) continue
      const delta = entry.filter.flush()
      if (delta) writeSafePayload({
        ...entry.base,
        type: entry.eventType,
        delta: sanitizeProviderText(delta, input.credential),
      })
      deltaFilters.delete(key)
    }
  }
  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    const remaining = policy.remainingWaitMs()
    if (remaining <= 0) {
      throw new CodexModelGatewayError(policy.timeoutCode(), 502)
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new CodexModelGatewayError(
            policy.timeoutCode(),
            502,
          )), remaining)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
  try {
    while (true) {
      const next = await readNext()
      if (next.done) break
      try {
        policy.recordWireBytes(next.value.byteLength)
      } catch (error) {
        if (error instanceof CodexProviderStreamPolicyError) {
          throw new CodexModelGatewayError(error.code, 502)
        }
        throw error
      }
      try {
        buffer += decoder.decode(next.value, { stream: true })
      } catch {
        throw new CodexModelGatewayError('gateway_native_sse_utf8_invalid', 502)
      }
      const parsed = parseSse(buffer)
      buffer = parsed.rest
      for (const block of parsed.blocks) {
        const parsedEvent = nativeEventFromBlock(block)
        if (!parsedEvent) continue
        const providerPayload = input.normalizeChatGptOAuth
          ? normalizeChatGptOAuthResponseEvent(
              parsedEvent.payload,
              [...state.items.values()].flatMap((item) => item.doneItem ? [item.doneItem] : []),
            )
          : parsedEvent.payload
        const eventType = String(parsedEvent.payload.type)
        assertNativeProviderIdentitySafe(providerPayload, input.credential)
        validateNativeEvent(
          providerPayload,
          input.allowedTools,
          input.toolArgumentValidators,
          state,
          input.expectedModel,
          input.credential,
        )
        try {
          policy.acceptValidatedEvent(providerPayload)
        } catch (error) {
          if (error instanceof CodexProviderStreamPolicyError) {
            throw new CodexModelGatewayError(error.code, 502)
          }
          throw error
        }
        if (
          eventType === 'response.output_item.added'
          && isRecord(providerPayload.item)
          && providerPayload.item.type === 'function_call'
        ) holdFromFunctionCall = true
        const itemId = typeof providerPayload.item_id === 'string'
          ? providerPayload.item_id
          : isRecord(providerPayload.item) && typeof providerPayload.item.id === 'string'
            ? providerPayload.item.id
            : ''
        if (eventType === 'response.output_item.done') {
          flushDeltaFilters((entry) => entry.itemId === itemId)
        } else if (eventType.endsWith('.done')) {
          const family = eventType.replace(/\.done$/, '').replace(/^response\./, '')
          flushDeltaFilters((entry) => (
            entry.itemId === itemId && entry.eventType.includes(family.replace(/_done$/, ''))
          ))
        }
        const family = deltaFamily(eventType)
        let gatewayPayload = providerPayload
        if (eventType === 'response.incomplete' && isRecord(providerPayload.response)) {
          const incompleteDetails = providerPayload.response.incomplete_details
          const reason = isRecord(incompleteDetails) ? incompleteDetails.reason : null
          const response = { ...providerPayload.response }
          delete response.incomplete_details
          const code = reason === 'max_output_tokens'
            ? 'gateway_upstream_output_truncated'
            : 'gateway_upstream_output_filtered'
          gatewayPayload = {
            ...providerPayload,
            type: 'response.failed',
            response: {
              ...response,
              status: 'failed',
              error: { code, message: code, type: 'gateway_error' },
            },
          }
        }
        let safePayload = redactNativeProviderEvent(
          gatewayPayload,
          input.credential,
          family !== null,
        )
        if (family && typeof providerPayload.delta === 'string') {
          const key = `${family}:${itemId}:${String(providerPayload.content_index ?? providerPayload.summary_index ?? 0)}`
          let entry = deltaFilters.get(key)
          if (!entry) {
            const base = { ...safePayload }
            delete base.delta
            entry = {
              filter: new ProviderCredentialFilter(input.credential),
              eventType,
              itemId,
              base,
            }
            deltaFilters.set(key, entry)
          }
          safePayload = {
            ...safePayload,
            delta: sanitizeProviderText(entry.filter.push(providerPayload.delta), input.credential),
          }
        }
        if (state.terminal) {
          terminalSucceeded = safePayload.type === 'response.completed'
          const completedPayload = terminalSucceeded || !isRecord(safePayload.response)
            ? safePayload
            : {
                ...safePayload,
                response: { ...safePayload.response, output: [] },
              }
          terminalEvent = `event: ${completedPayload.type}\ndata: ${JSON.stringify(completedPayload)}\n\n`
          terminalPayload = completedPayload
          if (safePayload.type !== 'response.completed' && holdFromFunctionCall) {
            heldFunctionTail.length = 0
            holdFromFunctionCall = false
          }
        } else writeSafePayload(safePayload)
      }
    }
    try {
      buffer += decoder.decode()
    } catch {
      throw new CodexModelGatewayError('gateway_native_sse_utf8_invalid', 502)
    }
    if (buffer.trim()) throw new CodexModelGatewayError('gateway_native_sse_truncated', 502)
    if (!state.terminal) throw new CodexModelGatewayError('gateway_native_terminal_missing', 502)
    if (!terminalEvent) throw new CodexModelGatewayError('gateway_native_terminal_missing', 502)
    if (!terminalSucceeded) {
      deltaFilters.clear()
      heldFunctionTail.length = 0
      holdFromFunctionCall = false
      input.response.write(terminalEvent)
      return
    }
    flushDeltaFilters(() => true)
    const toolCalls = [...state.items.values()]
      .filter((item) => item.type === 'function_call')
      .map((item) => {
        let parsedArguments: unknown
        try {
          parsedArguments = JSON.parse(item.arguments)
        } catch {
          throw new CodexModelGatewayError('gateway_native_tool_arguments_json_invalid', 502)
        }
        if (!item.callId || !item.name) {
          throw new CodexModelGatewayError('gateway_native_tool_identity_invalid', 502)
        }
        return {
          codexCallId: item.callId,
          toolName: item.name,
          argsDigest: digestCanonicalJson(parsedArguments),
        }
      })
    if (toolCalls.length > 0) await input.admitToolResponse(toolCalls)
    if (!terminalPayload || !isRecord(terminalPayload.response)) {
      throw new CodexModelGatewayError('gateway_native_terminal_missing', 502)
    }
    await input.recordCompleted({
      responseId: String(terminalPayload.response.id),
      terminalDigest: digestCanonicalJson(terminalPayload),
      outputDigest: digestCanonicalJson([...state.items.entries()].map(([index, item]) => ({
        index,
        digest: item.doneItemDigest,
      }))),
      usageDigest: digestCanonicalJson(terminalPayload.response.usage),
    })
    for (const safePayload of heldFunctionTail) input.response.write(encodeSafePayload(safePayload))
    heldFunctionTail.length = 0
    holdFromFunctionCall = false
    input.response.write(terminalEvent)
  } catch (error) {
    input.abort()
    await reader.cancel().catch(() => undefined)
    heldFunctionTail.length = 0
    holdFromFunctionCall = false
    const code = error instanceof CodexModelGatewayError ? error.code : 'gateway_native_stream_failed'
    const responseId = state.responseId || `resp_ready_${randomBytes(16).toString('hex')}`
    input.response.write(`event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      sequence_number: 0,
      response: {
        id: responseId,
        model: input.expectedModel,
        status: 'failed',
        output: [],
        error: { code, message: code, type: 'gateway_error', param: null },
      },
    })}\n\n`)
  } finally {
    reader.releaseLock()
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  const gatewayError = error instanceof CodexModelGatewayError
    ? error
    : new CodexModelGatewayError('gateway_request_unbound', 409)
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(gatewayError.status, {
    'content-type': 'application/json',
    ...gatewayError.responseHeaders,
  })
  response.end(JSON.stringify({
    error: gatewayError.responseError,
  }))
}

export class CodexModelGateway {
  private readonly bootstrapBearerToken: string
  private readonly maxBodyBytes: number
  private readonly maxConcurrentRequests: number
  private readonly bodyDeadlineMs: number
  private readonly nativeMaxBytes: number
  private readonly nativeMaxEvents: number
  private readonly nativeMaxItemBytes: number
  private readonly headersDeadlineMs: number
  private readonly firstByteDeadlineMs: number
  private readonly eventIdleMs: number
  private readonly postTerminalDrainMs: number
  private activeCapability: ActiveGatewayCapability | null
  private server: Server | null = null
  private port: number | null = null
  private startPromise: Promise<CodexModelGatewayAddress> | null = null
  private activeRequests = 0
  private readonly activeAbortControllers = new Set<AbortController>()
  private lifecycle: 'new' | 'starting' | 'running' | 'stopped' = 'new'

  constructor(private readonly deps: {
    bearerToken?: string
    spawnBound?: boolean
    maxBodyBytes?: number
    maxConcurrentRequests?: number
    bodyDeadlineMs?: number
    nativeMaxBytes?: number
    nativeMaxEvents?: number
    nativeMaxItemBytes?: number
    headersDeadlineMs?: number
    firstByteDeadlineMs?: number
    eventIdleMs?: number
    postTerminalDrainMs?: number
    onUpstreamAttempt?: (attempt: number) => void
    proofSentinel?: string
    proofSentinels?: readonly string[]
    onValidatedRequest?: (capture: CodexModelGatewayValidatedRequestCapture) => void | Promise<void>
    authority: CodexModelGatewayAuthority
    credentials: CodexModelGatewayCredentialStore
  }) {
    this.bootstrapBearerToken = deps.bearerToken || randomBytes(32).toString('base64url')
    this.activeCapability = deps.spawnBound
      ? null
      : { bearerToken: this.bootstrapBearerToken, sidecarSpawnInstanceId: 'standalone' }
    this.maxBodyBytes = deps.maxBodyBytes || 4_194_304
    this.maxConcurrentRequests = deps.maxConcurrentRequests || 8
    this.bodyDeadlineMs = deps.bodyDeadlineMs || DEFAULT_BODY_DEADLINE_MS
    this.nativeMaxBytes = deps.nativeMaxBytes || DEFAULT_NATIVE_MAX_BYTES
    this.nativeMaxEvents = deps.nativeMaxEvents || DEFAULT_NATIVE_MAX_EVENTS
    this.nativeMaxItemBytes = deps.nativeMaxItemBytes || DEFAULT_NATIVE_MAX_ITEM_BYTES
    this.headersDeadlineMs = deps.headersDeadlineMs || DEFAULT_HEADERS_DEADLINE_MS
    this.firstByteDeadlineMs = deps.firstByteDeadlineMs || DEFAULT_FIRST_BYTE_DEADLINE_MS
    this.eventIdleMs = deps.eventIdleMs || DEFAULT_EVENT_IDLE_MS
    this.postTerminalDrainMs = deps.postTerminalDrainMs || DEFAULT_POST_TERMINAL_DRAIN_MS
    if (
      !this.bootstrapBearerToken
      || this.maxBodyBytes <= 0
      || this.maxConcurrentRequests <= 0
      || this.bodyDeadlineMs <= 0
      || this.nativeMaxBytes <= 0
      || this.nativeMaxEvents <= 0
      || this.nativeMaxItemBytes <= 0
      || this.headersDeadlineMs <= 0
      || this.firstByteDeadlineMs <= 0
      || this.eventIdleMs <= 0
      || this.postTerminalDrainMs <= 0
    ) {
      throw new CodexModelGatewayError('gateway_configuration_invalid')
    }
  }

  async start(): Promise<CodexModelGatewayAddress> {
    if (this.lifecycle !== 'new') throw new CodexModelGatewayError('gateway_already_started')
    this.lifecycle = 'starting'
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    const starting = new Promise<CodexModelGatewayAddress>((resolve, reject) => {
      server.once('error', (error) => {
        if (this.lifecycle === 'starting') this.lifecycle = 'stopped'
        if (this.server === server) this.server = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        if (this.lifecycle !== 'starting') {
          server.closeAllConnections()
          server.close(() => {
            if (this.server === server) this.server = null
            reject(new CodexModelGatewayError('gateway_stopped', 503))
          })
          return
        }
        const address = server.address()
        if (!address || typeof address === 'string') {
          this.lifecycle = 'stopped'
          reject(new Error('gateway_address_invalid'))
          return
        }
        this.port = address.port
        this.lifecycle = 'running'
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          bearerToken: this.bootstrapBearerToken,
        })
      })
    })
    this.startPromise = starting
    try {
      return await starting
    } finally {
      if (this.startPromise === starting) this.startPromise = null
    }
  }

  activateSpawn(sidecarSpawnInstanceId: string): CodexModelGatewaySpawnCapability {
    if (this.lifecycle !== 'running' || !this.port) {
      throw new CodexModelGatewayError('gateway_not_started', 503)
    }
    if (!sidecarSpawnInstanceId.trim() || /[\r\n\0]/.test(sidecarSpawnInstanceId)) {
      throw new CodexModelGatewayError('gateway_spawn_identity_invalid')
    }
    for (const controller of this.activeAbortControllers) controller.abort()
    const capability = {
      bearerToken: randomBytes(32).toString('base64url'),
      sidecarSpawnInstanceId,
    }
    this.activeCapability = capability
    return {
      url: `http://127.0.0.1:${this.port}`,
      ...capability,
    }
  }

  revokeSpawn(sidecarSpawnInstanceId: string): void {
    if (this.activeCapability?.sidecarSpawnInstanceId !== sidecarSpawnInstanceId) return
    this.activeCapability = null
    for (const controller of this.activeAbortControllers) controller.abort()
  }

  async stop(): Promise<void> {
    const starting = this.startPromise
    this.lifecycle = 'stopped'
    this.activeCapability = null
    for (const controller of this.activeAbortControllers) controller.abort()
    if (starting) await starting.catch(() => undefined)
    const server = this.server
    this.server = null
    this.port = null
    if (!server || !server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let admitted = false
    try {
      if (this.lifecycle !== 'running' || !this.port) {
        throw new CodexModelGatewayError('gateway_not_started', 503)
      }
      if (request.socket.remoteAddress !== '127.0.0.1') {
        throw new CodexModelGatewayError('gateway_remote_not_loopback', 403)
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        throw new CodexModelGatewayError('gateway_route_invalid', 404)
      }
      if (request.headers.host !== `127.0.0.1:${this.port}`) {
        throw new CodexModelGatewayError('gateway_host_invalid')
      }
      const capability = this.activeCapability
      if (!capability) throw new CodexModelGatewayError('gateway_spawn_capability_inactive', 401)
      parseAuthorization(request, capability.bearerToken)
      if (
        String(request.headers['content-type'] || '').toLowerCase().split(';', 1)[0].trim()
        !== 'application/json'
      ) {
        throw new CodexModelGatewayError('gateway_content_type_invalid', 415)
      }
      if (this.activeRequests >= this.maxConcurrentRequests) {
        throw new CodexModelGatewayError('gateway_concurrency_exceeded', 429)
      }
      this.activeRequests += 1
      admitted = true
      await this.forward(request, response, capability)
    } catch (error) {
      sendError(response, error)
    } finally {
      if (admitted) this.activeRequests -= 1
    }
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
    capability: ActiveGatewayCapability,
  ): Promise<void> {
    const assertActiveCapability = (): void => {
      if (this.lifecycle !== 'running' || this.activeCapability !== capability) {
        throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
      }
    }
    const abortController = new AbortController()
    let completed = false
    const abortForRequest = () => abortController.abort()
    const abortForResponse = () => { if (!completed) abortController.abort() }
    request.once('aborted', abortForRequest)
    response.once('close', abortForResponse)
    this.activeAbortControllers.add(abortController)
    try {
      assertActiveCapability()
      const body = await readJsonBody(
        request,
        this.maxBodyBytes,
        abortController.signal,
        this.bodyDeadlineMs,
      )
      assertActiveCapability()
      const toolArgumentValidators = validateRequestShape(body)
      const metadata = parseMetadata(body)
      const sidecarRequestDigest = digestCanonicalJson(body)
      const receivedAt = new Date().toISOString()
      const sidecarRequestCapture = buildValidatedRequestCapture({
        body,
        metadata,
        requestDigest: sidecarRequestDigest,
        proofSentinel: this.deps.proofSentinel,
        proofSentinels: this.deps.proofSentinels,
      })
      const validation: {
        binding: CodexModelGatewayBinding | null
        allowedTools: ReadonlySet<string> | null
      } = { binding: null, allowedTools: null }
      type PreparedRequest = {
        body: JsonObject
        capture: CodexModelGatewayOriginalRequestCapture
        redaction: ReturnType<typeof redactPriorReadyMemoryHistory>
        receipt: CodexModelGatewayPreparedRequestReceipt
      }
      let preparedRequest: PreparedRequest | null = null
      const prepareRequestReceipt = (): CodexModelGatewayPreparedRequestReceipt => {
        if (preparedRequest) return preparedRequest.receipt
        if (!validation.binding || !validation.allowedTools) {
          throw new CodexModelGatewayError('gateway_request_prepared_before_validation', 409)
        }
        const redaction = redactPriorReadyMemoryHistory({
          requestKind: expectedKind(metadata),
          input: body.input as unknown[],
        })
        const redactedBody = { ...body, input: redaction.input }
        const requestDigest = digestCanonicalJson(redactedBody)
        const capture = buildValidatedRequestCapture({
          body: redactedBody,
          metadata,
          requestDigest,
          proofSentinel: this.deps.proofSentinel,
          proofSentinels: this.deps.proofSentinels,
        })
        const receipt = {
          requestDigest,
          requestEvidence: durableRequestEvidence(capture, redaction.evidence),
        }
        preparedRequest = { body: redactedBody, capture, redaction, receipt }
        return receipt
      }
      const binding = await this.deps.authority.resolve({
        metadata,
        receivedAt,
        validate: (candidate) => {
          if (validation.binding) throw new CodexModelGatewayError('gateway_binding_validated_twice', 409)
          validation.binding = candidate
          validation.allowedTools = validateBinding({ body, metadata, binding: candidate })
          return validation.allowedTools
        },
        prepareRequestReceipt,
      })
      if (
        this.lifecycle !== 'running'
        || this.activeCapability !== capability
        || abortController.signal.aborted
      ) {
        throw new CodexModelGatewayError('gateway_stopped', 503)
      }
      if (validation.binding !== binding || !validation.allowedTools) {
        throw new CodexModelGatewayError('gateway_binding_not_validated', 409)
      }
      const preparedReceipt = prepareRequestReceipt()
      const sealedRequest = preparedRequest as PreparedRequest | null
      if (!sealedRequest) throw new CodexModelGatewayError('gateway_request_not_prepared', 409)
      const requestDigest = preparedReceipt.requestDigest
      const allowedTools = binding.forceToolFreeFinalization
        ? new Set<string>()
        : validation.allowedTools
      const authorizedProviderTools = binding.forceToolFreeFinalization
        ? []
        : (body.tools as JsonObject[]).filter((tool) => (
            typeof tool.name === 'string' && allowedTools.has(tool.name)
          ))
      const providerRequestBody = {
        ...sealedRequest.body,
        tools: authorizedProviderTools,
        ...(authorizedProviderTools.length === 0
          ? { tool_choice: 'none', parallel_tool_calls: false }
          : {}),
      }
      await this.deps.onValidatedRequest?.({
        ...sealedRequest.capture,
        sidecarRequestDigest,
        sidecarInputDigest: sidecarRequestCapture.inputDigest,
        providerInputDigest: sealedRequest.redaction.evidence.providerInputDigest,
        memoryHistoryRedactionDigest: sealedRequest.redaction.evidence.redactionDigest,
        memoryHistoryRedactedItemCount: sealedRequest.redaction.evidence.redactedItemCount,
      })
      const parallelToolCallsAllowed = providerRequestBody.parallel_tool_calls === true
      const admitToolResponse = async (
        calls: readonly CodexModelGatewayToolResponseCall[],
      ): Promise<void> => {
        if (binding.forceToolFreeFinalization) {
          throw new CodexModelGatewayError('gateway_finalization_tool_response_forbidden', 409)
        }
        if (!parallelToolCallsAllowed && calls.length > 1) {
          throw new CodexModelGatewayError('gateway_parallel_tool_calls_forbidden', 409)
        }
        if (!this.deps.authority.admitToolResponse) {
          throw new CodexModelGatewayError('gateway_tool_response_admission_unavailable', 409)
        }
        await this.deps.authority.admitToolResponse({
          metadata,
          requestDigest,
          calls,
          admittedAt: new Date().toISOString(),
        })
      }
      const credential = await this.deps.credentials.resolve({
        credentialReferenceId: binding.snapshot.credentialReferenceId,
        snapshot: binding.snapshot,
      })
      const recordCompleted = async (
        responseEvidence: CodexModelGatewayResponseEvidence,
      ): Promise<void> => {
        if (!this.deps.authority.recordResponseEvidence) return
        await this.deps.authority.recordResponseEvidence({
          metadata,
          requestDigest,
          responseEvidence,
          completedAt: new Date().toISOString(),
        })
      }
      if (
        this.lifecycle !== 'running'
        || this.activeCapability !== capability
        || abortController.signal.aborted
      ) {
        throw new CodexModelGatewayError('gateway_stopped', 503)
      }
      if (typeof credential !== 'string' || !credential) {
        throw new CodexModelGatewayError('gateway_credential_unavailable', 503)
      }
      const upstreamBody = binding.snapshot.wireApi === 'chat/completions'
        ? responsesRequestToChat({
            request: providerRequestBody,
            snapshot: binding.snapshot,
          })
        : {
            ...providerRequestBody,
            model: binding.snapshot.model,
            ...(binding.snapshot.maxOutputTokens
              ? { max_output_tokens: binding.snapshot.maxOutputTokens }
              : {}),
            reasoning: {
              summary: 'auto',
              ...(binding.snapshot.reasoningEffort ? { effort: binding.snapshot.reasoningEffort } : {}),
            },
          }
      let upstreamResponse: Response
      let upstreamResponseBody: ReadableStream<Uint8Array> | null = null
      let retriesUsed = 0
      while (true) {
        let fetched: Awaited<ReturnType<typeof fetchCodexUpstreamWithRetry>>
        try {
          fetched = await fetchCodexUpstreamWithRetry({
            url: upstreamEndpoint(binding.snapshot),
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              ...binding.snapshot.extraHeaders,
              [binding.snapshot.authHeader]: `${binding.snapshot.authPrefix}${credential}`,
            },
            body: upstreamBody,
            maxRetries: binding.snapshot.retryPolicy.maxRetries - retriesUsed,
            attemptOffset: retriesUsed,
            signal: abortController.signal,
            headersDeadlineMs: this.headersDeadlineMs,
            onAttempt: this.deps.onUpstreamAttempt,
          })
        } catch (error) {
          if (error instanceof CodexModelGatewayRetryError) {
            throw new CodexModelGatewayError(error.code, error.status)
          }
          throw error
        }
        upstreamResponse = fetched.response
        retriesUsed += fetched.retriesUsed
        if (!upstreamResponse.ok) break
        if (!isCodexUpstreamEventStream(upstreamResponse, binding.snapshot)) {
          break
        }
        if (!upstreamResponse.body) break
        try {
          upstreamResponseBody = await prepareCodexUpstreamStreamForControlledRetry({
            body: upstreamResponse.body,
            wireApi: binding.snapshot.wireApi,
            snapshot: binding.snapshot,
            credential,
            signal: abortController.signal,
            deadlineMs: this.firstByteDeadlineMs,
          })
          break
        } catch (error) {
          if (!(error instanceof CodexModelGatewayRetryError)) throw error
          if (!error.retryableBeforeOutput) {
            throw new CodexModelGatewayError(error.code, error.status)
          }
          if (retriesUsed >= binding.snapshot.retryPolicy.maxRetries) {
            throw new CodexModelGatewayError('gateway_upstream_retry_exhausted', 502)
          }
          retriesUsed += 1
          try {
            await waitForControlledGatewayRetry({
              retryOrdinal: retriesUsed,
              response: upstreamResponse,
              signal: abortController.signal,
            })
          } catch (waitError) {
            if (waitError instanceof CodexModelGatewayRetryError) {
              throw new CodexModelGatewayError(waitError.code, waitError.status)
            }
            throw waitError
          }
        }
      }
      assertActiveCapability()
      if (abortController.signal.aborted) {
        throw new CodexModelGatewayError('gateway_spawn_capability_revoked', 401)
      }
      if (!upstreamResponse.ok) {
        const requestId = safeProviderHeader(
          upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('request-id'),
          credential,
          'request_id',
        )
        const retryAfter = safeProviderHeader(
          upstreamResponse.headers.get('retry-after'),
          credential,
          'retry_after',
        )
        const providerError = sanitizedProviderError(
          await readBoundedResponseText({
            response: upstreamResponse,
            signal: abortController.signal,
            deadlineMs: this.firstByteDeadlineMs,
          }),
          credential,
        )
        throw new CodexModelGatewayError(
          `gateway_upstream_http_${upstreamResponse.status}`,
          upstreamResponse.status,
          {
            ...(requestId ? { 'x-ready-upstream-request-id': requestId } : {}),
            ...(retryAfter ? { 'retry-after': retryAfter } : {}),
          },
          providerError || undefined,
        )
      }
      if (!isCodexUpstreamEventStream(upstreamResponse, binding.snapshot)) {
        await upstreamResponse.body?.cancel()
        throw new CodexModelGatewayError('gateway_upstream_not_sse', 502)
      }
      if (!upstreamResponseBody) throw new CodexModelGatewayError('gateway_upstream_body_missing', 502)
      const upstreamRequestId = safeProviderHeader(
        upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('request-id'),
        credential,
        'request_id',
      )
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...(upstreamRequestId ? { 'x-ready-upstream-request-id': upstreamRequestId } : {}),
      })
      if (binding.snapshot.wireApi === 'chat/completions') {
        await streamChatAsResponses({
          body: upstreamResponseBody,
          write: (chunk) => response.write(chunk),
          allowedToolNames: allowedTools,
          toolArgumentValidators,
          snapshot: binding.snapshot,
          credential,
          abort: () => abortController.abort(),
          maxBytes: this.nativeMaxBytes,
          maxEvents: this.nativeMaxEvents,
          maxItemBytes: this.nativeMaxItemBytes,
          eventIdleMs: this.eventIdleMs,
          postTerminalDrainMs: this.postTerminalDrainMs,
          admitToolResponse,
          recordCompleted,
        })
      } else {
        await streamNativeResponses({
          body: upstreamResponseBody,
          response,
          allowedTools,
          toolArgumentValidators,
          expectedModel: binding.snapshot.model,
          normalizeChatGptOAuth: isChatGptOAuthResponsesSnapshot(binding.snapshot),
          credential,
          abort: () => abortController.abort(),
          maxBytes: this.nativeMaxBytes,
          maxEvents: this.nativeMaxEvents,
          maxItemBytes: this.nativeMaxItemBytes,
          eventIdleMs: this.eventIdleMs,
          postTerminalDrainMs: this.postTerminalDrainMs,
          admitToolResponse,
          recordCompleted,
        })
      }
      completed = true
      response.end()
    } finally {
      this.activeAbortControllers.delete(abortController)
      request.off('aborted', abortForRequest)
      response.off('close', abortForResponse)
    }
  }
}
