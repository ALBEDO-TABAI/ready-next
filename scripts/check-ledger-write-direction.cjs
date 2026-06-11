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

/** table → owner path prefixes (writes allowed only там). */
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

const WRITE_SQL = (table) => new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, 'i')

const violations = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) { walk(abs); continue }
    if (!name.endsWith('.ts')) continue
    const rel = relative(ROOT, abs).replace(/\\/g, '/')
    const text = readFileSync(abs, 'utf-8')
    for (const [table, owners] of Object.entries(OWNERS)) {
      if (!WRITE_SQL(table).test(text)) continue
      if (owners.some((owner) => rel.startsWith(owner))) continue
      const line = text.slice(0, text.search(WRITE_SQL(table))).split('\n').length
      violations.push({ table, file: `${rel}:${line}` })
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
