import type { AIModelConfig, AIReasoningEffort } from '../ai-providers'

export const KIMI_K3_REASONING_EFFORTS = ['low', 'high', 'max'] as const satisfies readonly AIReasoningEffort[]
export const KIMI_K3_DEFAULT_REASONING_EFFORT = 'high' as const
export const KIMI_K3_CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27' as const
export const KIMI_K3_SESSION_IDENTITY_FIELD = 'readyModelSessionIdentity' as const
export const KIMI_K3_SESSION_IDENTITY = 'kimi-k3-preserved-thinking-v1' as const

export type KimiK3ReasoningEffort = (typeof KIMI_K3_REASONING_EFFORTS)[number]

type KimiK3ConfigLike = Pick<AIModelConfig, 'baseUrl' | 'model' | 'reasoningEffort'>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isKimiCodingBaseUrl(baseUrl: unknown): boolean {
  try {
    const parsed = new URL(String(baseUrl || '').trim())
    return parsed.protocol === 'https:'
      && parsed.hostname.toLowerCase() === 'api.kimi.com'
      && parsed.pathname.replace(/\/+$/, '') === '/coding'
  } catch {
    return false
  }
}

export function isKimiK3Config(config: KimiK3ConfigLike | null | undefined): boolean {
  return Boolean(
    config
      && String(config.model || '').trim() === 'k3'
      && isKimiCodingBaseUrl(config.baseUrl),
  )
}

export function resolveKimiK3ReasoningEffort(
  effort: unknown,
): KimiK3ReasoningEffort {
  return effort === 'low' || effort === 'high' || effort === 'max'
    ? effort
    : KIMI_K3_DEFAULT_REASONING_EFFORT
}

export function applyKimiK3AnthropicRequestContract(
  body: Record<string, unknown>,
  config: KimiK3ConfigLike,
): Record<string, unknown> {
  if (!isKimiK3Config(config)) return body

  body.thinking = { type: 'enabled' }
  body.output_config = {
    ...(asRecord(body.output_config) || {}),
    effort: resolveKimiK3ReasoningEffort(config.reasoningEffort),
  }

  const contextManagement = asRecord(body.context_management) || {}
  const existingEdits = Array.isArray(contextManagement.edits)
    ? contextManagement.edits.filter((edit) => asRecord(edit)?.type !== 'clear_thinking_20251015')
    : []
  body.context_management = {
    ...contextManagement,
    edits: [
      { type: 'clear_thinking_20251015', keep: 'all' },
      ...existingEdits,
    ],
  }
  return body
}

export function applyKimiK3AnthropicHeaders(
  headers: Record<string, string>,
  config: KimiK3ConfigLike,
): Record<string, string> {
  if (!isKimiK3Config(config)) return headers

  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'anthropic-beta')
  const key = existingKey || 'anthropic-beta'
  const betas = String(headers[key] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!betas.includes(KIMI_K3_CONTEXT_MANAGEMENT_BETA)) {
    betas.push(KIMI_K3_CONTEXT_MANAGEMENT_BETA)
  }
  headers[key] = betas.join(',')
  return headers
}

export function kimiK3ResponseProviderData(
  config: KimiK3ConfigLike,
): Record<string, unknown> | undefined {
  return isKimiK3Config(config)
    ? { [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY }
    : undefined
}

export function readKimiK3SessionIdentity(value: unknown): string | null {
  const record = asRecord(value)
  if (!record) return null
  const direct = record[KIMI_K3_SESSION_IDENTITY_FIELD]
  if (typeof direct === 'string' && direct) return direct
  const providerData = asRecord(record.providerData)
  if (!providerData) return null
  const nested = providerData[KIMI_K3_SESSION_IDENTITY_FIELD]
  return typeof nested === 'string' && nested ? nested : null
}

function isCompactionSummary(record: Record<string, unknown>): boolean {
  return record.role === 'user'
    && typeof record.content === 'string'
    && record.content.includes('[ready:context-compacted]')
}

function isModelHistoryItem(record: Record<string, unknown>): boolean {
  if (record.role === 'assistant') return true
  if (isCompactionSummary(record)) return true
  return record.type === 'reasoning'
    || record.type === 'function_call'
    || record.type === 'computer_call'
    || record.type === 'shell_call'
    || record.type === 'apply_patch_call'
    || record.type === 'tool_search_call'
    || record.type === 'hosted_tool_call'
}

export type KimiK3HistoryInspection =
  | { compatible: true; reason: 'no_model_history' | 'kimi_k3_history' }
  | { compatible: false; reason: 'foreign_or_unmarked_model_history' }

export function inspectKimiK3History(items: unknown): KimiK3HistoryInspection {
  if (!Array.isArray(items)) return { compatible: true, reason: 'no_model_history' }
  let foundModelHistory = false
  for (const value of items) {
    const record = asRecord(value)
    if (!record || !isModelHistoryItem(record)) continue
    foundModelHistory = true
    if (readKimiK3SessionIdentity(record) !== KIMI_K3_SESSION_IDENTITY) {
      return { compatible: false, reason: 'foreign_or_unmarked_model_history' }
    }
  }
  return foundModelHistory
    ? { compatible: true, reason: 'kimi_k3_history' }
    : { compatible: true, reason: 'no_model_history' }
}

export function kimiK3CompactionProviderData(
  items: unknown,
): Record<string, unknown> | undefined {
  const inspection = inspectKimiK3History(items)
  return inspection.compatible && inspection.reason === 'kimi_k3_history'
    ? { [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY }
    : undefined
}
