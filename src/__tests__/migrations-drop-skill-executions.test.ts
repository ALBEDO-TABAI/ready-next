/**
 * B Phase 4 PR4 — migration `029_drop_skill_execution_tables` contract.
 *
 * Runs as source-level regex assertions instead of in-memory SQLite
 * because `better-sqlite3` is compiled against Electron's Node ABI —
 * loading it from the plain-Node `tsx` test runner fails with
 * `NODE_MODULE_VERSION` mismatch. The real migration exercises happen
 * at app startup; this test guards the statements against drift.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function readMigrations(): string {
  return readWorkspaceFile('src/main/modules/migrations.ts')
}

test('migrations.ts declares migration 029_drop_skill_execution_tables', () => {
  const source = readMigrations()
  assert.match(
    source,
    /name:\s*'029_drop_skill_execution_tables'/,
    'missing migration entry for 029_drop_skill_execution_tables',
  )
})

test('029 drops the TTL index from migration 028 first', () => {
  const source = readMigrations()
  // Capture the 029 body so we can run sub-assertions against it alone.
  const match = source.match(
    /name:\s*'029_drop_skill_execution_tables'[\s\S]*?up:\s*\(db\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/,
  )
  assert.ok(match, 'could not locate the 029 up() body')
  const body = match![1]
  assert.match(
    body,
    /DROP INDEX IF EXISTS idx_skill_executions_status_finished_at/,
    '029 must drop the 028 TTL index before the tables',
  )
})

test('029 drops the 3 tables in child → parent order (artifacts, steps, parent)', () => {
  const source = readMigrations()
  const match = source.match(
    /name:\s*'029_drop_skill_execution_tables'[\s\S]*?up:\s*\(db\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/,
  )
  assert.ok(match, 'could not locate the 029 up() body')
  const body = match![1]

  const artifactsIdx = body.indexOf('DROP TABLE IF EXISTS skill_execution_artifacts')
  const stepsIdx = body.indexOf('DROP TABLE IF EXISTS skill_execution_steps')
  const parentIdx = body.indexOf('DROP TABLE IF EXISTS skill_executions')

  assert.ok(artifactsIdx >= 0, '029 must drop skill_execution_artifacts')
  assert.ok(stepsIdx >= 0, '029 must drop skill_execution_steps')
  assert.ok(parentIdx >= 0, '029 must drop skill_executions')

  // PRAGMA foreign_keys is not enabled on this DB (§6.11), so the order
  // is purely defensive — but we still want child tables dropped first so
  // a future migration could safely toggle the PRAGMA without rewriting
  // this script.
  assert.ok(
    artifactsIdx < stepsIdx,
    'skill_execution_artifacts must drop before skill_execution_steps',
  )
  assert.ok(
    stepsIdx < parentIdx,
    'skill_execution_steps must drop before skill_executions',
  )
})

test('029 uses IF EXISTS on every drop so re-runs are idempotent', () => {
  const source = readMigrations()
  const match = source.match(
    /name:\s*'029_drop_skill_execution_tables'[\s\S]*?up:\s*\(db\)\s*=>\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}/,
  )
  assert.ok(match, 'could not locate the 029 up() body')
  const body = match![1]

  const dropStatements = [...body.matchAll(/DROP\s+(?:TABLE|INDEX)[^\n]*/gi)]
  assert.ok(dropStatements.length >= 4, `expected 4 DROP statements, got ${dropStatements.length}`)
  for (const [stmt] of dropStatements) {
    assert.match(
      stmt,
      /IF EXISTS/,
      `DROP statement missing "IF EXISTS": ${stmt}`,
    )
  }
})

test('029 is declared after 028 in the migrations array (ordering matters)', () => {
  const source = readMigrations()
  const idx028 = source.indexOf("name: '028_add_skill_executions_ttl_index'")
  const idx029 = source.indexOf("name: '029_drop_skill_execution_tables'")
  assert.ok(idx028 >= 0, 'migration 028 missing')
  assert.ok(idx029 >= 0, 'migration 029 missing')
  assert.ok(
    idx028 < idx029,
    'migration 029 must come after 028 so the TTL index drop precedes the table drops on a fresh install',
  )
})

test('no earlier migration resurrects the 3 dropped tables (canonical retirement)', () => {
  const source = readMigrations()
  // Find each CREATE TABLE for the retired tables and verify it sits
  // before migration 029 (otherwise 029 would drop a freshly-created
  // table, defeating the purpose). All 3 tables were created in earlier
  // migrations (check presence + ordering).
  for (const tableName of ['skill_executions', 'skill_execution_steps', 'skill_execution_artifacts']) {
    const createPattern = new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\b`, 'i')
    const createMatch = source.match(createPattern)
    if (createMatch) {
      const createIdx = source.indexOf(createMatch[0])
      const idx029 = source.indexOf("name: '029_drop_skill_execution_tables'")
      assert.ok(
        createIdx < idx029,
        `CREATE TABLE ${tableName} must predate 029 — otherwise the drop runs against a just-created table`,
      )
    }
  }
})
