import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { captureCodexBoundaryContext, codexBeginNewContextOperationId } from '../main/modules/agent-control/codex-runtime/codex-context-boundary'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { createCodexProductionPorts } from './helpers/codex-production-composition-harness'
import { parseBeginNewContextResult } from '../shared/ipc-contracts/agent-runtime'

const at = '2026-09-04T00:00:00.000Z'
const historicalSchema = readFileSync(new URL('./fixtures/ready-pre118-schema.sql', import.meta.url), 'utf8')

test('production recovery replays after restart without clearing new context or returning an old current head', async (t) => {
  if (skipIfSqliteUnavailable(t, 'committed boundary production replay')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(historicalSchema)
  runMigrations(db as unknown as MigrationDatabase)
  db.prepare(`INSERT INTO chat_conversations (id, agent, created_at, updated_at)
    VALUES ('replay-scope', 'butler', ?, ?)`).run(at, at)
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection, {
    runtimeManifestDigest: 'current', protocolSchemaDigest: 'current',
  })
  repository.createEmptyAliasGeneration({ threadBindingId: 'replay-source', aliasId: 'replay-scope',
    aliasGeneration: 1, readyScopeId: 'replay-scope', runtimeManifestDigest: 'old', protocolSchemaDigest: 'old', createdAt: at })
  db.prepare(`UPDATE codex_thread_bindings SET retired_at = ?, retired_reason = 'publication_diverged',
    retirement_evidence_digest = ?, revision = revision + 1 WHERE thread_binding_id = 'replay-source'`)
    .run(at, digestCanonicalJson('retirement'))
  // __breaksInvariants: run the actual production closures without a sidecar;
  // only external invalidation and in-memory hint clearing are captured.
  const cleared: string[] = [], invalidated: unknown[] = []
  const boot = () => createCodexProductionPorts({ repository, gate: { assertOpen() {} },
    verified: { manifestDigest: 'current', manifest: { stableV2SchemaSha256: 'current' } },
    clearLastReferenceSkill: (id: string) => cleared.push(id),
    input: { onCodexActionSurfaceInvalidated: (event: unknown) => invalidated.push(event) },
  })
  const firstBoot = await boot()
  const actionRef = firstBoot.readActionSurface({ aliasId: 'replay-scope', aliasGeneration: 1 }).beginNewContext!
  assert.ok(actionRef)
  const first = firstBoot.aliasBindingPort.beginNewContext({ actionRef })
  assert.equal(first.aliasGeneration, 2)
  assert.deepEqual(cleared, ['replay-scope'])
  assert.equal(invalidated.length, 1)
  db.prepare(`UPDATE chat_conversations SET meta_json = ? WHERE id = 'replay-scope'`)
    .run(JSON.stringify({ lastReferenceSkill: { id: 'new-skill' } }))
  assert.equal(repository.refreshPristineFreshStartHeadAtomic({ aliasId: 'replay-scope',
    runtimeManifestDigest: 'next', protocolSchemaDigest: 'next', createdAt: at }).kind, 'refreshed')
  const restarted = await boot()
  const before = db.prepare('SELECT * FROM codex_thread_bindings').all()
  const replay = restarted.aliasBindingPort.beginNewContext({ actionRef })
  assert.deepEqual(replay.boundary, first.boundary)
  assert.equal(replay.aliasGeneration, 3)
  assert.equal(replay.actionSurfaceInvalidation.aliasGeneration, 3)
  assert.deepEqual(parseBeginNewContextResult(replay), replay)
  assert.throws(() => parseBeginNewContextResult({ ...replay, aliasGeneration: 2 }), /begin_new_context_result_inconsistent/)
  assert.deepEqual(db.prepare('SELECT * FROM codex_thread_bindings').all(), before)
  assert.deepEqual(cleared, ['replay-scope'])
  assert.equal(invalidated.length, 1)
  assert.equal(JSON.parse(db.prepare(`SELECT meta_json FROM chat_conversations WHERE id = 'replay-scope'`)
    .get<{ meta_json: string }>()!.meta_json).lastReferenceSkill.id, 'new-skill')
  for (const patch of [{ sourceRevision: 999 }, { candidateEvidenceDigest: 'f'.repeat(64) }]) {
    const { digest: _, ...forged } = { ...actionRef, ...patch }
    assert.throws(() => restarted.aliasBindingPort.beginNewContext({
      actionRef: { ...forged, digest: digestCanonicalJson(forged) },
    }), /begin_new_context_action_ref_invalid/)
  }
  const { digest: _, ...unissued } = { ...actionRef, draftRevision: 123 }
  unissued.operationId = codexBeginNewContextOperationId(unissued)
  assert.throws(() => restarted.aliasBindingPort.beginNewContext({
    actionRef: { ...unissued, digest: digestCanonicalJson(unissued) },
  }), /begin_new_context_action_ref_unissued/)
  db.prepare(`UPDATE chat_conversations SET message_visibility_epoch = 1 WHERE id = 'replay-scope'`).run()
  assert.throws(() => restarted.aliasBindingPort.beginNewContext({ actionRef }), /begin_new_context_scope_stale/)
})

test('begin-new-context keeps visible history and commits one immutable boundary and head', (t) => {
  if (skipIfSqliteUnavailable(t, 'history continuation boundary')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(historicalSchema)
  runMigrations(db as unknown as MigrationDatabase)
  db.prepare(`INSERT INTO chat_conversations
    (id, agent, created_at, updated_at, meta_json)
    VALUES ('scope-boundary', 'butler', ?, ?, ?)`)
    .run(at, at, JSON.stringify({
      lastReferenceSkill: { id: 'old-skill' },
      sessionRecallContext: [{ conversationId: 'old-scope' }],
      retained: 'yes',
    }))
  db.prepare(`INSERT INTO chat_messages
    (id, conversation_id, role, content, timestamp, message_visibility_epoch)
    VALUES ('old-message', 'scope-boundary', 'user', 'Visible old history', ?, 0)`).run(at)
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection, {
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
  })
  repository.createEmptyAliasGeneration({
    threadBindingId: 'source-binding',
    aliasId: 'scope-boundary',
    aliasGeneration: 1,
    readyScopeId: 'scope-boundary',
    runtimeManifestDigest: 'runtime-old',
    protocolSchemaDigest: 'protocol-old',
    createdAt: at,
  })
  const retiredEvidence = digestCanonicalJson({ retired: 'source-binding' })
  db.prepare(`UPDATE codex_thread_bindings
    SET retired_at = ?, retired_reason = 'publication_diverged',
        retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
    WHERE thread_binding_id = 'source-binding'`).run(at, retiredEvidence, at)

  const historyOnly = repository.readHistoryOnlyScope('scope-boundary')
  assert.ok(historyOnly)
  const actionRef = repository.buildBeginNewContextActionRef({
    scopeId: 'scope-boundary',
    scopeEpoch: 0,
    candidateEvidenceDigest: historyOnly.evidenceDigest,
    consequenceDigest: digestCanonicalJson(null),
    draftRevision: 7,
  })
  const unissuedRef = repository.buildBeginNewContextActionRef({
    scopeId: 'scope-boundary',
    scopeEpoch: 0,
    candidateEvidenceDigest: 'f'.repeat(64),
    consequenceDigest: digestCanonicalJson(null),
    draftRevision: 7,
  })
  assert.throws(() => repository.beginNewContext({
    actionRef: unissuedRef,
    issuedActionRef: actionRef,
    assertRecoveryEligible: () => undefined,
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
    committedAt: '2026-09-03T23:59:59.000Z',
  }), /begin_new_context_action_ref_unissued/)
  assert.throws(() => repository.beginNewContext({
    actionRef,
    issuedActionRef: actionRef,
    assertRecoveryEligible: () => {
      throw new Error('recovery_no_longer_eligible')
    },
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
    committedAt: '2026-09-04T00:00:00.000Z',
  }), /recovery_no_longer_eligible/)
  assert.equal(repository.readActiveAliasBinding('scope-boundary'), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM codex_conversation_context_boundaries')
    .get<{ count: number }>()?.count, 0)
  const first = repository.beginNewContext({
    actionRef,
    issuedActionRef: actionRef,
    assertRecoveryEligible: () => undefined,
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
    committedAt: '2026-09-04T00:00:01.000Z',
  })
  const repeated = repository.beginNewContext({
    actionRef,
    issuedActionRef: actionRef,
    assertRecoveryEligible: () => undefined,
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
    committedAt: '2026-09-04T00:00:02.000Z',
  })
  assert.throws(() => repository.beginNewContext({
    actionRef: { ...actionRef, draftRevision: 8 },
    issuedActionRef: actionRef,
    assertRecoveryEligible: () => undefined,
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
    committedAt: '2026-09-04T00:00:03.000Z',
  }), /begin_new_context_action_ref_invalid/)

  assert.deepEqual(repeated.boundary, first.boundary)
  assert.equal(repository.readActiveAliasBinding('scope-boundary')?.aliasGeneration, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM codex_conversation_context_boundaries')
    .get<{ count: number }>()?.count, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?')
    .get<{ count: number }>('old-message')?.count, 1)
  assert.equal(db.prepare('SELECT message_visibility_epoch FROM chat_conversations WHERE id = ?')
    .get<{ message_visibility_epoch: number }>('scope-boundary')?.message_visibility_epoch, 0)
  const meta = JSON.parse(db.prepare('SELECT meta_json FROM chat_conversations WHERE id = ?')
    .get<{ meta_json: string }>('scope-boundary')!.meta_json) as Record<string, unknown>
  assert.deepEqual(meta, { retained: 'yes' })
  assert.equal(first.boundary.previousVisibleMessageAnchor, 'old-message')
  const restarted = new CodexBindingRepository(db as unknown as DatabaseConnection, {
    runtimeManifestDigest: 'runtime-current',
    protocolSchemaDigest: 'protocol-current',
  })
  assert.deepEqual(restarted.readContextBoundaries({
    scopeId: 'scope-boundary', scopeEpoch: 0,
  }), [first.boundary])
  assert.throws(() => db.prepare(`UPDATE codex_conversation_context_boundaries
    SET committed_at = ? WHERE operation_id = ?`).run(at, actionRef.operationId),
  /codex_context_boundary_immutable/)

  const refreshed = restarted.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-boundary', runtimeManifestDigest: 'runtime-next',
    protocolSchemaDigest: 'protocol-next', createdAt: '2026-09-05T00:00:00.000Z',
  })
  assert.equal(refreshed.kind, 'refreshed', 'preserved visible history is not input to the empty new context')
  assert.equal(restarted.readActiveAliasBinding('scope-boundary')?.aliasGeneration, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get<{ count: number }>()?.count, 1)
  assert.deepEqual(restarted.readContextBoundaries({ scopeId: 'scope-boundary', scopeEpoch: 0 }), [first.boundary])
  assert.deepEqual(captureCodexBoundaryContext(db as unknown as DatabaseConnection, 'scope-boundary', 0).messages, [],
    'later boundaries do not duplicate already preserved message identities')
  db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, message_visibility_epoch)
    VALUES ('new-backdated-message', 'scope-boundary', 'user', 'New input', ?, 0)`).run(at)
  assert.deepEqual(restarted.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-boundary', runtimeManifestDigest: 'runtime-after-next',
    protocolSchemaDigest: 'protocol-after-next', createdAt: '2026-09-05T00:01:00.000Z',
  }), { kind: 'reset_required' }, 'new rows cannot be hidden by an old or backdated timestamp')
  assert.deepEqual(captureCodexBoundaryContext(db as unknown as DatabaseConnection, 'scope-boundary', 0).messages, ['new-backdated-message'])
  // __breaksInvariants: corrupt the private snapshot after dropping only its
  // immutability trigger; production must detect its mismatch with the receipt.
  db.exec('DROP TRIGGER codex_context_boundary_immutable_update')
  db.prepare(`UPDATE codex_conversation_context_boundaries
    SET preserved_context_json = json_set(preserved_context_json, '$.messages[1]', 'new-backdated-message')`).run()
  assert.throws(() => restarted.refreshPristineFreshStartHeadAtomic({
    aliasId: 'scope-boundary', runtimeManifestDigest: 'runtime-after-next',
    protocolSchemaDigest: 'protocol-after-next', createdAt: '2026-09-05T00:01:00.000Z',
  }), /context_boundary_receipt_invalid/)
})
