#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * run-budget-policy.ts TASK_TYPE_BUDGET_PRESETS.research must be exactly:
 *   research: { maxIterations: 220, maxToolCalls: 220 }
 *
 * 220/220 is an emergency ceiling. Healthy research should finish naturally
 * or stop on a no-progress guard, not be segmented by a small call counter.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/task-projection/run-budget-policy.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-research-budget-preset-shape] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

// Match: research: { maxIterations: 220, maxToolCalls: 220 }
// Whitespace tolerant.
const re = /research\s*:\s*\{\s*maxIterations\s*:\s*220\s*,\s*maxToolCalls\s*:\s*220\s*,?\s*\}/
if (!re.test(src)) {
  console.error('[check-research-budget-preset-shape] FAIL: TASK_TYPE_BUDGET_PRESETS.research must be exactly `{ maxIterations: 220, maxToolCalls: 220 }`')
  process.exit(1)
}

console.log('[check-research-budget-preset-shape] OK')
