/** Validate and bind the frozen request before resolving credentials or contacting a provider. */
import { redactPriorReadyMemoryHistory } from './codex-memory-history-redaction'
import { CodexModelGatewayError, isRecord, type JsonObject, nonEmptyString } from './codex-model-gateway-common'
import {
  canonicalJson,
  classifyCodexModelGatewayRequest,
  type CodexModelGatewayRequestEvidence,
  type CodexModelGatewayRequestKind,
  type CodexToolArgumentValidator,
  currentTurnReadyAdditionalContext,
  hasCurrentTurnReadyContext,
  digestCanonicalJson,
  digestReadyAdditionalContext,
  instructionTranscriptDigest,
  latestReadyResourceReferences,
  responsesToolArgumentValidators,
  responsesToolNames,
} from './codex-model-gateway-contract'
import type {
  CodexModelGatewayBinding,
  CodexModelGatewayMetadata,
  CodexModelGatewayOriginalRequestCapture,
} from './codex-model-gateway-types'

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

export function parseMetadata(body: JsonObject): CodexModelGatewayMetadata {
  if (!isRecord(body.client_metadata)) throw new CodexModelGatewayError('gateway_client_metadata_invalid')
  // The exact shape the pinned 0.160.1 runtime sends on every request: product turns and both compaction kinds.
  const outerKeys = [
    'x-codex-installation-id',
    'session_id',
    'x-codex-window-id',
    'turn_id',
    'thread_id',
    'root_turn_id',
    'x-codex-turn-metadata',
  ]
  if (JSON.stringify(Object.keys(body.client_metadata).sort()) !== JSON.stringify([...outerKeys].sort())) {
    throw new CodexModelGatewayError('gateway_client_metadata_shape_invalid')
  }
  const rawMetadata = body.client_metadata['x-codex-turn-metadata']
  if (typeof rawMetadata !== 'string') throw new CodexModelGatewayError('gateway_turn_metadata_missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMetadata)
  } catch {
    throw new CodexModelGatewayError('gateway_turn_metadata_invalid')
  }
  if (!isRecord(parsed)) throw new CodexModelGatewayError('gateway_turn_metadata_invalid')
  const hasForkedFromThreadId = 'forked_from_thread_id' in parsed
  if (hasForkedFromThreadId) {
    nonEmptyString(parsed.forked_from_thread_id, 'gateway_forked_from_thread_id_invalid')
  }
  const hasForkedFromOrdinal = 'forked_from_ordinal_exclusive' in parsed
  if (hasForkedFromOrdinal && (!hasForkedFromThreadId
    || !Number.isSafeInteger(parsed.forked_from_ordinal_exclusive)
    || Number(parsed.forked_from_ordinal_exclusive) < 0)) {
    throw new CodexModelGatewayError('gateway_forked_from_ordinal_exclusive_invalid')
  }
  // Present exactly when the turn runs with a reasoning effort; it must be the effort the request itself carries.
  const hasReasoningEffort = 'reasoning_effort' in parsed
  if (hasReasoningEffort && (typeof parsed.reasoning_effort !== 'string' || !parsed.reasoning_effort
    || !isRecord(body.reasoning) || body.reasoning.effort !== parsed.reasoning_effort)) {
    throw new CodexModelGatewayError('gateway_turn_metadata_reasoning_effort_invalid')
  }
  const baseInnerKeys = [
    'installation_id',
    'session_id',
    'thread_id',
    'turn_id',
    'root_turn_id',
    'window_id',
    'window_number',
    'context_window_id',
    'request_kind',
    'agent_name',
    'analytics_enabled',
    'auto_review_enabled',
    'node_repl_auto_review_required',
    'node_repl_disabled',
    'sandbox',
    'sandbox_mode',
    'turn_started_at_unix_ms',
    ...(hasReasoningEffort ? ['reasoning_effort'] : []),
    ...(hasForkedFromThreadId ? ['forked_from_thread_id'] : []),
    ...(hasForkedFromOrdinal ? ['forked_from_ordinal_exclusive'] : []),
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
    ? [...baseInnerKeys, 'model', ...readyKeys]
    : metadataKind === 'automatic_compaction'
      ? [...baseInnerKeys, 'compaction', ...readyKeys]
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
  if (
    nonEmptyString(outer.root_turn_id, 'gateway_root_turn_id_missing')
      !== nonEmptyString(parsed.root_turn_id, 'gateway_root_turn_id_missing')
    || parsed.root_turn_id !== parsed.turn_id
  ) throw new CodexModelGatewayError('gateway_root_turn_identity_mismatch')
  if (parsed.session_id !== parsed.thread_id) {
    throw new CodexModelGatewayError('gateway_root_session_thread_mismatch')
  }
  if (
    !Number.isSafeInteger(parsed.window_number)
    || Number(parsed.window_number) < 0
    || parsed.window_id !== `${String(parsed.thread_id)}:${String(parsed.window_number)}`
  ) throw new CodexModelGatewayError('gateway_root_window_thread_mismatch')
  nonEmptyString(parsed.context_window_id, 'gateway_context_window_id_missing')
  if (body.prompt_cache_key !== parsed.thread_id) {
    throw new CodexModelGatewayError('gateway_root_prompt_cache_thread_mismatch')
  }
  if (
    parsed.sandbox !== 'seatbelt'
    || parsed.sandbox_mode !== 'read-only'
    || parsed.agent_name !== '/root'
    || parsed.analytics_enabled !== false
    || parsed.auto_review_enabled !== false
    || parsed.node_repl_auto_review_required !== false
    || parsed.node_repl_disabled !== false
    || !Number.isSafeInteger(parsed.turn_started_at_unix_ms)
    || Number(parsed.turn_started_at_unix_ms) < 0
    || (metadataKind === 'product' && (typeof parsed.model !== 'string' || !parsed.model))
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

/**
 * The session identity Codex sends on every Responses call. Upstream prompt-cache
 * routing keys on it, so a hop that drops these headers turns every request into
 * a full prefill. Values come from client_metadata already checked by parseMetadata.
 */
/**
 * The ChatGPT Codex backend gives a turn's first response an opaque routing token, and Codex sends it back on
 * that turn's later requests; carried both ways, they reach the backend that holds the turn's prompt cache.
 */
export function codexTurnStateHeader(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_=.+/-]{1,8192}$/.test(value) ? value : null
}

export function codexSessionAffinityHeaders(body: JsonObject): Record<string, string> {
  const outer = body.client_metadata as JsonObject
  const threadId = String(outer.thread_id)
  const windowId = String(outer['x-codex-window-id'])
  const headerSafe = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
  if (!headerSafe.test(threadId) || !headerSafe.test(windowId)) return {}
  return {
    'session-id': threadId,
    'thread-id': threadId,
    'x-client-request-id': threadId,
    'x-codex-window-id': windowId,
  }
}

export function validateRequestShape(body: JsonObject): ReadonlyMap<string, CodexToolArgumentValidator> {
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

export function expectedKind(metadata: CodexModelGatewayMetadata): CodexModelGatewayRequestKind {
  try {
    return classifyCodexModelGatewayRequest(metadata.raw)
  } catch {
    throw new CodexModelGatewayError('gateway_request_unclassified', 409)
  }
}

function droppedTurnContext(
  input: unknown,
  readyRunId: string,
): ReturnType<typeof currentTurnReadyAdditionalContext> | null {
  if (!Array.isArray(input) || hasCurrentTurnReadyContext(input, readyRunId)) return null
  const lastUser = input.findLastIndex((item) => isRecord(item) && item.role === 'user')
  return {
    resourceReferences: [], explicitRetry: null, readyMemory: null, documentWidgetGuidance: null,
    replacedTurn: null, currentUserIndex: lastUser < 0 ? null : lastUser, readyMemoryIndex: null,
  }
}

export function validateBinding(input: {
  body: JsonObject
  metadata: CodexModelGatewayMetadata
  binding: CodexModelGatewayBinding
}): {
  allowedTools: ReadonlySet<string>
  currentTurnContext: ReturnType<typeof currentTurnReadyAdditionalContext> | null
} {
  const { body, metadata, binding } = input
  if (expectedKind(metadata) !== binding.kind) {
    throw new CodexModelGatewayError('gateway_binding_kind_mismatch', 409)
  }
  if (body.model !== binding.codexModel
    || (binding.kind === 'product' && metadata.raw.model !== binding.codexModel)) {
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
  if (digestCanonicalJson(tools) !== binding.requestToolsDigest) {
    throw new CodexModelGatewayError('gateway_tool_surface_mismatch', 409)
  }
  let currentTurnContext: ReturnType<typeof currentTurnReadyAdditionalContext> | null = null
  if (binding.kind === 'product') {
    if (
      metadata.toolSurfaceDigest !== binding.toolSurfaceDigest
      || metadata.turnContractDigest !== binding.turnContractDigest
      || metadata.upstreamProfileSnapshotDigest !== binding.snapshotDigest
      || !metadata.readyRunId
    ) throw new CodexModelGatewayError('gateway_product_metadata_mismatch', 409)
    let exactContext: ReturnType<typeof currentTurnReadyAdditionalContext> | null = null
    try {
      exactContext = currentTurnReadyAdditionalContext(body.input, binding.deliveredUserTail, metadata.readyRunId)
    } catch {
      // silent-catch: an unreadable turn context counts as absent and must then pass the compaction check below or fail as a mismatch
      exactContext = null
    }
    if (exactContext && binding.additionalContextDigest !== null
      && digestReadyAdditionalContext(exactContext) === binding.additionalContextDigest) {
      currentTurnContext = exactContext
    } else {
      // After an automatic compaction Codex rebuilds the history from its summary and drops the turn's Ready
      // context; that is the only mismatch allowed, and only when nothing of the context is left.
      const droppedByCompaction = binding.compactedEarlierInTurn === true
        ? droppedTurnContext(body.input, metadata.readyRunId)
        : null
      if (!droppedByCompaction) throw new CodexModelGatewayError('gateway_additional_context_mismatch', 409)
      currentTurnContext = droppedByCompaction
    }
  } else if (
    tools.length !== 0
    || binding.toolSurfaceDigest !== digestCanonicalJson([])
    || binding.requestToolsDigest !== digestCanonicalJson([])
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
  return { allowedTools, currentTurnContext }
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

export function buildValidatedRequestCapture(input: {
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

export function durableRequestEvidence(
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
