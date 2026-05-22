#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * run-budget-policy.ts `createContinuationRunBudgetSeed` must include a
 * branch for `inheritedFromTaskType === 'research'`. Without it, a
 * continuation of a research task would silently fall through to the
 * 24/24 'continuation' preset and trigger an early-budget-warning before
 * the deep-research pipeline can finish.
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
  console.error(`[check-research-budget-not-fallthrough-to-24] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

// Locate createContinuationRunBudgetSeed function body.
const fnMatch = src.match(/function\s+createContinuationRunBudgetSeed[\s\S]*?\n\}/)
if (!fnMatch) {
  console.error('[check-research-budget-not-fallthrough-to-24] FAIL: createContinuationRunBudgetSeed function not found')
  process.exit(1)
}

const body = fnMatch[0]
if (!/===\s*['"]research['"]/.test(body)) {
  console.error('[check-research-budget-not-fallthrough-to-24] FAIL: createContinuationRunBudgetSeed must contain a `=== \'research\'` branch')
  console.error('  Otherwise research continuations fall through to the 24-iter preset')
  process.exit(1)
}

console.log('[check-research-budget-not-fallthrough-to-24] OK')
