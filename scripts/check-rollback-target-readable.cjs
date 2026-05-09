#!/usr/bin/env node
/**
 * Stage T (W9.2) gate — `rollback_target` is readable end-to-end.
 *
 * Two checks pinned by plan v18 §4.3:
 *
 *   (A) `skill-child-run-log.ts` (the JSONL reader file) must reference
 *       `rollback_target` so the field is exposed to consumers.
 *
 *   (B) At least one TaskCard renderer surface (`ChatPanel.tsx` /
 *       `taskCardViewModel.ts` / `TaskPanel.tsx`) must reference
 *       `rollback_target` so the diagnostic field is reachable in UI.
 *
 * The reader is read-only — it must NOT trigger any rollback action.
 * That ban is enforced separately by `check-no-auto-rollback-on-cancel.cjs`.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const LOG_FILE = path.join(
  ROOT,
  'src/main/modules/agent-control/skill-child-run-log.ts',
)
const RENDERER_FILES = [
  'src/renderer/components/agent/ChatPanel.tsx',
  'src/renderer/modules/agent/taskCardViewModel.ts',
  'src/renderer/components/ready/TaskPanel.tsx',
]

function fail(violations) {
  console.error('check-rollback-target-readable: violations:')
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

function main() {
  const violations = []

  if (!fs.existsSync(LOG_FILE)) {
    fail([`missing file: ${LOG_FILE}`])
  }
  const logText = fs.readFileSync(LOG_FILE, 'utf8')
  if (!/\brollback_target\b/.test(logText)) {
    violations.push(
      'skill-child-run-log.ts: must reference `rollback_target` (reader-side exposure)',
    )
  }

  let rendererHits = 0
  for (const rel of RENDERER_FILES) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    const text = fs.readFileSync(abs, 'utf8')
    if (/\brollback_target\b/.test(text)) {
      rendererHits += 1
    }
  }
  if (rendererHits === 0) {
    violations.push(
      `no TaskCard renderer file references \`rollback_target\` (looked at: ${RENDERER_FILES.join(', ')})`,
    )
  }

  if (violations.length > 0) fail(violations)
  console.log('check-rollback-target-readable: ok')
}

main()
