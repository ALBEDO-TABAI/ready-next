import type { DatabaseConnection } from '../../database/connection'

export const CODEX_THREAD_ARCHIVE_CLEANUP_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS codex_thread_archive_intents (
    archive_intent_id TEXT PRIMARY KEY,
    thread_binding_id TEXT NOT NULL UNIQUE,
    codex_thread_id TEXT NOT NULL UNIQUE,
    codex_session_id TEXT NOT NULL,
    isolated_thread_cwd TEXT NOT NULL,
    ready_conversation_alias TEXT NOT NULL,
    alias_generation INTEGER NOT NULL CHECK (alias_generation >= 1),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
      'idle_close', 'engine_terminal_close', 'idle_reset', 'engine_terminal_reset',
      'engine_terminal_stop', 'browser_verifier_nonaccept', 'publication_divergence',
      'manual_compaction_quarantine', 'retired_backfill', 'begin_new_context'
    )),
    retired_reason TEXT NOT NULL CHECK (retired_reason IN (
      'closed', 'user_reset', 'publication_diverged', 'manual_compaction_quarantine', 'cleanup'
    )),
    ready_run_id TEXT,
    retirement_evidence_digest TEXT NOT NULL,
    retirement_transaction_digest TEXT NOT NULL,
    intent_digest TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'result_unknown', 'acknowledged')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_attempt_at TEXT,
    last_attempt_connection_epoch TEXT,
    last_attempt_rpc_id INTEGER,
    last_error_code TEXT,
    last_absence_after_attempt_count INTEGER,
    last_absence_evidence_digest TEXT,
    last_absence_at TEXT,
    acknowledged_at TEXT,
    acknowledgement_kind TEXT CHECK (
      acknowledgement_kind IN ('rpc_success', 'archived_readback', 'archived_notification')
    ),
    acknowledgement_evidence_digest TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (thread_binding_id) REFERENCES codex_thread_bindings(thread_binding_id),
    CHECK ((source_kind IN (
        'idle_close', 'idle_reset', 'manual_compaction_quarantine', 'retired_backfill',
        'begin_new_context'
      ) AND ready_run_id IS NULL)
      OR (source_kind IN (
        'engine_terminal_close', 'engine_terminal_reset', 'engine_terminal_stop',
        'browser_verifier_nonaccept', 'publication_divergence'
      ) AND ready_run_id IS NOT NULL)),
    CHECK (length(retirement_evidence_digest) = 64
      AND retirement_evidence_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(retirement_transaction_digest) = 64
      AND retirement_transaction_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK ((attempt_count = 0
        AND last_attempt_at IS NULL AND last_attempt_connection_epoch IS NULL
        AND last_attempt_rpc_id IS NULL)
      OR (attempt_count > 0
        AND last_attempt_at IS NOT NULL AND last_attempt_connection_epoch IS NOT NULL
        AND last_attempt_rpc_id IS NOT NULL AND last_attempt_rpc_id > 0)),
    CHECK ((last_absence_after_attempt_count IS NULL
        AND last_absence_evidence_digest IS NULL AND last_absence_at IS NULL)
      OR (last_absence_after_attempt_count IS NOT NULL
        AND last_absence_after_attempt_count >= 1
        AND last_absence_after_attempt_count <= attempt_count
        AND last_absence_evidence_digest IS NOT NULL
        AND length(last_absence_evidence_digest) = 64
        AND last_absence_evidence_digest NOT GLOB '*[^0-9a-f]*'
        AND last_absence_at IS NOT NULL)),
    CHECK (state != 'pending' OR attempt_count = 0
      OR last_absence_after_attempt_count = attempt_count),
    CHECK (state != 'result_unknown' OR attempt_count > 0),
    CHECK ((state != 'acknowledged'
        AND acknowledged_at IS NULL
        AND acknowledgement_kind IS NULL
        AND acknowledgement_evidence_digest IS NULL)
      OR (state = 'acknowledged'
        AND acknowledged_at IS NOT NULL
        AND acknowledgement_kind IS NOT NULL
        AND acknowledgement_evidence_digest IS NOT NULL
        AND length(acknowledgement_evidence_digest) = 64
        AND acknowledgement_evidence_digest NOT GLOB '*[^0-9a-f]*'))
  );

  CREATE INDEX IF NOT EXISTS codex_thread_archive_intents_pending_idx
    ON codex_thread_archive_intents(state, requested_at, archive_intent_id);

  CREATE TABLE IF NOT EXISTS codex_thread_archive_attempts (
    archive_intent_id TEXT NOT NULL,
    attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
    connection_epoch TEXT NOT NULL,
    rpc_id INTEGER NOT NULL CHECK (rpc_id > 0),
    request_digest TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    child_write_attempted_at TEXT,
    child_write_confirmed_at TEXT,
    child_write_digest TEXT,
    unresolved_at TEXT,
    unresolved_reason TEXT CHECK (
      unresolved_reason IN ('response_timeout', 'child_write_error', 'connection_closed')
    ),
    response_kind TEXT CHECK (response_kind IN ('accepted', 'rejected')),
    response_digest TEXT,
    response_at TEXT,
    notification_digest TEXT,
    notification_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    PRIMARY KEY (archive_intent_id, attempt_count),
    UNIQUE (connection_epoch, rpc_id),
    FOREIGN KEY (archive_intent_id)
      REFERENCES codex_thread_archive_intents(archive_intent_id),
    CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
    CHECK ((child_write_confirmed_at IS NULL AND child_write_digest IS NULL)
      OR (child_write_confirmed_at IS NOT NULL
        AND child_write_digest IS NOT NULL
        AND length(child_write_digest) = 64
        AND child_write_digest NOT GLOB '*[^0-9a-f]*')),
    CHECK (child_write_confirmed_at IS NULL OR child_write_attempted_at IS NOT NULL),
    CHECK ((unresolved_at IS NULL AND unresolved_reason IS NULL)
      OR (unresolved_at IS NOT NULL AND unresolved_reason IS NOT NULL)),
    CHECK ((response_kind IS NULL AND response_digest IS NULL AND response_at IS NULL)
      OR (response_kind IS NOT NULL AND response_digest IS NOT NULL
        AND length(response_digest) = 64 AND response_digest NOT GLOB '*[^0-9a-f]*'
        AND response_at IS NOT NULL)),
    CHECK ((notification_digest IS NULL AND notification_at IS NULL)
      OR (notification_digest IS NOT NULL
        AND length(notification_digest) = 64
        AND notification_digest NOT GLOB '*[^0-9a-f]*'
        AND notification_at IS NOT NULL))
  );

  CREATE TRIGGER IF NOT EXISTS codex_thread_archive_attempt_identity_immutable
  BEFORE UPDATE ON codex_thread_archive_attempts
  WHEN NEW.archive_intent_id IS NOT OLD.archive_intent_id
    OR NEW.attempt_count IS NOT OLD.attempt_count
    OR NEW.connection_epoch IS NOT OLD.connection_epoch
    OR NEW.rpc_id IS NOT OLD.rpc_id
    OR NEW.request_digest IS NOT OLD.request_digest
    OR NEW.activated_at IS NOT OLD.activated_at
  BEGIN SELECT RAISE(ABORT, 'codex_thread_archive_attempt_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_archive_intent_identity_immutable
  BEFORE UPDATE ON codex_thread_archive_intents
  WHEN NEW.thread_binding_id IS NOT OLD.thread_binding_id
    OR NEW.codex_thread_id IS NOT OLD.codex_thread_id
    OR NEW.codex_session_id IS NOT OLD.codex_session_id
    OR NEW.isolated_thread_cwd IS NOT OLD.isolated_thread_cwd
    OR NEW.ready_conversation_alias IS NOT OLD.ready_conversation_alias
    OR NEW.alias_generation IS NOT OLD.alias_generation
    OR NEW.source_kind IS NOT OLD.source_kind
    OR NEW.retired_reason IS NOT OLD.retired_reason
    OR NEW.ready_run_id IS NOT OLD.ready_run_id
    OR NEW.retirement_evidence_digest IS NOT OLD.retirement_evidence_digest
    OR NEW.retirement_transaction_digest IS NOT OLD.retirement_transaction_digest
    OR NEW.intent_digest IS NOT OLD.intent_digest
    OR NEW.requested_at IS NOT OLD.requested_at
  BEGIN SELECT RAISE(ABORT, 'codex_thread_archive_intent_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_archive_ack_immutable
  BEFORE UPDATE ON codex_thread_archive_intents
  WHEN OLD.state = 'acknowledged' AND (
    NEW.state IS NOT OLD.state
    OR NEW.acknowledged_at IS NOT OLD.acknowledged_at
    OR NEW.acknowledgement_kind IS NOT OLD.acknowledgement_kind
    OR NEW.acknowledgement_evidence_digest IS NOT OLD.acknowledgement_evidence_digest
  )
  BEGIN SELECT RAISE(ABORT, 'codex_thread_archive_ack_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_archive_attempt_monotonic
  BEFORE UPDATE ON codex_thread_archive_intents
  WHEN NEW.attempt_count < OLD.attempt_count
  BEGIN SELECT RAISE(ABORT, 'codex_thread_archive_attempt_not_monotonic'); END;
`

export function applyCodexThreadArchiveCleanupSchema(db: Pick<DatabaseConnection, 'exec'>): void {
  db.exec(CODEX_THREAD_ARCHIVE_CLEANUP_SCHEMA_SQL)
}

export function applyCodexBeginNewContextArchiveSourceMigration(
  db: Pick<DatabaseConnection, 'exec'>,
): void {
  db.exec(`
    ALTER TABLE codex_thread_archive_attempts
      RENAME TO codex_thread_archive_attempts_legacy_121;
    ALTER TABLE codex_thread_archive_intents
      RENAME TO codex_thread_archive_intents_legacy_121;

    DROP INDEX IF EXISTS codex_thread_archive_intents_pending_idx;
    DROP TRIGGER IF EXISTS codex_thread_archive_attempt_identity_immutable;
    DROP TRIGGER IF EXISTS codex_thread_archive_intent_identity_immutable;
    DROP TRIGGER IF EXISTS codex_thread_archive_ack_immutable;
    DROP TRIGGER IF EXISTS codex_thread_archive_attempt_monotonic;
  `)
  applyCodexThreadArchiveCleanupSchema(db)
  db.exec(`
    INSERT INTO codex_thread_archive_intents
      SELECT * FROM codex_thread_archive_intents_legacy_121;
    INSERT INTO codex_thread_archive_attempts
      SELECT * FROM codex_thread_archive_attempts_legacy_121;
    DROP TABLE codex_thread_archive_attempts_legacy_121;
    DROP TABLE codex_thread_archive_intents_legacy_121;
  `)
}
