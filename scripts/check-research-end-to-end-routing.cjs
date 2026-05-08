#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * task-type-resolver.ts must contain a branch that, given an intent with
 * primaryDomain === 'research', returns:
 *   {
 *     taskType: 'research',
 *     executionChain: 'domain_executor',
 *     preferredExecutor: 'research',
 *     ...
 *   }
 *
 * This is the source-level glue between intent-classifier (writes
 * primaryDomain) and the domain adapter (reads route.taskType).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const FILE = path.join(ROOT, 'src/main/modules/agent-control/task-type-resolver.ts')

let src
try {
  src = fs.readFileSync(FILE, 'utf8')
} catch (e) {
  console.error(`[check-research-end-to-end-routing] FAIL: cannot read ${FILE}: ${e.message}`)
  process.exit(1)
}

// 1. Branch on primaryDomain === 'research' must exist.
if (!/primaryDomain\s*===\s*['"]research['"]/.test(src)) {
  console.error('[check-research-end-to-end-routing] FAIL: missing branch `params.intent.primaryDomain === \'research\'` in task-type-resolver.ts')
  process.exit(1)
}

// 2. The research branch must produce taskType: 'research'
if (!/taskType:\s*['"]research['"]/.test(src)) {
  console.error('[check-research-end-to-end-routing] FAIL: research branch must produce `taskType: \'research\'`')
  process.exit(1)
}

// 3. preferredExecutor: 'research' must appear (route consumer reads it)
if (!/preferredExecutor:\s*['"]research['"]/.test(src)) {
  console.error('[check-research-end-to-end-routing] FAIL: research branch must set `preferredExecutor: \'research\'`')
  process.exit(1)
}

// 4. executionChain: 'domain_executor' for research routing
if (!/executionChain:\s*['"]domain_executor['"]/.test(src)) {
  console.error('[check-research-end-to-end-routing] FAIL: research branch must set `executionChain: \'domain_executor\'`')
  process.exit(1)
}

console.log('[check-research-end-to-end-routing] OK')
