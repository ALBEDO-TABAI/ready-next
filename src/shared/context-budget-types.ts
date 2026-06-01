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
