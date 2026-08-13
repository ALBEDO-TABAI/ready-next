import type { DatabaseConnection } from '../../database'

import { digestCanonicalJson } from './codex-model-gateway-contract'
import {
  recordCodexThreadArchiveIntentInOpenTransaction,
  type CodexThreadRetirementReason,
} from './codex-thread-archive-cleanup'
import { applyCodexThreadArchiveCleanupSchema } from './codex-thread-archive-schema'

type RetiredBindingRow = {
  thread_binding_id: string
  codex_thread_id: string
  codex_session_id: string
  isolated_thread_cwd: string
  ready_conversation_alias: string
  alias_generation: number
  retired_at: string
  retired_reason: CodexThreadRetirementReason
  retirement_evidence_digest: string
}

export function applyBrowserTargetClaimVisibilityEpochMigration(
  db: Pick<DatabaseConnection, 'exec' | 'prepare'>,
): void {
  const columns = new Set(
    db.prepare('PRAGMA table_info(browser_target_claims)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (columns.size === 0) return
  if (!columns.has('message_visibility_epoch')) {
    db.exec('ALTER TABLE browser_target_claims ADD COLUMN message_visibility_epoch INTEGER')
  }
  db.exec(`
    UPDATE browser_target_claims
       SET message_visibility_epoch = (
         SELECT scope.message_visibility_epoch
           FROM chat_conversations scope
          WHERE scope.id = COALESCE(browser_target_claims.scope_id, browser_target_claims.session_id)
       )
     WHERE message_visibility_epoch IS NULL
       AND COALESCE(scope_id, session_id) IS NOT NULL
  `)
}

export function applyCodexThreadRetirementCleanupMigration(
  db: Pick<DatabaseConnection, 'exec' | 'prepare' | 'inTransaction'>,
): void {
  applyCodexThreadArchiveCleanupSchema(db)
  const scopeColumns = new Set(
    db.prepare('PRAGMA table_info(chat_conversations)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (!scopeColumns.has('closed_at')) {
    db.exec('ALTER TABLE chat_conversations ADD COLUMN closed_at TEXT')
  }
  if (!scopeColumns.has('closed_reason')) {
    db.exec('ALTER TABLE chat_conversations ADD COLUMN closed_reason TEXT')
  }
  if (!scopeColumns.has('close_evidence_digest')) {
    db.exec('ALTER TABLE chat_conversations ADD COLUMN close_evidence_digest TEXT')
  }
  if (!scopeColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE chat_conversations
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT 0
    `)
  }
  applyBrowserTargetClaimVisibilityEpochMigration(db)
  const messageColumns = new Set(
    db.prepare('PRAGMA table_info(chat_messages)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (!messageColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT -1
    `)
    db.exec(`
      UPDATE chat_messages SET message_visibility_epoch = 0
       WHERE message_visibility_epoch = -1
    `)
  }
  const turnColumns = new Set(
    db.prepare('PRAGMA table_info(codex_turn_bindings)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (!turnColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE codex_turn_bindings
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (message_visibility_epoch >= 0)
    `)
  }
  const taskProjectionColumns = new Set(
    db.prepare('PRAGMA table_info(task_projections)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (!taskProjectionColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE task_projections
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT 0
        CHECK (message_visibility_epoch >= 0)
    `)
  }
  const runMetaColumns = new Set(
    db.prepare('PRAGMA table_info(run_meta)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (runMetaColumns.size > 0 && !runMetaColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE run_meta
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT -1
        CHECK (message_visibility_epoch >= -1)
    `)
    db.exec(`
      UPDATE run_meta
         SET message_visibility_epoch = COALESCE((
           SELECT scope.message_visibility_epoch
             FROM chat_conversations scope
            WHERE scope.id = run_meta.scope_id
         ), -1)
      WHERE message_visibility_epoch = -1
    `)
  }
  const skillTaskRunColumns = new Set(
    db.prepare('PRAGMA table_info(skill_task_runs)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (skillTaskRunColumns.size > 0 && !skillTaskRunColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE skill_task_runs
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT -1
        CHECK (message_visibility_epoch >= -1)
    `)
    db.exec(`
      UPDATE skill_task_runs
         SET message_visibility_epoch = COALESCE((
           SELECT scope.message_visibility_epoch
             FROM chat_conversations scope
            WHERE scope.id = skill_task_runs.scope_id
         ), -1)
       WHERE scope_id IS NOT NULL
         AND message_visibility_epoch = -1
    `)
  }
  const pendingTaskEventColumns = new Set(
    db.prepare('PRAGMA table_info(pending_task_events)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (pendingTaskEventColumns.size > 0 && !pendingTaskEventColumns.has('scope_id')) {
    db.exec('ALTER TABLE pending_task_events ADD COLUMN scope_id TEXT')
  }
  if (pendingTaskEventColumns.size > 0 && !pendingTaskEventColumns.has('message_visibility_epoch')) {
    db.exec(`
      ALTER TABLE pending_task_events
      ADD COLUMN message_visibility_epoch INTEGER NOT NULL DEFAULT -1
        CHECK (message_visibility_epoch >= -1)
    `)
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_chat_conversations_scope;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_active_scope
      ON chat_conversations(source_kind, source_id, thread_key, agent)
      WHERE closed_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS chat_conversation_close_fields_insert_guard
    BEFORE INSERT ON chat_conversations
    WHEN NOT (
      (NEW.closed_at IS NULL AND NEW.closed_reason IS NULL
        AND NEW.close_evidence_digest IS NULL)
      OR
      (NEW.closed_at IS NOT NULL AND NEW.closed_reason = 'closed'
        AND length(NEW.close_evidence_digest) = 64
        AND NEW.close_evidence_digest NOT GLOB '*[^0-9a-f]*')
    )
    BEGIN SELECT RAISE(ABORT, 'chat_conversation_close_fields_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS chat_conversation_close_fields_update_guard
    BEFORE UPDATE ON chat_conversations
    WHEN NOT (
      (NEW.closed_at IS NULL AND NEW.closed_reason IS NULL
        AND NEW.close_evidence_digest IS NULL)
      OR
      (NEW.closed_at IS NOT NULL AND NEW.closed_reason = 'closed'
        AND length(NEW.close_evidence_digest) = 64
        AND NEW.close_evidence_digest NOT GLOB '*[^0-9a-f]*')
    )
    BEGIN SELECT RAISE(ABORT, 'chat_conversation_close_fields_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS chat_conversation_close_immutable
    BEFORE UPDATE ON chat_conversations
    WHEN OLD.closed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'chat_conversation_close_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS chat_conversation_closed_delete_guard
    BEFORE DELETE ON chat_conversations
    WHEN OLD.closed_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'chat_conversation_closed_delete'); END;

    CREATE TRIGGER IF NOT EXISTS chat_conversation_visibility_epoch_update_guard
    BEFORE UPDATE OF message_visibility_epoch ON chat_conversations
    WHEN NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
      AND NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch + 1
    BEGIN SELECT RAISE(ABORT, 'chat_conversation_visibility_epoch_transition_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS chat_message_closed_scope_insert_guard
    BEFORE INSERT ON chat_messages
    WHEN EXISTS (
      SELECT 1 FROM chat_conversations scope
       WHERE scope.id = NEW.conversation_id AND scope.closed_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'chat_message_closed_scope'); END;

    CREATE TRIGGER IF NOT EXISTS chat_message_closed_scope_update_guard
    BEFORE UPDATE ON chat_messages
    WHEN EXISTS (
      SELECT 1 FROM chat_conversations scope
       WHERE scope.id IN (OLD.conversation_id, NEW.conversation_id)
         AND scope.closed_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'chat_message_closed_scope'); END;

    CREATE TRIGGER IF NOT EXISTS chat_message_closed_scope_delete_guard
    BEFORE DELETE ON chat_messages
    WHEN EXISTS (
      SELECT 1 FROM chat_conversations scope
       WHERE scope.id = OLD.conversation_id AND scope.closed_at IS NOT NULL
    )
    BEGIN SELECT RAISE(ABORT, 'chat_message_closed_scope'); END;

    DROP TRIGGER IF EXISTS chat_message_visibility_epoch_assign;

    CREATE TRIGGER IF NOT EXISTS chat_message_visibility_epoch_insert_guard
    BEFORE INSERT ON chat_messages
    WHEN NOT EXISTS (
      SELECT 1 FROM chat_conversations scope
       WHERE scope.id = NEW.conversation_id
         AND scope.closed_at IS NULL
         AND scope.message_visibility_epoch = NEW.message_visibility_epoch
    )
    BEGIN SELECT RAISE(ABORT, 'chat_message_visibility_epoch_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS chat_message_visibility_epoch_immutable
    BEFORE UPDATE OF message_visibility_epoch ON chat_messages
    WHEN OLD.message_visibility_epoch >= 0
      AND NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
    BEGIN SELECT RAISE(ABORT, 'chat_message_visibility_epoch_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_message_visibility_epoch_immutable
    BEFORE UPDATE OF message_visibility_epoch ON codex_turn_bindings
    WHEN NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
    BEGIN SELECT RAISE(ABORT, 'codex_turn_message_visibility_epoch_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS task_projection_visibility_epoch_insert_guard
    BEFORE INSERT ON task_projections
    WHEN NOT EXISTS (
      SELECT 1 FROM chat_conversations scope
       WHERE scope.id = NEW.scope_id
         AND scope.closed_at IS NULL
         AND scope.message_visibility_epoch = NEW.message_visibility_epoch
    )
    BEGIN SELECT RAISE(ABORT, 'task_projection_visibility_epoch_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS task_projection_visibility_epoch_update_guard
    BEFORE UPDATE ON task_projections
    WHEN NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
      OR NOT EXISTS (
        SELECT 1 FROM chat_conversations scope
         WHERE scope.id = OLD.scope_id
           AND scope.closed_at IS NULL
           AND scope.message_visibility_epoch = OLD.message_visibility_epoch
      )
    BEGIN SELECT RAISE(ABORT, 'task_projection_visibility_epoch_stale'); END;

  `)

  if (runMetaColumns.size > 0) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS run_meta_visibility_identity_immutable
      BEFORE UPDATE OF scope_id, message_visibility_epoch ON run_meta
      WHEN NEW.scope_id IS NOT OLD.scope_id
        OR NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
      BEGIN SELECT RAISE(ABORT, 'run_meta_visibility_identity_immutable'); END;

      CREATE TRIGGER IF NOT EXISTS run_meta_visibility_identity_insert_guard
      BEFORE INSERT ON run_meta
      WHEN NOT (
        (NEW.scope_id IS NULL AND NEW.message_visibility_epoch = -1)
        OR EXISTS (
          SELECT 1 FROM chat_conversations scope
           WHERE scope.id = NEW.scope_id
             AND scope.closed_at IS NULL
             AND scope.message_visibility_epoch = NEW.message_visibility_epoch
        )
      )
      BEGIN SELECT RAISE(ABORT, 'run_meta_visibility_identity_stale'); END;
    `)
  }
  if (pendingTaskEventColumns.size > 0) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_task_events_scope_visibility
        ON pending_task_events(scope_id, message_visibility_epoch, consumed, created_at);

      CREATE TRIGGER IF NOT EXISTS pending_task_event_visibility_identity_immutable
      BEFORE UPDATE OF scope_id, message_visibility_epoch ON pending_task_events
      WHEN NEW.scope_id IS NOT OLD.scope_id
        OR NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
      BEGIN SELECT RAISE(ABORT, 'pending_task_event_visibility_identity_immutable'); END;
    `)
  }
  if (skillTaskRunColumns.size > 0) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_skill_task_runs_scope_visibility_updated
        ON skill_task_runs(scope_id, message_visibility_epoch, updated_at DESC);

      CREATE TRIGGER IF NOT EXISTS skill_task_run_visibility_epoch_insert_guard
      BEFORE INSERT ON skill_task_runs
      WHEN NOT (
        (NEW.scope_id IS NULL AND NEW.message_visibility_epoch = -1)
        OR (
          NEW.scope_id IS NOT NULL
          AND NEW.message_visibility_epoch = -1
          AND NOT EXISTS (
            SELECT 1 FROM chat_conversations any_scope
             WHERE any_scope.id = NEW.scope_id
          )
        )
        OR EXISTS (
          SELECT 1 FROM chat_conversations scope
           WHERE scope.id = NEW.scope_id
             AND scope.closed_at IS NULL
             AND scope.message_visibility_epoch = NEW.message_visibility_epoch
        )
      )
      BEGIN SELECT RAISE(ABORT, 'skill_task_run_visibility_epoch_mismatch'); END;

      CREATE TRIGGER IF NOT EXISTS skill_task_run_visibility_epoch_update_guard
      BEFORE UPDATE ON skill_task_runs
      WHEN NEW.scope_id IS NOT OLD.scope_id
        OR NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
        OR NOT (
          (OLD.scope_id IS NULL AND OLD.message_visibility_epoch = -1)
          OR (
            OLD.scope_id IS NOT NULL
            AND OLD.message_visibility_epoch = -1
            AND NOT EXISTS (
              SELECT 1 FROM chat_conversations any_scope
               WHERE any_scope.id = OLD.scope_id
            )
          )
          OR EXISTS (
            SELECT 1 FROM chat_conversations scope
             WHERE scope.id = OLD.scope_id
               AND scope.closed_at IS NULL
               AND scope.message_visibility_epoch = OLD.message_visibility_epoch
          )
        )
      BEGIN SELECT RAISE(ABORT, 'skill_task_run_visibility_epoch_stale'); END;
    `)
  }

  const retired = db.prepare(`
    SELECT thread.thread_binding_id, thread.codex_thread_id, thread.codex_session_id,
           thread.isolated_thread_cwd, thread.ready_conversation_alias,
           thread.alias_generation, thread.retired_at, thread.retired_reason,
           thread.retirement_evidence_digest
      FROM codex_thread_bindings thread
     WHERE thread.retired_at IS NOT NULL
       AND thread.codex_thread_id IS NOT NULL
       AND thread.codex_session_id IS NOT NULL
       AND thread.isolated_thread_cwd IS NOT NULL
       AND thread.retirement_evidence_digest IS NOT NULL
       AND thread.retired_reason IN (
         'closed', 'user_reset', 'publication_diverged',
         'manual_compaction_quarantine', 'cleanup'
       )
       AND NOT EXISTS (
         SELECT 1 FROM codex_thread_dispatch_fences fence
          WHERE fence.thread_binding_id = thread.thread_binding_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM codex_turn_bindings turn
          WHERE turn.thread_binding_id = thread.thread_binding_id
            AND (
              turn.turn_start_reservation_released_at IS NULL
              OR (turn.product_terminal_digest IS NULL
                AND turn.host_failure_product_terminal_digest IS NULL)
            )
       )
       AND NOT EXISTS (
         SELECT 1 FROM codex_thread_archive_intents intent
          WHERE intent.thread_binding_id = thread.thread_binding_id
       )
     ORDER BY thread.retired_at, thread.thread_binding_id
  `).all<RetiredBindingRow>()
  for (const row of retired) {
    const retirementTransactionDigest = digestCanonicalJson({
      contract: 'codex_thread_archive_retired_backfill_v1',
      threadBindingId: row.thread_binding_id,
      codexThreadId: row.codex_thread_id,
      codexSessionId: row.codex_session_id,
      isolatedThreadCwd: row.isolated_thread_cwd,
      aliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      retiredAt: row.retired_at,
      retiredReason: row.retired_reason,
      retirementEvidenceDigest: row.retirement_evidence_digest,
    })
    recordCodexThreadArchiveIntentInOpenTransaction(db as DatabaseConnection, {
      threadBindingId: row.thread_binding_id,
      codexThreadId: row.codex_thread_id,
      codexSessionId: row.codex_session_id,
      isolatedThreadCwd: row.isolated_thread_cwd,
      aliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      sourceKind: 'retired_backfill',
      retiredReason: row.retired_reason,
      readyRunId: null,
      retirementEvidenceDigest: row.retirement_evidence_digest,
      retirementTransactionDigest,
      requestedAt: row.retired_at,
    })
  }
}
