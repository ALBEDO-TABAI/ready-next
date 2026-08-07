export const CODEX_BINDING_EVIDENCE_GUARDS_SQL = `
  CREATE TRIGGER IF NOT EXISTS codex_fence_parent_update
  BEFORE UPDATE ON codex_thread_dispatch_fences
  WHEN NEW.thread_binding_id IS NOT OLD.thread_binding_id
    OR NEW.owner_main_boot_id IS NOT OLD.owner_main_boot_id
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
    product_terminal_digest TEXT,
    product_closeout_at TEXT,
    origin_user_message_id TEXT,
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
    effective_codex_model TEXT NOT NULL,
    effective_upstream_snapshot_ref TEXT NOT NULL,
    effective_upstream_snapshot_digest TEXT NOT NULL,
    additional_context_digest TEXT NOT NULL,
    turn_contract_digest TEXT NOT NULL,
    interrupt_requested_at TEXT,
    interrupt_ack_at TEXT,
    interrupt_state_unknown_at TEXT,
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
    CHECK ((product_terminal_digest IS NULL) = (product_closeout_at IS NULL)),
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
    receipt_id TEXT UNIQUE,
    result_digest TEXT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (codex_thread_id, codex_turn_id, codex_call_id),
    CHECK ((receipt_id IS NULL) = (result_digest IS NULL))
  );

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
    OR (OLD.interrupt_requested_at IS NOT NULL
      AND NEW.interrupt_requested_at IS NOT OLD.interrupt_requested_at)
    OR (OLD.interrupt_ack_at IS NOT NULL AND NEW.interrupt_ack_at IS NOT OLD.interrupt_ack_at)
    OR (OLD.interrupt_state_unknown_at IS NOT NULL
      AND NEW.interrupt_state_unknown_at IS NOT OLD.interrupt_state_unknown_at)
  BEGIN SELECT RAISE(ABORT, 'codex_turn_binding_identity_immutable'); END;

  CREATE TRIGGER IF NOT EXISTS codex_turn_terminal_immutable_update
  BEFORE UPDATE ON codex_turn_bindings
  WHEN (OLD.host_failure_product_terminal_digest IS NOT NULL
      AND NEW.host_failure_product_terminal_digest IS NOT OLD.host_failure_product_terminal_digest)
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
    OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS NOT OLD.receipt_id)
    OR (OLD.result_digest IS NOT NULL AND NEW.result_digest IS NOT OLD.result_digest)
  BEGIN SELECT RAISE(ABORT, 'codex_call_binding_identity_immutable'); END;

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
    OR NEW.expires_at IS NOT OLD.expires_at
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
