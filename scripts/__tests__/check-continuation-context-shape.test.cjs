'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const SCRIPT = path.resolve(__dirname, '../check-continuation-context-shape.cjs')
const VALID_HELPER = `
export function restoreContinuationTaskBudgetRuntime(params: {
  projectionBudget: TaskBudget | null
  projectionBudgetRuntime: TaskBudgetRuntime | null
}): unknown { return params }
`

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-budget-gate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const helper = path.join(root, 'src/main/modules/agent-control/task-projection/run-budget-policy.ts')
  fs.mkdirSync(path.dirname(helper), { recursive: true })
  fs.writeFileSync(helper, VALID_HELPER)
  return root
}

function run(root) {
  return spawnSync('node', [SCRIPT], { cwd: root, encoding: 'utf8' })
}

test('continuation budget gate accepts the complete declaration and call shape', (t) => {
  const root = harness(t)
  const caller = path.join(root, 'src/main/modules/caller.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `restoreContinuationTaskBudgetRuntime({ projectionBudget: null, projectionBudgetRuntime: null })`)
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('continuation budget gate rejects a missing projectionBudget declaration', (t) => {
  const root = harness(t)
  const helper = path.join(root, 'src/main/modules/agent-control/task-projection/run-budget-policy.ts')
  fs.writeFileSync(helper, `export function restoreContinuationTaskBudgetRuntime(params: { projectionBudgetRuntime: TaskBudgetRuntime | null }) {}`)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /projectionBudget required field not declared/)
})

test('continuation budget gate rejects calls without the projection snapshot', (t) => {
  const root = harness(t)
  const caller = path.join(root, 'src/main/modules/caller.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `restoreContinuationTaskBudgetRuntime({ projectionBudgetRuntime: null })`)
  const result = run(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /call_missing_projection_budget/)
})

test('continuation budget gate ignores test fixtures', (t) => {
  const root = harness(t)
  const caller = path.join(root, 'src/main/modules/__tests__/caller.test.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `restoreContinuationTaskBudgetRuntime({ projectionBudgetRuntime: null })`)
  const result = run(root)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
