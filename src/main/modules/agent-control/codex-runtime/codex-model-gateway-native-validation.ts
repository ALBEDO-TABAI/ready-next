/** Pure Responses event state machine: identity, arguments, usage and terminal consistency. */
import {
  assertExactKeys,
  CodexModelGatewayError,
  isRecord,
  type JsonObject,
  nonEmptyString,
  carriesBearerCredential,
  isRequestedUpstreamModel,
} from './codex-model-gateway-common'
import { type CodexToolArgumentValidator, digestCanonicalJson } from './codex-model-gateway-contract'
import { CODEX_PROVIDER_RESPONSE_EVENT_TYPES } from './codex-provider-stream-policy'

const ALLOWED_NATIVE_EVENTS = new Set(CODEX_PROVIDER_RESPONSE_EVENT_TYPES)

const ALLOWED_ITEM_TYPES = new Set(['message', 'function_call', 'reasoning'])

const ALLOWED_MESSAGE_CONTENT_TYPES = new Set(['output_text', 'refusal'])

export const NATIVE_EVENT_KEYS: Readonly<Record<string, readonly string[]>> = {
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
    'type', 'sequence_number', 'item_id', 'output_index', 'arguments', 'name',
  ],
  'response.reasoning_text.delta': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'delta',
  ],
  'response.reasoning_text.done': [
    'type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'text',
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
  phase: string | null
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

export type NativeResponseState = {
  responseId: string | null
  inProgressSeen: boolean
  terminal: boolean
  items: Map<number, NativeItemState>
  itemIds: Set<string>
  callIds: Set<string>
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
      ['id', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details', 'object', 'created_at'],
      'gateway_response_shape_invalid',
    )
  }
  if (isRecord(payload.response) && (
    (payload.response.object !== undefined && payload.response.object !== 'response')
    || (payload.response.created_at !== undefined && (!Number.isSafeInteger(payload.response.created_at) || Number(payload.response.created_at) < 0))
  )) throw new CodexModelGatewayError('gateway_response_shape_invalid', 502)
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
  if ((item.type === 'message' || item.type === 'reasoning') && Array.isArray(item.content)) {
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
    phase: typeof item.phase === 'string' ? item.phase : null,
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
  if (expected.type === 'message' && expected.phase === null && actual.phase !== null) {
    const { phase: _phase, ...withoutPhase } = item
    if (nativeItemIdentityDigest(withoutPhase) === expected.identityDigest) {
      expected.phase = actual.phase
      expected.identityDigest = actual.identityDigest
    }
  }
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
  if ((credential && value.includes(credential)) || carriesBearerCredential(value)) {
    throw new CodexModelGatewayError('gateway_tool_arguments_secret_detected', 502)
  }
  const parsed = assertNativeToolArgumentsObject(value)
  if (!validators.get(toolName)?.safeParse(parsed).success) {
    throw new CodexModelGatewayError('gateway_tool_arguments_schema_invalid', 502)
  }
}

function assertNativeResponseModel(response: JsonObject, expectedModel: string): void {
  if (!isRequestedUpstreamModel(response.model, expectedModel)) {
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

export function validateNativeEvent(
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
      if ((existing.type === 'message' || existing.type === 'reasoning') && existing.messageParts.size > 0) {
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
    : (eventType.startsWith('response.reasoning_summary_') || eventType.startsWith('response.reasoning_text.'))
      ? 'reasoning'
      : (
          eventType.startsWith('response.output_text.')
          || eventType.startsWith('response.refusal.')
          ) ? 'message'
        : eventType.startsWith('response.content_part.') ? state.items.get(nativeOutputIndex(payload))?.type : null
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
        || !(item.type === 'reasoning' ? payload.part.type === 'reasoning_text' : ALLOWED_MESSAGE_CONTENT_TYPES.has(String(payload.part.type)))
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
    if (eventType.startsWith('response.output_text.') || eventType.startsWith('response.refusal.') || eventType.startsWith('response.reasoning_text.')) {
      const partIndex = nativePartIndex(payload, 'content_index')
      const partType = eventType.startsWith('response.refusal.') ? 'refusal' : eventType.startsWith('response.reasoning_text.') ? 'reasoning_text' : 'output_text'
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
      if (!item.name || (payload.name !== undefined && payload.name !== item.name)) throw new CodexModelGatewayError('gateway_response_tool_name_invalid', 502)
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
