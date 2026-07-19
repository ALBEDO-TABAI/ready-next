#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * Downstream consumers of `taskType` must honor the new 'research' value:
 *   1. run-budget-policy.ts  TASK_TYPE_BUDGET_PRESETS must include
 *      a `research:` key
 *   2. task-projection-sync.ts and continuation-state.ts must use the
 *      `isTaskType` helper rather than hard-coded 5-literal switches
 *      (5 was the pre-research count). The exhaustive allow-list lives in
 *      shared/task-types.ts.
 *
 * Without (1), creating a research run would fall through to the
 * 'short_task' preset (24/24) instead of the intended long-running ceiling.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    console.error(`[check-research-tasktype-downstream-consumers] FAIL: cannot read ${rel}: ${e.message}`)
    process.exit(1)
  }
}

const errors = []

// 1. run-budget-policy.ts must include research preset key.
const budgetPolicy = readFile('src/main/modules/agent-control/task-projection/run-budget-policy.ts')
const presetMatch = budgetPolicy.match(/TASK_TYPE_BUDGET_PRESETS[\s\S]*?\{([\s\S]*?)\}\n/)
if (!presetMatch) {
  errors.push('run-budget-policy.ts: TASK_TYPE_BUDGET_PRESETS literal not found')
} else if (!/\bresearch\s*:/.test(presetMatch[1])) {
  errors.push('run-budget-policy.ts: TASK_TYPE_BUDGET_PRESETS must include `research:` key')
}

// 2. task-projection-sync.ts must call isTaskType helper.
const projectionSync = readFile('src/main/modules/agent-control/task-projection/task-projection-sync.ts')
if (!/\bisTaskType\s*\(/.test(projectionSync)) {
  errors.push('task-projection-sync.ts: must use `isTaskType()` helper instead of hard-coded literals')
}

// 3. continuation-state.ts must call isTaskType helper.
const continuationState = readFile('src/main/modules/agent-control/contracts/continuation-state.ts')
if (!/\bisTaskType\s*\(/.test(continuationState)) {
  errors.push('continuation-state.ts: must use `isTaskType()` helper instead of hard-coded literals')
}

if (errors.length > 0) {
  console.error('[check-research-tasktype-downstream-consumers] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-research-tasktype-downstream-consumers] OK')
