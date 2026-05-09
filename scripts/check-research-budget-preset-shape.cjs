#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * run-budget-policy.ts TASK_TYPE_BUDGET_PRESETS.research must be exactly:
 *   research: { maxIterations: 60, maxToolCalls: 60 }
 *
 * 60/60 matches media_task; smaller numbers would throttle deep-research
 * pipelines mid-run.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/run-budget-policy.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-research-budget-preset-shape] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

// Match: research: { maxIterations: 60, maxToolCalls: 60 }
// Whitespace tolerant.
const re = /research\s*:\s*\{\s*maxIterations\s*:\s*60\s*,\s*maxToolCalls\s*:\s*60\s*,?\s*\}/
if (!re.test(src)) {
  console.error('[check-research-budget-preset-shape] FAIL: TASK_TYPE_BUDGET_PRESETS.research must be exactly `{ maxIterations: 60, maxToolCalls: 60 }`')
  process.exit(1)
}

console.log('[check-research-budget-preset-shape] OK')
