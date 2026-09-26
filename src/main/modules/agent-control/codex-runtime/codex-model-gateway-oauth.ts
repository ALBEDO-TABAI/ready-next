import { isRecord, type JsonObject } from './codex-model-gateway-common'
import { NATIVE_EVENT_KEYS } from './codex-model-gateway-native-validation'

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
