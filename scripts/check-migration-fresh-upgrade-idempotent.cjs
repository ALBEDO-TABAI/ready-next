#!/usr/bin/env node
/**
 * Stage S (PR-S11 / W10.1) — migration idempotency gate.
 *
 * Verifies that migrations 034 / 035 / 036 are written in a way that is
 * safe under all three re-application scenarios:
 *
 *   1. Fresh install — full migration chain runs on an empty DB.
 *   2. Upgrade from 033 — only 034+ run on an existing DB with prior data.
 *   3. Re-run idempotent — `runMigrations` is called twice; the migrations
 *      table prevents re-execution. Even if the migrations table were lost,
 *      every DDL we add must still be safe to apply against a populated DB.
 *
 * The gate enforces the third property syntactically: every CREATE TABLE
 * and CREATE INDEX statement inside the 034 / 035 / 036 migration bodies
 * must use `IF NOT EXISTS`. The first two scenarios are exercised by the
 * tsx tests under `src/__tests__/migration-03[456]-*.test.ts` (run by
 * `npm run test:s:focus` and `npm run verify:native`).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/migrations.ts'
const TARGET_MIGRATIONS = [
  { number: 34, slug: 'add_run_meta_table' },
  { number: 35, slug: 'add_thread_meta_table' },
  { number: 36, slug: 'add_run_feedback_table' },
]

let src
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-migration-fresh-upgrade-idempotent] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

const errors = []

for (const target of TARGET_MIGRATIONS) {
  const padded = String(target.number).padStart(3, '0')
  const fullName = `${padded}_${target.slug}`

  // Locate the migration block by its name literal.
  const nameLiteralRe = new RegExp(
    `name:\\s*['\"]${fullName}['\"]`,
    'm',
  )
  const nameMatch = nameLiteralRe.exec(src)
  if (!nameMatch) {
    errors.push(`migration '${fullName}' not found by name`)
    continue
  }

  // Slice forward to the next migration boundary (next `name:` literal or
  // closing `]` of the migrations array). This is a coarse-but-sufficient
  // window for the static check.
  const blockStart = nameMatch.index
  const nextNameRe = /name:\s*['"]\d{3}_/g
  nextNameRe.lastIndex = blockStart + nameMatch[0].length
  const nextMatch = nextNameRe.exec(src)
  const blockEnd = nextMatch ? nextMatch.index : src.length
  const block = src.slice(blockStart, blockEnd)

  // Extract every CREATE TABLE / CREATE INDEX statement and require
  // `IF NOT EXISTS`. We rely on db.exec(`...`) blocks; SQL is loose-form
  // text inside template literals.
  const createTableRe = /CREATE\s+TABLE(?!\s+IF\s+NOT\s+EXISTS)\s+([A-Za-z_][A-Za-z0-9_]*)/gi
  const createIndexRe = /CREATE\s+INDEX(?!\s+IF\s+NOT\s+EXISTS)\s+([A-Za-z_][A-Za-z0-9_]*)/gi

  let m
  while ((m = createTableRe.exec(block)) !== null) {
    errors.push(
      `migration '${fullName}': \`CREATE TABLE ${m[1]}\` must use \`IF NOT EXISTS\` ` +
        `(otherwise re-application against a populated DB fails)`,
    )
  }
  while ((m = createIndexRe.exec(block)) !== null) {
    errors.push(
      `migration '${fullName}': \`CREATE INDEX ${m[1]}\` must use \`IF NOT EXISTS\``,
    )
  }
}

// Also pin that the runMigrations() pattern (skip-applied-by-name) still
// exists. If someone refactors that out, idempotency for the FIRST run
// scenario breaks even with `IF NOT EXISTS` in place.
if (!/SELECT\s+name\s+FROM\s+migrations/i.test(src)) {
  errors.push(
    "runMigrations no longer reads the 'migrations' tracking table — " +
      'idempotency relies on the tracker',
  )
}
if (!/INSERT\s+INTO\s+migrations\s*\(\s*name\s*,\s*applied_at\s*\)/i.test(src)) {
  errors.push(
    "runMigrations no longer records applied migrations into the 'migrations' table",
  )
}

if (errors.length > 0) {
  console.error('[check-migration-fresh-upgrade-idempotent] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-migration-fresh-upgrade-idempotent] OK')
