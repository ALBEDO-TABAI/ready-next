#!/usr/bin/env node
/**
 * Stage S (PR-S11 / W10.2) — run_feedback upsert-shape gate.
 *
 * Asserts that `run-feedback-repository.ts` exposes an `upsert(...)` method
 * backed by an `INSERT … ON CONFLICT(feedback_id) DO UPDATE …` statement
 * that updates AT LEAST `rating`, `signal`, `comment`, and `updated_at`.
 *
 * Equivalent shapes (`INSERT OR REPLACE`) would also work at the SQLite
 * level, but the explicit ON-CONFLICT clause is the contract pinned here
 * because it preserves the pre-existing `created_at` (vs. INSERT OR REPLACE
 * which deletes-then-inserts and clobbers it).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const REL = 'src/main/modules/agent-control/task-projection/run-feedback-repository.ts'

let src
try {
  src = fs.readFileSync(path.join(ROOT, REL), 'utf8')
} catch (e) {
  console.error(`[check-feedback-upsert-shape] FAIL: cannot read ${REL}: ${e.message}`)
  process.exit(1)
}

const errors = []

// 1. Must export an `upsert` method.
if (!/\bupsert\s*\(/.test(src)) {
  errors.push("missing `upsert(...)` method on RunFeedbackRepository")
}

// 2. Must use INSERT … ON CONFLICT(feedback_id) DO UPDATE shape.
const onConflictRe = /INSERT\s+INTO\s+run_feedback[\s\S]*?ON\s+CONFLICT\s*\(\s*feedback_id\s*\)\s*DO\s+UPDATE\s+SET([\s\S]*?)(?:`|;|\$)/i
const m = onConflictRe.exec(src)
if (!m) {
  errors.push(
    'missing `INSERT INTO run_feedback ... ON CONFLICT(feedback_id) DO UPDATE SET ...` shape',
  )
} else {
  const setClause = m[1]
  for (const required of ['rating', 'signal', 'comment', 'updated_at']) {
    if (!new RegExp(`\\b${required}\\s*=`).test(setClause)) {
      errors.push(`upsert ON CONFLICT clause must update '${required}'`)
    }
  }
  // The contract specifically forbids touching `created_at` in the UPDATE
  // (so re-submission preserves the original creation timestamp).
  if (/\bcreated_at\s*=/.test(setClause)) {
    errors.push(
      'upsert ON CONFLICT clause must NOT update `created_at` (preserve original)',
    )
  }
}

// 3. The class must be exported.
if (!/export\s+class\s+RunFeedbackRepository\b/.test(src)) {
  errors.push('missing `export class RunFeedbackRepository`')
}

if (errors.length > 0) {
  console.error('[check-feedback-upsert-shape] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-feedback-upsert-shape] OK')
