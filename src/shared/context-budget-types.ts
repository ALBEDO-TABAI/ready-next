import type { AgentInputItem } from '@openai/agents'
import type { AIModelDef } from './ai-providers'

export const DEFAULT_CONTEXT_WINDOW = 200_000
export const MAX_CONTEXT_WINDOW = 2_000_000
export const CONTEXT_SOFT_RATIO = 0.8

export interface ContextBudgetState {
  windowTokens: number
  usedTokens: number
  pendingDeltaTokens: number
  projectedTokens: number
  ratio: number
  phase: 'ok' | 'soft' | 'hard'
}

export function resolveModelContextWindow(
  config: { contextWindowOverride?: number | null } | null | undefined,
  modelDef?: Pick<AIModelDef, 'contextWindow'> | null,
): number {
  const raw = Number(config?.contextWindowOverride ?? modelDef?.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
  if (!Number.isFinite(raw)) return DEFAULT_CONTEXT_WINDOW
  return Math.max(1, Math.min(MAX_CONTEXT_WINDOW, Math.floor(raw)))
}

export function computeContextBudget(params: {
  windowTokens: number
  lastUsageTokens?: number | null
  pendingDeltaTokens?: number | null
}): ContextBudgetState {
  const rawWindowTokens = Number(params.windowTokens)
  const windowTokens = Number.isFinite(rawWindowTokens)
    ? Math.max(1, Math.min(MAX_CONTEXT_WINDOW, Math.floor(rawWindowTokens)))
    : DEFAULT_CONTEXT_WINDOW
  const usedTokens = Math.max(0, Math.ceil(Number(params.lastUsageTokens) || 0))
  const pendingDeltaTokens = Math.max(0, Math.ceil(Number(params.pendingDeltaTokens) || 0))
  const projectedTokens = usedTokens + pendingDeltaTokens
  const ratio = projectedTokens / windowTokens
  return {
    windowTokens,
    usedTokens,
    pendingDeltaTokens,
    projectedTokens,
    ratio,
    phase: ratio >= 1 ? 'hard' : ratio >= CONTEXT_SOFT_RATIO ? 'soft' : 'ok',
  }
}

const textEncoder = new TextEncoder()
const OPAQUE_IMAGE_REF_TOKENS = 85_000
const OPAQUE_FILE_REF_TOKENS = 120_000
const OPAQUE_AUDIO_REF_TOKENS = 120_000

export function estimateTextTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char)) {
      tokens += 1
    } else if ((char.codePointAt(0) ?? 0) <= 0x7f) {
      tokens += 0.25
    } else {
      tokens += 0.5
    }
  }
  return Math.ceil(tokens)
}

export function estimateInputItemTokens(items: AgentInputItem[]): number {
  return items.reduce((total, item) => total + estimateUnknownTokens(item), 0)
}

function estimateUnknownTokens(value: unknown, keyHint = ''): number {
  if (typeof value === 'string') {
    if (/^(?:data:|[A-Za-z0-9+/]{200,}={0,2}$)/.test(value)) {
      return Math.max(value.length, estimateTextTokens(value))
    }
    return estimateTextTokens(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return 1
  }
  if (value instanceof Uint8Array) {
    return Math.ceil(value.byteLength * 4 / 3)
  }
  if (Array.isArray(value)) {
    return jsonFallbackTokens(value) + value.reduce((total, item) => total + estimateUnknownTokens(item, keyHint), 0)
  }
  if (typeof value !== 'object') return 1

  const record = value as Record<string, unknown>
  let semanticTokens = 0
  const type = typeof record.type === 'string' ? record.type : ''
  for (const [key, child] of Object.entries(record)) {
    semanticTokens += estimateUnknownTokens(child, key)
    if (isOpaqueMediaReference(child)) {
      semanticTokens += opaqueMediaReferenceTokens(type, key)
    }
  }
  if (isOpaqueMediaReference(record)) {
    semanticTokens += opaqueMediaReferenceTokens(type, keyHint)
  }
  return Math.max(jsonFallbackTokens(value), semanticTokens)
}

function jsonFallbackTokens(value: unknown): number {
  try {
    return Math.ceil(textEncoder.encode(JSON.stringify(value)).length / 3)
  } catch {
    return 1
  }
}

// ── R-CTX (P2) — provider-request section bill (instrumentation only) ─────────
// Attribute each provider request's estimated tokens to a source SECTION so the
// 565–633K bloat can be diagnosed (is the same image re-sent every turn? is it
// history accumulation? tool_results?). Pure classification; no behavior change.
export interface ProviderRequestBill {
  totalTokens: number
  itemCount: number
  visionItems: number
  sections: {
    vision: number
    history: number
    tool_results: number
    skill_inline: number
    reminders: number
    other: number
  }
}

const TOOL_TRACE_ITEM_TYPES = new Set([
  'function_call', 'computer_call', 'shell_call', 'apply_patch_call', 'tool_search_call',
  'function_call_result', 'computer_call_result', 'shell_call_output', 'apply_patch_call_output', 'tool_search_output',
])

function itemContainsImageRef(value: unknown, keyHint = ''): boolean {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return false
  if (Array.isArray(value)) return value.some((child) => itemContainsImageRef(child, keyHint))
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  const marker = `${type} ${keyHint}`.toLowerCase()
  // Canonical @openai/agents InputImage the app actually sends (toSdkInput):
  // { type:'input_image', image: <data-url string | {id}> }. The key is `image`.
  if (type === 'input_image' && 'image' in record) return true
  // Computer/browser screenshot payloads: { type:'computer_screenshot', data:… }.
  if (type === 'computer_screenshot') return true
  // Opaque media references (id/url/fileId/image_url) in an image/screenshot slot.
  const hasRef = typeof record.id === 'string' || typeof record.url === 'string'
    || typeof record.fileId === 'string' || 'image_url' in record
  if (hasRef && (marker.includes('image') || marker.includes('screenshot'))) return true
  return Object.entries(record).some(([key, child]) => itemContainsImageRef(child, key))
}

function itemPlainText(item: AgentInputItem): string {
  if (!item || typeof item !== 'object') return ''
  const content = (item as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string'
        ? part
        : part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? (part as Record<string, unknown>).text as string
          : ''))
      .join(' ')
  }
  return ''
}

/**
 * Attribute a provider request's estimated tokens to disjoint sections. Each item
 * lands in exactly one section, so the sections sum to totalTokens. Classification
 * is best-effort (vision/tool_results are precise from item type; reminders/
 * skill_inline are marker-based) — enough to answer the attribution question.
 */
export function billProviderRequestSections(items: AgentInputItem[]): ProviderRequestBill {
  const sections = { vision: 0, history: 0, tool_results: 0, skill_inline: 0, reminders: 0, other: 0 }
  let visionItems = 0
  for (const item of items) {
    const tokens = estimateInputItemTokens([item])
    // Total-safe: a null/non-object item must never throw here (the caller runs
    // inside callModelInputFilter with no try/catch — a throw breaks the provider
    // call). estimateInputItemTokens already tolerates it; classification must too.
    const record = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const type = typeof record.type === 'string' ? record.type : ''
    const role = typeof record.role === 'string' ? record.role : ''
    if (itemContainsImageRef(item)) {
      sections.vision += tokens
      visionItems += 1
    } else if (TOOL_TRACE_ITEM_TYPES.has(type)) {
      sections.tool_results += tokens
    } else {
      const text = itemPlainText(item)
      if (role === 'system' || text.includes('<system-reminder>')) {
        sections.reminders += tokens
      } else if (text.includes('SKILL.md') || text.includes('skill-runtime') || /(?:^|\n)---\n[\s\S]*?\nname:/.test(text)) {
        sections.skill_inline += tokens
      } else if (role === 'user' || role === 'assistant' || type === 'message') {
        sections.history += tokens
      } else {
        sections.other += tokens
      }
    }
  }
  const totalTokens = sections.vision + sections.history + sections.tool_results
    + sections.skill_inline + sections.reminders + sections.other
  return { totalTokens, itemCount: items.length, visionItems, sections }
}

function isOpaqueMediaReference(value: unknown): boolean {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    || typeof record.url === 'string'
    || typeof record.fileId === 'string'
}

function opaqueMediaReferenceTokens(type: string, key: string): number {
  const marker = `${type} ${key}`.toLowerCase()
  if (marker.includes('audio')) return OPAQUE_AUDIO_REF_TOKENS
  if (marker.includes('file')) return OPAQUE_FILE_REF_TOKENS
  if (marker.includes('image') || marker.includes('screenshot')) return OPAQUE_IMAGE_REF_TOKENS
  return 0
}
