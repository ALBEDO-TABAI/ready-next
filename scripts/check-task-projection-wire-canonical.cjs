#!/usr/bin/env node
/**
 * Stage U PR U4.v2-4 — task-projection wire-canonical drift gate.
 *
 * Phase 4 v2 § (scope freeze) — renderer must derive TaskProjection
 * Record / Event types from `src/shared/ipc-contracts/task-projection.ts`,
 * not re-declare their full structure inside `electron.d.ts`.
 *
 * Pre-U4.v2-2/-3 electron.d.ts hand-rewrote both interfaces (15+ field
 * declarations); any new field added on the main wire side would drift
 * silently. U4.v2-2/-3 replaced them with Omit/intersection or direct
 * alias from the wire module. This gate fences the regression.
 *
 * Forbidden in `src/renderer/types/electron.d.ts`:
 *   1. `interface TaskProjectionRecordData {` with body containing more
 *      than 3 field declarations (a full hand-rewrite — the wire-derived
 *      form is `type TaskProjectionRecordData = Omit<... > & { ... }`)
 *   2. `interface TaskProjectionChangeEventData {` (the wire-derived
 *      form is `type TaskProjectionChangeEventData = ...Wire`)
 *
 * Allowed:
 *   - `type TaskProjectionRecordData = ... TaskProjectionRecordWire ...`
 *     (the new wire-derived form using Omit/intersection)
 *   - `type TaskProjectionChangeEventData = TaskProjectionChangeEventWire`
 *
 * Why a structural gate (not a "must contain Wire import"): future PRs
 * may legitimately alias the wire import (e.g. `TaskProjectionRecordWire
 * as TPRWire`); locking the exact import shape would create needless
 * friction. Locking against the historical `interface ... {` shape
 * directly enforces "no full hand-rewrite".
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const TARGET = 'src/renderer/types/electron.d.ts'

function checkTaskProjectionWireCanonical() {
  const abs = path.join(REPO, TARGET)
  if (!fs.existsSync(abs)) {
    return { ok: false, violations: [{
      file: TARGET, line: 0,
      reason: 'electron.d.ts not found',
      code: '(missing file)',
    }] }
  }
  const raw = fs.readFileSync(abs, 'utf8')
  const lines = raw.split('\n')
  const violations = []

  // Pattern 1: TaskProjectionChangeEventData must NOT be an interface.
  for (let i = 0; i < lines.length; i += 1) {
    if (/interface\s+TaskProjectionChangeEventData\s*\{/.test(lines[i])) {
      violations.push({
        file: TARGET,
        line: i + 1,
        reason: 'TaskProjectionChangeEventData must be `type X = TaskProjectionChangeEventWire`, not an interface',
        code: lines[i].trim().slice(0, 160),
      })
    }
  }

  // Pattern 2: TaskProjectionRecordData must NOT be an interface body
  // with > 3 field declarations (which signals a hand-rewrite of the
  // wire shape). A wire-derived type alias with intersection is fine.
  for (let i = 0; i < lines.length; i += 1) {
    if (/interface\s+TaskProjectionRecordData\s*\{/.test(lines[i])) {
      // Count field-like declarations until the closing brace.
      let depth = 1
      let fieldCount = 0
      for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
        const line = lines[j]
        for (const ch of line) {
          if (ch === '{') depth += 1
          else if (ch === '}') depth -= 1
        }
        // Crude "looks like a field declaration" heuristic
        if (/^\s*[a-zA-Z_$][\w$]*\??:\s*\S/.test(line)) fieldCount += 1
      }
      if (fieldCount > 3) {
        violations.push({
          file: TARGET,
          line: i + 1,
          reason: `TaskProjectionRecordData is declared as an interface with ${fieldCount} fields — full hand-rewrite of the wire shape is forbidden. Use Omit/intersection alias from TaskProjectionRecordWire.`,
          code: lines[i].trim().slice(0, 160),
        })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkTaskProjectionWireCanonical()
  if (ok) { console.log('[check-task-projection-wire-canonical] OK'); return 0 }
  console.error('[check-task-projection-wire-canonical] FAIL — electron.d.ts is re-declaring a wire-canonical task-projection type.')
  console.error('  Stage U Phase 4 v2: derive from src/shared/ipc-contracts/task-projection.ts instead.')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.reason}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkTaskProjectionWireCanonical }
