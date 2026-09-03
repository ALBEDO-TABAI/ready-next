import { dirname, resolve } from 'node:path'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

import Database from 'better-sqlite3'

const outputPath = resolve(process.argv[2] || '')
if (!process.argv[2] || existsSync(outputPath)) {
  throw new Error('usage: create-codex-pre118-fixture.ts /new/absolute/path/ready-pre118.db')
}
mkdirSync(dirname(outputPath), { recursive: true })
const db = new Database(outputPath)
try {
  db.exec(readFileSync(new URL('../src/__tests__/fixtures/ready-pre118-schema.sql', import.meta.url), 'utf8'))
  const ledger = db.prepare('SELECT name FROM migrations ORDER BY id').all() as Array<{ name: string }>
  if (ledger.length !== 115 || ledger.at(-1)?.name !== '115_interrupt_retired_execution_scopes') {
    throw new Error('pre-118 fixture must retain the real f175a25f migration ledger')
  }
  const now = '2026-09-01T00:00:00.000Z'
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
  `).run('codex_pre118_fixture_sentinel', 'preserved', now)
  db.prepare(`
    INSERT INTO chat_conversations (
      id, agent, active_agent_id, title, created_at, updated_at,
      source_kind, source_id, thread_key, meta_json, user_id,
      handoff_generation, message_visibility_epoch
    ) VALUES (?, 'butler', 'butler', 'Pre-118 continuity fixture', ?, ?,
      'local', 'app', ?, '{}', 'default-user', 0, 0)
  `).run('pre118-scope', now, now, 'pre118-scope')
  db.prepare(`
    INSERT INTO codex_thread_bindings (
      thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
      runtime_manifest_digest, protocol_schema_digest, revision, created_at, updated_at
    ) VALUES ('pre118-thread-binding', 'pre118-scope', 1, 'pre118-scope',
      'legacy-runtime', 'legacy-protocol', 1, ?, ?)
  `).run(now, now)
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id,
      start_reservation_set_id, start_reservation_required_member_count,
      turn_start_reservation_member_id, turn_start_reservation_admitted_at,
      turn_request_id, origin_user_message_id, message_visibility_epoch,
      ingress_admitted_revision, ingress_admitted_digest, ingress_admitted_at,
      attempt_kind, tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json,
      effective_codex_model, effective_upstream_snapshot_ref,
      effective_upstream_snapshot_digest, additional_context_digest,
      turn_contract_digest, ingress_json,
      revision, created_at, updated_at
    ) VALUES (
      'pre118-run-e1', 'pre118-task-e1', 'pre118-thread-binding',
      'pre118-reservation-set', 1, 'pre118-turn-member', ?,
      'pre118-turn-request', 'pre118-user-message', 0,
      1, 'pre118-ingress-digest', ?,
      'user_ingress', 'pre118-tool-surface', 'pre118-authorization-digest',
      '{}', '{"maxIterations":8,"maxToolCalls":0,"maxParallelToolGroups":1}',
      'legacy-model', 'pre118-profile-ref', 'pre118-profile-digest',
      'pre118-additional-context-digest',
      'pre118-turn-contract', '{"prepared":{"preparationContract":"codex_product_run_e1"}}',
      1, ?, ?
    )
  `).run(now, now, now, now)
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id,
      start_reservation_set_id, start_reservation_required_member_count,
      turn_start_reservation_member_id, turn_start_reservation_admitted_at,
      turn_start_reservation_released_at, turn_start_reservation_release_reason,
      turn_request_id, origin_user_message_id, message_visibility_epoch,
      ingress_admitted_revision, ingress_admitted_digest, ingress_admitted_at,
      attempt_kind, tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json,
      effective_codex_model, effective_upstream_snapshot_ref,
      effective_upstream_snapshot_digest, additional_context_digest,
      turn_contract_digest, ingress_json,
      product_terminal_digest, product_closeout_at,
      revision, created_at, updated_at
    ) VALUES (
      'pre118-run-terminal', 'pre118-task-terminal', 'pre118-thread-binding',
      'pre118-terminal-set', 1, 'pre118-terminal-member', ?, ?,
      'pre118-terminal-complete', 'pre118-terminal-request',
      'pre118-terminal-message', 0,
      1, 'pre118-terminal-ingress-digest', ?,
      'user_ingress', 'pre118-tool-surface', 'pre118-authorization-digest',
      '{}', '{}', 'legacy-model', 'pre118-profile-ref', 'pre118-profile-digest',
      'pre118-additional-context-digest', 'pre118-terminal-contract',
      '{"prepared":{"preparationContract":"codex_product_run_e1"}}',
      ?, ?, 1, ?, ?
    )
  `).run(now, now, now, 'a'.repeat(64), now, now, now)
  const nowMs = Date.parse(now)
  db.prepare(`
    INSERT INTO run_meta (
      run_id, task_id, scope_id, status, created_at, updated_at,
      terminal_reason, provider_diagnostics_json, message_visibility_epoch
    ) VALUES (
      'pre118-run-terminal', 'pre118-task-terminal', 'pre118-scope',
      'error', ?, ?, 'blocked_external', '{}', 0
    )
  `).run(nowMs, nowMs)
  db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
    ) VALUES (
      'assistant:pre118-task-terminal:pre118-run-terminal:terminal',
      'pre118-scope', 'assistant', '旧版本失败记录', ?,
      '{"runId":"pre118-run-terminal"}', 0
    )
  `).run(now)
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id,
      start_reservation_set_id, start_reservation_required_member_count,
      turn_start_reservation_member_id, turn_start_reservation_admitted_at,
      turn_request_id, origin_user_message_id, message_visibility_epoch,
      ingress_admitted_revision, ingress_admitted_digest, ingress_admitted_at,
      attempt_kind, tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json,
      effective_codex_model, effective_upstream_snapshot_ref,
      effective_upstream_snapshot_digest, additional_context_digest,
      turn_contract_digest, ingress_json, revision, created_at, updated_at
    ) VALUES (
      'pre118-run-malformed', 'pre118-task-malformed', 'pre118-thread-binding',
      'pre118-malformed-set', 1, 'pre118-malformed-member', ?,
      'pre118-malformed-request', 'pre118-malformed-message', 0,
      1, 'pre118-malformed-ingress-digest', ?,
      'user_ingress', 'pre118-tool-surface', 'pre118-authorization-digest',
      '{}', '{}', 'legacy-model', 'pre118-profile-ref', 'pre118-profile-digest',
      'pre118-additional-context-digest', 'pre118-malformed-contract',
      '{malformed', 1, ?, ?
    )
  `).run(now, now, now, now)
  db.prepare(`
    INSERT INTO codex_thread_dispatch_fences (
      thread_binding_id, owner_main_boot_id, operation_kind,
      owner_ready_run_id, acquired_at, revision
    ) VALUES (
      'pre118-thread-binding', 'pre118-main-boot', 'product_turn',
      'pre118-run-e1', ?, 1
    )
  `).run(now)
  db.prepare(`
    INSERT INTO chat_messages (
      id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
    ) VALUES (
      'pre118-ambiguous-card', 'pre118-scope', 'agent_card', '等待回答', ?,
      '{"askUserQuestions":{"version":1,"cardId":"pre118-ambiguous-card","requestId":"pre118-run-e1","status":"pending","questions":[]}}',
      0
    )
  `).run(now)
  process.stdout.write(`${outputPath}\n`)
} finally {
  db.close()
}
