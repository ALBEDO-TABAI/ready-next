#!/usr/bin/env node
/**
 * Stage T (T-B) gate — `parallel-branch-orchestrator.ts` must declare a
 * hard cap of 3 (`PARALLEL_BRANCH_HARD_CAP = 3 as const`), enforce that
 * cap inside `spawn(...)`, and emit `parallel_branch_hard_cap_reached`
 * metric when over-spawning is rejected.
 */
const fs = require('fs')
const path = require('path')

const TARGET = path.join(
  __dirname,
  '..',
  'src',
  'main',
  'modules',
  'agent-control',
  'runtime-core',
  'parallel-branch-orchestrator.ts',
)

const errors = []

if (!fs.existsSync(TARGET)) {
  errors.push(`missing file: ${TARGET}`)
} else {
  const src = fs.readFileSync(TARGET, 'utf8')

  // (1) hard cap constant must literally equal 3
  const capConst = /export\s+const\s+PARALLEL_BRANCH_HARD_CAP\s*=\s*3\s+as\s+const/
  if (!capConst.test(src)) {
    errors.push(
      '`PARALLEL_BRANCH_HARD_CAP` must be exported as `= 3 as const` '
        + '(literal 3). Adjust spawn() and tests together if the cap moves.',
    )
  }

  // (2) spawn() must compare active count against PARALLEL_BRANCH_HARD_CAP
  const capCheckPattern = />=\s*PARALLEL_BRANCH_HARD_CAP/
  if (!capCheckPattern.test(src)) {
    errors.push(
      'spawn() must check active count `>= PARALLEL_BRANCH_HARD_CAP` and '
        + 'reject (return null) when at the cap.',
    )
  }

  // (3) hard-cap metric emission
  const metricPattern = /['"]parallel_branch_hard_cap_reached['"]/
  if (!metricPattern.test(src)) {
    errors.push(
      'spawn() must emit metric "parallel_branch_hard_cap_reached" when '
        + 'rejecting due to hard cap (use logAgentMetric).',
    )
  }
}

if (errors.length > 0) {
  console.error('[check-parallel-branch-hard-cap] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-parallel-branch-hard-cap] OK')
