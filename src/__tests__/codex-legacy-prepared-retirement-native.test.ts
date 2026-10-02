import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyLifecycleOperation } from '../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { DatabaseConnection } from '../main/modules/database/connection'
import {
  __getMigrationNamesForTests,
  __runMigrationForTests,
  type MigrationDatabase,
} from '../main/modules/migrations'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

const at = '2026-09-02T00:00:00.000Z'

function insertLegacyHead(
  db: InstanceType<ReturnType<typeof loadSqliteAfterGuardForTest>>,
  preparationContract = 'codex_product_run_e1',
): void {
  db.prepare(`
    INSERT INTO chat_conversations (
      id, agent, active_agent_id, title, created_at, updated_at,
      source_kind, source_id, thread_key, meta_json, user_id,
      handoff_generation, message_visibility_epoch
    ) VALUES ('legacy-scope', 'butler', 'butler', 'Legacy', ?, ?,
      'local', 'app', 'legacy-scope', '{}', 'default-user', 0, 0)
  `).run(at, at)
  db.prepare(`
    INSERT INTO codex_thread_bindings (
      thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
      runtime_manifest_digest, protocol_schema_digest, revision, created_at, updated_at
    ) VALUES ('legacy-binding', 'legacy-scope', 1, 'legacy-scope',
      'legacy-runtime', 'legacy-protocol', 1, ?, ?)
  `).run(at, at)
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
      'legacy-run', 'legacy-task', 'legacy-binding',
      'legacy-set', 1, 'legacy-member', ?,
      'legacy-request', 'legacy-message', 0,
      1, 'legacy-ingress', ?, 'user_ingress', 'legacy-tools', 'legacy-auth',
      '{}', '{}', 'legacy-model', 'legacy-profile', 'legacy-profile-digest',
      'legacy-context', 'legacy-contract',
      ?,
      1, ?, ?
    )
  `).run(
    at,
    at,
    JSON.stringify({ prepared: { preparationContract } }),
    at,
    at,
  )
  db.prepare(`
    INSERT INTO codex_thread_dispatch_fences (
      thread_binding_id, owner_main_boot_id, operation_kind,
      owner_ready_run_id, acquired_at, revision
    ) VALUES ('legacy-binding', 'old-main', 'product_turn', 'legacy-run', ?, 1)
  `).run(at)
}

function openDatabase(t: test.TestContext, preparationContract?: string) {
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec('PRAGMA foreign_keys = ON')
  for (const name of __getMigrationNamesForTests()) {
    __runMigrationForTests(name, db as unknown as MigrationDatabase)
  }
  insertLegacyHead(db, preparationContract)
  return { db, repository: new CodexBindingRepository(db as unknown as DatabaseConnection) }
}

test('legacy e1 fence is retired atomically before a reset successor becomes active', (t) => {
  if (skipIfSqliteUnavailable(t, 'legacy prepared retirement')) return
  const opened = openDatabase(t)
  const before = opened.repository.readLifecycleOperation({
    aliasId: 'legacy-scope',
    aliasGeneration: 1,
  })
  assert.equal(before.hasLegacyPreparedRun, true)
  assert.equal(classifyLifecycleOperation(before.facts), 'invariant_violation')

  const result = opened.repository.retireLegacyPreparedAlias({
    aliasId: 'legacy-scope',
    expectedGeneration: 1,
    action: 'reset',
    retirementEvidenceDigest: 'legacy-reset-evidence',
    retiredAt: at,
    currentRuntimeManifestDigest: 'current-runtime',
    currentProtocolSchemaDigest: 'current-protocol',
  })
  assert.equal(result.newGeneration, 2)
  const successor = opened.repository.readActiveAliasBinding('legacy-scope')
  assert.equal(successor?.aliasGeneration, 2)
  assert.deepEqual(opened.db.prepare(`
    SELECT runtime_manifest_digest, protocol_schema_digest
      FROM codex_thread_bindings
     WHERE ready_conversation_alias = 'legacy-scope' AND alias_generation = 2
  `).get(), {
    runtime_manifest_digest: 'current-runtime',
    protocol_schema_digest: 'current-protocol',
  })
  assert.equal(opened.db.prepare(`
    SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
     WHERE thread_binding_id = 'legacy-binding'
  `).get<{ count: number }>()?.count, 0)
  assert.deepEqual(opened.db.prepare(`
    SELECT turn_start_reservation_release_reason, effect_authority_closed_at
      FROM codex_turn_bindings WHERE ready_run_id = 'legacy-run'
  `).get(), {
    turn_start_reservation_release_reason: 'legacy_prepared_contract_reset',
    effect_authority_closed_at: at,
  })
  assert.equal(opened.db.prepare(`
    SELECT message_visibility_epoch FROM chat_conversations WHERE id = 'legacy-scope'
  `).get<{ message_visibility_epoch: number }>()?.message_visibility_epoch, 1)
})

test('legacy prepared retirement refuses to swallow a current e2 run', (t) => {
  if (skipIfSqliteUnavailable(t, 'legacy prepared e2 rejection')) return
  const opened = openDatabase(t, 'codex_product_run_e2')
  assert.throws(() => opened.repository.retireLegacyPreparedAlias({
    aliasId: 'legacy-scope',
    expectedGeneration: 1,
    action: 'reset',
    retirementEvidenceDigest: 'must-not-retire-e2',
    retiredAt: at,
    currentRuntimeManifestDigest: 'current-runtime',
    currentProtocolSchemaDigest: 'current-protocol',
  }), /legacy_prepared_contract_missing/)
  assert.equal(opened.repository.readActiveAliasBinding('legacy-scope')?.aliasGeneration, 1)
})
