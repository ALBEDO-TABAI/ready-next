#!/usr/bin/env node
/**
 * Stage R W1.6 gate.
 *
 * `'research'` must appear in three independent string-literal unions:
 *   1. run-contracts.ts  TaskTypeResolution.preferredExecutor
 *   2. run-contracts.ts  TaskExecutionRoute.executor
 *   3. shared/task-types.ts  TASK_TYPES (6 values)
 *
 * If any of these is missing the literal, the typesystem will accept
 * `'research'` at one boundary but drop it at another, creating a silent
 * drop hole in routing.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function readFile(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    console.error(`[check-research-in-all-task-route-unions] FAIL: cannot read ${rel}: ${e.message}`)
    process.exit(1)
  }
}

const errors = []

// 1. run-contracts.ts: TaskTypeResolution.preferredExecutor union must include 'research'
const runContracts = readFile('src/main/modules/agent-control/contracts/run-contracts.ts')
const preferredExecutorMatch = runContracts.match(/preferredExecutor\?\s*:\s*([^\n]+)/)
if (!preferredExecutorMatch) {
  errors.push('run-contracts.ts: TaskTypeResolution.preferredExecutor field not found')
} else if (!/['"]research['"]/.test(preferredExecutorMatch[1])) {
  errors.push('run-contracts.ts: TaskTypeResolution.preferredExecutor must include literal \'research\'')
}

// 2. run-contracts.ts: TaskExecutionRoute.executor union must include 'research'
const executorMatch = runContracts.match(/\bexecutor\s*:\s*([^\n]+)/)
if (!executorMatch) {
  errors.push('run-contracts.ts: TaskExecutionRoute.executor field not found')
} else if (!/['"]research['"]/.test(executorMatch[1])) {
  errors.push('run-contracts.ts: TaskExecutionRoute.executor must include literal \'research\'')
}

// 3. shared/task-types.ts: TASK_TYPES array must contain 'research'
const taskTypes = readFile('src/shared/task-types.ts')
if (!/TASK_TYPES\s*=\s*\[[^\]]*['"]research['"][^\]]*\]/.test(taskTypes)) {
  errors.push('shared/task-types.ts: TASK_TYPES array must include literal \'research\'')
}

if (errors.length > 0) {
  console.error('[check-research-in-all-task-route-unions] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}

console.log('[check-research-in-all-task-route-unions] OK')
