import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import {
  AGENT_IDENTITY_PERSONAS,
  runMigrations,
  type MigrationDatabase,
} from '../main/modules/migrations'
import { BUILTIN_AGENT_META } from '../shared/agent-identity'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteModule = new (path: string, options?: { readonly?: boolean }) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes?: number }
    get: <T = unknown>(...params: unknown[]) => T | undefined
    all: <T = unknown>(...params: unknown[]) => T[]
  }
  close: () => void
}

const require = createRequire(import.meta.url)

function loadSqlite(): SqliteModule | null {
  try {
    return require('better-sqlite3') as SqliteModule
  } catch {
    return null
  }
}

function openInMemory(): MigrationDatabase {
  const Sqlite = loadSqlite()!
  return new Sqlite(':memory:') as unknown as MigrationDatabase
}

test('migrations seed and upgrade the built-in agent personas', (t) => {
  if (skipIfSqliteUnavailable(t, 'default agent persona seed')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)

    const rows = db
      .prepare(`
        SELECT agent_name, display_name, personality_text, meta_json
        FROM agent_personalities
        WHERE agent_name IN ('butler', 'copywriter', 'video-editor', 'analyst', 'operator')
        ORDER BY agent_name
      `)
      .all<{
        agent_name: string
        display_name: string
        personality_text: string
        meta_json: string
      }>()

    assert.equal(rows.length, 5)
    const byName = new Map(rows.map((row) => [row.agent_name, row]))
    assert.equal(byName.get('butler')?.display_name, BUILTIN_AGENT_META.butler.displayName)
    assert.equal(byName.get('copywriter')?.display_name, BUILTIN_AGENT_META.copywriter.displayName)
    assert.equal(byName.get('video-editor')?.display_name, BUILTIN_AGENT_META['video-editor'].displayName)
    assert.equal(byName.get('analyst')?.display_name, BUILTIN_AGENT_META.analyst.displayName)
    assert.equal(byName.get('operator')?.display_name, BUILTIN_AGENT_META.operator.displayName)
    for (const row of rows) assert.ok(JSON.parse(row.meta_json).emoji)
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 045 does not overwrite an existing customized persona', (t) => {
  if (skipIfSqliteUnavailable(t, 'default agent persona seed idempotence')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    db
      .prepare(`
        UPDATE agent_personalities
        SET personality_text = ?
        WHERE agent_name = 'butler'
      `)
      .run('custom butler persona')
    db.prepare("DELETE FROM migrations WHERE name = '045_seed_default_agent_personas'").run()

    runMigrations(db)

    const row = db
      .prepare("SELECT personality_text FROM agent_personalities WHERE agent_name = 'butler'")
      .get<{ personality_text: string }>()
    const count = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM agent_personalities
        WHERE agent_name IN ('butler', 'copywriter', 'video-editor', 'analyst', 'operator')
      `)
      .get<{ count: number }>()

    assert.equal(row?.personality_text, 'custom butler persona')
    assert.equal(count?.count, 5)
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 079 reseeds the operator agent on databases that already ran 064', (t) => {
  if (skipIfSqliteUnavailable(t, 'operator agent catch-up seed')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    // 模拟"升级库"：064 已应用但当时还没有 operator（删掉 064 期产物与 079 记录）。
    db.prepare("DELETE FROM agents WHERE id = 'operator'").run()
    db.prepare("DELETE FROM agent_personalities WHERE agent_name = 'operator'").run()
    db.prepare("DELETE FROM migrations WHERE name = '079_seed_operator_agent'").run()

    runMigrations(db)

    const agentRow = db
      .prepare("SELECT id, name, status, persona_ref FROM agents WHERE id = 'operator'")
      .get<{ id: string; name: string; status: string; persona_ref: string }>()
    const personaRow = db
      .prepare("SELECT display_name, personality_text FROM agent_personalities WHERE agent_name = 'operator'")
      .get<{ display_name: string; personality_text: string }>()

    assert.equal(agentRow?.status, 'active')
    assert.equal(agentRow?.persona_ref, 'operator')
    assert.equal(agentRow?.name, BUILTIN_AGENT_META.operator.displayName)
    assert.equal(personaRow?.display_name, BUILTIN_AGENT_META.operator.displayName)
    assert.ok(personaRow?.personality_text.includes('运营'))
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 079 reassigns a user agent that already occupies the operator slug', (t) => {
  if (skipIfSqliteUnavailable(t, 'operator slug conflict reassignment')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    // 构造冲突态：079 未应用，operator 槽位被一个用户派生 agent 占用。
    db.prepare("DELETE FROM agents WHERE id = 'operator'").run()
    db.prepare("DELETE FROM agent_personalities WHERE agent_name = 'operator'").run()
    db.prepare("DELETE FROM migrations WHERE name = '079_seed_operator_agent'").run()
    db.prepare(`
      INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at)
      VALUES ('operator', '增长黑客', NULL, 'operator', 'active', 'butler', 'blueprint:bp-growth', NULL, '2026-01-01T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO agent_personalities (
        id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
      ) VALUES ('user-persona-operator', 'operator', '增长黑客', '用户自定义运营人格', NULL, '{"emoji":"🧪"}', 1, 1)
    `).run()

    runMigrations(db)

    const builtin = db
      .prepare("SELECT id, name, status, persona_ref FROM agents WHERE id = 'operator'")
      .get<{ id: string; name: string; status: string; persona_ref: string }>()
    const reassigned = db
      .prepare("SELECT id, name, parent_agent_id FROM agents WHERE id = 'operator-custom'")
      .get<{ id: string; name: string; parent_agent_id: string }>()
    const ledger = db
      .prepare("SELECT new_agent_id FROM agent_identity_migration WHERE old_agent_id = 'operator'")
      .get<{ new_agent_id: string }>()
    const builtinPersonality = db
      .prepare("SELECT display_name, personality_text FROM agent_personalities WHERE agent_name = 'operator'")
      .get<{ display_name: string; personality_text: string }>()
    const reassignedPersonality = db
      .prepare("SELECT display_name, personality_text FROM agent_personalities WHERE agent_name = 'operator-custom'")
      .get<{ display_name: string; personality_text: string }>()

    assert.deepEqual(builtin, {
      id: 'operator',
      name: BUILTIN_AGENT_META.operator.displayName,
      status: 'active',
      persona_ref: 'operator',
    })
    assert.equal(reassigned?.name, '增长黑客')
    assert.equal(reassigned?.parent_agent_id, 'butler')
    assert.equal(ledger?.new_agent_id, 'operator-custom')
    assert.equal(builtinPersonality?.display_name, BUILTIN_AGENT_META.operator.displayName)
    assert.equal(builtinPersonality?.personality_text, AGENT_IDENTITY_PERSONAS.operator)
    assert.equal(reassignedPersonality?.display_name, '增长黑客')
    assert.equal(reassignedPersonality?.personality_text, '用户自定义运营人格')
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 079 preserves a legacy top-level user agent on the operator slug', (t) => {
  if (skipIfSqliteUnavailable(t, 'top-level operator slug conflict reassignment')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    db.prepare("DELETE FROM agents WHERE id = 'operator'").run()
    db.prepare("DELETE FROM agent_personalities WHERE agent_name = 'operator'").run()
    db.prepare("DELETE FROM migrations WHERE name = '079_seed_operator_agent'").run()
    db.prepare(`
      INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at)
      VALUES ('operator', '增长顾问', '用户自己的增长章程', 'operator', 'active', NULL, NULL, NULL, '2025-01-01T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO agent_personalities (
        id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
      ) VALUES ('legacy-top-level-operator', 'operator', '增长顾问', '顶层用户自定义人格', 'direct', '{"emoji":"🌱"}', 1, 1)
    `).run()

    runMigrations(db)

    const builtin = db.prepare("SELECT name, charter FROM agents WHERE id = 'operator'")
      .get<{ name: string; charter: string }>()
    const recovered = db.prepare("SELECT name, charter, parent_agent_id FROM agents WHERE id = 'operator-custom'")
      .get<{ name: string; charter: string; parent_agent_id: string | null }>()
    const recoveredPersona = db.prepare("SELECT personality_text FROM agent_personalities WHERE agent_name = 'operator-custom'")
      .get<{ personality_text: string }>()

    assert.equal(builtin?.name, BUILTIN_AGENT_META.operator.displayName)
    assert.equal(builtin?.charter, BUILTIN_AGENT_META.operator.charter)
    assert.deepEqual(recovered, {
      name: '增长顾问',
      charter: '用户自己的增长章程',
      parent_agent_id: null,
    })
    assert.equal(recoveredPersona?.personality_text, '顶层用户自定义人格')
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 080 repairs the historical reserved-slug personality misbinding', (t) => {
  if (skipIfSqliteUnavailable(t, 'reserved slug personality forward repair')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    db.prepare("DELETE FROM migrations WHERE name = '080_repair_reserved_slug_personality_binding'").run()
    db.prepare(`
      INSERT INTO agents (id, name, charter, persona_ref, status, parent_agent_id, derivation_reason, merged_into_agent_id, created_at)
      VALUES ('copywriter-custom', '葵老板', '用户自己的文案章程', 'copywriter-custom', 'active', 'butler', 'blueprint:legacy', NULL, '2025-01-01T00:00:00.000Z')
    `).run()
    db.prepare(`
      INSERT INTO agent_identity_migration (
        id, kind, old_agent_id, new_agent_id, details_json, asset_reconciled_at, created_at
      ) VALUES ('legacy-copywriter-reassign', 'reserved_slug_reassigned', 'copywriter', 'copywriter-custom', '{}', NULL, '2025-01-01T00:00:00.000Z')
    `).run()
    db.prepare(`
      UPDATE agent_personalities
      SET personality_text = '用户原始自定义文案人格', display_name = '文案'
      WHERE agent_name = 'copywriter'
    `).run()
    const placeholder = [
      '# 葵老板',
      '',
      '你是 Ready 工作台中的一个完整 Agent。',
      '职责范围：用户自己的文案章程',
      '请用清晰、稳定、可复盘的方式工作；遇到边界不清时先向用户确认。',
    ].join('\n')
    db.prepare(`
      INSERT INTO agent_personalities (
        id, agent_name, display_name, personality_text, tone, meta_json, created_at, updated_at
      ) VALUES ('personality-copywriter-custom', 'copywriter-custom', '葵老板', ?, NULL, '{"emoji":"🤖"}', 1, 1)
    `).run(placeholder)

    runMigrations(db)

    const builtinPersona = db.prepare("SELECT personality_text FROM agent_personalities WHERE agent_name = 'copywriter'")
      .get<{ personality_text: string }>()
    const recoveredPersona = db.prepare("SELECT display_name, personality_text FROM agent_personalities WHERE agent_name = 'copywriter-custom'")
      .get<{ display_name: string; personality_text: string }>()
    assert.equal(builtinPersona?.personality_text, AGENT_IDENTITY_PERSONAS.copywriter)
    assert.deepEqual(recoveredPersona, {
      display_name: '葵老板',
      personality_text: '用户原始自定义文案人格',
    })

    runMigrations(db)
    const recoveredCount = db.prepare("SELECT COUNT(*) AS count FROM agent_personalities WHERE agent_name = 'copywriter-custom'")
      .get<{ count: number }>()
    assert.equal(recoveredCount?.count, 1)
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})
