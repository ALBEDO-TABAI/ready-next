import type { MigrationDatabase } from '../../migrations'

type TableInfoRow = { name: string }

function tableExists(db: MigrationDatabase, tableName: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName))
}

function addColumnIfMissing(
  db: MigrationDatabase,
  tableName: string,
  columnName: string,
  declaration: string,
): void {
  if (!tableExists(db, tableName)) return
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all<TableInfoRow>()
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${declaration}`)
  }
}

function clearLegacyMemoryRows(db: MigrationDatabase): void {
  for (const tableName of [
    'agent_trigger_refs',
    'agent_memory_access_log',
    'agent_triggers',
    'agent_memory_metadata',
    'agent_knowledge',
  ]) {
    if (tableExists(db, tableName)) db.exec(`DELETE FROM ${tableName}`)
  }
}

function settleRetiredSkillJobs(db: MigrationDatabase): void {
  if (!tableExists(db, 'skills_jobs')) return
  const columns = new Set(
    db.prepare('PRAGMA table_info(skills_jobs)').all<TableInfoRow>().map((column) => column.name),
  )
  if (!columns.has('status') || !columns.has('finished_at') || !columns.has('error')) return
  const durationAssignment = columns.has('duration_ms') && columns.has('started_at')
    ? `duration_ms = CASE
        WHEN duration_ms IS NOT NULL THEN duration_ms
        WHEN started_at IS NULL THEN NULL
        ELSE MAX(0, CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER))
      END,`
    : ''
  db.exec(`
    UPDATE skills_jobs
    SET status = 'failed',
        finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        ${durationAssignment}
        error = 'retired_workflow: legacy skill job was settled by migration 113'
    WHERE status IN ('queued', 'running')
  `)
}

function addCodexTurnMemoryColumns(db: MigrationDatabase): void {
  addColumnIfMissing(
    db,
    'codex_turn_bindings',
    'ready_memory_snapshot_json',
    `ready_memory_snapshot_json TEXT
      CHECK (ready_memory_snapshot_json IS NULL OR (
        json_valid(ready_memory_snapshot_json)
        AND json_type(ready_memory_snapshot_json) = 'object'
      ))`,
  )
  addColumnIfMissing(
    db,
    'codex_turn_bindings',
    'ready_memory_snapshot_digest',
    `ready_memory_snapshot_digest TEXT
      CHECK (ready_memory_snapshot_digest IS NULL OR (
        length(ready_memory_snapshot_digest) = 64
        AND ready_memory_snapshot_digest NOT GLOB '*[^0-9a-f]*'
      ))`,
  )
  addColumnIfMissing(
    db,
    'codex_turn_bindings',
    'ready_memory_state_revision',
    `ready_memory_state_revision INTEGER
      CHECK (ready_memory_state_revision IS NULL OR ready_memory_state_revision >= 1)`,
  )
  addColumnIfMissing(
    db,
    'codex_turn_bindings',
    'ready_memory_revocation_revision',
    `ready_memory_revocation_revision INTEGER
      CHECK (ready_memory_revocation_revision IS NULL OR ready_memory_revocation_revision >= 0)`,
  )
  addColumnIfMissing(
    db,
    'codex_turn_bindings',
    'ready_memory_read_receipt_json',
    `ready_memory_read_receipt_json TEXT
      CHECK (ready_memory_read_receipt_json IS NULL OR (
        json_valid(ready_memory_read_receipt_json)
        AND json_type(ready_memory_read_receipt_json) = 'object'
      ))`,
  )
  addColumnIfMissing(
    db,
    'codex_turn_bindings',
    'ready_memory_read_receipt_digest',
    `ready_memory_read_receipt_digest TEXT
      CHECK (ready_memory_read_receipt_digest IS NULL OR (
        length(ready_memory_read_receipt_digest) = 64
        AND ready_memory_read_receipt_digest NOT GLOB '*[^0-9a-f]*'
      ))`,
  )

  if (!tableExists(db, 'codex_turn_bindings')) return
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS codex_turn_ready_memory_pair_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NOT (
      (NEW.ready_memory_snapshot_json IS NULL
        AND NEW.ready_memory_snapshot_digest IS NULL
        AND NEW.ready_memory_state_revision IS NULL
        AND NEW.ready_memory_revocation_revision IS NULL
        AND NEW.ready_memory_read_receipt_json IS NULL
        AND NEW.ready_memory_read_receipt_digest IS NULL)
      OR
      (NEW.ready_memory_snapshot_json IS NOT NULL
        AND NEW.ready_memory_snapshot_digest IS NOT NULL
        AND NEW.ready_memory_state_revision IS NOT NULL
        AND NEW.ready_memory_revocation_revision IS NOT NULL
        AND NEW.ready_memory_revocation_revision <= NEW.ready_memory_state_revision
        AND ((NEW.ready_memory_read_receipt_json IS NULL
              AND NEW.ready_memory_read_receipt_digest IS NULL)
          OR (NEW.ready_memory_read_receipt_json IS NOT NULL
              AND NEW.ready_memory_read_receipt_digest IS NOT NULL)))
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_ready_memory_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_ready_memory_pair_update
    BEFORE UPDATE OF ready_memory_snapshot_json, ready_memory_snapshot_digest,
      ready_memory_state_revision, ready_memory_revocation_revision,
      ready_memory_read_receipt_json, ready_memory_read_receipt_digest
    ON codex_turn_bindings
    WHEN NOT (
      NEW.ready_memory_snapshot_json IS NOT NULL
      AND NEW.ready_memory_snapshot_digest IS NOT NULL
      AND NEW.ready_memory_state_revision IS NOT NULL
      AND NEW.ready_memory_revocation_revision IS NOT NULL
      AND NEW.ready_memory_revocation_revision <= NEW.ready_memory_state_revision
      AND ((NEW.ready_memory_read_receipt_json IS NULL
            AND NEW.ready_memory_read_receipt_digest IS NULL)
        OR (NEW.ready_memory_read_receipt_json IS NOT NULL
            AND NEW.ready_memory_read_receipt_digest IS NOT NULL))
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_ready_memory_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_ready_memory_snapshot_immutable
    BEFORE UPDATE OF ready_memory_snapshot_json, ready_memory_snapshot_digest,
      ready_memory_state_revision, ready_memory_revocation_revision
    ON codex_turn_bindings
    WHEN OLD.ready_memory_snapshot_digest IS NOT NULL AND (
      NEW.ready_memory_snapshot_json IS NOT OLD.ready_memory_snapshot_json
      OR NEW.ready_memory_snapshot_digest IS NOT OLD.ready_memory_snapshot_digest
      OR NEW.ready_memory_state_revision IS NOT OLD.ready_memory_state_revision
      OR NEW.ready_memory_revocation_revision IS NOT OLD.ready_memory_revocation_revision
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_ready_memory_snapshot_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_ready_memory_receipt_immutable
    BEFORE UPDATE OF ready_memory_read_receipt_json, ready_memory_read_receipt_digest
    ON codex_turn_bindings
    WHEN OLD.ready_memory_read_receipt_digest IS NOT NULL AND (
      NEW.ready_memory_read_receipt_json IS NOT OLD.ready_memory_read_receipt_json
      OR NEW.ready_memory_read_receipt_digest IS NOT OLD.ready_memory_read_receipt_digest
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_ready_memory_receipt_immutable'); END;
  `)
}

function addGatewayMemoryRedactionReceiptColumns(db: MigrationDatabase): void {
  addColumnIfMissing(
    db,
    'ready_model_gateway_exchange_events',
    'memory_history_redaction_digest',
    `memory_history_redaction_digest TEXT
      CHECK (memory_history_redaction_digest IS NULL OR (
        length(memory_history_redaction_digest) = 64
        AND memory_history_redaction_digest NOT GLOB '*[^0-9a-f]*'
      ))`,
  )
  addColumnIfMissing(
    db,
    'ready_model_gateway_exchange_events',
    'memory_history_redacted_item_count',
    `memory_history_redacted_item_count INTEGER
      CHECK (memory_history_redacted_item_count IS NULL
        OR memory_history_redacted_item_count >= 0)`,
  )
}

export function applyReadyMemoryMigration(db: MigrationDatabase): void {
  addGatewayMemoryRedactionReceiptColumns(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ready_memory_sources (
      source_id TEXT PRIMARY KEY CHECK (length(trim(source_id)) > 0),
      conversation_id TEXT NOT NULL CHECK (length(trim(conversation_id)) > 0),
      source_digest TEXT NOT NULL UNIQUE CHECK (
        length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'
      ),
      source_updated_at TEXT NOT NULL CHECK (length(trim(source_updated_at)) > 0),
      evidence_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(evidence_refs_json)
        AND json_type(evidence_refs_json) = 'array'
        AND json_array_length(evidence_refs_json) <= 128
        AND length(evidence_refs_json) <= 32768
      ),
      summary_text TEXT,
      summary_digest TEXT CHECK (summary_digest IS NULL OR (
        length(summary_digest) = 64 AND summary_digest NOT GLOB '*[^0-9a-f]*'
      )),
      sealed_at TEXT,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      CHECK (
        (summary_text IS NULL AND summary_digest IS NULL AND sealed_at IS NULL)
        OR
        (summary_text IS NOT NULL AND length(trim(summary_text)) > 0
          AND length(summary_text) <= 65536
          AND summary_digest IS NOT NULL
          AND sealed_at IS NOT NULL AND length(trim(sealed_at)) > 0)
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ready_memory_entries (
      entry_id TEXT PRIMARY KEY CHECK (length(trim(entry_id)) > 0),
      category TEXT NOT NULL CHECK (
        category IN ('preference', 'fact', 'project', 'workflow', 'other')
      ),
      content TEXT NOT NULL CHECK (length(trim(content)) > 0 AND length(content) <= 16384),
      content_digest TEXT NOT NULL CHECK (
        length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
      ),
      origin TEXT NOT NULL CHECK (origin IN ('manual', 'consolidated')),
      confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN ('active', 'superseded', 'expired')
      ),
      superseded_by_entry_id TEXT,
      expires_at TEXT,
      source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(source_refs_json)
        AND json_type(source_refs_json) = 'array'
        AND json_array_length(source_refs_json) <= 32
        AND length(source_refs_json) <= 8192
      ),
      state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
      revocation_revision INTEGER NOT NULL CHECK (
        revocation_revision >= 0 AND revocation_revision <= state_revision
      ),
      last_used_at TEXT,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      CHECK (
        (status = 'superseded' AND superseded_by_entry_id IS NOT NULL
          AND length(trim(superseded_by_entry_id)) > 0
          AND superseded_by_entry_id <> entry_id)
        OR (status <> 'superseded' AND superseded_by_entry_id IS NULL)
      ),
      CHECK (status <> 'expired' OR expires_at IS NOT NULL),
      CHECK (pinned = 0 OR (status = 'active' AND expires_at IS NULL)),
      CHECK (origin = 'manual' OR json_array_length(source_refs_json) > 0)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ready_memory_jobs (
      job_id TEXT PRIMARY KEY CHECK (length(trim(job_id)) > 0),
      job_kind TEXT NOT NULL CHECK (job_kind IN ('extraction', 'consolidation')),
      source_id TEXT,
      input_digest TEXT NOT NULL CHECK (
        length(input_digest) = 64 AND input_digest NOT GLOB '*[^0-9a-f]*'
      ),
      input_payload_json TEXT CHECK (input_payload_json IS NULL OR (
        json_valid(input_payload_json) AND json_type(input_payload_json) = 'object'
        AND length(input_payload_json) <= 65536
      )),
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'leased', 'submitted', 'succeeded', 'no_output', 'failed', 'unknown')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      provider_request_id TEXT,
      submitted_at TEXT,
      submission_receipt_json TEXT CHECK (
        submission_receipt_json IS NULL OR (
          json_valid(submission_receipt_json) AND json_type(submission_receipt_json) = 'object'
          AND length(submission_receipt_json) <= 131072
        )
      ),
      submission_receipt_digest TEXT CHECK (submission_receipt_digest IS NULL OR (
        length(submission_receipt_digest) = 64
        AND submission_receipt_digest NOT GLOB '*[^0-9a-f]*'
      )),
      terminal_at TEXT,
      result_receipt_json TEXT CHECK (
        result_receipt_json IS NULL OR (
          json_valid(result_receipt_json) AND json_type(result_receipt_json) = 'object'
          AND length(result_receipt_json) <= 65536
        )
      ),
      result_receipt_digest TEXT CHECK (result_receipt_digest IS NULL OR (
        length(result_receipt_digest) = 64
        AND result_receipt_digest NOT GLOB '*[^0-9a-f]*'
      )),
      effects_applied_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      FOREIGN KEY (source_id) REFERENCES ready_memory_sources(source_id) ON DELETE RESTRICT,
      UNIQUE (job_kind, input_digest),
      CHECK (
        (job_kind = 'extraction' AND source_id IS NOT NULL AND input_payload_json IS NULL)
        OR (job_kind = 'consolidation' AND source_id IS NULL AND input_payload_json IS NOT NULL)
      ),
      CHECK (effects_applied_at IS NULL OR status IN ('succeeded', 'no_output')),
      CHECK (
        (status = 'pending' AND lease_owner IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL AND provider_request_id IS NULL
          AND submitted_at IS NULL AND submission_receipt_json IS NULL
          AND submission_receipt_digest IS NULL AND terminal_at IS NULL
          AND result_receipt_json IS NULL AND result_receipt_digest IS NULL
          AND last_error IS NULL)
        OR
        (status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL
          AND lease_expires_at IS NOT NULL AND provider_request_id IS NULL
          AND submitted_at IS NULL AND submission_receipt_json IS NULL
          AND submission_receipt_digest IS NULL AND terminal_at IS NULL
          AND result_receipt_json IS NULL AND result_receipt_digest IS NULL
          AND last_error IS NULL)
        OR
        (status = 'submitted' AND lease_owner IS NULL AND lease_token IS NULL
          AND lease_expires_at IS NULL AND provider_request_id IS NOT NULL
          AND submitted_at IS NOT NULL AND submission_receipt_json IS NOT NULL
          AND submission_receipt_digest IS NOT NULL AND terminal_at IS NULL
          AND result_receipt_json IS NULL AND result_receipt_digest IS NULL
          AND last_error IS NULL)
        OR
        (status IN ('succeeded', 'no_output', 'failed', 'unknown')
          AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL
          AND provider_request_id IS NOT NULL AND submitted_at IS NOT NULL
          AND submission_receipt_json IS NOT NULL AND submission_receipt_digest IS NOT NULL
          AND terminal_at IS NOT NULL AND result_receipt_json IS NOT NULL
          AND result_receipt_digest IS NOT NULL
          AND ((status = 'failed' AND last_error IS NOT NULL)
            OR (status <> 'failed' AND last_error IS NULL)))
      )
    ) STRICT;

    CREATE TABLE IF NOT EXISTS ready_memory_policies (
      policy_key TEXT PRIMARY KEY CHECK (length(trim(policy_key)) > 0),
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'conversation')),
      conversation_id TEXT,
      use_memories INTEGER CHECK (use_memories IS NULL OR use_memories IN (0, 1)),
      generate_memories INTEGER CHECK (generate_memories IS NULL OR generate_memories IN (0, 1)),
      contribute_to_memories INTEGER CHECK (
        contribute_to_memories IS NULL OR contribute_to_memories IN (0, 1)
      ),
      state_revision INTEGER NOT NULL CHECK (state_revision >= 1),
      revocation_revision INTEGER NOT NULL CHECK (
        revocation_revision >= 0 AND revocation_revision <= state_revision
      ),
      last_revocation_reason TEXT CHECK (
        last_revocation_reason IS NULL OR last_revocation_reason IN (
          'edit', 'delete', 'reset', 'use_off', 'generate_off', 'supersede', 'expire'
        )
      ),
      updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
      CHECK (
        (scope_kind = 'global' AND policy_key = 'global' AND conversation_id IS NULL
          AND use_memories IS NOT NULL AND generate_memories IS NOT NULL
          AND contribute_to_memories IS NULL)
        OR
        (scope_kind = 'conversation' AND conversation_id IS NOT NULL
          AND length(trim(conversation_id)) > 0
          AND policy_key = 'conversation:' || conversation_id
          AND use_memories IS NULL AND generate_memories IS NULL
          AND contribute_to_memories IS NOT NULL)
      ),
      CHECK (
        (revocation_revision = 0 AND last_revocation_reason IS NULL)
        OR (revocation_revision > 0 AND last_revocation_reason IS NOT NULL)
      )
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_ready_memory_sources_conversation
      ON ready_memory_sources(conversation_id, source_updated_at DESC, source_id);
    CREATE INDEX IF NOT EXISTS idx_ready_memory_entries_snapshot
      ON ready_memory_entries(pinned DESC, origin, updated_at DESC, entry_id)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_ready_memory_entries_expiry
      ON ready_memory_entries(expires_at, entry_id)
      WHERE status = 'active' AND expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ready_memory_entries_content_digest
      ON ready_memory_entries(content_digest, status);
    CREATE INDEX IF NOT EXISTS idx_ready_memory_jobs_claim
      ON ready_memory_jobs(status, created_at, job_id);
    CREATE INDEX IF NOT EXISTS idx_ready_memory_jobs_lease_expiry
      ON ready_memory_jobs(lease_expires_at, job_id) WHERE status = 'leased';
    CREATE INDEX IF NOT EXISTS idx_ready_memory_jobs_source
      ON ready_memory_jobs(source_id, job_kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ready_memory_policy_conversation
      ON ready_memory_policies(conversation_id) WHERE conversation_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS ready_memory_source_identity_immutable
    BEFORE UPDATE ON ready_memory_sources
    WHEN NEW.source_id IS NOT OLD.source_id
      OR NEW.conversation_id IS NOT OLD.conversation_id
      OR NEW.source_digest IS NOT OLD.source_digest
      OR NEW.source_updated_at IS NOT OLD.source_updated_at
      OR NEW.evidence_refs_json IS NOT OLD.evidence_refs_json
      OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.summary_digest IS NOT NULL AND (
        NEW.summary_text IS NOT OLD.summary_text
        OR NEW.summary_digest IS NOT OLD.summary_digest
        OR NEW.sealed_at IS NOT OLD.sealed_at
      ))
    BEGIN SELECT RAISE(ABORT, 'ready_memory_source_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS ready_memory_job_input_immutable
    BEFORE UPDATE ON ready_memory_jobs
    WHEN NEW.job_id IS NOT OLD.job_id
      OR NEW.job_kind IS NOT OLD.job_kind
      OR NEW.source_id IS NOT OLD.source_id
      OR NEW.input_digest IS NOT OLD.input_digest
      OR NEW.input_payload_json IS NOT OLD.input_payload_json
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'ready_memory_job_input_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS ready_memory_policy_revision_monotonic
    BEFORE UPDATE ON ready_memory_policies
    WHEN NEW.state_revision <= OLD.state_revision
      OR NEW.revocation_revision < OLD.revocation_revision
    BEGIN SELECT RAISE(ABORT, 'ready_memory_policy_revision_not_monotonic'); END;

    INSERT INTO ready_memory_policies (
      policy_key, scope_kind, conversation_id, use_memories, generate_memories,
      contribute_to_memories, state_revision, revocation_revision,
      last_revocation_reason, updated_at
    ) VALUES (
      'global', 'global', NULL, 1, 0, NULL, 1, 0, NULL,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ) ON CONFLICT(policy_key) DO NOTHING;
  `)

  addCodexTurnMemoryColumns(db)
  clearLegacyMemoryRows(db)
  settleRetiredSkillJobs(db)
}
