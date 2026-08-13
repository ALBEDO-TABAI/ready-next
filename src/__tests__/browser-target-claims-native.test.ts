import assert from 'node:assert/strict'
import test from 'node:test'

import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { applyBrowserTargetClaimVisibilityEpochMigration } from '../main/modules/agent-control/codex-runtime/codex-thread-retirement-cleanup-migration'
import {
  BrowserTargetClaimRepository,
  BrowserTargetClaimService,
} from '../main/modules/browser-engine/browser-target-claims'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 087 upgrades a pending target fence, is idempotent, and passes quick_check', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 087 target claims')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        human_takeover_ref_json TEXT,
        checkpoint_refs_json TEXT
      );
      INSERT INTO task_projections VALUES (
        'parent-1',
        'scope-1',
        '{"state":"pending","ownerRunId":"run-1","browserTaskId":"browser-1","physicalTarget":{"surface":"user-view","profileId":"Work","sessionId":null,"tabId":"tab-1"}}',
        '{"suspensionCheckpointId":"checkpoint-1"}'
      );
    `)
    __runMigrationForTests('087_browser_target_claims', db as unknown as MigrationDatabase)
    __runMigrationForTests('087_browser_target_claims', db as unknown as MigrationDatabase)

    const row = db.prepare(`
      SELECT partition, tab_id, state, parent_task_id, browser_task_id,
             owner_run_id, suspension_checkpoint_id
        FROM browser_target_claims
    `).get() as Record<string, unknown>
    assert.deepEqual(row, {
      partition: 'persist:browser-profile-work',
      tab_id: 'tab-1',
      state: 'user_owned',
      parent_task_id: 'parent-1',
      browser_task_id: 'browser-1',
      owner_run_id: 'run-1',
      suspension_checkpoint_id: 'checkpoint-1',
    })
    const claimColumns = db.prepare('PRAGMA table_info(browser_target_claims)').all<{ name: string }>()
    assert.ok(claimColumns.some((column) => column.name === 'message_visibility_epoch'))
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM browser_target_claims').get<{ count: number }>()?.count, 1)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('migration 108 upgrades an existing durable claim with its exact scope epoch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 108 target claim visibility epoch')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        message_visibility_epoch INTEGER NOT NULL,
        closed_at TEXT
      );
      CREATE TABLE browser_target_claims (
        claim_id TEXT PRIMARY KEY,
        scope_id TEXT,
        session_id TEXT
      );
      INSERT INTO chat_conversations VALUES ('scope-upgrade', 7, NULL);
      INSERT INTO browser_target_claims VALUES ('claim-upgrade', 'scope-upgrade', NULL);
    `)

    applyBrowserTargetClaimVisibilityEpochMigration(db as never)
    applyBrowserTargetClaimVisibilityEpochMigration(db as never)

    assert.deepEqual(db.prepare(`
      SELECT claim_id, message_visibility_epoch
        FROM browser_target_claims
    `).get(), {
      claim_id: 'claim-upgrade',
      message_visibility_epoch: 7,
    })
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('SQLite target-claim CAS preserves one writer and rejects stale generations', async (t) => {
  if (skipIfSqliteUnavailable(t, 'target claim CAS')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE task_projections (task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, human_takeover_ref_json TEXT, checkpoint_refs_json TEXT);
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, message_visibility_epoch INTEGER NOT NULL, closed_at TEXT);
      INSERT INTO chat_conversations VALUES ('scope-1', 0, NULL);
    `)
    __runMigrationForTests('087_browser_target_claims', db as unknown as MigrationDatabase)
    const accessor = { getRawDb: () => db }
    const first = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
    const second = new BrowserTargetClaimService(new BrowserTargetClaimRepository(accessor))
    const base = {
      partition: 'persist:browser',
      tabId: 'tab-1',
      physicalTargetToken: 'boot-1:tab-1:1',
      bootIncarnationId: 'boot-1',
      profileId: null,
      surface: 'user-view' as const,
      parentTaskId: 'parent-1',
      browserTaskId: 'browser-1',
      scopeId: 'scope-1',
      sessionId: null,
      messageVisibilityEpoch: 0,
    }
    const a = first.acquire({ ...base, ownerRunId: 'run-a' })
    assert.equal('ok' in a && a.ok === false, false)
    const b = second.acquire({ ...base, ownerRunId: 'run-b' })
    assert.equal('ok' in b && b.ok === false ? b.errorCode : null, 'lease_held')
    if ('ok' in a && a.ok === false) return
    const oldIdentity = {
      ...base,
      claimId: a.claimId,
      generation: a.generation,
      ownerRunId: a.ownerRunId,
    }
    first.closeTarget(a.logicalKey)
    assert.equal(second.checkWrite(oldIdentity)?.errorCode, 'lease_required')
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('startup expires target claims persisted by an older Browser boot', async (t) => {
  if (skipIfSqliteUnavailable(t, 'target claim boot expiry')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE task_projections (task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, human_takeover_ref_json TEXT, checkpoint_refs_json TEXT);
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, message_visibility_epoch INTEGER NOT NULL, closed_at TEXT);
      INSERT INTO chat_conversations VALUES ('scope-old', 0, NULL);
    `)
    __runMigrationForTests('087_browser_target_claims', db as unknown as MigrationDatabase)
    const service = new BrowserTargetClaimService(new BrowserTargetClaimRepository({ getRawDb: () => db as never }))
    const claim = service.acquire({
      partition: 'persist:browser', tabId: 'tab-old',
      physicalTargetToken: 'boot-old:tab-old:1', bootIncarnationId: 'boot-old',
      profileId: null, surface: 'user-view', parentTaskId: 'parent-old',
      browserTaskId: 'browser-old', ownerRunId: 'run-old', scopeId: 'scope-old', sessionId: null,
      messageVisibilityEpoch: 0,
    })
    assert.equal('ok' in claim && claim.ok === false, false)
    assert.equal(service.expirePreviousBoot('boot-current').length, 1)
    assert.equal(service.read({ partition: 'persist:browser', tabId: 'tab-old' })?.state, 'expired')
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('reset closes only exact-scope durable claims and lets the new context acquire', async (t) => {
  if (skipIfSqliteUnavailable(t, 'target claim reset closure')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE task_projections (task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, human_takeover_ref_json TEXT, checkpoint_refs_json TEXT);
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, message_visibility_epoch INTEGER NOT NULL, closed_at TEXT);
      INSERT INTO chat_conversations VALUES ('scope-reset', 0, NULL);
    `)
    __runMigrationForTests('087_browser_target_claims', db as unknown as MigrationDatabase)
    const service = new BrowserTargetClaimService(new BrowserTargetClaimRepository({ getRawDb: () => db as never }))
    const base = {
      partition: 'persist:browser', tabId: 'tab-reset',
      physicalTargetToken: 'boot-current:tab-reset:1', bootIncarnationId: 'boot-current',
      profileId: null, surface: 'user-view' as const, parentTaskId: 'parent-old',
      browserTaskId: 'browser-old', ownerRunId: 'run-old', scopeId: 'scope-reset', sessionId: 'scope-reset',
      messageVisibilityEpoch: 0,
    }
    const old = service.acquire(base)
    if ('ok' in old && old.ok === false) throw new Error(old.message)
    const oldIdentity = {
      partition: base.partition,
      tabId: base.tabId,
      physicalTargetToken: base.physicalTargetToken,
      bootIncarnationId: base.bootIncarnationId,
      claimId: old.claimId,
      generation: old.generation,
      ownerRunId: old.ownerRunId,
    }
    db.prepare('UPDATE browser_target_claims SET state = ?, suspension_checkpoint_id = ?, suspension_reason = ? WHERE claim_id = ?')
      .run('user_owned', 'checkpoint-old', 'browser_target_user_owned', old.claimId)

    assert.equal(service.acquire({ ...base, ownerRunId: 'run-blocked' }).errorCode, 'lease_takeover')
    db.prepare('UPDATE chat_conversations SET message_visibility_epoch = 1 WHERE id = ?').run('scope-reset')
    assert.equal(service.closeScopeContext('scope-reset').length, 1)
    assert.equal(service.checkWrite(oldIdentity)?.errorCode, 'lease_required')

    const current = service.acquire({
      ...base,
      ownerRunId: 'run-current',
      parentTaskId: 'parent-current',
      browserTaskId: 'browser-current',
      messageVisibilityEpoch: 1,
    })
    assert.equal('ok' in current && current.ok === false, false)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('durable epoch fences a persisted old owner even when reset cleanup never reaches the claim row', async (t) => {
  if (skipIfSqliteUnavailable(t, 'target claim durable epoch fence')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE task_projections (task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, human_takeover_ref_json TEXT, checkpoint_refs_json TEXT);
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY, message_visibility_epoch INTEGER NOT NULL, closed_at TEXT);
      INSERT INTO chat_conversations VALUES ('scope-cleanup-failed', 0, NULL);
    `)
    __runMigrationForTests('087_browser_target_claims', db as unknown as MigrationDatabase)
    const service = new BrowserTargetClaimService(new BrowserTargetClaimRepository({ getRawDb: () => db as never }))
    const base = {
      partition: 'persist:browser', tabId: 'tab-cleanup-failed',
      physicalTargetToken: 'boot-current:tab-cleanup-failed:1', bootIncarnationId: 'boot-current',
      profileId: null, surface: 'user-view' as const, parentTaskId: 'parent-old',
      browserTaskId: 'browser-old', ownerRunId: 'run-old', scopeId: 'scope-cleanup-failed',
      sessionId: 'scope-cleanup-failed', messageVisibilityEpoch: 0,
    }
    const old = service.acquire(base)
    if ('ok' in old && old.ok === false) throw new Error(old.message)
    const oldIdentity = {
      partition: base.partition,
      tabId: base.tabId,
      physicalTargetToken: base.physicalTargetToken,
      bootIncarnationId: base.bootIncarnationId,
      claimId: old.claimId,
      generation: old.generation,
      ownerRunId: old.ownerRunId,
    }

    db.prepare('UPDATE chat_conversations SET message_visibility_epoch = 1 WHERE id = ?')
      .run('scope-cleanup-failed')

    assert.equal(db.prepare('SELECT state FROM browser_target_claims WHERE claim_id = ?').get<{ state: string }>(old.claimId)?.state, 'held')
    assert.equal(service.checkWrite(oldIdentity)?.errorCode, 'lease_required')
    const current = service.acquire({
      ...base,
      ownerRunId: 'run-current',
      parentTaskId: 'parent-current',
      browserTaskId: 'browser-current',
      messageVisibilityEpoch: 1,
    })
    assert.equal('ok' in current && current.ok === false, false)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})
