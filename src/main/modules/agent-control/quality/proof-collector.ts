/**
 * EP2-Q3 — proof collection, five sources (02 §3): tool results, artifacts,
 * task events, run state, and the assistant's final response digest.
 *
 * The response digest makes direct_answer turns provable WITHOUT a task-type
 * exemption: a pure Q&A turn's deliverable IS the reply — we store sha256 +
 * a truncated excerpt, never the full text. Ordering contract (Q4a): the
 * digest proof lands inside finalizeRunOutcome BEFORE the adjudicator runs.
 *
 * Governance (Q1 schema): proof_refs ≤100 per task — overflow rolls into
 * the task archive (jsonl), oldest first. Collection failures never block
 * the main flow (metric only).
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { logAgentMetric } from '../metrics'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import {
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
} from '../tools-runtime/tool-result-types'

export const PROOF_KINDS = ['tool_result', 'artifact', 'task_event', 'run_state', 'assistant_response', 'transaction_confirmed'] as const
export type ProofKind = (typeof PROOF_KINDS)[number]
export type ResearchSourceAcquisitionKind = 'discovery' | 'content' | 'answer'

export interface ProofRef {
  kind: ProofKind
  /** Human-meaningful reference: tool name, artifact path, event key, excerpt. */
  ref: string
  ts: string
  digest: string
  /** Run identity for live proofs. Older persisted rows may omit it and remain readable,
   *  but current-run delivery readback never treats an unscoped row as fresh evidence. */
  runId?: string
  /** Research acquisition receipt. Stored only for successful source tools so
   *  a later verifier can distinguish a real URL+body acquisition from a
   *  generic tool-result digest. */
  sourceReceipt?: {
    acquisitionTool: string
    acquisitionKind: ResearchSourceAcquisitionKind
    urls: string[]
    acquiredAt: string
    contentDigest: string
    excerpt: string
  }
}

export const PROOF_REFS_LIMIT = 100

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export const RESEARCH_SOURCE_DISCOVERY_TOOL_NAMES = new Set([
  'web_search',
  'browser_search',
])

export const RESEARCH_SOURCE_CONTENT_TOOL_NAMES = new Set([
  'web_fetch',
  'browser_read',
])

// Browser workflow resources are verified against their durable observation
// receipts before they enter the verifier. A status/task handle is never source
// evidence by itself.
export const RESEARCH_SOURCE_BUNDLED_TOOL_NAMES = new Set<string>()

const RESEARCH_SOURCE_TOOL_NAMES = new Set([
  ...RESEARCH_SOURCE_DISCOVERY_TOOL_NAMES,
  ...RESEARCH_SOURCE_CONTENT_TOOL_NAMES,
  ...RESEARCH_SOURCE_BUNDLED_TOOL_NAMES,
])
const SOURCE_RECEIPT_MATERIAL_CAP = 64 * 1024

function extractHttpUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"'`\])}]+/gi)) {
    const url = String(match[0] || '').replace(/[.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f]+$/g, '')
    if (url) urls.add(url)
    if (urls.size >= 12) break
  }
  return Array.from(urls)
}

function buildSourceReceipt(
  toolName: string,
  summary: string,
  now: Date,
  acquisitionKind?: ResearchSourceAcquisitionKind,
): ProofRef['sourceReceipt'] {
  if (!RESEARCH_SOURCE_TOOL_NAMES.has(toolName)) return undefined
  const urls = extractHttpUrls(summary)
  if (urls.length === 0) return undefined
  const excerpt = String(summary || '').trim().slice(0, 1600)
  return {
    acquisitionTool: toolName,
    acquisitionKind: acquisitionKind || (
      RESEARCH_SOURCE_CONTENT_TOOL_NAMES.has(toolName) ? 'content' : 'discovery'
    ),
    urls,
    acquiredAt: now.toISOString(),
    contentDigest: sha256(summary),
    excerpt: excerpt || urls.join('\n'),
  }
}

function proof(
  kind: ProofKind,
  ref: string,
  digestSource: string,
  now: Date,
  sourceReceipt?: ProofRef['sourceReceipt'],
  runId?: string,
): ProofRef {
  return {
    kind,
    ref: ref.slice(0, 200),
    ts: now.toISOString(),
    digest: sha256(digestSource),
    ...(runId ? { runId } : {}),
    ...(sourceReceipt ? { sourceReceipt } : {}),
  }
}

export function collectToolResultProof(
  toolName: string,
  resultSummary: string,
  now: Date,
  sourceMaterial: string = resultSummary,
  runId?: string,
  acquisitionKind?: ResearchSourceAcquisitionKind,
): ProofRef {
  return proof(
    'tool_result',
    toolName,
    `${toolName}:${resultSummary}`,
    now,
    buildSourceReceipt(toolName, sourceMaterial, now, acquisitionKind),
    runId,
  )
}

function collectScopedToolResultProof(ref: string, resultSummary: string, now: Date): ProofRef {
  return proof('tool_result', ref, `${ref}:${resultSummary}`, now)
}

export function collectArtifactProof(path: string, now: Date, runId?: string): ProofRef {
  return proof('artifact', path, path, now, undefined, runId)
}

export function collectTaskEventProof(payload: { taskId: string; status: string }, now: Date): ProofRef {
  const key = `${payload.taskId}|${payload.status}`
  return proof('task_event', key, key, now)
}

export function collectRunStateProof(runStateRef: string, now: Date): ProofRef {
  return proof('run_state', runStateRef, runStateRef, now)
}

export function collectTransactionConfirmedProof(ref: string, digestSource: string, now: Date): ProofRef {
  return proof('transaction_confirmed', ref, digestSource, now)
}

/** sha256 + truncated excerpt, never the full reply. Empty reply → null
 *  (a run that produced no final text has nothing to prove). */
export function collectResponseDigestProof(finalText: string | null | undefined, now: Date): ProofRef | null {
  const text = String(finalText || '').trim()
  if (!text) return null
  return { kind: 'assistant_response', ref: text.slice(0, 120), ts: now.toISOString(), digest: sha256(text) }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text.trim().startsWith('{')) return null
  try {
    return recordValue(JSON.parse(text))
  } catch {
    // silent-catch: non-JSON tool text is valid input here; the caller falls back to text-based failure detection.
    return null
  }
}

function isFailedToolOutput(output: ToolExecutionOutput): boolean {
  const data = recordValue(output.data) || parseJsonRecord(output.text)
  const status = typeof data?.status === 'string' ? data.status.trim().toLowerCase() : ''
  const mutationReason = typeof data?.mutationReason === 'string' ? data.mutationReason.trim() : ''
  if (
    mutationReason === 'validation_failed' ||
    mutationReason === 'rejected' ||
    mutationReason === 'no_match' ||
    mutationReason === 'cancelled'
  ) {
    return true
  }
  if (
    typeof data?.errorKind === 'string'
    || data?.ok === false
    || status === 'error'
    || status === 'failed'
  ) {
    return true
  }
  const explicitlySuccessful =
    data?.ok === true ||
    data?.mutated === true ||
    status === 'completed' ||
    status === 'success' ||
    status === 'succeeded' ||
    status === 'done' ||
    mutationReason === 'changed' ||
    mutationReason === 'saved' ||
    mutationReason === 'identical' ||
    mutationReason === 'not_mutation' ||
    data?.documentSaved === true ||
    'documentTabId' in (data || {}) ||
    'documentTitle' in (data || {}) ||
    'documentSaveState' in (data || {}) ||
    'documentDirty' in (data || {})
  if (explicitlySuccessful) return false
  return /(?:^Error:|Document action failed|failed|失败|无法|没有可|未匹配到|未找到|缺少|已拒绝|被拒绝|已取消|被取消)/i.test(output.text)
}

export function isNonterminalToolOutput(output: ToolExecutionOutput): boolean {
  const data = recordValue(output.data) || parseJsonRecord(output.text)
  const status = typeof data?.status === 'string' ? data.status.trim().toLowerCase() : ''
  return data?.reviewRequired === true
    || data?.done === false
    || status === 'waiting_review'
    || status === 'pending'
    || status === 'queued'
    || status === 'running'
    || status === 'paused'
    || status === 'waiting_human'
    || status === 'recoverable_paused'
}

export function isSuccessfulToolOutput(output: ToolExecutionOutput): boolean {
  const normalized = normalizeToolExecutionOutput(output)
  return !isFailedToolOutput(normalized) && !isNonterminalToolOutput(normalized)
}

function cleanArtifactPathCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let text = value.trim()
  if (!text) return null
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim()
  text = text.replace(/^[*_\s]+|[*_\s]+$/g, '').trim()
  text = text.replace(/[。；;，,)\]）]+$/g, '').trim()
  if (!text) return null
  if (/^https?:\/\//i.test(text)) return null
  if (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('outputs/')) return text
  return null
}

function collectPathCandidatesFromRecord(record: Record<string, unknown> | null, paths: Set<string>): void {
  if (!record) return
  for (const key of ['path', 'savedPath', 'filePath', 'absolutePath', 'outputDir', 'runStatePath', 'sceneScoresPath', 'deliveryReportPath']) {
    const path = cleanArtifactPathCandidate(record[key])
    if (path) paths.add(path)
  }
  const artifacts = Array.isArray(record.recentArtifacts)
    ? record.recentArtifacts
    : Array.isArray(record.artifactRefs)
      ? record.artifactRefs
      : []
  for (const artifact of artifacts) {
    const path = cleanArtifactPathCandidate(recordValue(artifact)?.path)
    if (path) paths.add(path)
  }
  const autoExport = recordValue(record.autoExport)
  const autoExportPath = cleanArtifactPathCandidate(autoExport?.absolutePath)
  const autoExportTarget = cleanArtifactPathCandidate(autoExport?.targetPath)
  const autoExportBytes = Number(autoExport?.bytesWritten)
  if (
    autoExportPath
    && autoExportTarget
    && autoExportPath === autoExportTarget
    && Number.isFinite(autoExportBytes)
    && autoExportBytes >= 0
  ) {
    paths.add(autoExportPath)
  }
}

function collectVerifiedDocumentSavePaths(toolName: string, record: Record<string, unknown> | null, paths: Set<string>): void {
  if (toolName !== 'document_save_tab' || !record || record.documentSaved !== true) return
  const nestedDocument = recordValue(record.document)
  for (const key of ['path', 'savedPath', 'filePath', 'documentPath']) {
    const path = cleanArtifactPathCandidate(record[key])
    if (path) paths.add(path)
  }
  if (nestedDocument) {
    const path = cleanArtifactPathCandidate(nestedDocument.path)
    if (path) paths.add(path)
  }
}

function collectPathCandidatesFromText(text: string, paths: Set<string>): void {
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const path = cleanArtifactPathCandidate(match[1])
    if (path) paths.add(path)
  }
  for (const match of text.matchAll(/(?:已保存文档|已另存文档|保存路径|saved path|saved file|path)\s*[:：]\s*([^\n\r]+)/gi)) {
    const path = cleanArtifactPathCandidate(match[1])
    if (path) paths.add(path)
  }
}

function transactionConfirmationFromRecord(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return null
  const direct = record.transactionConfirmed && typeof record.transactionConfirmed === 'object' && !Array.isArray(record.transactionConfirmed)
    ? record.transactionConfirmed as Record<string, unknown>
    : null
  if (direct?.confirmed === true) return direct
  return null
}

function transactionConfirmationRef(toolName: string, confirmation: Record<string, unknown>): string {
  const source = typeof confirmation.source === 'string' && confirmation.source.trim()
    ? confirmation.source.trim()
    : 'unknown'
  const signal = typeof confirmation.signal === 'string' && confirmation.signal.trim()
    ? confirmation.signal.trim()
    : 'confirmed'
  return `${toolName}:${source}:${signal}`.slice(0, 200)
}

function sourceReceiptMaterial(
  toolName: string,
  normalized: ReturnType<typeof normalizeToolExecutionOutput>,
): string {
  if (!RESEARCH_SOURCE_TOOL_NAMES.has(toolName)) return normalized.text
  const parts = [normalized.text]
  for (const value of [normalized.data, normalized.projectionPatch]) {
    if (value === undefined || value === null) continue
    try {
      parts.push(JSON.stringify(value))
    } catch {
      // silent-catch: text remains authoritative if an unexpected host object is not serializable
    }
  }
  return parts.join('\n').slice(0, SOURCE_RECEIPT_MATERIAL_CAP)
}

export function collectToolOutputProofs(
  toolName: string,
  output: ToolExecutionOutput,
  now: Date,
  context: { runId?: string } = {},
): ProofRef[] {
  const normalized = normalizeToolExecutionOutput(output)
  if (isFailedToolOutput(normalized) || isNonterminalToolOutput(normalized)) return []

  const summary = normalized.text || JSON.stringify(normalized.data || normalized.projectionPatch || {})
  const proofs: ProofRef[] = []
  const paths = new Set<string>()
  const dataRecord = recordValue(normalized.data)
  const acquisitionKind = toolName === 'web_search' && dataRecord?.acquisitionKind === 'answer'
    ? 'answer' as const
    : undefined
  const transactionConfirmation =
    transactionConfirmationFromRecord(dataRecord)
    || transactionConfirmationFromRecord(recordValue(normalized.projectionPatch))
  if (toolName === 'document_save_tab') {
    collectVerifiedDocumentSavePaths(toolName, dataRecord, paths)
  } else {
    collectPathCandidatesFromRecord(dataRecord, paths)
    collectPathCandidatesFromRecord(recordValue(normalized.projectionPatch), paths)
    collectPathCandidatesFromText(normalized.text, paths)
  }
  const documentSavePath = toolName === 'document_save_tab' ? [...paths][0] : null
  proofs.push(documentSavePath
    ? collectScopedToolResultProof(`${toolName}:${documentSavePath}`, summary.slice(0, 500), now)
    : collectToolResultProof(
        toolName,
        summary.slice(0, 500),
        now,
        sourceReceiptMaterial(toolName, normalized),
        context.runId,
        acquisitionKind,
      ))
  for (const path of paths) {
    proofs.push(collectArtifactProof(path, now, context.runId))
  }
  if (transactionConfirmation) {
    proofs.push(collectTransactionConfirmedProof(
      transactionConfirmationRef(toolName, transactionConfirmation),
      JSON.stringify(transactionConfirmation),
      now,
    ))
  }
  // NOTE: a bare `runStatePath` is NOT minted as a `run_state` proof here — a
  // skill child emits its runStatePath at START (still running). The `run_state`
  // KIND proof (which `skill_run_state`/`steps_complete` require) is minted ONLY
  // in run-finalizer, after validating the run_state.json is terminally done +
  // delivery report present. Tool-output level only yields the artifact path.
  return context.runId
    ? proofs.map((row) => row.runId ? row : { ...row, runId: context.runId })
    : proofs
}

export function isValidProofRef(row: unknown): row is ProofRef {
  if (!row || typeof row !== 'object') return false
  const candidate = row as Record<string, unknown>
  const baseValid = (PROOF_KINDS as readonly string[]).includes(String(candidate.kind))
    && typeof candidate.ref === 'string' && candidate.ref.length > 0
    && typeof candidate.ts === 'string' && Number.isFinite(Date.parse(candidate.ts))
    && typeof candidate.digest === 'string' && /^[0-9a-f]{64}$/.test(candidate.digest)
  if (!baseValid) return false
  if (candidate.runId !== undefined && (typeof candidate.runId !== 'string' || candidate.runId.length === 0)) return false
  if (candidate.sourceReceipt === undefined) return true
  if (!candidate.sourceReceipt || typeof candidate.sourceReceipt !== 'object' || Array.isArray(candidate.sourceReceipt)) return false
  const receipt = candidate.sourceReceipt as Record<string, unknown>
  return typeof receipt.acquisitionTool === 'string' && receipt.acquisitionTool.length > 0
    && Array.isArray(receipt.urls) && receipt.urls.length > 0
    && receipt.urls.every((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
    && typeof receipt.acquiredAt === 'string' && Number.isFinite(Date.parse(receipt.acquiredAt))
    && typeof receipt.contentDigest === 'string' && /^[0-9a-f]{64}$/.test(receipt.contentDigest)
    && typeof receipt.excerpt === 'string' && receipt.excerpt.length > 0
}

/**
 * Append with rolling governance: malformed ADDITIONS are rejected loudly
 * (writer bug, not data); overflow beyond the limit rolls the OLDEST rows
 * into the archive callback so recent proofs stay queryable in the DB.
 */
export function appendProofRefs(
  existing: unknown,
  additions: ReadonlyArray<ProofRef>,
  opts: { limit?: number; archive?: (rows: ProofRef[]) => void } = {},
): ProofRef[] {
  for (const row of additions) {
    if (!isValidProofRef(row)) {
      throw new Error(`[proof-collector] malformed proof ref rejected: ${JSON.stringify(row).slice(0, 120)}`)
    }
  }
  const limit = opts.limit ?? PROOF_REFS_LIMIT
  const base = Array.isArray(existing) ? existing.filter(isValidProofRef) : []
  const merged = [...base, ...additions]
  if (merged.length <= limit) return merged
  const overflow = merged.slice(0, merged.length - limit)
  if (overflow.length > 0 && opts.archive) {
    try { opts.archive(overflow) } catch { /* silent-catch: archive failure must not lose the write */ }
  }
  return merged.slice(merged.length - limit)
}

/** Default archive writer: one JSON line per overflow row. */
export function createJsonlArchiver(filePath: string): (rows: ProofRef[]) => void {
  return (rows) => {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
  }
}

export interface ProofSinkStore {
  get(taskId: string): TaskProjectionRecord | null
  update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: { silent?: boolean; reasonHint?: string }): void
  compareAndSwap?(
    taskId: string,
    expectedRevision: number,
    patch: Partial<TaskProjectionRecord>,
    options?: { silent?: boolean; reasonHint?: string; browserDerivedFieldOwner?: 'proof' },
  ): TaskProjectionRecord | null
}

/**
 * Store-backed sink. Failures are metrics, never throws into the caller —
 * proof collection must not break runs (合同：采集失败不阻断主流程).
 */
export function createTaskProofSink(store: ProofSinkStore): {
  append(taskId: string | null | undefined, proofs: ReadonlyArray<ProofRef>, opts?: { archive?: (rows: ProofRef[]) => void }): boolean
} {
  return {
    append(taskId, proofs, opts = {}) {
      if (!taskId || proofs.length === 0) return false
      try {
        const record = store.get(taskId)
        if (!record) return false
        const next = appendProofRefs(record.proofRefs ?? [], proofs, { archive: opts.archive })
        if (store.compareAndSwap && record.requestAnchor) {
          const updated = store.compareAndSwap(
            taskId,
            Number(record.revision ?? 0),
            { proofRefs: next, updatedAt: new Date().toISOString() },
            { silent: true, reasonHint: 'proof_collect', browserDerivedFieldOwner: 'proof' },
          )
          if (!updated) throw new Error('bound_parent_proof_revision_conflict')
        } else {
          store.update(taskId, { proofRefs: next }, { silent: true, reasonHint: 'proof_collect' })
        }
        return true
      } catch (error) {
        logAgentMetric('proof_collect_failed', {
          taskId,
          reason: error instanceof Error ? error.message : String(error),
        })
        return false
      }
    },
  }
}

/** Additive TaskEventBridge listener — terminal task events become proofs. */
export function createTaskEventProofListener(
  sink: ReturnType<typeof createTaskProofSink>,
  now: () => Date = () => new Date(),
): (payload: { taskId: string; status: string }) => void {
  return (payload) => {
    sink.append(payload.taskId, [collectTaskEventProof(payload, now())])
  }
}
