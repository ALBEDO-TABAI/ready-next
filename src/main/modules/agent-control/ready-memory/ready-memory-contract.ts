import { createHash } from 'node:crypto'

import {
  READY_MEMORY_SNAPSHOT_CONTRACT,
  READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS,
  READY_MEMORY_SNAPSHOT_ENTRY_LIMIT,
  READY_MEMORY_SUMMARY_BUDGET_CHARS,
  type ReadyMemorySnapshot,
  type ReadyMemorySnapshotEntry,
} from './ready-memory-types'

export const READY_MEMORY_ADDITIONAL_CONTEXT_KEY = 'ready-memory:v1' as const
export const READY_MEMORY_SEARCH_TOOL_NAME = 'ready_memory_search' as const

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) throw new Error('ready_memory_contract_invalid')
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  )
}

export function canonicalReadyMemoryJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function digestReadyMemoryValue(value: unknown): string {
  return createHash('sha256').update(canonicalReadyMemoryJson(value)).digest('hex')
}

function exactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length
    && [...keys].sort().every((key, index) => key === actual[index])
}

function validStringArray(value: unknown, limit: number): value is string[] {
  return Array.isArray(value)
    && value.length <= limit
    && value.every((item) => typeof item === 'string' && item.length > 0)
    && new Set(value).size === value.length
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value
}

function validSnapshotEntry(value: unknown, snapshotRevision: number): value is ReadyMemorySnapshotEntry {
  if (!isRecord(value) || !exactKeys(value, [
    'category', 'content', 'contentDigest', 'entryId', 'origin', 'pinned', 'sourceRefs', 'stateRevision',
  ])) return false
  if (typeof value.entryId !== 'string' || !value.entryId
    || !['preference', 'fact', 'project', 'workflow', 'other'].includes(String(value.category))
    || typeof value.content !== 'string' || !value.content.trim()
    || typeof value.contentDigest !== 'string'
    || value.contentDigest !== createHash('sha256').update(value.content).digest('hex')
    || !['manual', 'consolidated'].includes(String(value.origin))
    || typeof value.pinned !== 'boolean'
    || !validStringArray(value.sourceRefs, 32)
    || !Number.isSafeInteger(value.stateRevision)
    || Number(value.stateRevision) < 1
    || Number(value.stateRevision) > snapshotRevision) return false
  return value.origin === 'manual' || value.sourceRefs.length > 0
}

export function assertReadyMemorySnapshot(value: unknown): asserts value is ReadyMemorySnapshot {
  if (!isRecord(value) || !exactKeys(value, [
    'contract', 'enabled', 'entries', 'frozenAt', 'lastRevocationReason', 'revocationRevision',
    'snapshotDigest', 'sourceRefs', 'stateRevision', 'summary', 'summaryBudgetChars',
    'summaryChars', 'summaryEntryIds', 'truncated',
  ])) throw new Error('ready_memory_snapshot_invalid')
  if (value.contract !== READY_MEMORY_SNAPSHOT_CONTRACT
    || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.stateRevision) || Number(value.stateRevision) < 1
    || !Number.isSafeInteger(value.revocationRevision) || Number(value.revocationRevision) < 0
    || Number(value.revocationRevision) > Number(value.stateRevision)
    || (value.lastRevocationReason !== null && ![
      'edit', 'delete', 'reset', 'use_off', 'generate_off', 'supersede', 'expire',
    ].includes(String(value.lastRevocationReason)))
    || !validIsoTimestamp(value.frozenAt)
    || value.summaryBudgetChars !== READY_MEMORY_SUMMARY_BUDGET_CHARS
    || typeof value.summary !== 'string'
    || Array.from(value.summary).length !== value.summaryChars
    || Number(value.summaryChars) > READY_MEMORY_SUMMARY_BUDGET_CHARS
    || !validStringArray(value.summaryEntryIds, READY_MEMORY_SNAPSHOT_ENTRY_LIMIT)
    || !Array.isArray(value.entries) || value.entries.length > READY_MEMORY_SNAPSHOT_ENTRY_LIMIT
    || value.entries.reduce((total, entry) => total + (isRecord(entry)
      && typeof entry.content === 'string' ? Array.from(entry.content).length : 0), 0)
      > READY_MEMORY_SNAPSHOT_CONTENT_BUDGET_CHARS
    || !value.entries.every((entry) => validSnapshotEntry(entry, Number(value.stateRevision)))
    || new Set((value.entries as ReadyMemorySnapshotEntry[]).map((entry) => entry.entryId)).size
      !== (value.entries as ReadyMemorySnapshotEntry[]).length
    || !value.summaryEntryIds.every((id) => (value.entries as ReadyMemorySnapshotEntry[])
      .some((entry) => entry.entryId === id))
    || !validStringArray(value.sourceRefs, READY_MEMORY_SNAPSHOT_ENTRY_LIMIT * 32)
    || typeof value.truncated !== 'boolean'
    || typeof value.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotDigest)) {
    throw new Error('ready_memory_snapshot_invalid')
  }
  const { snapshotDigest, ...core } = value
  if (digestReadyMemoryValue(core) !== snapshotDigest) throw new Error('ready_memory_snapshot_invalid')
  if (!value.enabled && (value.summary || value.entries.length > 0 || value.summaryEntryIds.length > 0)) {
    throw new Error('ready_memory_snapshot_invalid')
  }
}

export type ReadyMemoryPromptPayload = Readonly<{
  contract: typeof READY_MEMORY_SNAPSHOT_CONTRACT
  snapshotDigest: string
  stateRevision: number
  revocationRevision: number
  frozenAt: string
  summary: string
  summaryEntryIds: string[]
  truncated: boolean
  priority: 'current_user_over_memory'
}>

export function readyMemoryPromptPayload(
  snapshot: ReadyMemorySnapshot,
): ReadyMemoryPromptPayload | null {
  assertReadyMemorySnapshot(snapshot)
  if (!snapshot.enabled || !snapshot.summary) return null
  return Object.freeze({
    contract: READY_MEMORY_SNAPSHOT_CONTRACT,
    snapshotDigest: snapshot.snapshotDigest,
    stateRevision: snapshot.stateRevision,
    revocationRevision: snapshot.revocationRevision,
    frozenAt: snapshot.frozenAt,
    summary: snapshot.summary,
    summaryEntryIds: [...snapshot.summaryEntryIds],
    truncated: snapshot.truncated,
    priority: 'current_user_over_memory' as const,
  })
}

export function readyMemoryPromptText(payload: ReadyMemoryPromptPayload): string {
  return `<${READY_MEMORY_ADDITIONAL_CONTEXT_KEY}>${canonicalReadyMemoryJson(payload)}</${READY_MEMORY_ADDITIONAL_CONTEXT_KEY}>`
}

export function parseReadyMemoryPromptText(text: string): ReadyMemoryPromptPayload | null {
  const match = text.match(/^<ready-memory:v1>([\s\S]*)<\/ready-memory:v1>$/)
  if (!match) return null
  let value: unknown
  try {
    value = JSON.parse(match[1])
  } catch {
    throw new Error('ready_memory_prompt_invalid')
  }
  if (!isRecord(value) || !exactKeys(value, [
    'contract', 'frozenAt', 'priority', 'revocationRevision', 'snapshotDigest', 'stateRevision',
    'summary', 'summaryEntryIds', 'truncated',
  ]) || value.contract !== READY_MEMORY_SNAPSHOT_CONTRACT
    || typeof value.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotDigest)
    || !Number.isSafeInteger(value.stateRevision) || Number(value.stateRevision) < 1
    || !Number.isSafeInteger(value.revocationRevision) || Number(value.revocationRevision) < 0
    || Number(value.revocationRevision) > Number(value.stateRevision)
    || !validIsoTimestamp(value.frozenAt)
    || typeof value.summary !== 'string' || Array.from(value.summary).length > READY_MEMORY_SUMMARY_BUDGET_CHARS
    || !validStringArray(value.summaryEntryIds, READY_MEMORY_SNAPSHOT_ENTRY_LIMIT)
    || typeof value.truncated !== 'boolean'
    || value.priority !== 'current_user_over_memory') {
    throw new Error('ready_memory_prompt_invalid')
  }
  return value as ReadyMemoryPromptPayload
}

export function searchReadyMemorySnapshot(input: {
  snapshot: ReadyMemorySnapshot
  query: string
  limit: number
}): ReadyMemorySnapshotEntry[] {
  assertReadyMemorySnapshot(input.snapshot)
  const query = input.query.trim().toLocaleLowerCase('en')
  if (!query || !input.snapshot.enabled) return []
  const terms = [...new Set(query.split(/[\s,，。.!！?？;；:：/\\|]+/).filter(Boolean))]
  return input.snapshot.entries
    .map((entry, index) => {
      const content = entry.content.toLocaleLowerCase('en')
      const exact = content.includes(query) ? 100 : 0
      const termScore = terms.reduce((score, term) => score + (content.includes(term) ? 10 : 0), 0)
      return { entry, index, score: exact + termScore + (entry.pinned ? 3 : 0) + (entry.origin === 'manual' ? 2 : 0) }
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(1, Math.min(20, Math.floor(input.limit))))
    .map((candidate) => candidate.entry)
}
