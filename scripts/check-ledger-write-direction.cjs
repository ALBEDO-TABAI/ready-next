#!/usr/bin/env node
/**
 * EP2-T2 — ledger write-direction gate (07 §1, ownership matrix in
 * docs/superpowers/specs/2026-06-12-ledger-ownership-matrix.md).
 *
 * Scans src/main for raw SQL writes against the four ledgers outside their
 * owning modules. WARNING MODE by default (one release): violations are
 * listed but exit code stays 0 so the existing-violation inventory can be
 * collected and burned down; `--strict` turns violations into a failure
 * (the flip to error is its own小单 per the contract risk clause).
 */

const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = join(__dirname, '..')
const SCAN_ROOT = join(ROOT, 'src', 'main')
const STRICT = process.argv.includes('--strict')
const DIRECT_ANSWER_HISTORY_MIGRATION_REL =
  'src/main/modules/agent-control/task-projection/direct-answer-history-migration.ts'
const DIRECT_ANSWER_HISTORY_MIGRATION_MARKER =
  'run-finalizer-exempt: migration-077 repairs persisted legacy false failures only'

/** table → owner files/directories (writes allowed only there). */
const OWNERS = {
  task_projections: [
    'src/main/modules/repositories/task-projection-repository.ts',
    'src/main/modules/migrations.ts',
  ],
  run_meta: [
    'src/main/modules/agent-control/task-projection/run-meta-repository.ts',
    'src/main/modules/migrations.ts',
  ],
  browser_tasks: [
    'src/main/modules/browser-engine/',
    'src/main/modules/migrations.ts',
  ],
  skill_task_runs: [
    'src/main/modules/skills-runtime/',
    'src/main/modules/repositories/skill-task-run-repository.ts',
    'src/main/modules/migrations.ts',
  ],
}

const WRITE_SQL = (table) => new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'gi')

const MIGRATION_WRITE_EXEMPTIONS = {
  task_projections: {
    file: DIRECT_ANSWER_HISTORY_MIGRATION_REL,
    marker: DIRECT_ANSWER_HISTORY_MIGRATION_MARKER,
    statement: [
      'UPDATE task_projections',
      "SET status = 'completed',",
      "interaction_state = 'suspended',",
      "waiting_for = 'none',",
      "resumable_actions_json = '[]',",
      'blocked_reason = NULL,',
      'degradation_reason = NULL,',
      "task_type = 'direct_answer',",
      'budget_json = ?,',
      'budget_usage_percent = 13,',
      "budget_warning_level = 'none',",
      'criteria_json = ?,',
      'checkins_json = ?',
      "WHERE task_id = ? AND status = 'failed'",
    ].join(' '),
  },
  run_meta: {
    file: DIRECT_ANSWER_HISTORY_MIGRATION_REL,
    marker: DIRECT_ANSWER_HISTORY_MIGRATION_MARKER,
    statement: [
      'UPDATE run_meta',
      "SET status = 'done',",
      "task_type = 'direct_answer',",
      "terminal_reason = 'done',",
      'budget_json = ?',
      "WHERE run_id = ? AND task_id = ? AND status = 'error'",
      "AND terminal_reason = 'adjudication_degraded'",
    ].join(' '),
  },
}

const violations = []

function isOwner(rel, owner) {
  return owner.endsWith('/') ? rel.startsWith(owner) : rel === owner
}

function normalizedTemplateSql(text, matchIndex) {
  const tail = text.slice(matchIndex)
  const closingBacktick = tail.indexOf('`')
  if (closingBacktick < 0) return null
  return tail.slice(0, closingBacktick).replace(/\s+/g, ' ').trim()
}

function isRegisteredMigrationWrite(table, rel, text, matchIndex) {
  const exemption = MIGRATION_WRITE_EXEMPTIONS[table]
  return Boolean(
    exemption
    && rel === exemption.file
    && text.includes(exemption.marker)
    && normalizedTemplateSql(text, matchIndex) === exemption.statement
  )
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) { walk(abs); continue }
    if (!name.endsWith('.ts')) continue
    const rel = relative(ROOT, abs).replace(/\\/g, '/')
    const text = readFileSync(abs, 'utf-8')
    for (const [table, owners] of Object.entries(OWNERS)) {
      if (owners.some((owner) => isOwner(rel, owner))) continue
      for (const match of text.matchAll(WRITE_SQL(table))) {
        if (isRegisteredMigrationWrite(table, rel, text, match.index)) continue
        const line = text.slice(0, match.index).split('\n').length
        violations.push({ table, file: `${rel}:${line}` })
      }
    }
  }
}

walk(SCAN_ROOT)

if (violations.length > 0) {
  const label = STRICT ? 'FAIL' : 'WARNING'
  console.error(`check-ledger-write-direction: ${label} — ${violations.length} out-of-owner ledger write(s):`)
  for (const violation of violations) console.error(`  [${violation.table}] ${violation.file}`)
  if (STRICT) process.exit(1)
  console.error('(warning mode: collecting the existing-violation inventory; flip to --strict in its own ticket)')
}
console.log(`check-ledger-write-direction: ok (${violations.length} warning${violations.length === 1 ? '' : 's'})`)
