export const CODEX_TOOL_RESPONSE_DELIVERY_ATTEMPT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS codex_tool_response_delivery_attempts (
    attempt_id TEXT PRIMARY KEY,
    codex_thread_id TEXT NOT NULL,
    codex_turn_id TEXT NOT NULL,
    codex_call_id TEXT NOT NULL,
    ready_action_id TEXT NOT NULL,
    connection_epoch TEXT NOT NULL,
    request_rpc_id TEXT NOT NULL,
    tool_response_json TEXT NOT NULL,
    tool_response_digest TEXT NOT NULL CHECK (
      length(tool_response_digest) = 64
      AND tool_response_digest NOT GLOB '*[^0-9a-f]*'
    ),
    transport_write_confirmed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (connection_epoch, request_rpc_id),
    UNIQUE (
      codex_thread_id, codex_turn_id, codex_call_id,
      connection_epoch, request_rpc_id
    ),
    FOREIGN KEY (codex_thread_id, codex_turn_id, codex_call_id)
      REFERENCES codex_tool_call_bindings(codex_thread_id, codex_turn_id, codex_call_id)
  );

  CREATE TRIGGER IF NOT EXISTS codex_tool_delivery_attempt_parent_insert
  BEFORE INSERT ON codex_tool_response_delivery_attempts
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_tool_call_bindings binding
    JOIN ready_tool_action_receipts action
      ON action.ready_action_id = binding.ready_action_id
     AND action.state = 'confirmed'
     AND action.receipt_id = binding.receipt_id
     AND action.result_digest = binding.result_digest
     WHERE binding.codex_thread_id = NEW.codex_thread_id
       AND binding.codex_turn_id = NEW.codex_turn_id
       AND binding.codex_call_id = NEW.codex_call_id
       AND binding.ready_action_id = NEW.ready_action_id
       AND binding.receipt_id IS NOT NULL
       AND binding.result_digest IS NOT NULL
  )
  BEGIN SELECT RAISE(ABORT, 'codex_tool_delivery_attempt_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_tool_delivery_attempt_immutable_update
  BEFORE UPDATE ON codex_tool_response_delivery_attempts
  WHEN NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.codex_thread_id IS NOT OLD.codex_thread_id
    OR NEW.codex_turn_id IS NOT OLD.codex_turn_id
    OR NEW.codex_call_id IS NOT OLD.codex_call_id
    OR NEW.ready_action_id IS NOT OLD.ready_action_id
    OR NEW.connection_epoch IS NOT OLD.connection_epoch
    OR NEW.request_rpc_id IS NOT OLD.request_rpc_id
    OR NEW.tool_response_json IS NOT OLD.tool_response_json
    OR NEW.tool_response_digest IS NOT OLD.tool_response_digest
    OR NEW.created_at IS NOT OLD.created_at
    OR (OLD.transport_write_confirmed_at IS NOT NULL
      AND NEW.transport_write_confirmed_at IS NOT OLD.transport_write_confirmed_at)
  BEGIN SELECT RAISE(ABORT, 'codex_tool_delivery_attempt_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_tool_delivery_attempt_no_delete
  BEFORE DELETE ON codex_tool_response_delivery_attempts
  BEGIN SELECT RAISE(ABORT, 'codex_tool_delivery_attempt_delete_forbidden'); END;
`

export const CODEX_TOOL_REQUEST_RPC_BINDING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS codex_tool_request_rpc_bindings (
    connection_epoch TEXT NOT NULL,
    request_rpc_id TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL,
    codex_turn_id TEXT NOT NULL,
    codex_call_id TEXT NOT NULL,
    ready_action_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (connection_epoch, request_rpc_id),
    FOREIGN KEY (codex_thread_id, codex_turn_id, codex_call_id)
      REFERENCES codex_tool_call_bindings(codex_thread_id, codex_turn_id, codex_call_id)
  );

  CREATE TRIGGER IF NOT EXISTS codex_tool_request_rpc_binding_immutable_update
  BEFORE UPDATE ON codex_tool_request_rpc_bindings
  BEGIN SELECT RAISE(ABORT, 'codex_tool_request_rpc_binding_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_tool_request_rpc_binding_no_delete
  BEFORE DELETE ON codex_tool_request_rpc_bindings
  BEGIN SELECT RAISE(ABORT, 'codex_tool_request_rpc_binding_delete_forbidden'); END;
`

export const CODEX_BINDING_EVIDENCE_GUARDS_SQL = `
  CREATE TRIGGER IF NOT EXISTS codex_fence_parent_update
  BEFORE UPDATE ON codex_thread_dispatch_fences
  WHEN NEW.thread_binding_id IS NOT OLD.thread_binding_id
    OR (
      NEW.owner_main_boot_id IS NOT OLD.owner_main_boot_id
      AND NOT (
        NEW.revision = OLD.revision + 1
        AND EXISTS (
          SELECT 1 FROM codex_fence_owner_transfers transfer
           WHERE transfer.thread_binding_id = OLD.thread_binding_id
             AND transfer.operation_kind = OLD.operation_kind
             AND transfer.owner_ready_run_id IS OLD.owner_ready_run_id
             AND transfer.owner_manual_compaction_id IS OLD.owner_manual_compaction_id
             AND transfer.previous_owner_main_boot_id = OLD.owner_main_boot_id
             AND transfer.new_owner_main_boot_id = NEW.owner_main_boot_id
             AND transfer.previous_fence_revision = OLD.revision
             AND transfer.new_fence_revision = NEW.revision
        )
      )
    )
    OR NEW.operation_kind IS NOT OLD.operation_kind
    OR NEW.owner_ready_run_id IS NOT OLD.owner_ready_run_id
    OR NEW.owner_manual_compaction_id IS NOT OLD.owner_manual_compaction_id
    OR NEW.acquired_at IS NOT OLD.acquired_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR (OLD.quarantined_at IS NOT NULL AND NEW.quarantined_at IS NOT OLD.quarantined_at)
    OR (OLD.quarantine_reason IS NOT NULL AND NEW.quarantine_reason IS NOT OLD.quarantine_reason)
  BEGIN SELECT RAISE(ABORT, 'codex_fence_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_process_lease_identity_immutable_update
  BEFORE UPDATE ON codex_sidecar_process_leases
  WHEN NEW.process_lease_id IS NOT OLD.process_lease_id
    OR NEW.singleton_slot IS NOT OLD.singleton_slot
    OR NEW.owner_main_boot_id IS NOT OLD.owner_main_boot_id
    OR NEW.owner_main_pid IS NOT OLD.owner_main_pid
    OR NEW.owner_main_process_start_identity IS NOT OLD.owner_main_process_start_identity
    OR NEW.sidecar_spawn_instance_id IS NOT OLD.sidecar_spawn_instance_id
    OR NEW.connection_epoch IS NOT OLD.connection_epoch
    OR NEW.runtime_manifest_digest IS NOT OLD.runtime_manifest_digest
    OR NEW.binary_sha256 IS NOT OLD.binary_sha256
    OR NEW.executable_path IS NOT OLD.executable_path
    OR NEW.isolated_state_dir IS NOT OLD.isolated_state_dir
    OR NEW.spawn_intent_at IS NOT OLD.spawn_intent_at
    OR NEW.spawn_visibility_deadline_at IS NOT OLD.spawn_visibility_deadline_at
    OR (OLD.pid IS NOT NULL AND NEW.pid IS NOT OLD.pid)
    OR (OLD.process_group_id IS NOT NULL AND NEW.process_group_id IS NOT OLD.process_group_id)
    OR (OLD.process_start_identity IS NOT NULL
      AND NEW.process_start_identity IS NOT OLD.process_start_identity)
    OR (OLD.ownership_confirmed_at IS NOT NULL
      AND NEW.ownership_confirmed_at IS NOT OLD.ownership_confirmed_at)
    OR (OLD.owner_main_dead_at IS NOT NULL
      AND NEW.owner_main_dead_at IS NOT OLD.owner_main_dead_at)
    OR (OLD.owner_main_death_evidence_digest IS NOT NULL
      AND NEW.owner_main_death_evidence_digest IS NOT OLD.owner_main_death_evidence_digest)
    OR (OLD.connection_opened_at IS NOT NULL
      AND NEW.connection_opened_at IS NOT OLD.connection_opened_at)
    OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS NOT OLD.closed_at)
    OR (OLD.tree_zero_at IS NOT NULL AND NEW.tree_zero_at IS NOT OLD.tree_zero_at)
    OR (OLD.tree_zero_matcher_mode IS NOT NULL
      AND NEW.tree_zero_matcher_mode IS NOT OLD.tree_zero_matcher_mode)
    OR (OLD.stable_zero_sample_transcript_digest IS NOT NULL
      AND NEW.stable_zero_sample_transcript_digest IS NOT OLD.stable_zero_sample_transcript_digest)
    OR (OLD.tree_zero_evidence_digest IS NOT NULL
      AND NEW.tree_zero_evidence_digest IS NOT OLD.tree_zero_evidence_digest)
  BEGIN SELECT RAISE(ABORT, 'codex_process_lease_identity_immutable'); END;
`

export function applyCodexGatewayTurnClaimMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const columns = db.prepare('PRAGMA table_info(codex_turn_bindings)').all<{ name: string }>()
  if (!columns.some((column) => column.name === 'gateway_claimed_codex_turn_id')) {
    db.exec('ALTER TABLE codex_turn_bindings ADD COLUMN gateway_claimed_codex_turn_id TEXT')
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_turn_gateway_claim
      ON codex_turn_bindings(codex_thread_id, gateway_claimed_codex_turn_id)
      WHERE gateway_claimed_codex_turn_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS codex_turn_gateway_claim_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN OLD.gateway_claimed_codex_turn_id IS NOT NULL
      AND NEW.gateway_claimed_codex_turn_id IS NOT OLD.gateway_claimed_codex_turn_id
    BEGIN SELECT RAISE(ABORT, 'codex_turn_gateway_claim_immutable'); END;
  `)
}

export function applyCodexToolBridgeMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const addMissingColumns = (table: string, columns: ReadonlyArray<readonly [string, string]>) => {
    const existing = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>().map((column) => column.name),
    )
    for (const [name, declaration] of columns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`)
    }
  }
  addMissingColumns('codex_thread_bindings', [
    ['tool_surface_snapshot_digest', 'TEXT'],
    ['tool_surface_json', 'TEXT'],
  ])
  addMissingColumns('codex_turn_bindings', [
    ['authorization_snapshot_json', 'TEXT'],
    ['product_budget_seed_json', 'TEXT'],
  ])
  addMissingColumns('codex_tool_call_bindings', [
    ['ready_alias_id', 'TEXT'],
    ['codex_session_id', 'TEXT'],
    ['ready_task_id', 'TEXT'],
    ['surface_snapshot_digest', 'TEXT'],
    ['tool_surface_digest', 'TEXT'],
    ['authorization_snapshot_digest', 'TEXT'],
    ['tool_schema_digest', 'TEXT'],
    ['request_connection_epoch', 'TEXT'],
    ['request_rpc_id', 'TEXT'],
    ['delivered_connection_epoch', 'TEXT'],
    ['delivered_rpc_id', 'TEXT'],
    ['tool_response_digest', 'TEXT'],
    ['legacy_delivery_evidence_unverifiable', 'INTEGER NOT NULL DEFAULT 0'],
    ['delivery_intent_at', 'TEXT'],
  ])
  db.exec(`
    CREATE TABLE IF NOT EXISTS ready_tool_action_receipts (
      ready_action_id TEXT PRIMARY KEY,
      action_identity_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'proven_absent', 'indeterminate')),
      receipt_id TEXT UNIQUE,
      result_digest TEXT,
      result_json TEXT,
      resolution_reason TEXT,
      resolution_evidence_digest TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'pending' AND receipt_id IS NULL AND result_digest IS NULL AND result_json IS NULL
          AND resolution_reason IS NULL AND resolution_evidence_digest IS NULL)
        OR (state = 'confirmed' AND receipt_id IS NOT NULL AND result_digest IS NOT NULL
          AND result_json IS NOT NULL AND resolution_reason IS NULL AND resolution_evidence_digest IS NULL)
        OR (state IN ('proven_absent', 'indeterminate') AND receipt_id IS NULL
          AND result_digest IS NULL AND result_json IS NULL
          AND resolution_reason IS NOT NULL AND resolution_evidence_digest IS NOT NULL)
      )
    );

    DROP TRIGGER IF EXISTS ready_tool_action_receipt_identity_immutable_update;
    CREATE TRIGGER ready_tool_action_receipt_identity_immutable_update
    BEFORE UPDATE ON ready_tool_action_receipts
    WHEN NEW.ready_action_id IS NOT OLD.ready_action_id
      OR NEW.action_identity_digest IS NOT OLD.action_identity_digest
      OR (OLD.state != 'pending' AND NEW.state IS NOT OLD.state)
      OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
      OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS NOT OLD.result_digest)
      OR (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json)
      OR (OLD.resolution_reason IS NOT NULL AND NEW.resolution_reason IS NOT OLD.resolution_reason)
      OR (OLD.resolution_evidence_digest IS NOT NULL
        AND NEW.resolution_evidence_digest IS NOT OLD.resolution_evidence_digest)
    BEGIN SELECT RAISE(ABORT, 'ready_tool_action_receipt_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS ready_tool_action_receipt_no_delete
    BEFORE DELETE ON ready_tool_action_receipts
    BEGIN SELECT RAISE(ABORT, 'ready_tool_action_receipt_delete_forbidden'); END;

    CREATE TRIGGER IF NOT EXISTS codex_thread_tool_surface_snapshot_immutable_update
    BEFORE UPDATE ON codex_thread_bindings
    WHEN (OLD.tool_surface_snapshot_digest IS NOT NULL
      AND NEW.tool_surface_snapshot_digest IS NOT OLD.tool_surface_snapshot_digest)
      OR (OLD.tool_surface_json IS NOT NULL AND NEW.tool_surface_json IS NOT OLD.tool_surface_json)
    BEGIN SELECT RAISE(ABORT, 'codex_thread_tool_surface_snapshot_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_authorization_snapshot_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN OLD.authorization_snapshot_json IS NOT NULL
      AND NEW.authorization_snapshot_json IS NOT OLD.authorization_snapshot_json
      OR (OLD.product_budget_seed_json IS NOT NULL
        AND NEW.product_budget_seed_json IS NOT OLD.product_budget_seed_json)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_authorization_snapshot_immutable'); END;

    DROP TRIGGER IF EXISTS codex_call_binding_immutable_update;
    CREATE TRIGGER codex_call_binding_immutable_update
    BEFORE UPDATE ON codex_tool_call_bindings
    WHEN NEW.codex_thread_id IS NOT OLD.codex_thread_id
      OR NEW.codex_turn_id IS NOT OLD.codex_turn_id
      OR NEW.codex_call_id IS NOT OLD.codex_call_id
      OR NEW.ready_run_id IS NOT OLD.ready_run_id
      OR NEW.ready_action_id IS NOT OLD.ready_action_id
      OR NEW.tool_name IS NOT OLD.tool_name
      OR NEW.args_digest IS NOT OLD.args_digest
      OR NEW.turn_contract_digest IS NOT OLD.turn_contract_digest
      OR NEW.ready_alias_id IS NOT OLD.ready_alias_id
      OR NEW.codex_session_id IS NOT OLD.codex_session_id
      OR NEW.ready_task_id IS NOT OLD.ready_task_id
      OR NEW.surface_snapshot_digest IS NOT OLD.surface_snapshot_digest
      OR NEW.tool_surface_digest IS NOT OLD.tool_surface_digest
      OR NEW.authorization_snapshot_digest IS NOT OLD.authorization_snapshot_digest
      OR NEW.tool_schema_digest IS NOT OLD.tool_schema_digest
      OR NEW.request_connection_epoch IS NOT OLD.request_connection_epoch
      OR NEW.request_rpc_id IS NOT OLD.request_rpc_id
      OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
      OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS NOT OLD.result_digest)
      OR (OLD.delivered_connection_epoch IS NOT NULL
        AND NEW.delivered_connection_epoch IS NOT OLD.delivered_connection_epoch)
      OR (OLD.delivered_rpc_id IS NOT NULL AND NEW.delivered_rpc_id IS NOT OLD.delivered_rpc_id)
      OR (OLD.tool_response_digest IS NOT NULL
        AND NEW.tool_response_digest IS NOT OLD.tool_response_digest)
      OR NEW.legacy_delivery_evidence_unverifiable
        IS NOT OLD.legacy_delivery_evidence_unverifiable
      OR (OLD.delivery_intent_at IS NOT NULL AND NEW.delivery_intent_at IS NOT OLD.delivery_intent_at)
    BEGIN SELECT RAISE(ABORT, 'codex_call_binding_identity_immutable'); END;
  `)
}

export function applyCodexToolResponseEvidenceMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const columns = new Set(
    db.prepare('PRAGMA table_info(codex_tool_call_bindings)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (!columns.has('tool_response_digest')) {
    db.exec('ALTER TABLE codex_tool_call_bindings ADD COLUMN tool_response_digest TEXT')
  }
  if (!columns.has('legacy_delivery_evidence_unverifiable')) {
    db.exec(`
      ALTER TABLE codex_tool_call_bindings
      ADD COLUMN legacy_delivery_evidence_unverifiable INTEGER NOT NULL DEFAULT 0
    `)
  }
  db.exec('DROP TRIGGER IF EXISTS codex_call_binding_immutable_update')
  db.exec(`
    UPDATE codex_tool_call_bindings AS binding
       SET legacy_delivery_evidence_unverifiable = 1
     WHERE binding.legacy_delivery_evidence_unverifiable = 0
       AND binding.delivered_connection_epoch IS NOT NULL
       AND binding.delivered_rpc_id IS NOT NULL
       AND binding.delivery_intent_at IS NOT NULL
       AND binding.tool_response_digest IS NULL
       AND EXISTS (
         SELECT 1
           FROM codex_turn_bindings turn_binding,
                json_each(turn_binding.engine_terminal_candidate_json, '$.usedToolCalls') call
          WHERE turn_binding.ready_run_id = binding.ready_run_id
            AND turn_binding.product_closeout_at IS NULL
            AND turn_binding.host_failure_closeout_at IS NULL
            AND turn_binding.engine_terminal_status = 'failed'
            AND json_extract(call.value, '$.itemId') = binding.codex_call_id
            AND json_extract(call.value, '$.status') = 'failed'
            AND json_type(call.value, '$.responseDigest') IS NULL
       );
  `)
  db.exec(`
    DROP TRIGGER IF EXISTS codex_call_binding_immutable_update;
    CREATE TRIGGER codex_call_binding_immutable_update
    BEFORE UPDATE ON codex_tool_call_bindings
    WHEN NEW.codex_thread_id IS NOT OLD.codex_thread_id
      OR NEW.codex_turn_id IS NOT OLD.codex_turn_id
      OR NEW.codex_call_id IS NOT OLD.codex_call_id
      OR NEW.ready_run_id IS NOT OLD.ready_run_id
      OR NEW.ready_action_id IS NOT OLD.ready_action_id
      OR NEW.tool_name IS NOT OLD.tool_name
      OR NEW.args_digest IS NOT OLD.args_digest
      OR NEW.turn_contract_digest IS NOT OLD.turn_contract_digest
      OR NEW.ready_alias_id IS NOT OLD.ready_alias_id
      OR NEW.codex_session_id IS NOT OLD.codex_session_id
      OR NEW.ready_task_id IS NOT OLD.ready_task_id
      OR NEW.surface_snapshot_digest IS NOT OLD.surface_snapshot_digest
      OR NEW.tool_surface_digest IS NOT OLD.tool_surface_digest
      OR NEW.authorization_snapshot_digest IS NOT OLD.authorization_snapshot_digest
      OR NEW.tool_schema_digest IS NOT OLD.tool_schema_digest
      OR NEW.request_connection_epoch IS NOT OLD.request_connection_epoch
      OR NEW.request_rpc_id IS NOT OLD.request_rpc_id
      OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
      OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS NOT OLD.result_digest)
      OR (OLD.delivered_connection_epoch IS NOT NULL
        AND NEW.delivered_connection_epoch IS NOT OLD.delivered_connection_epoch)
      OR (OLD.delivered_rpc_id IS NOT NULL AND NEW.delivered_rpc_id IS NOT OLD.delivered_rpc_id)
      OR (OLD.tool_response_digest IS NOT NULL
        AND NEW.tool_response_digest IS NOT OLD.tool_response_digest)
      OR NEW.legacy_delivery_evidence_unverifiable
        IS NOT OLD.legacy_delivery_evidence_unverifiable
      OR (OLD.delivery_intent_at IS NOT NULL AND NEW.delivery_intent_at IS NOT OLD.delivery_intent_at)
    BEGIN SELECT RAISE(ABORT, 'codex_call_binding_identity_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_call_delivery_evidence_insert
    BEFORE INSERT ON codex_tool_call_bindings
    WHEN NOT (
      (NEW.delivered_connection_epoch IS NULL
        AND NEW.delivered_rpc_id IS NULL
        AND NEW.tool_response_digest IS NULL
        AND NEW.legacy_delivery_evidence_unverifiable = 0
        AND NEW.delivery_intent_at IS NULL)
      OR
      (NEW.delivered_connection_epoch IS NOT NULL
        AND NEW.delivered_rpc_id IS NOT NULL
        AND NEW.tool_response_digest IS NOT NULL
        AND length(NEW.tool_response_digest) = 64
        AND NEW.tool_response_digest NOT GLOB '*[^0-9a-f]*'
        AND NEW.legacy_delivery_evidence_unverifiable = 0
        AND NEW.delivery_intent_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_call_delivery_evidence_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_call_delivery_evidence_update
    BEFORE UPDATE ON codex_tool_call_bindings
    WHEN NOT (
      (NEW.delivered_connection_epoch IS NULL
        AND NEW.delivered_rpc_id IS NULL
        AND NEW.tool_response_digest IS NULL
        AND NEW.legacy_delivery_evidence_unverifiable = 0
        AND NEW.delivery_intent_at IS NULL)
      OR
      (NEW.delivered_connection_epoch IS NOT NULL
        AND NEW.delivered_rpc_id IS NOT NULL
        AND NEW.tool_response_digest IS NOT NULL
        AND length(NEW.tool_response_digest) = 64
        AND NEW.tool_response_digest NOT GLOB '*[^0-9a-f]*'
        AND NEW.legacy_delivery_evidence_unverifiable = 0
        AND NEW.delivery_intent_at IS NOT NULL)
      OR
      (NEW.delivered_connection_epoch IS NOT NULL
        AND NEW.delivered_rpc_id IS NOT NULL
        AND NEW.tool_response_digest IS NULL
        AND NEW.legacy_delivery_evidence_unverifiable = 1
        AND NEW.delivery_intent_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_call_delivery_evidence_invalid'); END;
  `)
}

export function applyCodexToolResponseDeliveryAttemptMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(CODEX_TOOL_RESPONSE_DELIVERY_ATTEMPT_SCHEMA_SQL)
}

export function applyCodexToolRequestRpcBindingMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(CODEX_TOOL_REQUEST_RPC_BINDING_SCHEMA_SQL)
  db.exec(`
    INSERT INTO codex_tool_request_rpc_bindings (
      connection_epoch, request_rpc_id, codex_thread_id, codex_turn_id,
      codex_call_id, ready_action_id, created_at
    )
    SELECT request_connection_epoch, trim(request_rpc_id), codex_thread_id, codex_turn_id,
           codex_call_id, ready_action_id, created_at
      FROM codex_tool_call_bindings
     WHERE request_connection_epoch IS NOT NULL
       AND trim(COALESCE(request_rpc_id, '')) <> '';

    INSERT INTO codex_tool_request_rpc_bindings (
      connection_epoch, request_rpc_id, codex_thread_id, codex_turn_id,
      codex_call_id, ready_action_id, created_at
    )
    SELECT attempt.connection_epoch, trim(attempt.request_rpc_id),
           attempt.codex_thread_id, attempt.codex_turn_id, attempt.codex_call_id,
           attempt.ready_action_id, attempt.created_at
      FROM codex_tool_response_delivery_attempts attempt
     WHERE NOT EXISTS (
       SELECT 1 FROM codex_tool_request_rpc_bindings existing
        WHERE existing.connection_epoch = attempt.connection_epoch
          AND existing.request_rpc_id = trim(attempt.request_rpc_id)
          AND existing.codex_thread_id = attempt.codex_thread_id
          AND existing.codex_turn_id = attempt.codex_turn_id
          AND existing.codex_call_id = attempt.codex_call_id
          AND existing.ready_action_id = attempt.ready_action_id
     );
  `)
}

export function applyCodexE5BudgetAdmissionMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_tool_group_admissions (
      gateway_request_receipt_id TEXT PRIMARY KEY,
      ready_run_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      tool_call_count INTEGER NOT NULL CHECK (tool_call_count > 0),
      parallel_group_charged INTEGER NOT NULL CHECK (
        parallel_group_charged = CASE WHEN tool_call_count >= 2 THEN 1 ELSE 0 END
      ),
      group_digest TEXT NOT NULL UNIQUE,
      admitted_at TEXT NOT NULL,
      FOREIGN KEY (gateway_request_receipt_id)
        REFERENCES ready_model_gateway_request_receipts(receipt_id),
      FOREIGN KEY (ready_run_id) REFERENCES codex_turn_bindings(ready_run_id)
    );

    CREATE TABLE IF NOT EXISTS codex_tool_call_admissions (
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      codex_call_id TEXT NOT NULL,
      gateway_request_receipt_id TEXT NOT NULL,
      ready_run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_digest TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      PRIMARY KEY (codex_thread_id, codex_turn_id, codex_call_id),
      FOREIGN KEY (gateway_request_receipt_id)
        REFERENCES codex_tool_group_admissions(gateway_request_receipt_id),
      FOREIGN KEY (ready_run_id) REFERENCES codex_turn_bindings(ready_run_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_tool_call_admission_receipt_call
      ON codex_tool_call_admissions(gateway_request_receipt_id, codex_call_id);
    CREATE INDEX IF NOT EXISTS idx_codex_tool_group_admission_run
      ON codex_tool_group_admissions(ready_run_id);

    CREATE TRIGGER IF NOT EXISTS codex_tool_group_admission_parent_insert
    BEFORE INSERT ON codex_tool_group_admissions
    WHEN NOT EXISTS (
      SELECT 1
        FROM ready_model_gateway_request_receipts r
        JOIN codex_turn_bindings t ON t.ready_run_id = NEW.ready_run_id
       WHERE r.receipt_id = NEW.gateway_request_receipt_id
         AND r.request_kind = 'product'
         AND r.ready_run_id = NEW.ready_run_id
         AND r.codex_thread_id = NEW.codex_thread_id
         AND r.codex_turn_id = NEW.codex_turn_id
         AND t.codex_thread_id = NEW.codex_thread_id
         AND (t.codex_turn_id = NEW.codex_turn_id
           OR (t.codex_turn_id IS NULL
             AND t.gateway_claimed_codex_turn_id = NEW.codex_turn_id))
    )
    BEGIN SELECT RAISE(ABORT, 'codex_tool_group_admission_parent_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS codex_tool_call_admission_parent_insert
    BEFORE INSERT ON codex_tool_call_admissions
    WHEN NOT EXISTS (
      SELECT 1 FROM codex_tool_group_admissions g
       WHERE g.gateway_request_receipt_id = NEW.gateway_request_receipt_id
         AND g.ready_run_id = NEW.ready_run_id
         AND g.codex_thread_id = NEW.codex_thread_id
         AND g.codex_turn_id = NEW.codex_turn_id
    )
    BEGIN SELECT RAISE(ABORT, 'codex_tool_call_admission_parent_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS codex_tool_call_admission_cardinality_insert
    BEFORE INSERT ON codex_tool_call_admissions
    WHEN (
      SELECT COUNT(*) FROM codex_tool_call_admissions
       WHERE gateway_request_receipt_id = NEW.gateway_request_receipt_id
    ) >= (
      SELECT tool_call_count FROM codex_tool_group_admissions
       WHERE gateway_request_receipt_id = NEW.gateway_request_receipt_id
    )
    BEGIN SELECT RAISE(ABORT, 'codex_tool_call_admission_cardinality_exceeded'); END;

    CREATE TRIGGER IF NOT EXISTS codex_tool_group_admission_immutable_update
    BEFORE UPDATE ON codex_tool_group_admissions
    BEGIN SELECT RAISE(ABORT, 'codex_tool_group_admission_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_tool_group_admission_no_delete
    BEFORE DELETE ON codex_tool_group_admissions
    BEGIN SELECT RAISE(ABORT, 'codex_tool_group_admission_delete_forbidden'); END;

    CREATE TRIGGER IF NOT EXISTS codex_tool_call_admission_immutable_update
    BEFORE UPDATE ON codex_tool_call_admissions
    BEGIN SELECT RAISE(ABORT, 'codex_tool_call_admission_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_tool_call_admission_no_delete
    BEFORE DELETE ON codex_tool_call_admissions
    BEGIN SELECT RAISE(ABORT, 'codex_tool_call_admission_delete_forbidden'); END;
  `)
}

export function applyCodexHostFailureCloseoutMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const columns = db.prepare('PRAGMA table_info(codex_turn_bindings)').all<{ name: string }>()
  if (!columns.some((column) => column.name === 'host_failure_closeout_at')) {
    db.exec('ALTER TABLE codex_turn_bindings ADD COLUMN host_failure_closeout_at TEXT')
  }
  db.exec(`
    UPDATE codex_turn_bindings
       SET host_failure_closeout_at = COALESCE(turn_start_reservation_released_at, updated_at)
     WHERE host_failure_product_terminal_digest IS NOT NULL
       AND host_failure_closeout_at IS NULL;

    DROP TRIGGER IF EXISTS codex_turn_terminal_immutable_update;
    CREATE TRIGGER codex_turn_terminal_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN (OLD.host_failure_product_terminal_digest IS NOT NULL
        AND NEW.host_failure_product_terminal_digest IS NOT OLD.host_failure_product_terminal_digest)
      OR (OLD.host_failure_closeout_at IS NOT NULL
        AND NEW.host_failure_closeout_at IS NOT OLD.host_failure_closeout_at)
      OR (OLD.product_terminal_digest IS NOT NULL
        AND NEW.product_terminal_digest IS NOT OLD.product_terminal_digest)
      OR (OLD.product_closeout_at IS NOT NULL
        AND NEW.product_closeout_at IS NOT OLD.product_closeout_at)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_terminal_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_host_failure_terminal_pair_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN (NEW.host_failure_product_terminal_digest IS NULL)
      != (NEW.host_failure_closeout_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_host_failure_terminal_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_host_failure_terminal_pair_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN (NEW.host_failure_product_terminal_digest IS NULL)
      != (NEW.host_failure_closeout_at IS NULL)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_host_failure_terminal_pair_invalid'); END;
  `)
}

export function applyCodexLifecycleRecoveryEvidenceMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const columns = new Set(
    db.prepare('PRAGMA table_info(codex_turn_bindings)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  const additions: ReadonlyArray<readonly [string, string]> = [
    ['ingress_json', 'TEXT'],
    ['engine_terminal_status', "TEXT CHECK (engine_terminal_status IN ('completed', 'interrupted', 'failed'))"],
    ['engine_terminal_candidate_json', 'TEXT'],
    ['engine_terminal_candidate_digest', 'TEXT'],
    ['engine_terminal_recorded_at', 'TEXT'],
    ['publication_receipt_refs_json', 'TEXT'],
    ['publication_receipt_digest', 'TEXT'],
    ['publication_recorded_at', 'TEXT'],
    ['fence_release_revision', 'INTEGER CHECK (fence_release_revision >= 2)'],
  ]
  for (const [name, declaration] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE codex_turn_bindings ADD COLUMN ${name} ${declaration}`)
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS codex_turn_ingress_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN OLD.ingress_json IS NOT NULL AND NEW.ingress_json IS NOT OLD.ingress_json
    BEGIN SELECT RAISE(ABORT, 'codex_turn_ingress_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_engine_terminal_pair_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NOT (
      (NEW.engine_terminal_status IS NULL
        AND NEW.engine_terminal_candidate_json IS NULL
        AND NEW.engine_terminal_candidate_digest IS NULL
        AND NEW.engine_terminal_recorded_at IS NULL)
      OR
      (NEW.engine_terminal_status IS NOT NULL
        AND NEW.engine_terminal_candidate_json IS NOT NULL
        AND NEW.engine_terminal_candidate_digest IS NOT NULL
        AND NEW.engine_terminal_recorded_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_engine_terminal_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_engine_terminal_pair_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN NOT (
      (NEW.engine_terminal_status IS NULL
        AND NEW.engine_terminal_candidate_json IS NULL
        AND NEW.engine_terminal_candidate_digest IS NULL
        AND NEW.engine_terminal_recorded_at IS NULL)
      OR
      (NEW.engine_terminal_status IS NOT NULL
        AND NEW.engine_terminal_candidate_json IS NOT NULL
        AND NEW.engine_terminal_candidate_digest IS NOT NULL
        AND NEW.engine_terminal_recorded_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_engine_terminal_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_publication_receipt_pair_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NOT (
      (NEW.publication_receipt_refs_json IS NULL
        AND NEW.publication_receipt_digest IS NULL
        AND NEW.publication_recorded_at IS NULL)
      OR
      (NEW.publication_receipt_refs_json IS NOT NULL
        AND NEW.publication_receipt_digest IS NOT NULL
        AND NEW.publication_recorded_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_publication_receipt_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_publication_receipt_pair_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN NOT (
      (NEW.publication_receipt_refs_json IS NULL
        AND NEW.publication_receipt_digest IS NULL
        AND NEW.publication_recorded_at IS NULL)
      OR
      (NEW.publication_receipt_refs_json IS NOT NULL
        AND NEW.publication_receipt_digest IS NOT NULL
        AND NEW.publication_recorded_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_publication_receipt_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_engine_terminal_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN (OLD.engine_terminal_status IS NOT NULL
        AND NEW.engine_terminal_status IS NOT OLD.engine_terminal_status)
      OR (OLD.engine_terminal_candidate_json IS NOT NULL
        AND NEW.engine_terminal_candidate_json IS NOT OLD.engine_terminal_candidate_json)
      OR (OLD.engine_terminal_candidate_digest IS NOT NULL
        AND NEW.engine_terminal_candidate_digest IS NOT OLD.engine_terminal_candidate_digest)
      OR (OLD.engine_terminal_recorded_at IS NOT NULL
        AND NEW.engine_terminal_recorded_at IS NOT OLD.engine_terminal_recorded_at)
      OR (OLD.fence_release_revision IS NOT NULL
        AND NEW.fence_release_revision IS NOT OLD.fence_release_revision)
      OR (OLD.publication_receipt_refs_json IS NOT NULL
        AND NEW.publication_receipt_refs_json IS NOT OLD.publication_receipt_refs_json)
      OR (OLD.publication_receipt_digest IS NOT NULL
        AND NEW.publication_receipt_digest IS NOT OLD.publication_receipt_digest)
      OR (OLD.publication_recorded_at IS NOT NULL
        AND NEW.publication_recorded_at IS NOT OLD.publication_recorded_at)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_lifecycle_evidence_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_engine_terminal_transition_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN OLD.engine_terminal_recorded_at IS NULL
      AND NEW.engine_terminal_recorded_at IS NOT NULL
      AND (
        OLD.product_terminal_digest IS NOT NULL
        OR OLD.host_failure_product_terminal_digest IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM codex_thread_dispatch_fences fence
           WHERE fence.thread_binding_id = OLD.thread_binding_id
             AND fence.operation_kind = 'product_turn'
             AND fence.owner_ready_run_id = OLD.ready_run_id
             AND fence.owner_manual_compaction_id IS NULL
             AND fence.quarantined_at IS NULL
        )
      )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_engine_terminal_transition_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_publication_receipt_transition_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN OLD.publication_recorded_at IS NULL
      AND NEW.publication_recorded_at IS NOT NULL
      AND (
        OLD.engine_terminal_recorded_at IS NULL
        OR OLD.product_terminal_digest IS NOT NULL
        OR OLD.host_failure_product_terminal_digest IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM codex_thread_dispatch_fences fence
           WHERE fence.thread_binding_id = OLD.thread_binding_id
             AND fence.operation_kind = 'product_turn'
             AND fence.owner_ready_run_id = OLD.ready_run_id
             AND fence.quarantined_at IS NULL
        )
      )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_publication_receipt_transition_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_fence_release_transition_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN OLD.fence_release_revision IS NULL
      AND NEW.fence_release_revision IS NOT NULL
      AND NOT (
        OLD.product_terminal_digest IS NULL
        AND OLD.host_failure_product_terminal_digest IS NULL
        AND (
          (NEW.product_terminal_digest IS NOT NULL
            AND NEW.host_failure_product_terminal_digest IS NULL)
          OR
          (NEW.product_terminal_digest IS NULL
            AND NEW.host_failure_product_terminal_digest IS NOT NULL)
        )
        AND EXISTS (
          SELECT 1 FROM codex_thread_dispatch_fences fence
           WHERE fence.thread_binding_id = OLD.thread_binding_id
             AND fence.operation_kind = 'product_turn'
             AND fence.owner_ready_run_id = OLD.ready_run_id
             AND fence.owner_manual_compaction_id IS NULL
             AND fence.quarantined_at IS NULL
             AND NEW.fence_release_revision = fence.revision + 1
        )
      )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_fence_release_transition_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_fence_release_requires_closeout_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NEW.fence_release_revision IS NOT NULL
      AND NEW.product_terminal_digest IS NULL
      AND NEW.host_failure_product_terminal_digest IS NULL
    BEGIN SELECT RAISE(ABORT, 'codex_turn_fence_release_without_closeout'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_fence_release_requires_closeout_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN NEW.fence_release_revision IS NOT NULL
      AND NEW.product_terminal_digest IS NULL
      AND NEW.host_failure_product_terminal_digest IS NULL
    BEGIN SELECT RAISE(ABORT, 'codex_turn_fence_release_without_closeout'); END;
  `)
}

export function applyCodexProductRecoveryFailureMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const columns = new Set(
    db.prepare('PRAGMA table_info(codex_turn_bindings)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  const addColumn = (name: string): void => {
    if (!columns.has(name)) db.exec(`ALTER TABLE codex_turn_bindings ADD COLUMN ${name} TEXT`)
  }
  addColumn('recovery_failure_code')
  addColumn('recovery_failure_evidence_digest')
  addColumn('recovery_failure_recorded_at')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS codex_turn_recovery_failure_pair_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NOT (
      (NEW.recovery_failure_code IS NULL
        AND NEW.recovery_failure_evidence_digest IS NULL
        AND NEW.recovery_failure_recorded_at IS NULL)
      OR
      (NEW.recovery_failure_code IS NOT NULL
        AND NEW.recovery_failure_evidence_digest IS NOT NULL
        AND NEW.recovery_failure_recorded_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_recovery_failure_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_recovery_failure_pair_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN NOT (
      (NEW.recovery_failure_code IS NULL
        AND NEW.recovery_failure_evidence_digest IS NULL
        AND NEW.recovery_failure_recorded_at IS NULL)
      OR
      (NEW.recovery_failure_code IS NOT NULL
        AND NEW.recovery_failure_evidence_digest IS NOT NULL
        AND NEW.recovery_failure_recorded_at IS NOT NULL)
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_recovery_failure_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_recovery_failure_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN (OLD.recovery_failure_code IS NOT NULL
        AND NEW.recovery_failure_code IS NOT OLD.recovery_failure_code)
      OR (OLD.recovery_failure_evidence_digest IS NOT NULL
        AND NEW.recovery_failure_evidence_digest IS NOT OLD.recovery_failure_evidence_digest)
      OR (OLD.recovery_failure_recorded_at IS NOT NULL
        AND NEW.recovery_failure_recorded_at IS NOT OLD.recovery_failure_recorded_at)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_recovery_failure_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_recovery_failure_kind_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NEW.recovery_failure_code IS NOT NULL AND NEW.host_failure_kind IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'codex_turn_recovery_failure_kind_conflict'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_recovery_failure_kind_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN NEW.recovery_failure_code IS NOT NULL AND NEW.host_failure_kind IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'codex_turn_recovery_failure_kind_conflict'); END;
  `)
}

export function applyCodexFenceOwnerTransferMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_fence_owner_transfers (
      transfer_id TEXT PRIMARY KEY,
      thread_binding_id TEXT NOT NULL,
      operation_kind TEXT NOT NULL CHECK (operation_kind IN ('product_turn', 'manual_compaction')),
      owner_ready_run_id TEXT,
      owner_manual_compaction_id TEXT,
      previous_owner_main_boot_id TEXT NOT NULL,
      new_owner_main_boot_id TEXT NOT NULL,
      previous_fence_revision INTEGER NOT NULL,
      new_fence_revision INTEGER NOT NULL,
      process_lease_id TEXT NOT NULL,
      new_process_lease_id TEXT NOT NULL,
      evidence_digest TEXT NOT NULL,
      transferred_at TEXT NOT NULL,
      CHECK (previous_owner_main_boot_id != new_owner_main_boot_id),
      CHECK (new_fence_revision = previous_fence_revision + 1),
      CHECK ((owner_ready_run_id IS NULL) != (owner_manual_compaction_id IS NULL)),
      UNIQUE(thread_binding_id, previous_fence_revision)
    );

    CREATE TRIGGER IF NOT EXISTS codex_fence_owner_transfer_immutable_update
    BEFORE UPDATE ON codex_fence_owner_transfers
    BEGIN SELECT RAISE(ABORT, 'codex_fence_owner_transfer_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_fence_owner_transfer_immutable_delete
    BEFORE DELETE ON codex_fence_owner_transfers
    BEGIN SELECT RAISE(ABORT, 'codex_fence_owner_transfer_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_fence_owner_transfer_evidence_insert
    BEFORE INSERT ON codex_fence_owner_transfers
    WHEN NOT EXISTS (
      SELECT 1 FROM codex_thread_dispatch_fences fence
       WHERE fence.thread_binding_id = NEW.thread_binding_id
         AND fence.operation_kind = NEW.operation_kind
         AND fence.owner_ready_run_id IS NEW.owner_ready_run_id
         AND fence.owner_manual_compaction_id IS NEW.owner_manual_compaction_id
         AND fence.owner_main_boot_id = NEW.previous_owner_main_boot_id
         AND fence.revision = NEW.previous_fence_revision
         AND fence.quarantined_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM codex_sidecar_process_leases lease
       WHERE lease.process_lease_id = NEW.process_lease_id
         AND lease.owner_main_boot_id = NEW.previous_owner_main_boot_id
         AND lease.owner_main_dead_at IS NOT NULL
         AND lease.owner_main_death_evidence_digest IS NOT NULL
         AND lease.tree_zero_at IS NOT NULL
         AND lease.tree_zero_evidence_digest IS NOT NULL
         AND lease.stable_zero_sample_transcript_digest IS NOT NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM codex_sidecar_process_leases new_lease
       WHERE new_lease.process_lease_id = NEW.new_process_lease_id
         AND new_lease.owner_main_boot_id = NEW.new_owner_main_boot_id
         AND new_lease.connection_opened_at IS NOT NULL
         AND new_lease.tree_zero_at IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'codex_fence_owner_transfer_evidence_invalid'); END;

    DROP TRIGGER IF EXISTS codex_fence_parent_update;
    ${CODEX_BINDING_EVIDENCE_GUARDS_SQL}
  `)
}

export function applyCodexGatewayCompletionEvidenceMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ready_model_gateway_exchange_events (
      event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      gateway_request_receipt_id TEXT NOT NULL,
      event_kind TEXT NOT NULL CHECK (event_kind IN ('request_admitted', 'response_completed')),
      instruction_digest TEXT,
      input_digest TEXT,
      input_items_json TEXT,
      input_total_string_characters INTEGER,
      input_max_string_characters INTEGER,
      tools_digest TEXT,
      tool_count INTEGER,
      body_bytes INTEGER,
      response_id TEXT,
      terminal_digest TEXT,
      output_digest TEXT,
      usage_digest TEXT,
      evidence_digest TEXT NOT NULL UNIQUE,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (gateway_request_receipt_id)
        REFERENCES ready_model_gateway_request_receipts(receipt_id),
      UNIQUE(gateway_request_receipt_id, event_kind),
      CHECK (
        (event_kind = 'request_admitted'
          AND instruction_digest IS NOT NULL
          AND input_digest IS NOT NULL
          AND input_items_json IS NOT NULL
          AND json_valid(input_items_json)
          AND json_type(input_items_json) = 'array'
          AND input_total_string_characters >= 0
          AND input_max_string_characters >= 0
          AND input_total_string_characters >= input_max_string_characters
          AND tools_digest IS NOT NULL
          AND tool_count >= 0
          AND body_bytes > 0
          AND response_id IS NULL AND terminal_digest IS NULL
          AND output_digest IS NULL AND usage_digest IS NULL)
        OR
        (event_kind = 'response_completed'
          AND instruction_digest IS NULL AND input_digest IS NULL
          AND input_items_json IS NULL
          AND input_total_string_characters IS NULL
          AND input_max_string_characters IS NULL
          AND tools_digest IS NULL AND tool_count IS NULL AND body_bytes IS NULL
          AND response_id IS NOT NULL AND terminal_digest IS NOT NULL
          AND output_digest IS NOT NULL AND usage_digest IS NOT NULL)
      )
    );

    CREATE TRIGGER IF NOT EXISTS ready_model_gateway_exchange_immutable_update
    BEFORE UPDATE ON ready_model_gateway_exchange_events
    BEGIN SELECT RAISE(ABORT, 'ready_model_gateway_exchange_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS ready_model_gateway_exchange_immutable_delete
    BEFORE DELETE ON ready_model_gateway_exchange_events
    BEGIN SELECT RAISE(ABORT, 'ready_model_gateway_exchange_immutable'); END;
  `)
}

export function applyCodexManualCompactionRecoveryEvidenceMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN pre_dispatch_thread_read_digest TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN pre_dispatch_turn_ids_json TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN pre_dispatch_turn_ids_digest TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN unknown_at TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN unknown_reason TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN unknown_evidence_digest TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN context_compaction_item_id TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN terminal_status TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN terminal_evidence_digest TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN thread_read_digest TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN gateway_request_receipt_id TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN gateway_request_evidence_digest TEXT;
    ALTER TABLE codex_manual_compaction_bindings ADD COLUMN gateway_response_evidence_digest TEXT;

    CREATE TABLE IF NOT EXISTS codex_manual_compaction_dispatch_attempts (
      attempt_id TEXT PRIMARY KEY,
      manual_compaction_id TEXT NOT NULL,
      connection_epoch TEXT NOT NULL,
      rpc_id INTEGER NOT NULL CHECK (rpc_id > 0),
      request_digest TEXT NOT NULL,
      dispatch_intent_at TEXT NOT NULL,
      child_write_attempted_at TEXT,
      child_write_confirmed_at TEXT,
      child_write_digest TEXT,
      unresolved_at TEXT,
      unresolved_reason TEXT CHECK (unresolved_reason IN (
        'response_timeout', 'child_write_error', 'connection_closed'
      )),
      response_kind TEXT CHECK (response_kind IN ('accepted', 'rejected')),
      response_digest TEXT,
      response_at TEXT,
      proven_absent_at TEXT,
      proven_absent_reason TEXT,
      proven_absent_evidence_digest TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (manual_compaction_id)
        REFERENCES codex_manual_compaction_bindings(manual_compaction_id),
      UNIQUE(connection_epoch, rpc_id),
      CHECK ((child_write_confirmed_at IS NULL) = (child_write_digest IS NULL)),
      CHECK ((unresolved_at IS NULL) = (unresolved_reason IS NULL)),
      CHECK ((response_kind IS NULL) = (response_digest IS NULL)),
      CHECK ((response_kind IS NULL) = (response_at IS NULL)),
      CHECK ((proven_absent_at IS NULL) = (proven_absent_reason IS NULL)),
      CHECK ((proven_absent_at IS NULL) = (proven_absent_evidence_digest IS NULL)),
      CHECK (child_write_confirmed_at IS NULL OR child_write_attempted_at IS NOT NULL)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_manual_compaction_active_attempt
      ON codex_manual_compaction_dispatch_attempts(manual_compaction_id)
      WHERE proven_absent_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_attempt_parent_insert
    BEFORE INSERT ON codex_manual_compaction_dispatch_attempts
    WHEN NOT EXISTS (
      SELECT 1 FROM codex_manual_compaction_bindings parent
       WHERE parent.manual_compaction_id = NEW.manual_compaction_id
    )
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_attempt_parent_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_attempt_parent_update
    BEFORE UPDATE ON codex_manual_compaction_dispatch_attempts
    WHEN NOT EXISTS (
      SELECT 1 FROM codex_manual_compaction_bindings parent
       WHERE parent.manual_compaction_id = NEW.manual_compaction_id
    )
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_attempt_parent_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_recovery_pair_update
    BEFORE UPDATE ON codex_manual_compaction_bindings
    WHEN ((NEW.unknown_at IS NULL) != (NEW.unknown_reason IS NULL))
      OR ((NEW.unknown_at IS NULL) != (NEW.unknown_evidence_digest IS NULL))
      OR ((NEW.context_compaction_item_id IS NULL) != (NEW.terminal_status IS NULL))
      OR ((NEW.context_compaction_item_id IS NULL) != (NEW.terminal_evidence_digest IS NULL))
      OR ((NEW.context_compaction_item_id IS NULL) != (NEW.thread_read_digest IS NULL))
      OR ((NEW.context_compaction_item_id IS NULL) != (NEW.gateway_request_receipt_id IS NULL))
      OR ((NEW.context_compaction_item_id IS NULL) != (NEW.gateway_request_evidence_digest IS NULL))
      OR ((NEW.context_compaction_item_id IS NULL) != (NEW.gateway_response_evidence_digest IS NULL))
      OR (NEW.unknown_at IS NOT NULL AND NEW.context_compaction_item_id IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_recovery_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_recovery_immutable_update
    BEFORE UPDATE ON codex_manual_compaction_bindings
    WHEN (OLD.pre_dispatch_thread_read_digest IS NOT NULL
        AND OLD.pre_dispatch_thread_read_digest IS NOT NEW.pre_dispatch_thread_read_digest)
      OR (OLD.pre_dispatch_turn_ids_json IS NOT NULL
        AND OLD.pre_dispatch_turn_ids_json IS NOT NEW.pre_dispatch_turn_ids_json)
      OR (OLD.pre_dispatch_turn_ids_digest IS NOT NULL
        AND OLD.pre_dispatch_turn_ids_digest IS NOT NEW.pre_dispatch_turn_ids_digest)
      OR (OLD.unknown_at IS NOT NULL AND OLD.unknown_at IS NOT NEW.unknown_at)
      OR (OLD.unknown_reason IS NOT NULL AND OLD.unknown_reason IS NOT NEW.unknown_reason)
      OR (OLD.unknown_evidence_digest IS NOT NULL
        AND OLD.unknown_evidence_digest IS NOT NEW.unknown_evidence_digest)
      OR (OLD.context_compaction_item_id IS NOT NULL
        AND OLD.context_compaction_item_id IS NOT NEW.context_compaction_item_id)
      OR (OLD.terminal_status IS NOT NULL AND OLD.terminal_status IS NOT NEW.terminal_status)
      OR (OLD.terminal_evidence_digest IS NOT NULL
        AND OLD.terminal_evidence_digest IS NOT NEW.terminal_evidence_digest)
      OR (OLD.thread_read_digest IS NOT NULL AND OLD.thread_read_digest IS NOT NEW.thread_read_digest)
      OR (OLD.gateway_request_receipt_id IS NOT NULL
        AND OLD.gateway_request_receipt_id IS NOT NEW.gateway_request_receipt_id)
      OR (OLD.gateway_request_evidence_digest IS NOT NULL
        AND OLD.gateway_request_evidence_digest IS NOT NEW.gateway_request_evidence_digest)
      OR (OLD.gateway_response_evidence_digest IS NOT NULL
        AND OLD.gateway_response_evidence_digest IS NOT NEW.gateway_response_evidence_digest)
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_recovery_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_attempt_state_insert
    BEFORE INSERT ON codex_manual_compaction_dispatch_attempts
    WHEN (NEW.response_kind IS NOT NULL AND NEW.proven_absent_at IS NOT NULL)
      OR (NEW.proven_absent_at IS NOT NULL AND NEW.child_write_attempted_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_attempt_state_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_attempt_state_update
    BEFORE UPDATE ON codex_manual_compaction_dispatch_attempts
    WHEN (NEW.response_kind IS NOT NULL AND NEW.proven_absent_at IS NOT NULL)
      OR (NEW.proven_absent_at IS NOT NULL AND NEW.child_write_attempted_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_attempt_state_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_attempt_immutable_update
    BEFORE UPDATE ON codex_manual_compaction_dispatch_attempts
    WHEN OLD.manual_compaction_id IS NOT NEW.manual_compaction_id
      OR OLD.connection_epoch IS NOT NEW.connection_epoch
      OR OLD.rpc_id IS NOT NEW.rpc_id
      OR OLD.request_digest IS NOT NEW.request_digest
      OR OLD.dispatch_intent_at IS NOT NEW.dispatch_intent_at
      OR (OLD.child_write_attempted_at IS NOT NULL
        AND OLD.child_write_attempted_at IS NOT NEW.child_write_attempted_at)
      OR (OLD.child_write_confirmed_at IS NOT NULL
        AND OLD.child_write_confirmed_at IS NOT NEW.child_write_confirmed_at)
      OR (OLD.child_write_digest IS NOT NULL AND OLD.child_write_digest IS NOT NEW.child_write_digest)
      OR (OLD.unresolved_at IS NOT NULL AND OLD.unresolved_at IS NOT NEW.unresolved_at)
      OR (OLD.unresolved_reason IS NOT NULL AND OLD.unresolved_reason IS NOT NEW.unresolved_reason)
      OR (OLD.response_kind IS NOT NULL AND OLD.response_kind IS NOT NEW.response_kind)
      OR (OLD.response_digest IS NOT NULL AND OLD.response_digest IS NOT NEW.response_digest)
      OR (OLD.response_at IS NOT NULL AND OLD.response_at IS NOT NEW.response_at)
      OR (OLD.proven_absent_at IS NOT NULL AND OLD.proven_absent_at IS NOT NEW.proven_absent_at)
      OR (OLD.proven_absent_reason IS NOT NULL
        AND OLD.proven_absent_reason IS NOT NEW.proven_absent_reason)
      OR (OLD.proven_absent_evidence_digest IS NOT NULL
        AND OLD.proven_absent_evidence_digest IS NOT NEW.proven_absent_evidence_digest)
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_attempt_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_attempt_no_delete
    BEFORE DELETE ON codex_manual_compaction_dispatch_attempts
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_attempt_delete_forbidden'); END;
  `)
}

export function applyCodexThreadResumeEvidenceMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_thread_resume_evidence (
      resume_evidence_id TEXT PRIMARY KEY,
      thread_binding_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      connection_epoch TEXT NOT NULL,
      pre_resume_thread_read_digest TEXT NOT NULL,
      resumed_thread_digest TEXT NOT NULL,
      evidence_digest TEXT NOT NULL UNIQUE,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (thread_binding_id)
        REFERENCES codex_thread_bindings(thread_binding_id),
      FOREIGN KEY (connection_epoch)
        REFERENCES codex_sidecar_process_leases(connection_epoch),
      UNIQUE(thread_binding_id, connection_epoch)
    );

    CREATE TRIGGER IF NOT EXISTS codex_thread_resume_evidence_parent_insert
    BEFORE INSERT ON codex_thread_resume_evidence
    WHEN NOT EXISTS (
      SELECT 1 FROM codex_thread_bindings parent
       WHERE parent.thread_binding_id = NEW.thread_binding_id
         AND parent.codex_thread_id = NEW.codex_thread_id
         AND parent.retired_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM codex_sidecar_process_leases lease
       WHERE lease.connection_epoch = NEW.connection_epoch
         AND lease.connection_opened_at IS NOT NULL
         AND lease.closed_at IS NULL
         AND lease.tree_zero_at IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_parent_mismatch'); END;

    CREATE TRIGGER IF NOT EXISTS codex_thread_resume_evidence_immutable_update
    BEFORE UPDATE ON codex_thread_resume_evidence
    BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_thread_resume_evidence_immutable_delete
    BEFORE DELETE ON codex_thread_resume_evidence
    BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_immutable'); END;
  `)
}

export function applyCodexManualCompactionItemIdentityMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    ALTER TABLE codex_manual_compaction_bindings
      ADD COLUMN notification_context_compaction_item_id TEXT;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_notification_item_pair_update
    BEFORE UPDATE ON codex_manual_compaction_bindings
    WHEN NEW.notification_context_compaction_item_id IS NOT NULL
      AND NEW.context_compaction_item_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_notification_item_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_manual_compaction_notification_item_immutable_update
    BEFORE UPDATE ON codex_manual_compaction_bindings
    WHEN OLD.notification_context_compaction_item_id IS NOT NULL
      AND OLD.notification_context_compaction_item_id
        IS NOT NEW.notification_context_compaction_item_id
    BEGIN SELECT RAISE(ABORT, 'codex_manual_compaction_notification_item_immutable'); END;
  `)
}

export const CODEX_BINDING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS codex_thread_bindings (
    thread_binding_id TEXT PRIMARY KEY,
    codex_thread_id TEXT UNIQUE,
    codex_session_id TEXT,
    codex_parent_thread_id TEXT,
    codex_forked_from_id TEXT,
    codex_source_json TEXT,
    codex_thread_source_json TEXT,
    thread_start_reservation_set_id TEXT UNIQUE,
    thread_start_reservation_member_id TEXT UNIQUE,
    thread_start_reservation_admitted_at TEXT,
    thread_start_reservation_released_at TEXT,
    thread_start_reservation_release_reason TEXT,
    thread_start_request_id TEXT UNIQUE,
    thread_start_rpc_connection_epoch TEXT,
    thread_start_rpc_id INTEGER,
    thread_start_dispatch_intent_at TEXT,
    thread_start_child_write_confirmed_at TEXT,
    thread_start_child_write_digest TEXT,
    thread_start_response_at TEXT,
    thread_start_reconciled_at TEXT,
    thread_start_reconciliation_evidence_digest TEXT,
    thread_start_late_response_guard_closed_at TEXT,
    thread_start_late_response_guard_close_reason TEXT,
    isolated_thread_cwd TEXT UNIQUE,
    ready_conversation_alias TEXT NOT NULL,
    alias_generation INTEGER NOT NULL,
    ready_scope_id TEXT NOT NULL,
    runtime_manifest_digest TEXT NOT NULL,
    protocol_schema_digest TEXT NOT NULL,
    tool_surface_digest TEXT,
    tool_surface_snapshot_digest TEXT,
    tool_surface_json TEXT,
    instruction_contract_digest TEXT,
    codex_model_provider_id TEXT CHECK (codex_model_provider_id = 'ready_gateway'),
    codex_model TEXT,
    upstream_profile_snapshot_ref TEXT,
    upstream_profile_snapshot_digest TEXT,
    thread_started_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    retired_at TEXT,
    retired_reason TEXT CHECK (retired_reason IN (
      'user_reset', 'closed', 'publication_diverged', 'manual_compaction_quarantine', 'cleanup'
    )),
    retirement_evidence_digest TEXT,
    continuation_blocked_at TEXT,
    continuation_blocked_reason TEXT CHECK (continuation_blocked_reason IN (
      'start_delivery_absent', 'publication_diverged'
    )),
    continuation_blocked_evidence_digest TEXT,
    CHECK (alias_generation >= 1),
    CHECK (
      (thread_start_reservation_set_id IS NULL
        AND thread_start_reservation_member_id IS NULL
        AND thread_start_reservation_admitted_at IS NULL
        AND thread_start_request_id IS NULL
        AND isolated_thread_cwd IS NULL
        AND tool_surface_digest IS NULL
        AND tool_surface_snapshot_digest IS NULL
        AND tool_surface_json IS NULL
        AND instruction_contract_digest IS NULL
        AND codex_model_provider_id IS NULL
        AND codex_model IS NULL
        AND upstream_profile_snapshot_ref IS NULL
        AND upstream_profile_snapshot_digest IS NULL)
      OR
      (thread_start_reservation_set_id IS NOT NULL
        AND thread_start_reservation_member_id IS NOT NULL
        AND thread_start_reservation_admitted_at IS NOT NULL
        AND thread_start_request_id IS NOT NULL
        AND isolated_thread_cwd IS NOT NULL
        AND tool_surface_digest IS NOT NULL
        AND tool_surface_snapshot_digest IS NOT NULL
        AND tool_surface_json IS NOT NULL
        AND instruction_contract_digest IS NOT NULL
        AND codex_model_provider_id = 'ready_gateway'
        AND codex_model IS NOT NULL
        AND upstream_profile_snapshot_ref IS NOT NULL
        AND upstream_profile_snapshot_digest IS NOT NULL)
    ),
    CHECK ((thread_start_reservation_released_at IS NULL) = (thread_start_reservation_release_reason IS NULL)),
    CHECK (
      (thread_start_dispatch_intent_at IS NULL
        AND thread_start_rpc_connection_epoch IS NULL AND thread_start_rpc_id IS NULL)
      OR
      (thread_start_dispatch_intent_at IS NOT NULL
        AND thread_start_rpc_connection_epoch IS NOT NULL AND thread_start_rpc_id IS NOT NULL)
    ),
    CHECK ((thread_start_child_write_confirmed_at IS NULL) = (thread_start_child_write_digest IS NULL)),
    CHECK (thread_start_child_write_confirmed_at IS NULL OR thread_start_dispatch_intent_at IS NOT NULL),
    CHECK (
      (thread_start_reconciled_at IS NULL
        AND thread_start_reconciliation_evidence_digest IS NULL AND codex_thread_id IS NULL
        AND codex_session_id IS NULL AND thread_started_at IS NULL)
      OR
      (thread_start_reconciled_at IS NOT NULL
        AND thread_start_reconciliation_evidence_digest IS NOT NULL AND codex_thread_id IS NOT NULL
        AND codex_session_id IS NOT NULL AND thread_started_at IS NOT NULL)
    ),
    CHECK (thread_start_response_at IS NULL OR thread_start_dispatch_intent_at IS NOT NULL),
    CHECK (
      (thread_start_late_response_guard_closed_at IS NULL)
      = (thread_start_late_response_guard_close_reason IS NULL)
    ),
    CHECK (thread_start_late_response_guard_closed_at IS NULL OR thread_start_reconciled_at IS NOT NULL),
    CHECK ((retired_at IS NULL AND retired_reason IS NULL AND retirement_evidence_digest IS NULL)
      OR (retired_at IS NOT NULL AND retired_reason IS NOT NULL AND retirement_evidence_digest IS NOT NULL)),
    CHECK ((continuation_blocked_at IS NULL AND continuation_blocked_reason IS NULL
      AND continuation_blocked_evidence_digest IS NULL)
      OR (continuation_blocked_at IS NOT NULL AND continuation_blocked_reason IS NOT NULL
      AND continuation_blocked_evidence_digest IS NOT NULL))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_thread_binding_active_alias
    ON codex_thread_bindings(ready_conversation_alias)
    WHERE retired_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_thread_binding_alias_generation
    ON codex_thread_bindings(ready_conversation_alias, alias_generation);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_thread_start_rpc
    ON codex_thread_bindings(thread_start_rpc_connection_epoch, thread_start_rpc_id)
    WHERE thread_start_dispatch_intent_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS codex_turn_bindings (
    ready_run_id TEXT PRIMARY KEY,
    ready_task_id TEXT NOT NULL,
    thread_binding_id TEXT NOT NULL,
    codex_thread_id TEXT,
    codex_turn_id TEXT,
    start_reservation_set_id TEXT NOT NULL UNIQUE,
    start_reservation_required_member_count INTEGER NOT NULL CHECK (
      start_reservation_required_member_count IN (1, 2)
    ),
    turn_start_reservation_member_id TEXT NOT NULL UNIQUE,
    turn_start_reservation_admitted_at TEXT NOT NULL,
    turn_start_reservation_released_at TEXT,
    turn_start_reservation_release_reason TEXT,
    turn_request_id TEXT NOT NULL UNIQUE,
    turn_start_rpc_connection_epoch TEXT,
    turn_start_rpc_id INTEGER,
    turn_start_dispatch_intent_at TEXT,
    turn_start_child_write_confirmed_at TEXT,
    turn_start_child_write_digest TEXT,
    turn_start_response_at TEXT,
    turn_start_reconciled_at TEXT,
    turn_start_reconciliation_evidence_digest TEXT,
    turn_start_late_response_guard_closed_at TEXT,
    turn_start_late_response_guard_close_reason TEXT,
    host_failure_kind TEXT CHECK (host_failure_kind IN (
      'sidecar_spawn_failed', 'thread_start_rpc_rejected',
      'thread_start_delivery_proven_absent', 'turn_start_rpc_rejected',
      'turn_start_delivery_proven_absent'
    )),
    host_failure_recorded_at TEXT,
    host_failure_evidence_digest TEXT,
    host_failure_product_terminal_digest TEXT,
    host_failure_closeout_at TEXT,
    recovery_failure_code TEXT,
    recovery_failure_evidence_digest TEXT,
    recovery_failure_recorded_at TEXT,
    product_terminal_digest TEXT,
    product_closeout_at TEXT,
    origin_user_message_id TEXT,
    message_visibility_epoch INTEGER NOT NULL DEFAULT 0 CHECK (message_visibility_epoch >= 0),
    ingress_admitted_revision INTEGER NOT NULL CHECK (ingress_admitted_revision >= 1),
    ingress_admitted_digest TEXT NOT NULL,
    ingress_admitted_at TEXT NOT NULL,
    predecessor_run_id TEXT,
    attempt_kind TEXT NOT NULL CHECK (attempt_kind IN (
      'user_ingress', 'recovery_successor', 'checkpoint_successor', 'explicit_retry'
    )),
    history_parity_evidence_digest TEXT,
    current_thread_read_evidence_digest TEXT,
    continuation_contract_digest TEXT,
    tool_surface_digest TEXT NOT NULL,
    authorization_snapshot_digest TEXT NOT NULL,
    authorization_snapshot_json TEXT NOT NULL,
    product_budget_seed_json TEXT NOT NULL,
    effective_codex_model TEXT NOT NULL,
    effective_upstream_snapshot_ref TEXT NOT NULL,
    effective_upstream_snapshot_digest TEXT NOT NULL,
    additional_context_digest TEXT NOT NULL,
    turn_contract_digest TEXT NOT NULL,
    ingress_json TEXT NOT NULL,
    interrupt_requested_at TEXT,
    interrupt_ack_at TEXT,
    interrupt_state_unknown_at TEXT,
    lifecycle_action TEXT CHECK (lifecycle_action IN ('stop', 'close', 'reset')),
    lifecycle_action_requested_at TEXT,
    lifecycle_action_evidence_digest TEXT,
    engine_terminal_status TEXT CHECK (engine_terminal_status IN ('completed', 'interrupted', 'failed')),
    engine_terminal_candidate_json TEXT,
    engine_terminal_candidate_digest TEXT,
    engine_terminal_recorded_at TEXT,
    publication_receipt_refs_json TEXT,
    publication_receipt_digest TEXT,
    publication_recorded_at TEXT,
    fence_release_revision INTEGER CHECK (fence_release_revision >= 2),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(codex_thread_id, codex_turn_id),
    CHECK ((turn_start_reservation_released_at IS NULL) = (turn_start_reservation_release_reason IS NULL)),
    CHECK (
      (turn_start_dispatch_intent_at IS NULL
        AND turn_start_rpc_connection_epoch IS NULL AND turn_start_rpc_id IS NULL)
      OR
      (turn_start_dispatch_intent_at IS NOT NULL
        AND turn_start_rpc_connection_epoch IS NOT NULL AND turn_start_rpc_id IS NOT NULL)
    ),
    CHECK (
      (publication_receipt_refs_json IS NULL AND publication_receipt_digest IS NULL
        AND publication_recorded_at IS NULL)
      OR
      (publication_receipt_refs_json IS NOT NULL AND publication_receipt_digest IS NOT NULL
        AND publication_recorded_at IS NOT NULL AND engine_terminal_recorded_at IS NOT NULL)
    ),
    CHECK ((turn_start_child_write_confirmed_at IS NULL) = (turn_start_child_write_digest IS NULL)),
    CHECK (turn_start_child_write_confirmed_at IS NULL OR turn_start_dispatch_intent_at IS NOT NULL),
    CHECK (
      (turn_start_reconciled_at IS NULL
        AND turn_start_reconciliation_evidence_digest IS NULL AND codex_turn_id IS NULL)
      OR
      (turn_start_reconciled_at IS NOT NULL
        AND turn_start_reconciliation_evidence_digest IS NOT NULL AND codex_turn_id IS NOT NULL
        AND codex_thread_id IS NOT NULL)
    ),
    CHECK (turn_start_response_at IS NULL OR turn_start_dispatch_intent_at IS NOT NULL),
    CHECK (
      (turn_start_late_response_guard_closed_at IS NULL)
      = (turn_start_late_response_guard_close_reason IS NULL)
    ),
    CHECK (turn_start_late_response_guard_closed_at IS NULL OR turn_start_reconciled_at IS NOT NULL),
    CHECK (
      (host_failure_kind IS NULL AND host_failure_recorded_at IS NULL
        AND host_failure_evidence_digest IS NULL AND host_failure_product_terminal_digest IS NULL)
      OR
      (host_failure_kind IS NOT NULL AND host_failure_recorded_at IS NOT NULL
        AND host_failure_evidence_digest IS NOT NULL)
    ),
    CHECK (
      (host_failure_product_terminal_digest IS NULL) = (host_failure_closeout_at IS NULL)
    ),
    CHECK (
      (recovery_failure_code IS NULL
        AND recovery_failure_evidence_digest IS NULL
        AND recovery_failure_recorded_at IS NULL)
      OR
      (recovery_failure_code IS NOT NULL
        AND recovery_failure_evidence_digest IS NOT NULL
        AND recovery_failure_recorded_at IS NOT NULL)
    ),
    CHECK (recovery_failure_code IS NULL OR host_failure_kind IS NULL),
    CHECK ((product_terminal_digest IS NULL) = (product_closeout_at IS NULL)),
    CHECK (
      (lifecycle_action IS NULL AND lifecycle_action_requested_at IS NULL
        AND lifecycle_action_evidence_digest IS NULL)
      OR
      (lifecycle_action IS NOT NULL AND lifecycle_action_requested_at IS NOT NULL
        AND lifecycle_action_evidence_digest IS NOT NULL
        AND length(lifecycle_action_evidence_digest) = 64
        AND lifecycle_action_evidence_digest NOT GLOB '*[^0-9a-f]*')
    ),
    CHECK (
      (engine_terminal_status IS NULL AND engine_terminal_candidate_json IS NULL
        AND engine_terminal_candidate_digest IS NULL AND engine_terminal_recorded_at IS NULL)
      OR
      (engine_terminal_status IS NOT NULL AND engine_terminal_candidate_json IS NOT NULL
        AND engine_terminal_candidate_digest IS NOT NULL AND engine_terminal_recorded_at IS NOT NULL)
    ),
    CHECK (fence_release_revision IS NULL
      OR product_terminal_digest IS NOT NULL
      OR host_failure_product_terminal_digest IS NOT NULL),
    CHECK (
      (attempt_kind = 'user_ingress' AND origin_user_message_id IS NOT NULL
        AND predecessor_run_id IS NULL AND history_parity_evidence_digest IS NULL
        AND current_thread_read_evidence_digest IS NULL AND continuation_contract_digest IS NULL)
      OR
      (attempt_kind IN ('recovery_successor', 'checkpoint_successor', 'explicit_retry')
        AND predecessor_run_id IS NOT NULL AND history_parity_evidence_digest IS NOT NULL
        AND current_thread_read_evidence_digest IS NOT NULL AND continuation_contract_digest IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_turn_origin_user_message
    ON codex_turn_bindings(origin_user_message_id)
    WHERE attempt_kind = 'user_ingress' AND origin_user_message_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_turn_predecessor
    ON codex_turn_bindings(predecessor_run_id)
    WHERE attempt_kind IN ('recovery_successor', 'checkpoint_successor', 'explicit_retry')
      AND predecessor_run_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_turn_start_rpc
    ON codex_turn_bindings(turn_start_rpc_connection_epoch, turn_start_rpc_id)
    WHERE turn_start_dispatch_intent_at IS NOT NULL;

  CREATE TABLE IF NOT EXISTS codex_tool_call_bindings (
    codex_thread_id TEXT NOT NULL,
    codex_turn_id TEXT NOT NULL,
    codex_call_id TEXT NOT NULL,
    ready_run_id TEXT NOT NULL,
    ready_action_id TEXT NOT NULL UNIQUE,
    tool_name TEXT NOT NULL,
    args_digest TEXT NOT NULL,
    turn_contract_digest TEXT NOT NULL,
    ready_alias_id TEXT NOT NULL,
    codex_session_id TEXT NOT NULL,
    ready_task_id TEXT NOT NULL,
    surface_snapshot_digest TEXT NOT NULL,
    tool_surface_digest TEXT NOT NULL,
    authorization_snapshot_digest TEXT NOT NULL,
    tool_schema_digest TEXT NOT NULL,
    request_connection_epoch TEXT NOT NULL,
    request_rpc_id TEXT NOT NULL,
    receipt_id TEXT UNIQUE,
    result_digest TEXT,
    delivered_connection_epoch TEXT,
    delivered_rpc_id TEXT,
    tool_response_digest TEXT,
    legacy_delivery_evidence_unverifiable INTEGER NOT NULL DEFAULT 0
      CHECK (legacy_delivery_evidence_unverifiable IN (0, 1)),
    delivery_intent_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (codex_thread_id, codex_turn_id, codex_call_id),
    CHECK ((receipt_id IS NULL) = (result_digest IS NULL)),
    CHECK ((delivered_connection_epoch IS NULL) = (delivered_rpc_id IS NULL)),
    CHECK ((delivered_connection_epoch IS NULL) = (delivery_intent_at IS NULL)),
    CHECK (tool_response_digest IS NULL OR (
      length(tool_response_digest) = 64
      AND tool_response_digest NOT GLOB '*[^0-9a-f]*'
    ))
  );

  CREATE TABLE IF NOT EXISTS ready_tool_action_receipts (
    ready_action_id TEXT PRIMARY KEY,
    action_identity_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'proven_absent', 'indeterminate')),
    receipt_id TEXT UNIQUE,
    result_digest TEXT,
    result_json TEXT,
    resolution_reason TEXT,
    resolution_evidence_digest TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state = 'pending' AND receipt_id IS NULL AND result_digest IS NULL AND result_json IS NULL
        AND resolution_reason IS NULL AND resolution_evidence_digest IS NULL)
      OR (state = 'confirmed' AND receipt_id IS NOT NULL AND result_digest IS NOT NULL
        AND result_json IS NOT NULL AND resolution_reason IS NULL AND resolution_evidence_digest IS NULL)
      OR (state IN ('proven_absent', 'indeterminate') AND receipt_id IS NULL
        AND result_digest IS NULL AND result_json IS NULL
        AND resolution_reason IS NOT NULL AND resolution_evidence_digest IS NOT NULL)
    )
  );

  ${CODEX_TOOL_RESPONSE_DELIVERY_ATTEMPT_SCHEMA_SQL}
  ${CODEX_TOOL_REQUEST_RPC_BINDING_SCHEMA_SQL}

  CREATE TABLE IF NOT EXISTS codex_manual_compaction_bindings (
    manual_compaction_id TEXT PRIMARY KEY,
    thread_binding_id TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL,
    codex_compaction_turn_id TEXT,
    codex_model_provider_id TEXT NOT NULL CHECK (codex_model_provider_id = 'ready_gateway'),
    codex_model TEXT NOT NULL,
    upstream_profile_snapshot_ref TEXT NOT NULL,
    upstream_profile_snapshot_digest TEXT NOT NULL,
    provider_snapshot_json TEXT NOT NULL,
    credential_reference_id TEXT NOT NULL,
    expected_tools_digest TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consume_evidence_digest TEXT,
    abandoned_at TEXT,
    abandoned_reason TEXT,
    abandoned_reconciled_at TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((consumed_at IS NULL) = (consume_evidence_digest IS NULL)),
    CHECK (NOT (consumed_at IS NOT NULL AND abandoned_at IS NOT NULL)),
    CHECK ((abandoned_at IS NULL AND abandoned_reason IS NULL AND abandoned_reconciled_at IS NULL)
      OR (abandoned_at IS NOT NULL AND abandoned_reason IS NOT NULL))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_manual_compaction_active_thread
    ON codex_manual_compaction_bindings(thread_binding_id)
    WHERE consumed_at IS NULL AND abandoned_at IS NULL;

  CREATE TABLE IF NOT EXISTS codex_thread_dispatch_fences (
    thread_binding_id TEXT PRIMARY KEY,
    owner_main_boot_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('product_turn', 'manual_compaction')),
    owner_ready_run_id TEXT,
    owner_manual_compaction_id TEXT,
    acquired_at TEXT NOT NULL,
    expires_at TEXT,
    quarantined_at TEXT,
    quarantine_reason TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    CHECK ((owner_ready_run_id IS NULL) != (owner_manual_compaction_id IS NULL)),
    CHECK (
      (operation_kind = 'product_turn' AND owner_ready_run_id IS NOT NULL
        AND owner_manual_compaction_id IS NULL)
      OR
      (operation_kind = 'manual_compaction' AND owner_manual_compaction_id IS NOT NULL
        AND owner_ready_run_id IS NULL)
    ),
    CHECK ((quarantined_at IS NULL) = (quarantine_reason IS NULL))
  );

  CREATE TABLE IF NOT EXISTS codex_fence_owner_transfers (
    transfer_id TEXT PRIMARY KEY,
    thread_binding_id TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK (operation_kind IN ('product_turn', 'manual_compaction')),
    owner_ready_run_id TEXT,
    owner_manual_compaction_id TEXT,
    previous_owner_main_boot_id TEXT NOT NULL,
    new_owner_main_boot_id TEXT NOT NULL,
    previous_fence_revision INTEGER NOT NULL,
    new_fence_revision INTEGER NOT NULL,
    process_lease_id TEXT NOT NULL,
    new_process_lease_id TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    transferred_at TEXT NOT NULL,
    CHECK (previous_owner_main_boot_id != new_owner_main_boot_id),
    CHECK (new_fence_revision = previous_fence_revision + 1),
    CHECK ((owner_ready_run_id IS NULL) != (owner_manual_compaction_id IS NULL)),
    UNIQUE(thread_binding_id, previous_fence_revision)
  );

  CREATE TRIGGER IF NOT EXISTS codex_fence_owner_transfer_immutable_update
  BEFORE UPDATE ON codex_fence_owner_transfers
  BEGIN SELECT RAISE(ABORT, 'codex_fence_owner_transfer_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_fence_owner_transfer_immutable_delete
  BEFORE DELETE ON codex_fence_owner_transfers
  BEGIN SELECT RAISE(ABORT, 'codex_fence_owner_transfer_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_fence_owner_transfer_evidence_insert
  BEFORE INSERT ON codex_fence_owner_transfers
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_dispatch_fences fence
     WHERE fence.thread_binding_id = NEW.thread_binding_id
       AND fence.operation_kind = NEW.operation_kind
       AND fence.owner_ready_run_id IS NEW.owner_ready_run_id
       AND fence.owner_manual_compaction_id IS NEW.owner_manual_compaction_id
       AND fence.owner_main_boot_id = NEW.previous_owner_main_boot_id
       AND fence.revision = NEW.previous_fence_revision
       AND fence.quarantined_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM codex_sidecar_process_leases lease
     WHERE lease.process_lease_id = NEW.process_lease_id
       AND lease.owner_main_boot_id = NEW.previous_owner_main_boot_id
       AND lease.owner_main_dead_at IS NOT NULL
       AND lease.owner_main_death_evidence_digest IS NOT NULL
       AND lease.tree_zero_at IS NOT NULL
       AND lease.tree_zero_evidence_digest IS NOT NULL
       AND lease.stable_zero_sample_transcript_digest IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM codex_sidecar_process_leases new_lease
     WHERE new_lease.process_lease_id = NEW.new_process_lease_id
       AND new_lease.owner_main_boot_id = NEW.new_owner_main_boot_id
       AND new_lease.connection_opened_at IS NOT NULL
       AND new_lease.tree_zero_at IS NULL
  )
  BEGIN SELECT RAISE(ABORT, 'codex_fence_owner_transfer_evidence_invalid'); END;

  CREATE TABLE IF NOT EXISTS codex_sidecar_process_leases (
    process_lease_id TEXT PRIMARY KEY,
    singleton_slot INTEGER NOT NULL CHECK (singleton_slot = 1),
    owner_main_boot_id TEXT NOT NULL,
    owner_main_pid INTEGER NOT NULL CHECK (owner_main_pid > 0),
    owner_main_process_start_identity TEXT NOT NULL,
    sidecar_spawn_instance_id TEXT NOT NULL UNIQUE,
    connection_epoch TEXT NOT NULL UNIQUE,
    runtime_manifest_digest TEXT NOT NULL,
    binary_sha256 TEXT NOT NULL,
    executable_path TEXT NOT NULL,
    isolated_state_dir TEXT NOT NULL,
    spawn_intent_at TEXT NOT NULL,
    spawn_visibility_deadline_at TEXT NOT NULL,
    pid INTEGER,
    process_group_id INTEGER,
    process_start_identity TEXT,
    ownership_confirmed_at TEXT,
    owner_main_dead_at TEXT,
    owner_main_death_evidence_digest TEXT,
    connection_opened_at TEXT,
    closed_at TEXT,
    tree_zero_at TEXT,
    tree_zero_matcher_mode TEXT CHECK (tree_zero_matcher_mode IN ('pre_cas', 'post_cas')),
    stable_zero_sample_transcript_digest TEXT,
    tree_zero_evidence_digest TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    CHECK (
      (pid IS NULL AND process_group_id IS NULL AND process_start_identity IS NULL
        AND ownership_confirmed_at IS NULL)
      OR
      (pid IS NOT NULL AND pid > 0 AND process_group_id IS NOT NULL AND process_group_id > 0
        AND process_start_identity IS NOT NULL AND ownership_confirmed_at IS NOT NULL)
    ),
    CHECK ((owner_main_dead_at IS NULL) = (owner_main_death_evidence_digest IS NULL)),
    CHECK (
      (tree_zero_at IS NULL AND tree_zero_matcher_mode IS NULL
        AND stable_zero_sample_transcript_digest IS NULL AND tree_zero_evidence_digest IS NULL)
      OR
      (tree_zero_at IS NOT NULL AND tree_zero_matcher_mode IS NOT NULL
        AND stable_zero_sample_transcript_digest IS NOT NULL AND tree_zero_evidence_digest IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_sidecar_single_live_slot
    ON codex_sidecar_process_leases(singleton_slot)
    WHERE tree_zero_at IS NULL;

  CREATE TABLE IF NOT EXISTS codex_thread_resume_evidence (
    resume_evidence_id TEXT PRIMARY KEY,
    thread_binding_id TEXT NOT NULL,
    codex_thread_id TEXT NOT NULL,
    connection_epoch TEXT NOT NULL,
    pre_resume_thread_read_digest TEXT NOT NULL,
    resumed_thread_digest TEXT NOT NULL,
    evidence_digest TEXT NOT NULL UNIQUE,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (thread_binding_id)
      REFERENCES codex_thread_bindings(thread_binding_id),
    FOREIGN KEY (connection_epoch)
      REFERENCES codex_sidecar_process_leases(connection_epoch),
    UNIQUE(thread_binding_id, connection_epoch)
  );

  CREATE TRIGGER IF NOT EXISTS codex_thread_resume_evidence_parent_insert
  BEFORE INSERT ON codex_thread_resume_evidence
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_bindings parent
     WHERE parent.thread_binding_id = NEW.thread_binding_id
       AND parent.codex_thread_id = NEW.codex_thread_id
       AND parent.retired_at IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM codex_sidecar_process_leases lease
       WHERE lease.connection_epoch = NEW.connection_epoch
         AND lease.connection_opened_at IS NOT NULL
         AND lease.closed_at IS NULL
         AND lease.tree_zero_at IS NULL
  )
  BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_resume_evidence_immutable_update
  BEFORE UPDATE ON codex_thread_resume_evidence
  BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_resume_evidence_immutable_delete
  BEFORE DELETE ON codex_thread_resume_evidence
  BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_binding_immutable_update
  BEFORE UPDATE ON codex_thread_bindings
  WHEN NEW.thread_binding_id IS NOT OLD.thread_binding_id
    OR NEW.ready_conversation_alias IS NOT OLD.ready_conversation_alias
    OR NEW.alias_generation IS NOT OLD.alias_generation
    OR NEW.ready_scope_id IS NOT OLD.ready_scope_id
    OR NEW.runtime_manifest_digest IS NOT OLD.runtime_manifest_digest
    OR NEW.protocol_schema_digest IS NOT OLD.protocol_schema_digest
  BEGIN SELECT RAISE(ABORT, 'codex_thread_binding_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_binding_admission_immutable_update
  BEFORE UPDATE ON codex_thread_bindings
  WHEN (OLD.thread_start_reservation_set_id IS NOT NULL
      AND NEW.thread_start_reservation_set_id IS NOT OLD.thread_start_reservation_set_id)
    OR (OLD.thread_start_reservation_member_id IS NOT NULL
      AND NEW.thread_start_reservation_member_id IS NOT OLD.thread_start_reservation_member_id)
    OR (OLD.thread_start_reservation_admitted_at IS NOT NULL
      AND NEW.thread_start_reservation_admitted_at IS NOT OLD.thread_start_reservation_admitted_at)
    OR (OLD.thread_start_request_id IS NOT NULL
      AND NEW.thread_start_request_id IS NOT OLD.thread_start_request_id)
    OR (OLD.isolated_thread_cwd IS NOT NULL
      AND NEW.isolated_thread_cwd IS NOT OLD.isolated_thread_cwd)
    OR (OLD.tool_surface_digest IS NOT NULL
      AND NEW.tool_surface_digest IS NOT OLD.tool_surface_digest)
    OR (OLD.tool_surface_snapshot_digest IS NOT NULL
      AND NEW.tool_surface_snapshot_digest IS NOT OLD.tool_surface_snapshot_digest)
    OR (OLD.tool_surface_json IS NOT NULL AND NEW.tool_surface_json IS NOT OLD.tool_surface_json)
    OR (OLD.instruction_contract_digest IS NOT NULL
      AND NEW.instruction_contract_digest IS NOT OLD.instruction_contract_digest)
    OR (OLD.codex_model_provider_id IS NOT NULL
      AND NEW.codex_model_provider_id IS NOT OLD.codex_model_provider_id)
    OR (OLD.codex_model IS NOT NULL AND NEW.codex_model IS NOT OLD.codex_model)
    OR (OLD.upstream_profile_snapshot_ref IS NOT NULL
      AND NEW.upstream_profile_snapshot_ref IS NOT OLD.upstream_profile_snapshot_ref)
    OR (OLD.upstream_profile_snapshot_digest IS NOT NULL
      AND NEW.upstream_profile_snapshot_digest IS NOT OLD.upstream_profile_snapshot_digest)
    OR (OLD.codex_thread_id IS NOT NULL AND NEW.codex_thread_id IS NOT OLD.codex_thread_id)
    OR (OLD.codex_session_id IS NOT NULL AND NEW.codex_session_id IS NOT OLD.codex_session_id)
    OR (OLD.codex_parent_thread_id IS NOT NULL
      AND NEW.codex_parent_thread_id IS NOT OLD.codex_parent_thread_id)
    OR (OLD.codex_forked_from_id IS NOT NULL
      AND NEW.codex_forked_from_id IS NOT OLD.codex_forked_from_id)
    OR (OLD.codex_source_json IS NOT NULL AND NEW.codex_source_json IS NOT OLD.codex_source_json)
    OR (OLD.codex_thread_source_json IS NOT NULL
      AND NEW.codex_thread_source_json IS NOT OLD.codex_thread_source_json)
    OR (OLD.thread_start_rpc_connection_epoch IS NOT NULL
      AND NEW.thread_start_rpc_connection_epoch IS NOT OLD.thread_start_rpc_connection_epoch)
    OR (OLD.thread_start_rpc_id IS NOT NULL AND NEW.thread_start_rpc_id IS NOT OLD.thread_start_rpc_id)
    OR (OLD.thread_start_dispatch_intent_at IS NOT NULL
      AND NEW.thread_start_dispatch_intent_at IS NOT OLD.thread_start_dispatch_intent_at)
    OR (OLD.thread_start_child_write_confirmed_at IS NOT NULL
      AND NEW.thread_start_child_write_confirmed_at IS NOT OLD.thread_start_child_write_confirmed_at)
    OR (OLD.thread_start_child_write_digest IS NOT NULL
      AND NEW.thread_start_child_write_digest IS NOT OLD.thread_start_child_write_digest)
    OR (OLD.thread_start_response_at IS NOT NULL
      AND NEW.thread_start_response_at IS NOT OLD.thread_start_response_at)
    OR (OLD.thread_start_reconciled_at IS NOT NULL
      AND NEW.thread_start_reconciled_at IS NOT OLD.thread_start_reconciled_at)
    OR (OLD.thread_start_reconciliation_evidence_digest IS NOT NULL
      AND NEW.thread_start_reconciliation_evidence_digest IS NOT OLD.thread_start_reconciliation_evidence_digest)
    OR (OLD.thread_start_reservation_released_at IS NOT NULL
      AND NEW.thread_start_reservation_released_at IS NOT OLD.thread_start_reservation_released_at)
    OR (OLD.thread_start_reservation_release_reason IS NOT NULL
      AND NEW.thread_start_reservation_release_reason IS NOT OLD.thread_start_reservation_release_reason)
    OR (OLD.thread_start_late_response_guard_closed_at IS NOT NULL
      AND NEW.thread_start_late_response_guard_closed_at IS NOT OLD.thread_start_late_response_guard_closed_at)
    OR (OLD.thread_start_late_response_guard_close_reason IS NOT NULL
      AND NEW.thread_start_late_response_guard_close_reason IS NOT OLD.thread_start_late_response_guard_close_reason)
    OR (OLD.thread_started_at IS NOT NULL AND NEW.thread_started_at IS NOT OLD.thread_started_at)
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
    OR (OLD.retired_reason IS NOT NULL AND NEW.retired_reason IS NOT OLD.retired_reason)
    OR (OLD.retirement_evidence_digest IS NOT NULL
      AND NEW.retirement_evidence_digest IS NOT OLD.retirement_evidence_digest)
    OR (OLD.continuation_blocked_at IS NOT NULL
      AND NEW.continuation_blocked_at IS NOT OLD.continuation_blocked_at)
    OR (OLD.continuation_blocked_reason IS NOT NULL
      AND NEW.continuation_blocked_reason IS NOT OLD.continuation_blocked_reason)
    OR (OLD.continuation_blocked_evidence_digest IS NOT NULL
      AND NEW.continuation_blocked_evidence_digest IS NOT OLD.continuation_blocked_evidence_digest)
  BEGIN SELECT RAISE(ABORT, 'codex_thread_binding_admission_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_thread_native_identity_propagate
  AFTER UPDATE OF codex_thread_id ON codex_thread_bindings
  WHEN OLD.codex_thread_id IS NULL AND NEW.codex_thread_id IS NOT NULL
  BEGIN
    UPDATE codex_turn_bindings
       SET codex_thread_id = NEW.codex_thread_id,
           revision = revision + 1,
           updated_at = NEW.updated_at
     WHERE thread_binding_id = NEW.thread_binding_id AND codex_thread_id IS NULL;
  END;

  CREATE TRIGGER IF NOT EXISTS codex_turn_parent_insert
  BEFORE INSERT ON codex_turn_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_bindings parent
     WHERE parent.thread_binding_id = NEW.thread_binding_id
       AND ((parent.codex_thread_id IS NULL AND NEW.codex_thread_id IS NULL)
         OR parent.codex_thread_id = NEW.codex_thread_id)
  )
  BEGIN SELECT RAISE(ABORT, 'codex_turn_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_turn_parent_update
  BEFORE UPDATE ON codex_turn_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_bindings parent
     WHERE parent.thread_binding_id = NEW.thread_binding_id
       AND ((parent.codex_thread_id IS NULL AND NEW.codex_thread_id IS NULL)
         OR parent.codex_thread_id = NEW.codex_thread_id)
  )
  BEGIN SELECT RAISE(ABORT, 'codex_turn_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_turn_binding_immutable_update
  BEFORE UPDATE ON codex_turn_bindings
  WHEN NEW.ready_run_id IS NOT OLD.ready_run_id
    OR NEW.ready_task_id IS NOT OLD.ready_task_id
    OR NEW.thread_binding_id IS NOT OLD.thread_binding_id
    OR NEW.start_reservation_set_id IS NOT OLD.start_reservation_set_id
    OR NEW.turn_start_reservation_member_id IS NOT OLD.turn_start_reservation_member_id
    OR NEW.turn_request_id IS NOT OLD.turn_request_id
    OR NEW.origin_user_message_id IS NOT OLD.origin_user_message_id
    OR NEW.message_visibility_epoch IS NOT OLD.message_visibility_epoch
    OR NEW.predecessor_run_id IS NOT OLD.predecessor_run_id
    OR NEW.attempt_kind IS NOT OLD.attempt_kind
    OR NEW.start_reservation_required_member_count IS NOT OLD.start_reservation_required_member_count
    OR NEW.turn_start_reservation_admitted_at IS NOT OLD.turn_start_reservation_admitted_at
    OR NEW.ingress_admitted_revision IS NOT OLD.ingress_admitted_revision
    OR NEW.ingress_admitted_digest IS NOT OLD.ingress_admitted_digest
    OR NEW.ingress_admitted_at IS NOT OLD.ingress_admitted_at
    OR NEW.history_parity_evidence_digest IS NOT OLD.history_parity_evidence_digest
    OR NEW.current_thread_read_evidence_digest IS NOT OLD.current_thread_read_evidence_digest
    OR NEW.continuation_contract_digest IS NOT OLD.continuation_contract_digest
    OR NEW.tool_surface_digest IS NOT OLD.tool_surface_digest
    OR NEW.authorization_snapshot_digest IS NOT OLD.authorization_snapshot_digest
    OR NEW.authorization_snapshot_json IS NOT OLD.authorization_snapshot_json
    OR NEW.product_budget_seed_json IS NOT OLD.product_budget_seed_json
    OR NEW.effective_codex_model IS NOT OLD.effective_codex_model
    OR NEW.effective_upstream_snapshot_ref IS NOT OLD.effective_upstream_snapshot_ref
    OR NEW.effective_upstream_snapshot_digest IS NOT OLD.effective_upstream_snapshot_digest
    OR NEW.additional_context_digest IS NOT OLD.additional_context_digest
    OR NEW.turn_contract_digest IS NOT OLD.turn_contract_digest
    OR (OLD.codex_thread_id IS NOT NULL AND NEW.codex_thread_id IS NOT OLD.codex_thread_id)
    OR (OLD.codex_turn_id IS NOT NULL AND NEW.codex_turn_id IS NOT OLD.codex_turn_id)
    OR (OLD.turn_start_rpc_connection_epoch IS NOT NULL
      AND NEW.turn_start_rpc_connection_epoch IS NOT OLD.turn_start_rpc_connection_epoch)
    OR (OLD.turn_start_rpc_id IS NOT NULL AND NEW.turn_start_rpc_id IS NOT OLD.turn_start_rpc_id)
    OR (OLD.turn_start_dispatch_intent_at IS NOT NULL
      AND NEW.turn_start_dispatch_intent_at IS NOT OLD.turn_start_dispatch_intent_at)
    OR (OLD.turn_start_child_write_confirmed_at IS NOT NULL
      AND NEW.turn_start_child_write_confirmed_at IS NOT OLD.turn_start_child_write_confirmed_at)
    OR (OLD.turn_start_child_write_digest IS NOT NULL
      AND NEW.turn_start_child_write_digest IS NOT OLD.turn_start_child_write_digest)
    OR (OLD.turn_start_response_at IS NOT NULL
      AND NEW.turn_start_response_at IS NOT OLD.turn_start_response_at)
    OR (OLD.turn_start_reconciled_at IS NOT NULL
      AND NEW.turn_start_reconciled_at IS NOT OLD.turn_start_reconciled_at)
    OR (OLD.turn_start_reconciliation_evidence_digest IS NOT NULL
      AND NEW.turn_start_reconciliation_evidence_digest IS NOT OLD.turn_start_reconciliation_evidence_digest)
    OR (OLD.turn_start_reservation_released_at IS NOT NULL
      AND NEW.turn_start_reservation_released_at IS NOT OLD.turn_start_reservation_released_at)
    OR (OLD.turn_start_reservation_release_reason IS NOT NULL
      AND NEW.turn_start_reservation_release_reason IS NOT OLD.turn_start_reservation_release_reason)
    OR (OLD.turn_start_late_response_guard_closed_at IS NOT NULL
      AND NEW.turn_start_late_response_guard_closed_at IS NOT OLD.turn_start_late_response_guard_closed_at)
    OR (OLD.turn_start_late_response_guard_close_reason IS NOT NULL
      AND NEW.turn_start_late_response_guard_close_reason IS NOT OLD.turn_start_late_response_guard_close_reason)
    OR (OLD.host_failure_kind IS NOT NULL AND NEW.host_failure_kind IS NOT OLD.host_failure_kind)
    OR (OLD.host_failure_recorded_at IS NOT NULL
      AND NEW.host_failure_recorded_at IS NOT OLD.host_failure_recorded_at)
    OR (OLD.host_failure_evidence_digest IS NOT NULL
      AND NEW.host_failure_evidence_digest IS NOT OLD.host_failure_evidence_digest)
    OR (OLD.recovery_failure_code IS NOT NULL
      AND NEW.recovery_failure_code IS NOT OLD.recovery_failure_code)
    OR (OLD.recovery_failure_evidence_digest IS NOT NULL
      AND NEW.recovery_failure_evidence_digest IS NOT OLD.recovery_failure_evidence_digest)
    OR (OLD.recovery_failure_recorded_at IS NOT NULL
      AND NEW.recovery_failure_recorded_at IS NOT OLD.recovery_failure_recorded_at)
    OR (OLD.interrupt_requested_at IS NOT NULL
      AND NEW.interrupt_requested_at IS NOT OLD.interrupt_requested_at)
    OR (OLD.interrupt_ack_at IS NOT NULL AND NEW.interrupt_ack_at IS NOT OLD.interrupt_ack_at)
    OR (OLD.interrupt_state_unknown_at IS NOT NULL
      AND NEW.interrupt_state_unknown_at IS NOT OLD.interrupt_state_unknown_at)
    OR (OLD.ingress_json IS NOT NULL AND NEW.ingress_json IS NOT OLD.ingress_json)
    OR (OLD.engine_terminal_status IS NOT NULL
      AND NEW.engine_terminal_status IS NOT OLD.engine_terminal_status)
    OR (OLD.engine_terminal_candidate_json IS NOT NULL
      AND NEW.engine_terminal_candidate_json IS NOT OLD.engine_terminal_candidate_json)
    OR (OLD.engine_terminal_candidate_digest IS NOT NULL
      AND NEW.engine_terminal_candidate_digest IS NOT OLD.engine_terminal_candidate_digest)
    OR (OLD.engine_terminal_recorded_at IS NOT NULL
      AND NEW.engine_terminal_recorded_at IS NOT OLD.engine_terminal_recorded_at)
    OR (OLD.fence_release_revision IS NOT NULL
      AND NEW.fence_release_revision IS NOT OLD.fence_release_revision)
    OR (OLD.publication_receipt_refs_json IS NOT NULL
      AND NEW.publication_receipt_refs_json IS NOT OLD.publication_receipt_refs_json)
    OR (OLD.publication_receipt_digest IS NOT NULL
      AND NEW.publication_receipt_digest IS NOT OLD.publication_receipt_digest)
    OR (OLD.publication_recorded_at IS NOT NULL
      AND NEW.publication_recorded_at IS NOT OLD.publication_recorded_at)
  BEGIN SELECT RAISE(ABORT, 'codex_turn_binding_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_turn_terminal_immutable_update
  BEFORE UPDATE ON codex_turn_bindings
  WHEN (OLD.host_failure_product_terminal_digest IS NOT NULL
      AND NEW.host_failure_product_terminal_digest IS NOT OLD.host_failure_product_terminal_digest)
    OR (OLD.host_failure_closeout_at IS NOT NULL
      AND NEW.host_failure_closeout_at IS NOT OLD.host_failure_closeout_at)
    OR (OLD.product_terminal_digest IS NOT NULL
      AND NEW.product_terminal_digest IS NOT OLD.product_terminal_digest)
    OR (OLD.product_closeout_at IS NOT NULL
      AND NEW.product_closeout_at IS NOT OLD.product_closeout_at)
  BEGIN SELECT RAISE(ABORT, 'codex_turn_terminal_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_call_parent_insert
  BEFORE INSERT ON codex_tool_call_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_turn_bindings parent
     WHERE parent.ready_run_id = NEW.ready_run_id
       AND parent.codex_thread_id = NEW.codex_thread_id
       AND parent.codex_turn_id = NEW.codex_turn_id
  )
  BEGIN SELECT RAISE(ABORT, 'codex_call_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_call_parent_update
  BEFORE UPDATE ON codex_tool_call_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_turn_bindings parent
     WHERE parent.ready_run_id = NEW.ready_run_id
       AND parent.codex_thread_id = NEW.codex_thread_id
       AND parent.codex_turn_id = NEW.codex_turn_id
  )
  BEGIN SELECT RAISE(ABORT, 'codex_call_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_call_binding_immutable_update
  BEFORE UPDATE ON codex_tool_call_bindings
  WHEN NEW.codex_thread_id IS NOT OLD.codex_thread_id
    OR NEW.codex_turn_id IS NOT OLD.codex_turn_id
    OR NEW.codex_call_id IS NOT OLD.codex_call_id
    OR NEW.ready_run_id IS NOT OLD.ready_run_id
    OR NEW.ready_action_id IS NOT OLD.ready_action_id
    OR NEW.tool_name IS NOT OLD.tool_name
    OR NEW.args_digest IS NOT OLD.args_digest
    OR NEW.turn_contract_digest IS NOT OLD.turn_contract_digest
    OR NEW.ready_alias_id IS NOT OLD.ready_alias_id
    OR NEW.codex_session_id IS NOT OLD.codex_session_id
    OR NEW.ready_task_id IS NOT OLD.ready_task_id
    OR NEW.surface_snapshot_digest IS NOT OLD.surface_snapshot_digest
    OR NEW.tool_surface_digest IS NOT OLD.tool_surface_digest
    OR NEW.authorization_snapshot_digest IS NOT OLD.authorization_snapshot_digest
    OR NEW.tool_schema_digest IS NOT OLD.tool_schema_digest
    OR NEW.request_connection_epoch IS NOT OLD.request_connection_epoch
    OR NEW.request_rpc_id IS NOT OLD.request_rpc_id
    OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
    OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS NOT OLD.result_digest)
    OR (OLD.delivered_connection_epoch IS NOT NULL
      AND NEW.delivered_connection_epoch IS NOT OLD.delivered_connection_epoch)
    OR (OLD.delivered_rpc_id IS NOT NULL AND NEW.delivered_rpc_id IS NOT OLD.delivered_rpc_id)
    OR (OLD.delivery_intent_at IS NOT NULL AND NEW.delivery_intent_at IS NOT OLD.delivery_intent_at)
  BEGIN SELECT RAISE(ABORT, 'codex_call_binding_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS ready_tool_action_receipt_identity_immutable_update
  BEFORE UPDATE ON ready_tool_action_receipts
  WHEN NEW.ready_action_id IS NOT OLD.ready_action_id
    OR NEW.action_identity_digest IS NOT OLD.action_identity_digest
    OR (OLD.state != 'pending' AND NEW.state IS NOT OLD.state)
    OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
    OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS NOT OLD.result_digest)
    OR (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json)
    OR (OLD.resolution_reason IS NOT NULL AND NEW.resolution_reason IS NOT OLD.resolution_reason)
    OR (OLD.resolution_evidence_digest IS NOT NULL
      AND NEW.resolution_evidence_digest IS NOT OLD.resolution_evidence_digest)
  BEGIN SELECT RAISE(ABORT, 'ready_tool_action_receipt_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS ready_tool_action_receipt_no_delete
  BEFORE DELETE ON ready_tool_action_receipts
  BEGIN SELECT RAISE(ABORT, 'ready_tool_action_receipt_delete_forbidden'); END;

  CREATE TRIGGER IF NOT EXISTS codex_manual_parent_insert
  BEFORE INSERT ON codex_manual_compaction_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_bindings parent
     WHERE parent.thread_binding_id = NEW.thread_binding_id
       AND parent.codex_thread_id = NEW.codex_thread_id
       AND parent.retired_at IS NULL
  )
  BEGIN SELECT RAISE(ABORT, 'codex_manual_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_manual_parent_update
  BEFORE UPDATE ON codex_manual_compaction_bindings
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_bindings parent
     WHERE parent.thread_binding_id = NEW.thread_binding_id
       AND parent.codex_thread_id = NEW.codex_thread_id
  )
  BEGIN SELECT RAISE(ABORT, 'codex_manual_parent_mismatch'); END;

  CREATE TRIGGER IF NOT EXISTS codex_manual_binding_immutable_update
  BEFORE UPDATE ON codex_manual_compaction_bindings
  WHEN NEW.manual_compaction_id IS NOT OLD.manual_compaction_id
    OR NEW.thread_binding_id IS NOT OLD.thread_binding_id
    OR NEW.codex_thread_id IS NOT OLD.codex_thread_id
    OR NEW.codex_model_provider_id IS NOT OLD.codex_model_provider_id
    OR NEW.codex_model IS NOT OLD.codex_model
    OR NEW.upstream_profile_snapshot_ref IS NOT OLD.upstream_profile_snapshot_ref
    OR NEW.upstream_profile_snapshot_digest IS NOT OLD.upstream_profile_snapshot_digest
    OR NEW.provider_snapshot_json IS NOT OLD.provider_snapshot_json
    OR NEW.credential_reference_id IS NOT OLD.credential_reference_id
    OR NEW.expected_tools_digest IS NOT OLD.expected_tools_digest
    OR (OLD.codex_compaction_turn_id IS NOT NULL
      AND NEW.codex_compaction_turn_id IS NOT OLD.codex_compaction_turn_id)
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at)
    OR (OLD.consume_evidence_digest IS NOT NULL
      AND NEW.consume_evidence_digest IS NOT OLD.consume_evidence_digest)
    OR (OLD.abandoned_at IS NOT NULL AND NEW.abandoned_at IS NOT OLD.abandoned_at)
    OR (OLD.abandoned_reason IS NOT NULL AND NEW.abandoned_reason IS NOT OLD.abandoned_reason)
    OR (OLD.abandoned_reconciled_at IS NOT NULL
      AND NEW.abandoned_reconciled_at IS NOT OLD.abandoned_reconciled_at)
  BEGIN SELECT RAISE(ABORT, 'codex_manual_binding_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_fence_parent_insert
  BEFORE INSERT ON codex_thread_dispatch_fences
  WHEN NOT EXISTS (
    SELECT 1 FROM codex_thread_bindings parent
     WHERE parent.thread_binding_id = NEW.thread_binding_id AND parent.retired_at IS NULL
  ) OR (
    NEW.operation_kind = 'product_turn' AND NOT EXISTS (
      SELECT 1 FROM codex_turn_bindings turn_row
       WHERE turn_row.ready_run_id = NEW.owner_ready_run_id
         AND turn_row.thread_binding_id = NEW.thread_binding_id
    )
  ) OR (
    NEW.operation_kind = 'manual_compaction' AND NOT EXISTS (
      SELECT 1 FROM codex_manual_compaction_bindings manual_row
       WHERE manual_row.manual_compaction_id = NEW.owner_manual_compaction_id
         AND manual_row.thread_binding_id = NEW.thread_binding_id
    )
  )
  BEGIN SELECT RAISE(ABORT, 'codex_fence_parent_mismatch'); END;

  ${CODEX_BINDING_EVIDENCE_GUARDS_SQL}

  CREATE TRIGGER IF NOT EXISTS codex_thread_binding_no_delete
  BEFORE DELETE ON codex_thread_bindings
  BEGIN SELECT RAISE(ABORT, 'codex_thread_binding_delete_forbidden'); END;
  CREATE TRIGGER IF NOT EXISTS codex_turn_binding_no_delete
  BEFORE DELETE ON codex_turn_bindings
  BEGIN SELECT RAISE(ABORT, 'codex_turn_binding_delete_forbidden'); END;
  CREATE TRIGGER IF NOT EXISTS codex_call_binding_no_delete
  BEFORE DELETE ON codex_tool_call_bindings
  BEGIN SELECT RAISE(ABORT, 'codex_call_binding_delete_forbidden'); END;
  CREATE TRIGGER IF NOT EXISTS codex_manual_binding_no_delete
  BEFORE DELETE ON codex_manual_compaction_bindings
  BEGIN SELECT RAISE(ABORT, 'codex_manual_binding_delete_forbidden'); END;
  CREATE TRIGGER IF NOT EXISTS codex_process_lease_no_delete
  BEFORE DELETE ON codex_sidecar_process_leases
  BEGIN SELECT RAISE(ABORT, 'codex_process_lease_delete_forbidden'); END;
`

export function applyCodexThreadResumeActiveLeaseMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    DROP TRIGGER IF EXISTS codex_thread_resume_evidence_parent_insert;
    CREATE TRIGGER codex_thread_resume_evidence_parent_insert
    BEFORE INSERT ON codex_thread_resume_evidence
    WHEN NOT EXISTS (
      SELECT 1 FROM codex_thread_bindings parent
       WHERE parent.thread_binding_id = NEW.thread_binding_id
         AND parent.codex_thread_id = NEW.codex_thread_id
         AND parent.retired_at IS NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM codex_sidecar_process_leases lease
       WHERE lease.connection_epoch = NEW.connection_epoch
         AND lease.connection_opened_at IS NOT NULL
         AND lease.closed_at IS NULL
         AND lease.tree_zero_at IS NULL
    )
    BEGIN SELECT RAISE(ABORT, 'codex_thread_resume_evidence_parent_mismatch'); END;
  `)
}

export function applyCodexStartupOwnerHandoffMigration(db: {
  exec(sql: string): void
}): void {
  // run-finalizer-exempt: migration-101 restores only exact interrupted Codex owners
  db.exec(`
    UPDATE task_projections
       SET status = 'running', interaction_state = 'running', waiting_for = 'none',
           degradation_reason = NULL, blocked_reason = NULL,
           resumable_actions_json = '[]', revision = revision + 1
     WHERE status = 'failed'
       AND degradation_reason = 'main_process_restarted'
       AND EXISTS (
         SELECT 1
           FROM codex_turn_bindings codex
           JOIN run_meta owner
             ON owner.run_id = codex.ready_run_id
            AND owner.task_id = codex.ready_task_id
          WHERE codex.ready_run_id = task_projections.run_id
            AND codex.ready_task_id = task_projections.task_id
            AND codex.product_terminal_digest IS NULL
            AND codex.host_failure_product_terminal_digest IS NULL
            AND owner.status = 'interrupted'
            AND owner.initiator = 'process_exit'
            AND owner.terminal_reason = 'main_process_restarted'
       );

    UPDATE run_meta
       SET status = 'running', initiator = NULL, terminal_reason = NULL,
           duration_ms = NULL
     WHERE status = 'interrupted'
       AND initiator = 'process_exit'
       AND terminal_reason = 'main_process_restarted'
       AND EXISTS (
         SELECT 1
          FROM codex_turn_bindings codex
          WHERE codex.ready_run_id = run_meta.run_id
            AND codex.ready_task_id = run_meta.task_id
            AND codex.product_terminal_digest IS NULL
            AND codex.host_failure_product_terminal_digest IS NULL
       );
  `)
}

export function applyCodexBrowserVerifierReceiptMigration(db: {
  exec(sql: string): void
}): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_browser_verifier_attempts (
      attempt_id TEXT PRIMARY KEY,
      ready_run_id TEXT NOT NULL UNIQUE,
      ready_task_id TEXT NOT NULL,
      ready_scope_id TEXT NOT NULL,
      ready_alias_id TEXT NOT NULL,
      alias_generation INTEGER NOT NULL CHECK (alias_generation >= 1),
      thread_binding_id TEXT NOT NULL,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      candidate_digest TEXT NOT NULL CHECK (
        length(candidate_digest) = 64 AND candidate_digest NOT GLOB '*[^0-9a-f]*'
      ),
      frozen_identity_digest TEXT NOT NULL CHECK (
        length(frozen_identity_digest) = 64 AND frozen_identity_digest NOT GLOB '*[^0-9a-f]*'
      ),
      upstream_profile_snapshot_ref TEXT NOT NULL,
      upstream_profile_snapshot_digest TEXT NOT NULL CHECK (
        length(upstream_profile_snapshot_digest) = 64
        AND upstream_profile_snapshot_digest NOT GLOB '*[^0-9a-f]*'
      ),
      workflow_closeout_seal_digest TEXT NOT NULL CHECK (
        length(workflow_closeout_seal_digest) = 64
        AND workflow_closeout_seal_digest NOT GLOB '*[^0-9a-f]*'
      ),
      status TEXT NOT NULL CHECK (status IN ('dispatching', 'settled')),
      outcome TEXT CHECK (outcome IN (
        'accept', 'repair', 'block', 'invalid', 'provider_unavailable', 'result_unknown', 'identity_drift'
      )),
      verdict_json TEXT,
      verdict_digest TEXT,
      sealed_candidate_digest TEXT,
      verification_usage_json TEXT,
      receipt_digest TEXT,
      dispatched_at TEXT NOT NULL,
      verified_at TEXT,
      settled_at TEXT,
      CHECK (
        (status = 'dispatching' AND outcome IS NULL AND verdict_json IS NULL
          AND verdict_digest IS NULL AND sealed_candidate_digest IS NULL
          AND verification_usage_json IS NULL AND receipt_digest IS NULL
          AND verified_at IS NULL AND settled_at IS NULL)
        OR
        (status = 'settled' AND outcome IS NOT NULL AND verdict_json IS NOT NULL
          AND verdict_digest IS NOT NULL
          AND verification_usage_json IS NOT NULL AND receipt_digest IS NOT NULL
          AND verified_at IS NOT NULL AND settled_at IS NOT NULL)
      ),
      FOREIGN KEY (ready_run_id) REFERENCES codex_turn_bindings(ready_run_id)
    );

    CREATE TRIGGER IF NOT EXISTS codex_browser_verifier_attempt_identity_immutable
    BEFORE UPDATE ON codex_browser_verifier_attempts
    WHEN NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.ready_run_id IS NOT OLD.ready_run_id
      OR NEW.ready_task_id IS NOT OLD.ready_task_id
      OR NEW.ready_scope_id IS NOT OLD.ready_scope_id
      OR NEW.ready_alias_id IS NOT OLD.ready_alias_id
      OR NEW.alias_generation IS NOT OLD.alias_generation
      OR NEW.thread_binding_id IS NOT OLD.thread_binding_id
      OR NEW.codex_thread_id IS NOT OLD.codex_thread_id
      OR NEW.codex_turn_id IS NOT OLD.codex_turn_id
      OR NEW.candidate_digest IS NOT OLD.candidate_digest
      OR NEW.frozen_identity_digest IS NOT OLD.frozen_identity_digest
      OR NEW.upstream_profile_snapshot_ref IS NOT OLD.upstream_profile_snapshot_ref
      OR NEW.upstream_profile_snapshot_digest IS NOT OLD.upstream_profile_snapshot_digest
      OR NEW.workflow_closeout_seal_digest IS NOT OLD.workflow_closeout_seal_digest
      OR NEW.dispatched_at IS NOT OLD.dispatched_at
    BEGIN SELECT RAISE(ABORT, 'codex_browser_verifier_attempt_identity_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_browser_verifier_attempt_settled_immutable
    BEFORE UPDATE ON codex_browser_verifier_attempts
    WHEN OLD.status = 'settled'
    BEGIN SELECT RAISE(ABORT, 'codex_browser_verifier_attempt_settled_immutable'); END;

    CREATE TRIGGER IF NOT EXISTS codex_browser_verifier_attempt_no_delete
    BEFORE DELETE ON codex_browser_verifier_attempts
    BEGIN SELECT RAISE(ABORT, 'codex_browser_verifier_attempt_delete_forbidden'); END;
  `)
}

export function applyCodexTurnLifecycleActionMigration(db: {
  exec(sql: string): void
  prepare(sql: string): { all<T = unknown>(): T[] }
}): void {
  const columns = new Set(
    db.prepare('PRAGMA table_info(codex_turn_bindings)')
      .all<{ name: string }>()
      .map((column) => column.name),
  )
  if (!columns.has('lifecycle_action')) {
    db.exec(`ALTER TABLE codex_turn_bindings ADD COLUMN lifecycle_action TEXT
      CHECK (lifecycle_action IN ('stop', 'close', 'reset'))`)
  }
  if (!columns.has('lifecycle_action_requested_at')) {
    db.exec('ALTER TABLE codex_turn_bindings ADD COLUMN lifecycle_action_requested_at TEXT')
  }
  if (!columns.has('lifecycle_action_evidence_digest')) {
    db.exec('ALTER TABLE codex_turn_bindings ADD COLUMN lifecycle_action_evidence_digest TEXT')
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS codex_turn_lifecycle_action_pair_insert
    BEFORE INSERT ON codex_turn_bindings
    WHEN NOT (
      (NEW.lifecycle_action IS NULL
        AND NEW.lifecycle_action_requested_at IS NULL
        AND NEW.lifecycle_action_evidence_digest IS NULL)
      OR
      (NEW.lifecycle_action IS NOT NULL
        AND NEW.lifecycle_action_requested_at IS NOT NULL
        AND NEW.lifecycle_action_evidence_digest IS NOT NULL
        AND length(NEW.lifecycle_action_evidence_digest) = 64
        AND NEW.lifecycle_action_evidence_digest NOT GLOB '*[^0-9a-f]*')
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_lifecycle_action_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_lifecycle_action_pair_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN NOT (
      (NEW.lifecycle_action IS NULL
        AND NEW.lifecycle_action_requested_at IS NULL
        AND NEW.lifecycle_action_evidence_digest IS NULL)
      OR
      (NEW.lifecycle_action IS NOT NULL
        AND NEW.lifecycle_action_requested_at IS NOT NULL
        AND NEW.lifecycle_action_evidence_digest IS NOT NULL
        AND length(NEW.lifecycle_action_evidence_digest) = 64
        AND NEW.lifecycle_action_evidence_digest NOT GLOB '*[^0-9a-f]*')
    )
    BEGIN SELECT RAISE(ABORT, 'codex_turn_lifecycle_action_pair_invalid'); END;

    CREATE TRIGGER IF NOT EXISTS codex_turn_lifecycle_action_immutable_update
    BEFORE UPDATE ON codex_turn_bindings
    WHEN (OLD.lifecycle_action IS NOT NULL
        AND NEW.lifecycle_action IS NOT OLD.lifecycle_action)
      OR (OLD.lifecycle_action_requested_at IS NOT NULL
        AND NEW.lifecycle_action_requested_at IS NOT OLD.lifecycle_action_requested_at)
      OR (OLD.lifecycle_action_evidence_digest IS NOT NULL
        AND NEW.lifecycle_action_evidence_digest IS NOT OLD.lifecycle_action_evidence_digest)
    BEGIN SELECT RAISE(ABORT, 'codex_turn_lifecycle_action_immutable'); END;
  `)
}
