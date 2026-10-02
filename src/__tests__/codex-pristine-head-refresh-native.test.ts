import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CODEX_PRISTINE_CONTRACT_REFRESH_GUARDS_SQL } from '../main/modules/agent-control/codex-runtime/codex-binding-schema'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { createCodexProductionPorts } from './helpers/codex-production-composition-harness'

// The extracted production closure executes against the real repository and projectors.
// It does not initialize the sidecar or claim installed-app/IPC delivery coverage.
export const __breaksInvariants = [
  'codex.production-composition-startup-replaced-by-exact-action-surface-closure',
  'codex.scope-history-seeded-with-valid-current-epoch-product-rows',
] as const

const at = '2026-09-03T00:00:00.000Z'
const currentContract = { runtimeManifestDigest: 'runtime-v2', protocolSchemaDigest: 'protocol-v2' }
const historicalSchema = readFileSync(new URL('./fixtures/ready-pre118-schema.sql', import.meta.url), 'utf8')

function productionBootRefresh(repository: CodexBindingRepository, publish: (aliasId: string, candidate: unknown) => void) {
  // allow-source-grep: Execute the exact boot refresh loop with real database owners; no source-string assertions or sidecar replacement behavior is counted as boot coverage.
  const source = readFileSync(new URL('../main/modules/agent-control/codex-runtime/codex-runtime-production-composition.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('production.ts', source, ts.ScriptTarget.Latest, true)
  let loop: ts.ForOfStatement | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && ts.isCallExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === 'readDriftedFreshStartAliases') loop = node
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (!loop) throw new Error('production_boot_refresh_loop_missing')
  const compiled = ts.transpileModule(loop.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  return () => Function('repository', 'verified', 'restartSweepAt', 'publishCodexActionSurfaceInvalidation', compiled)(
    repository,
    { manifestDigest: currentContract.runtimeManifestDigest,
      manifest: { stableV2SchemaSha256: currentContract.protocolSchemaDigest } },
    at, publish,
  )
}

function fixture(t: Parameters<typeof skipIfSqliteUnavailable>[0], kind: 'fresh_start' | 'legacy' = 'fresh_start') {
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  db.exec(historicalSchema)
  runMigrations(db as unknown as MigrationDatabase)
  db.prepare(`INSERT INTO chat_conversations (id, agent, created_at, updated_at)
    VALUES ('scope-pristine', 'butler', ?, ?)`).run(at, at)
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection, currentContract)
  if (kind === 'legacy') {
    db.prepare(`INSERT INTO codex_thread_bindings
      (thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
       runtime_manifest_digest, protocol_schema_digest, revision, created_at, updated_at)
      VALUES ('old-head', 'scope-pristine', 1, 'scope-pristine', 'runtime-v1', 'protocol-v1', 1, ?, ?)`)
      .run(at, at)
  } else repository.createEmptyAliasGeneration({
    threadBindingId: 'old-head', aliasId: 'scope-pristine', aliasGeneration: 1,
    readyScopeId: 'scope-pristine', runtimeManifestDigest: 'runtime-v1',
    protocolSchemaDigest: 'protocol-v1', createdAt: at,
  })
  return { db, repository }
}

test('action-surface projection is a pure read and leaves pristine refresh to its write owners', (t) => {
  if (skipIfSqliteUnavailable(t, 'pristine head refresh')) return
  const state = fixture(t)
  if (!state) return
  const { db, repository } = state
  t.after(() => db.close())
  const before = digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all())
  const head = projectCodexHeadActionProjection(repository.readHeadActionFacts({
    aliasId: 'scope-pristine',
    aliasGeneration: 1,
    currentRuntimeManifestDigest: currentContract.runtimeManifestDigest,
    currentProtocolSchemaDigest: currentContract.protocolSchemaDigest,
  }))
  assert.equal(head.actions.send_new_message.availability, 'blocked')
  assert.deepEqual(head.actions.send_new_message.blockers, ['head_contract_drift'])
  assert.equal(head.actionHeadIdentity?.aliasGeneration, 1)
  assert.equal(digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all()), before)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM codex_turn_bindings').get<{ count: number }>()?.count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get<{ count: number }>()?.count, 0)
})

test('ingress pristine refresh preserves the epoch and advances the named action identity exactly once', (t) => {
  if (skipIfSqliteUnavailable(t, 'pristine head refresh')) return
  const state = fixture(t)
  if (!state) return
  const { db, repository } = state
  t.after(() => db.close())
  const refresh = () => repository.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-pristine', ...currentContract, createdAt: at,
  })
  const result = refresh()
  assert.equal(result.kind, 'refreshed')
  if (result.kind !== 'refreshed') throw new Error('pristine_refresh_missing')
  assert.equal(result.binding.aliasGeneration, 2)
  const repeated = refresh()
  assert.equal(repeated.kind, 'current')
  if (repeated.kind !== 'current') throw new Error('pristine_refresh_not_idempotent')
  assert.equal(repeated.binding.threadBindingId, result.binding.threadBindingId)
  assert.deepEqual(db.prepare(`SELECT alias_generation, retired_reason, action_projection_sequence
    FROM codex_thread_bindings ORDER BY alias_generation`).all(), [
    { alias_generation: 1, retired_reason: 'pristine_contract_refresh', action_projection_sequence: 1 },
    { alias_generation: 2, retired_reason: null, action_projection_sequence: 1 },
  ])
  assert.equal(db.prepare('SELECT message_visibility_epoch FROM chat_conversations')
    .get<{ message_visibility_epoch: number }>()?.message_visibility_epoch, 0)
})

for (const role of ['user', 'assistant']) {
  test(`current-epoch ${role} content without a Codex turn disqualifies pristine refresh`, (t) => {
    if (skipIfSqliteUnavailable(t, 'pristine head refresh')) return
    const state = fixture(t)
    if (!state) return
    const { db, repository } = state
    t.after(() => db.close())
    db.prepare(`INSERT INTO chat_messages
      (id, conversation_id, role, content, timestamp, message_visibility_epoch)
      VALUES ('prior-content', 'scope-pristine', ?, 'Prior product content', ?, 0)`).run(role, at)
    const before = db.prepare('SELECT * FROM codex_thread_bindings').all()
    const resolved = repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-pristine', ...currentContract, createdAt: at,
    })
    assert.equal(digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all()),
      digestCanonicalJson(before), 'non-pristine refresh must perform zero head writes')
    assert.deepEqual(resolved, { kind: 'reset_required' })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get<{ count: number }>()?.count, 1)
    assert.equal(repository.readActiveAliasBinding('scope-pristine')?.aliasGeneration, 1)
  })
}

test('pristine refresh rolls back retirement when successor insertion fails', (t) => {
  if (skipIfSqliteUnavailable(t, 'pristine head refresh')) return
  const state = fixture(t)
  if (!state) return
  const { db, repository } = state
  t.after(() => db.close())
  db.exec(`CREATE TRIGGER reject_refresh_successor BEFORE INSERT ON codex_thread_bindings
    WHEN NEW.alias_generation = 2 BEGIN SELECT RAISE(ABORT, 'test_successor_insert_failed'); END`)
  const before = digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all())
  assert.throws(() => repository.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-pristine', ...currentContract, createdAt: at,
  }), /test_successor_insert_failed/)
  assert.equal(digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all()), before)
  assert.equal(db.inTransaction, false)
})

for (const kind of ['fresh_start', 'legacy'] as const) for (const withContent of [false, true]) {
  test(`production boot refresh loop ${kind} ${withContent ? 'leaves non-pristine content untouched' : 'refreshes before ingress exactly once'}`, (t) => {
    if (skipIfSqliteUnavailable(t, 'pristine head refresh')) return
    const state = fixture(t, kind)
    if (!state) return
    const { db, repository } = state
    t.after(() => db.close())
    if (withContent) db.prepare(`INSERT INTO chat_messages
      (id, conversation_id, role, content, timestamp, message_visibility_epoch)
      VALUES ('prior-content', 'scope-pristine', 'user', 'Prior content', ?, 0)`).run(at)
    const before = digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all())
    const events: unknown[] = []
    const run = productionBootRefresh(repository, (aliasId, candidate) => {
      assert.equal(db.inTransaction, false)
      events.push({ aliasId, candidate })
    })
    run()
    run()
    assert.equal(repository.readActiveAliasBinding('scope-pristine')?.aliasGeneration, withContent ? 1 : 2)
    assert.equal(events.length, withContent ? 0 : 1)
    if (withContent) assert.equal(digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all()), before)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM codex_turn_bindings').get<{ count: number }>()?.count, 0)
  })
}

test('migration 122 replaces the installed legacy-excluding guard without rewriting old bindings', (t) => {
  if (skipIfSqliteUnavailable(t, 'legacy pristine guard upgrade')) return
  const { db, repository } = fixture(t, 'legacy')
  t.after(() => db.close())
  db.exec(`DROP TRIGGER codex_pristine_contract_refresh_update;
    ${CODEX_PRISTINE_CONTRACT_REFRESH_GUARDS_SQL.replace("IN ('legacy', 'fresh_start')", "= 'fresh_start'")}`)
  db.prepare('DELETE FROM migrations WHERE name = ?').run('122_codex_pristine_legacy_root_refresh')
  const before = db.prepare('SELECT * FROM codex_thread_bindings').all()
  assert.throws(() => repository.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-pristine', ...currentContract, createdAt: at,
  }), /codex_pristine_contract_refresh_not_pristine/)
  // Model the pre-122 installed boundary table, not only the old guard text.
  db.exec(`DROP TRIGGER codex_pristine_contract_refresh_update;
    ALTER TABLE codex_conversation_context_boundaries DROP COLUMN preserved_context_json;`)
  runMigrations(db as unknown as MigrationDatabase)
  assert.ok(db.prepare('PRAGMA table_info(codex_conversation_context_boundaries)').all<{ name: string }>()
    .some((column) => column.name === 'preserved_context_json'))
  assert.deepEqual(db.prepare('SELECT * FROM codex_thread_bindings').all(), before)
  assert.equal(repository.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-pristine', ...currentContract, createdAt: at,
  }).kind, 'refreshed')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})

for (const terminalWithoutNative of [false, true]) {
  test(`production read offers explicit context for a blocked settled root (prior terminal=${terminalWithoutNative})`, async (t) => {
    if (skipIfSqliteUnavailable(t, 'settled no-native recovery surface')) return
    const { db, repository } = fixture(t, 'legacy')
    t.after(() => db.close())
    const identity = { aliasId: 'scope-pristine', aliasGeneration: 1, workbenchMode: 'browser' as const }
    const read = repository.readLifecycleOperation(identity)
    // __breaksInvariants: inject the lifecycle observations only; this tests
    // production issuance/revalidation, not how a failed native start settles.
    // The populated installed test exercises that real failed-start history.
    const facts = { ...read.facts, readyRunCreated: terminalWithoutNative,
      readyTerminalWithoutNativeThread: terminalWithoutNative, allNativeThreadAttemptsSettled: true }
    t.mock.method(repository, 'readLifecycleOperation', () => ({ ...read, facts }))
    let revalidate: (() => string | null) | undefined
    const ports = await createCodexProductionPorts({
      repository, resolveHeadContinuation: () => null,
      verified: { manifestDigest: currentContract.runtimeManifestDigest,
        manifest: { stableV2SchemaSha256: currentContract.protocolSchemaDigest } },
      issueBeginNewContextAction: (input: Parameters<typeof repository.buildBeginNewContextActionRef>[0], current: () => string | null) => {
        revalidate = current
        return repository.buildBeginNewContextActionRef(input)
      },
    })
    const before = db.prepare('SELECT * FROM codex_thread_bindings').all()
    const surface = ports.readActionSurface(identity)
    assert.equal(surface.state, 'active_head')
    assert.ok(surface.beginNewContext, 'settled roots cannot be omitted just because there is no native continuation contract')
    assert.equal(revalidate?.(), surface.beginNewContext.candidateEvidenceDigest)
    assert.deepEqual(db.prepare('SELECT * FROM codex_thread_bindings').all(), before, 'issuance is read-only')
    facts.threadStartUnreconciled = true
    facts.allNativeThreadAttemptsSettled = false
    assert.equal(revalidate?.(), null, 'a new or unknown start invalidates the old recovery action')
  })
}

const occupiedScopeRows = {
  run: `INSERT INTO run_meta (run_id, scope_id, status, created_at, updated_at, message_visibility_epoch)
    VALUES ('foreign-run', 'scope-pristine', 'completed', 1, 1, 0)`,
  task: `INSERT INTO task_projections
    (task_id, scope_id, run_id, task_type, module, status, interaction_state, steps_json, created_at, updated_at, message_visibility_epoch)
    VALUES ('foreign-task', 'scope-pristine', 'foreign-run', 'agent', 'agent', 'completed', 'idle', '[]', '${at}', '${at}', 0)`,
  interaction: `INSERT INTO pending_confirmations
    (id, scope_id, tool_name, params_json, created_at, expires_at)
    VALUES ('foreign-confirmation', 'scope-pristine', 'test_action', '{}', '${at}', '2027-01-01T00:00:00Z')`,
  answeredCard: `INSERT INTO chat_messages
    (id, conversation_id, role, content, timestamp, message_visibility_epoch, meta_json)
    VALUES ('answered-card', 'scope-pristine', 'agent_card', 'Answered question', '${at}', 0,
      '{"askUserQuestions":{"status":"answered","answers":["Yes"]}}')`,
  settledOrphanInteraction: `INSERT INTO pending_confirmations
    (id, scope_id, tool_name, params_json, created_at, expires_at, status, released_at)
    VALUES ('settled-orphan', 'scope-pristine', 'test_action', '{}', '${at}', '${at}', 'released', '${at}')`,
}

for (const [kind, statement] of Object.entries(occupiedScopeRows)) {
  test(`current scope ${kind} without a Codex turn blocks both refresh owner and direct named retirement`, (t) => {
    if (skipIfSqliteUnavailable(t, 'pristine head refresh')) return
    const state = fixture(t)
    if (!state) return
    const { db, repository } = state
    t.after(() => db.close())
    db.exec(statement)
    const before = digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all())
    assert.deepEqual(repository.refreshPristineFreshStartHeadAtomic({
      aliasId: 'scope-pristine', ...currentContract, createdAt: at,
    }), { kind: 'reset_required' })
    assert.throws(() => db.prepare(`UPDATE codex_thread_bindings
      SET retired_at = ?, retired_reason = 'pristine_contract_refresh', retirement_evidence_digest = 'attempt',
          action_projection_sequence = action_projection_sequence + 1, revision = revision + 1
      WHERE thread_binding_id = 'old-head'`).run(at), /codex_pristine_contract_refresh_not_pristine/)
    assert.equal(digestCanonicalJson(db.prepare('SELECT * FROM codex_thread_bindings').all()), before)
  })
}
