import type { DatabaseConnection } from '../../database/connection'
import type { CodexAcceptedNativePrefixHead, CodexNativeCoverageItem } from './codex-binding-repository'
import { CodexBindingRepositoryError } from './codex-binding-error'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export function readAcceptedNativePrefixHead(db: DatabaseConnection, thread: {
  thread_binding_id: string
  thread_materialization_kind: string
  source_accepted_native_coverage_receipt_id: string | null
  source_accepted_native_coverage_receipt_digest: string | null
}): CodexAcceptedNativePrefixHead | null {
  const row = db.prepare(`
    SELECT receipt_id, receipt_digest, accepted_native_head_kind,
           accepted_native_head_id, accepted_product_ready_run_id
      FROM codex_native_coverage_receipts
     WHERE thread_binding_id = ?
        OR (receipt_id = ? AND receipt_digest = ?)
     ORDER BY rowid DESC LIMIT 1
  `).get<{
    receipt_id: string
    receipt_digest: string
    accepted_native_head_kind: 'turn' | 'compaction'
    accepted_native_head_id: string
    accepted_product_ready_run_id: string | null
  }>(thread.thread_binding_id,
    thread.thread_materialization_kind === 'native_fork'
      ? thread.source_accepted_native_coverage_receipt_id : null,
    thread.thread_materialization_kind === 'native_fork'
      ? thread.source_accepted_native_coverage_receipt_digest : null)
  if (row) readNativeCoverage(db, row.receipt_id)
  else if (thread.thread_materialization_kind === 'native_fork') {
    throw new CodexBindingRepositoryError('coverage_fork_parent_missing')
  }
  return row ? {
    acceptedNativeHeadKind: row.accepted_native_head_kind,
    acceptedNativeHeadId: row.accepted_native_head_id,
    acceptedProductReadyRunId: row.accepted_product_ready_run_id,
    coverageReceiptRef: { receiptId: row.receipt_id, digest: row.receipt_digest },
  } : null
}

export function excludeAlreadyCoveredItems(
  db: DatabaseConnection,
  parentReceiptId: string | null,
  candidates: readonly CodexNativeCoverageItem[],
): CodexNativeCoverageItem[] {
  const covered = parentReceiptId
    ? readNativeCoverage(db, parentReceiptId).covered
    : new Map<string, string>()
  return candidates.filter((item) => {
    const priorDigest = covered.get(item.messageId)
    if (!priorDigest) return true
    if (priorDigest !== item.digest) {
      throw new CodexBindingRepositoryError('coverage_message_digest_conflict')
    }
    return false
  })
}

export function readNativeCoverage(db: DatabaseConnection, receiptId: string) {
  const covered = new Map<string, string>()
  const compacted = new Map<string, string>()
  let insideCompactionPrefix = false
  const visited = new Set<string>()
  let cursor: string | null = receiptId
  while (cursor) {
    if (visited.has(cursor)) throw new CodexBindingRepositoryError('coverage_lineage_cycle')
    visited.add(cursor)
    const row = db.prepare(`
      SELECT receipt_id, thread_binding_id, parent_receipt_id, producer_kind,
             producer_owner_id, codex_thread_id, accepted_native_head_kind,
             accepted_native_head_id, accepted_product_ready_run_id,
             newly_covered_json, newly_covered_digest, receipt_digest, created_at
        FROM codex_native_coverage_receipts WHERE receipt_id = ? LIMIT 1
    `).get<{
      receipt_id: string
      thread_binding_id: string
      parent_receipt_id: string | null
      producer_kind: 'product_closeout' | 'automatic_compaction' | 'manual_compaction'
      producer_owner_id: string
      codex_thread_id: string
      accepted_native_head_kind: 'turn' | 'compaction'
      accepted_native_head_id: string
      accepted_product_ready_run_id: string | null
      newly_covered_json: string
      newly_covered_digest: string
      receipt_digest: string
      created_at: string
    }>(cursor)
    if (!row) throw new CodexBindingRepositoryError('coverage_lineage_broken')
    let items: CodexNativeCoverageItem[]
    try { items = JSON.parse(row.newly_covered_json) as CodexNativeCoverageItem[] }
    catch { throw new CodexBindingRepositoryError('coverage_lineage_invalid') }
    const unsigned = {
      contract: 'codex_native_coverage_receipt_v1',
      threadBindingId: row.thread_binding_id,
      parentReceiptId: row.parent_receipt_id,
      producerKind: row.producer_kind,
      producerOwnerId: row.producer_owner_id,
      codexThreadId: row.codex_thread_id,
      acceptedNativeHeadKind: row.accepted_native_head_kind,
      acceptedNativeHeadId: row.accepted_native_head_id,
      acceptedProductReadyRunId: row.accepted_product_ready_run_id,
      newlyCoveredDigest: row.newly_covered_digest,
      createdAt: row.created_at,
    }
    if (digestCanonicalJson(items) !== row.newly_covered_digest
      || digestCanonicalJson(unsigned) !== row.receipt_digest
      || row.receipt_id !== `coverage-${row.receipt_digest.slice(0, 32)}`) {
      throw new CodexBindingRepositoryError('coverage_lineage_invalid')
    }
    if (row.producer_kind === 'automatic_compaction' || row.producer_kind === 'manual_compaction') {
      insideCompactionPrefix = true
    }
    for (const item of items) {
      const previous = covered.get(item.messageId)
      if (previous && previous !== item.digest) {
        throw new CodexBindingRepositoryError('coverage_message_digest_conflict')
      }
      covered.set(item.messageId, item.digest)
      if (insideCompactionPrefix) compacted.set(item.messageId, item.digest)
    }
    cursor = row.parent_receipt_id
  }
  return { covered, compacted }
}
