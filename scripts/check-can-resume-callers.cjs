#!/usr/bin/env node
/**
 * Stage Q (Stage 11) — 5-layer canResume single-source enforcement.
 *
 * Stage Q audit §2 found 5 layers each defining "is this resumable?"
 * differently, with only `task-projection-reconciler.ts:hasDurableHandle`
 * being strict. Plan §3.4 contract C6: every layer must consume
 * `canResumeShape` from `agent-control/resume-handle.ts`.
 *
 * This gate verifies the 5 (now 6 with supervisor's two helpers
 * already covered by `check-supervisor-uses-canresume.cjs`) target
 * files import the helper and call it at least once.
 *
 * Layers covered:
 *   1. agent-control/skill-task-lifecycle.ts (hasContinuationHandle)
 *   2. agent-control/run-contracts.ts (loadSkillRunContract anchor)
 *   3. agent-control/task-projection-reconciler.ts (hasDurableHandle)
 *   4. agent-control/runtime.ts (buildContinuationIntent +
 *                                 deriveTaskProjectionCanResume)
 *
 * `--root <path>` lets tests point the gate at a fixture tree.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  stripCodeStringsAndComments,
  stripCommentsOnly,
} = require('./_lib_strip_code_strings_and_comments.cjs')

const REPO_DEFAULT = path.resolve(__dirname, '..')

const TARGETS = [
  'src/main/modules/agent-control/skills/skill-task-lifecycle.ts',
  'src/main/modules/agent-control/contracts/run-contracts.ts',
  'src/main/modules/agent-control/task-projection/task-projection-reconciler.ts',
  'src/main/modules/agent-control/runtime-core/runtime.ts',
]

function parseRoot(argv) {
  let root = REPO_DEFAULT
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' && i + 1 < argv.length) {
      root = path.resolve(argv[i + 1])
      i++
    }
  }
  return root
}

function main() {
  const root = parseRoot(process.argv.slice(2))
  const violations = []
  for (const rel of TARGETS) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      violations.push(`Missing target file: ${rel}`)
      continue
    }
    let src
    try {
      src = fs.readFileSync(abs, 'utf8')
    } catch (error) {
      violations.push(`Cannot read ${rel}: ${error}`)
      continue
    }
    // PASS A — string contents intact, used to detect import path
    // (whose body lives inside a string literal).
    const passA = stripCommentsOnly(src)
    if (!/from\s+['"][^'"]*resume-handle['"]/.test(passA)) {
      violations.push(`${rel}: does not import from resume-handle module`)
      continue
    }
    // PASS B — strings blanked, used to detect identifier-shaped
    // patterns (so `'canResumeShape('` inside a comment/string doesn't
    // false-positive).
    const passB = stripCodeStringsAndComments(src)
    if (!/\b(canResumeShape|canResumeWithFs)\b/.test(passB)) {
      violations.push(`${rel}: imports resume-handle but does not call canResumeShape/canResumeWithFs`)
      continue
    }
    if (!/\b(canResumeShape|canResumeWithFs)\s*\(/.test(passB)) {
      violations.push(`${rel}: imports helper but does not invoke it`)
    }
  }
  if (violations.length === 0) {
    console.log('[check-can-resume-callers] OK')
    return 0
  }
  console.error('[check-can-resume-callers] FAIL')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Stage Q (Stage 11): 5-layer canResume single-source contract violated.')
  console.error('Each target must import + invoke canResumeShape (or canResumeWithFs).')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = { main }
