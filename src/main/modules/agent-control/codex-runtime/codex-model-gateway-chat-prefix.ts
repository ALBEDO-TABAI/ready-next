import type { AIModelConfig } from '../../../../shared/ai-providers'
import {
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
} from '../../../../shared/ai-providers/index'
import { REGISTERED_PATCH_PROFILES } from '../../../../shared/ai-providers/resolve-provider-patch-profile'
import type { CodexUpstreamProfileSnapshot } from './codex-model-gateway-contract'

type JsonObject = Record<string, unknown>

export type CodexChatPreSemanticState = {
  upstreamResponseId: string | null
}

export type CodexChatPrefixInspection =
  | { kind: 'invalid'; code: string }
  | { kind: 'provider_error'; payload: JsonObject; error: JsonObject }
  | { kind: 'neutral' | 'semantic'; payload: JsonObject }

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function createCodexChatPreSemanticState(): CodexChatPreSemanticState {
  return { upstreamResponseId: null }
}

function patchChatPayload(input: {
  payload: JsonObject
  snapshot: CodexUpstreamProfileSnapshot
}): JsonObject | null {
  const config: AIModelConfig = {
    provider: input.snapshot.providerId as AIModelConfig['provider'],
    baseUrl: input.snapshot.baseUrl,
    apiKey: '',
    model: input.snapshot.model,
    agentProtocol: 'openai',
    wireApi: 'chat/completions',
    reasoningEffort: input.snapshot.reasoningEffort || undefined,
  }
  const patchProfile = input.snapshot.patchProfileId
    ? REGISTERED_PATCH_PROFILES.find((profile) => profile.profileId === input.snapshot.patchProfileId) || null
    : null
  const defaultPatchers = resolveProviderDefaultPatchers(input.snapshot.providerId)
  const patched = applyProviderResponsePatch(input.payload, {
    config,
    baseUrl: input.snapshot.baseUrl,
    model: input.snapshot.model,
    profile: patchProfile,
    providerDefaultRequestPatcher: defaultPatchers.defaultRequestPatcher,
    providerDefaultResponsePatcher: defaultPatchers.defaultResponsePatcher,
  })
  return isRecord(patched) ? patched : null
}

export function inspectCodexChatPrefix(input: {
  parsedPayload: JsonObject
  snapshot: CodexUpstreamProfileSnapshot
  credential: string
  state: CodexChatPreSemanticState
}): CodexChatPrefixInspection {
  let payload: JsonObject | null
  try {
    payload = patchChatPayload({ payload: input.parsedPayload, snapshot: input.snapshot })
  } catch {
    // silent-catch: a provider response patch that throws classifies the chunk as invalid (gateway_chat_stream_failed)
    return { kind: 'invalid', code: 'gateway_chat_stream_failed' }
  }
  if (!payload) return { kind: 'invalid', code: 'gateway_chat_sse_payload_invalid' }
  if (Object.keys(payload).some((key) => ![
    'id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier',
    'choices', 'usage', 'error', 'status',
  ].includes(key))) return { kind: 'invalid', code: 'gateway_chat_chunk_field_not_allowed' }
  if (payload.object !== undefined && typeof payload.object !== 'string') {
    return { kind: 'invalid', code: 'gateway_chat_chunk_metadata_invalid' }
  }
  if (
    payload.created !== undefined
    && (!Number.isSafeInteger(payload.created) || Number(payload.created) < 0)
  ) return { kind: 'invalid', code: 'gateway_chat_chunk_metadata_invalid' }
  for (const field of ['system_fingerprint', 'service_tier'] as const) {
    if (payload[field] !== undefined && payload[field] !== null && typeof payload[field] !== 'string') {
      return { kind: 'invalid', code: 'gateway_chat_chunk_metadata_invalid' }
    }
  }
  if (payload.error !== undefined) {
    if (!isRecord(payload.error)) {
      return { kind: 'invalid', code: 'gateway_chat_stream_error_invalid' }
    }
    if (
      payload.model !== undefined
      || payload.choices !== undefined
      || (payload.usage !== undefined && payload.usage !== null)
      || payload.status !== undefined
    ) return { kind: 'invalid', code: 'gateway_chat_stream_error_mixed' }
    return { kind: 'provider_error', payload, error: payload.error }
  }
  if (typeof payload.model !== 'string' || payload.model !== input.snapshot.model) {
    return { kind: 'invalid', code: 'gateway_upstream_model_mismatch' }
  }
  if (payload.id !== undefined) {
    if (typeof payload.id !== 'string' || !payload.id) {
      return { kind: 'invalid', code: 'gateway_chat_response_id_invalid' }
    }
    if (
      (input.credential && payload.id.includes(input.credential))
      || /Bearer\s+/i.test(payload.id)
    ) return { kind: 'invalid', code: 'gateway_provider_credential_in_identity' }
    if (input.state.upstreamResponseId && input.state.upstreamResponseId !== payload.id) {
      return { kind: 'invalid', code: 'gateway_chat_response_id_changed' }
    }
    input.state.upstreamResponseId = payload.id
  }
  if (payload.status !== undefined) {
    return { kind: 'invalid', code: 'gateway_chat_status_unsupported' }
  }
  if (payload.usage !== undefined && payload.usage !== null) {
    return { kind: 'semantic', payload }
  }
  if (!Array.isArray(payload.choices) || payload.choices.length > 1) {
    return { kind: 'invalid', code: 'gateway_chat_choices_invalid' }
  }
  if (payload.choices.length === 0) return { kind: 'neutral', payload }
  const choice = payload.choices[0]
  if (!isRecord(choice)) return { kind: 'invalid', code: 'gateway_chat_choice_invalid' }
  if (Object.keys(choice).some((key) => ![
    'index', 'delta', 'message', 'finish_reason', 'logprobs',
  ].includes(key))) return { kind: 'invalid', code: 'gateway_chat_choice_field_not_allowed' }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    return { kind: 'invalid', code: 'gateway_chat_logprobs_unsupported' }
  }
  if (choice.index !== undefined && choice.index !== 0) {
    return { kind: 'invalid', code: 'gateway_chat_choice_index_invalid' }
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    return { kind: 'semantic', payload }
  }
  if (choice.delta !== undefined && choice.message !== undefined) {
    return { kind: 'invalid', code: 'gateway_chat_delta_invalid' }
  }
  const delta = choice.delta !== undefined ? choice.delta : choice.message
  if (!isRecord(delta)) return { kind: 'invalid', code: 'gateway_chat_delta_invalid' }
  if (Object.keys(delta).some((key) => ![
    'role', 'content', 'tool_calls', 'function_call', 'refusal', 'audio',
    'additional_kwargs', 'reasoning_details', 'reasoning_summary', 'reasoning_content',
  ].includes(key))) return { kind: 'invalid', code: 'gateway_chat_delta_field_not_allowed' }
  if (delta.role !== undefined && delta.role !== 'assistant') {
    return { kind: 'invalid', code: 'gateway_chat_role_invalid' }
  }
  if (delta.function_call !== undefined || (delta.refusal !== undefined && delta.refusal !== null)) {
    return { kind: 'semantic', payload }
  }
  if (delta.audio !== undefined && delta.audio !== null) return { kind: 'semantic', payload }
  if (delta.content !== undefined && delta.content !== null) {
    if (typeof delta.content !== 'string') return { kind: 'semantic', payload }
    if (delta.content) return { kind: 'semantic', payload }
  }
  if (delta.additional_kwargs !== undefined && !isRecord(delta.additional_kwargs)) {
    return { kind: 'invalid', code: 'gateway_chat_reasoning_invalid' }
  }
  const additional = isRecord(delta.additional_kwargs) ? delta.additional_kwargs : {}
  if (Object.keys(additional).some((key) => key !== 'reasoning_content')) {
    return { kind: 'invalid', code: 'gateway_chat_reasoning_invalid' }
  }
  if (
    additional.reasoning_content !== undefined
    && additional.reasoning_content !== null
    && typeof additional.reasoning_content !== 'string'
  ) return { kind: 'invalid', code: 'gateway_chat_reasoning_invalid' }
  if (delta.reasoning_details !== undefined && !Array.isArray(delta.reasoning_details)) {
    return { kind: 'invalid', code: 'gateway_chat_reasoning_invalid' }
  }
  for (const field of ['reasoning_summary', 'reasoning_content'] as const) {
    if (delta[field] !== undefined && delta[field] !== null && typeof delta[field] !== 'string') {
      return { kind: 'invalid', code: 'gateway_chat_reasoning_invalid' }
    }
  }
  if (
    (typeof delta.reasoning_summary === 'string' && delta.reasoning_summary)
    || (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
    || (typeof additional.reasoning_content === 'string' && additional.reasoning_content)
    || (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0)
  ) return { kind: 'semantic', payload }
  if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
    return { kind: 'invalid', code: 'gateway_chat_tool_calls_invalid' }
  }
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
    return { kind: 'semantic', payload }
  }
  return { kind: 'neutral', payload }
}
