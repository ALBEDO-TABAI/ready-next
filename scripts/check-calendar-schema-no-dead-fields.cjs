#!/usr/bin/env node
/**
 * Calendar L0-Schema-Lock CI gate.
 *
 * Enforces two invariants on the calendar module schema:
 *
 * 1. RESERVED FIELDS (must be alive, not dead-letters):
 *    `recurrence_rule`, `reminders`, `sync_url`, `sync_interval`
 *    The 002 migration creates these columns. L2/L3/L4 teams will land
 *    real consumers (reminder scheduler, RRULE engine, ICS sync). Until
 *    each field has at least one production consumer beyond the
 *    migration declaration and the `CalendarEvent` / `CalendarSource`
 *    row type, this gate enforces a minimum reference count so the
 *    fields cannot silently revert to dead state. Threshold is
 *    intentionally low (>= 3) and should be ratcheted up by each team
 *    as they land consumers — see RESERVED_THRESHOLD below.
 *
 * 2. RETIRED FIELDS (must be absent from src/, except inside the 037
 *    migration's drop machinery):
 *    `agent_action` — retired by migration 037.
 *
 * Per CLAUDE.md §0.5.5 (CI 强制 > 文档约束 > 人审) this gate is the
 * structural defense against "声明但不用" regressions.
 *
 * Not wired to verify chain yet (deferred to L6-Verification — append
 * `node scripts/check-calendar-schema-no-dead-fields.cjs` to a
 * `verify:calendar` script and chain that from `verify`).
 */

const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = process.cwd()
const SRC_DIR = join(ROOT, 'src')

const RESERVED_FIELDS = ['recurrence_rule', 'reminders', 'sync_url', 'sync_interval']
const RESERVED_THRESHOLD = 3

const RETIRED_FIELDS = ['agent_action', 'agentAction']

/**
 * Files allowed to mention retired fields. Currently only the 037
 * migration is allowed (its DROP TABLE / INSERT path is the unique
 * place that legitimately names the dead column). The 002 migration
 * also still creates the column for fresh DBs that then run 037, so
 * 002 is allowed too — it is the historical snapshot.
 */
const RETIRED_ALLOWED_FILES = [
  /(^|\/)src\/main\/modules\/migrations\.ts$/,
]

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...walk(full))
    } else if (/\.(ts|tsx|js|jsx|cjs|mjs)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function countMatches(text, needle) {
  let count = 0
  let i = 0
  while ((i = text.indexOf(needle, i)) !== -1) {
    count += 1
    i += needle.length
  }
  return count
}

function main() {
  const files = walk(SRC_DIR)

  const reservedCounts = Object.fromEntries(RESERVED_FIELDS.map((f) => [f, 0]))
  const retiredHits = []

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const text = readFileSync(file, 'utf8')

    for (const field of RESERVED_FIELDS) {
      reservedCounts[field] += countMatches(text, field)
    }

    const allowedForRetired = RETIRED_ALLOWED_FILES.some((re) => re.test('/' + rel))
    if (!allowedForRetired) {
      for (const field of RETIRED_FIELDS) {
        const n = countMatches(text, field)
        if (n > 0) {
          retiredHits.push({ file: rel, field, count: n })
        }
      }
    }
  }

  const failures = []

  for (const field of RESERVED_FIELDS) {
    if (reservedCounts[field] < RESERVED_THRESHOLD) {
      failures.push(
        `reserved field "${field}" has only ${reservedCounts[field]} reference(s) in src/ — must be >= ${RESERVED_THRESHOLD}. ` +
          `Either land a consumer (L2/L3/L4) or remove the migration declaration.`,
      )
    }
  }

  if (retiredHits.length > 0) {
    for (const hit of retiredHits) {
      failures.push(`retired field "${hit.field}" still referenced in ${hit.file} (count=${hit.count})`)
    }
  }

  if (failures.length > 0) {
    console.error('[check-calendar-schema-no-dead-fields] FAIL')
    for (const msg of failures) console.error('  - ' + msg)
    process.exit(1)
  }

  const summary = RESERVED_FIELDS.map((f) => `${f}=${reservedCounts[f]}`).join(', ')
  console.log(`[check-calendar-schema-no-dead-fields] OK (${summary}; agent_action retired)`)
}

main()
