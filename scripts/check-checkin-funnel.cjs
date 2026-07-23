#!/usr/bin/env node
/**
 * EP2-Q4a — CheckIn funnel gate. `checkins` writes on task projections may
 * only originate from the adjudication channel: the finalizer (shadow/enforce
 * adjudication), the adjudicator module itself, and the repository column
 * mapping. Any other src/main file constructing a `checkins:` property write
 * is an out-of-channel CheckIn and fails the gate.
 */

const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = join(__dirname, '..')
const SCAN_ROOT = join(ROOT, 'src', 'main')

const WHITELIST = new Set([
  'src/main/modules/agent-control/runtime-core/run-finalizer.ts',
  'src/main/modules/agent-control/runtime-core/run-finalizer-adjudication.ts',
  'src/main/modules/agent-control/quality/task-adjudicator.ts',
  'src/main/modules/repositories/task-projection-repository.ts',
])

// property-write form: `checkins:` inside an object literal (reads like
// `record.checkins` or `patch.checkins` do not match).
const WRITE_PATTERN = /[{,]\s*checkins\s*:/

const violations = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) { walk(abs); continue }
    if (!name.endsWith('.ts')) continue
    const rel = relative(ROOT, abs).replace(/\\/g, '/')
    if (WHITELIST.has(rel)) continue
    const text = readFileSync(abs, 'utf-8')
    if (WRITE_PATTERN.test(text)) {
      const line = text.slice(0, text.search(WRITE_PATTERN)).split('\n').length
      violations.push(`${rel}:${line}`)
    }
  }
}

walk(SCAN_ROOT)

if (violations.length > 0) {
  console.error('check-checkin-funnel: FAIL — out-of-channel checkins writes:')
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log('check-checkin-funnel: ok')
