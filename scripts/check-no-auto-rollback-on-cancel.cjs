#!/usr/bin/env node
/**
 * Stage T (W9.2) gate — cancel path MUST NOT call any auto-rollback
 * function. Plan v18 §4.3 hard-bans `/rollback\(/i` from the runner cancel
 * path: `rollback_target` is a diagnostic field only.
 *
 * Scope: `src/main/modules/agent-control/skill-child-runner.ts` — the only
 * file that owns the cancel terminal path. Any *call* to a function whose
 * name matches `/rollback\(/i` is rejected. Identifiers like
 * `rollback_target` (snake-case data field) and `rollback_target:` in
 * object literals are explicitly NOT calls and MUST pass.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUNNER_FILE = path.join(
  ROOT,
  'src/main/modules/agent-control/skill-child-runner.ts',
)

function fail(violations) {
  console.error('check-no-auto-rollback-on-cancel: violations:')
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

function main() {
  if (!fs.existsSync(RUNNER_FILE)) {
    fail([`missing file: ${RUNNER_FILE}`])
  }
  const text = fs.readFileSync(RUNNER_FILE, 'utf8')

  const violations = []
  const lines = text.split('\n')
  // Match a function call: `<word ending with rollback>(`
  // Excludes `rollback_target` (snake-case data field — never callable
  // because the underscore breaks the function-call pattern; the regex
  // requires `rollback` immediately followed by `(`).
  const callRegex = /\brollback\s*\(/i
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    // Strip line comments so commentary referencing `rollback()` does not
    // trip the gate.
    const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '')
    if (callRegex.test(stripped)) {
      violations.push(
        `skill-child-runner.ts:${i + 1} forbidden auto-rollback call: ${line.trim()}`,
      )
    }
  }

  if (violations.length > 0) fail(violations)
  console.log('check-no-auto-rollback-on-cancel: ok')
}

main()
