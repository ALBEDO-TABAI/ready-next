import type { DatabaseConnection } from '../../database'
import type { CodexBeginNewContextActionRef, CodexConversationContextBoundary } from '../../../../shared/ipc-contracts/agent-runtime'
import { CodexBindingRepositoryError } from './codex-binding-error'
import { digestCanonicalJson } from './codex-model-gateway-contract'

const contextRows = {
  messages: ['chat_messages', 'id', 'conversation_id', 'message_visibility_epoch'],
  runs: ['run_meta', 'run_id', 'scope_id', 'message_visibility_epoch'],
  tasks: ['task_projections', 'task_id', 'scope_id', 'message_visibility_epoch'],
  effects: ['codex_product_effect_bindings', 'effect_action_id', 'ready_scope_id', 'message_visibility_epoch'],
  interactions: ['pending_confirmations', 'id', 'scope_id', null],
} as const
const contextKeys = [...Object.keys(contextRows), 'turns'].sort()

export function codexBeginNewContextOperationId(input: Pick<CodexBeginNewContextActionRef,
  'scopeId' | 'scopeEpoch' | 'sourceEvidenceDigest' | 'candidateEvidenceDigest' | 'consequenceDigest' | 'draftRevision'>): string {
  return `begin-context-${digestCanonicalJson({
    scopeId: input.scopeId, scopeEpoch: input.scopeEpoch, sourceEvidenceDigest: input.sourceEvidenceDigest,
    candidateEvidenceDigest: input.candidateEvidenceDigest, consequenceDigest: input.consequenceDigest,
    draftRevision: input.draftRevision,
  })}`
}

export function captureCodexBoundaryContext(db: DatabaseConnection, scopeId: string, scopeEpoch: number) {
  const previous = db.prepare(`SELECT preserved_context_json FROM codex_conversation_context_boundaries
    WHERE ready_scope_id = ? AND message_visibility_epoch = ? AND preserved_context_json IS NOT NULL`)
    .all<{ preserved_context_json: string }>(scopeId, scopeEpoch).map((row) => parsePreservedContext(row.preserved_context_json))
  const snapshot: Record<string, string[]> = {}
  for (const [key, [table, id, scope, epoch]] of Object.entries(contextRows)) {
    snapshot[key] = db.prepare(`SELECT ${id} AS id FROM ${table} WHERE ${scope} = ?${epoch ? ` AND ${epoch} = ?` : ''}`)
      .all<{ id: string }>(scopeId, ...(epoch ? [scopeEpoch] : [])).map((row) => row.id).sort()
  }
  snapshot.turns = db.prepare(`SELECT turn.ready_run_id AS id FROM codex_turn_bindings turn
    JOIN codex_thread_bindings owner ON owner.thread_binding_id = turn.thread_binding_id
    WHERE owner.ready_scope_id = ? AND turn.message_visibility_epoch = ?`)
    .all<{ id: string }>(scopeId, scopeEpoch).map((row) => row.id).sort()
  // A later boundary adds only new identities; repeated boundaries do not
  // duplicate the entire visible history in every receipt.
  for (const key of contextKeys) {
    const alreadyPreserved = new Set(previous.flatMap((item) => item[key]))
    snapshot[key] = snapshot[key].filter((id) => !alreadyPreserved.has(id))
  }
  return snapshot
}

export function preservedCodexContextRowSql(key: keyof typeof contextRows | 'turns', rowId: string): string {
  return `EXISTS (SELECT 1 FROM codex_conversation_context_boundaries boundary,
    json_each(boundary.preserved_context_json, '$.${key}') preserved
    WHERE boundary.ready_scope_id = head.ready_scope_id
      AND boundary.message_visibility_epoch = scope.message_visibility_epoch
      AND boundary.target_alias_generation <= head.alias_generation
      AND preserved.value = ${rowId})`
}

function parsePreservedContext(value: string): Record<string, string[]> {
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(value) } catch { throw new CodexBindingRepositoryError('context_boundary_snapshot_invalid') }
  if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).sort().join(',') !== contextKeys.join(',')
    || Object.values(parsed).some((ids) => !Array.isArray(ids)
      || ids.some((id) => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length)) throw new CodexBindingRepositoryError('context_boundary_snapshot_invalid')
  return parsed as Record<string, string[]>
}

export function readCodexContextBoundaries(db: DatabaseConnection, input: { scopeId: string; scopeEpoch: number }): CodexConversationContextBoundary[] {
  return db.prepare(`SELECT operation_id, ready_scope_id, message_visibility_epoch,
      source_thread_binding_id, source_alias_generation, source_revision,
      target_thread_binding_id, target_alias_generation, previous_visible_message_anchor,
      preserved_context_json, committed_at, receipt_digest
    FROM codex_conversation_context_boundaries
    WHERE ready_scope_id = ? AND message_visibility_epoch = ?
    ORDER BY target_alias_generation ASC, committed_at ASC`).all<{
      operation_id: string; ready_scope_id: string; message_visibility_epoch: number
      source_thread_binding_id: string; source_alias_generation: number; source_revision: number
      target_thread_binding_id: string; target_alias_generation: number
      previous_visible_message_anchor: string | null; preserved_context_json: string | null
      committed_at: string; receipt_digest: string
    }>(input.scopeId, input.scopeEpoch).map((row) => {
      const unsigned = {
        operationId: row.operation_id, scopeId: row.ready_scope_id, scopeEpoch: row.message_visibility_epoch,
        sourceThreadBindingId: row.source_thread_binding_id, sourceAliasGeneration: row.source_alias_generation,
        sourceRevision: row.source_revision, targetThreadBindingId: row.target_thread_binding_id,
        targetAliasGeneration: row.target_alias_generation, previousVisibleMessageAnchor: row.previous_visible_message_anchor,
        ...(row.preserved_context_json === null ? {} : { preservedContextDigest: digestCanonicalJson(parsePreservedContext(row.preserved_context_json)) }),
        committedAt: row.committed_at,
      }
      if (digestCanonicalJson(unsigned) !== row.receipt_digest) throw new CodexBindingRepositoryError('context_boundary_receipt_invalid')
      return { ...unsigned, receiptDigest: row.receipt_digest }
    })
}

export const CODEX_CONTEXT_BOUNDARY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS codex_conversation_context_boundaries (
    operation_id TEXT PRIMARY KEY,
    ready_scope_id TEXT NOT NULL,
    message_visibility_epoch INTEGER NOT NULL CHECK (message_visibility_epoch >= 0),
    source_thread_binding_id TEXT NOT NULL,
    source_alias_generation INTEGER NOT NULL CHECK (source_alias_generation > 0),
    source_revision INTEGER NOT NULL CHECK (source_revision > 0),
    source_evidence_digest TEXT NOT NULL,
    target_thread_binding_id TEXT NOT NULL UNIQUE,
    target_alias_generation INTEGER NOT NULL CHECK (target_alias_generation > 0),
    previous_visible_message_anchor TEXT,
    preserved_context_json TEXT,
    committed_at TEXT NOT NULL,
    receipt_digest TEXT NOT NULL UNIQUE,
    FOREIGN KEY (ready_scope_id) REFERENCES chat_conversations(id),
    FOREIGN KEY (source_thread_binding_id) REFERENCES codex_thread_bindings(thread_binding_id),
    FOREIGN KEY (target_thread_binding_id) REFERENCES codex_thread_bindings(thread_binding_id),
    UNIQUE (ready_scope_id, message_visibility_epoch, source_thread_binding_id, source_revision)
  );
  CREATE INDEX IF NOT EXISTS idx_codex_context_boundaries_scope ON codex_conversation_context_boundaries(
    ready_scope_id, message_visibility_epoch, target_alias_generation
  );
  CREATE TRIGGER IF NOT EXISTS codex_context_boundary_immutable_update
  BEFORE UPDATE ON codex_conversation_context_boundaries
  BEGIN SELECT RAISE(ABORT, 'codex_context_boundary_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS codex_context_boundary_immutable_delete
  BEFORE DELETE ON codex_conversation_context_boundaries
  WHEN EXISTS (SELECT 1 FROM chat_conversations WHERE id = OLD.ready_scope_id)
  BEGIN SELECT RAISE(ABORT, 'codex_context_boundary_immutable'); END;
`
