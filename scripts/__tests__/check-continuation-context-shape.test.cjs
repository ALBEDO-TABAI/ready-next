'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-continuation-context-shape.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l4-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeHelper(rootDir, body) {
  const p = path.join(rootDir, 'src/main/modules/agent-control/run-budget-policy.ts')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

function writeRouter(rootDir, body) {
  const p = path.join(rootDir, 'src/main/modules/agent-control/task-execution-router.ts')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

const VALID_HELPER = `
export function restoreContinuationTaskBudgetRuntime(params: {
  taskType: any
  projectionBudget: TaskBudget | null
  projectionBudgetRuntime: TaskBudgetRuntime | null
  budget?: any
  continuationState?: any
}): any {
  return null
}
`

const VALID_ROUTER = `
export function resolveTaskExecutionRoute(params: {
  taskId: string
  continuationContext: {
    state: any | null
    projection: any | null
  } | null
}) {
  return null
}
`

test('L4 gate passes when declaration has both fields and no callers', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L4 gate fails when declaration missing projectionBudget', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, `
export function restoreContinuationTaskBudgetRuntime(params: {
  taskType: any
  projectionBudgetRuntime: TaskBudgetRuntime | null
}): any { return null }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /projectionBudget required field not declared/)
})

test('L4 gate fails when a caller omits projectionBudget at top level', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/some-caller.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function bad() {
  return restoreContinuationTaskBudgetRuntime({
    taskType: 'continuation',
    continuationState: state,
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /call_missing_projection_budget/)
})

test('L4 gate passes when a caller passes projectionBudget at top level', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/some-caller.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function good() {
  return restoreContinuationTaskBudgetRuntime({
    taskType: 'continuation',
    projectionBudget: null,
    projectionBudgetRuntime: null,
    continuationState: state,
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L4 gate rejects nested-only projectionBudget keys', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/sneaky.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function sneaky() {
  return restoreContinuationTaskBudgetRuntime({
    taskType: 'continuation',
    continuationState: { projectionBudget: someBudget },
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /call_missing_projection_budget/)
})

test('L4 gate handles multiline calls correctly', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/multiline.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function multilined() {
  return restoreContinuationTaskBudgetRuntime(
    {
      taskType:
        'continuation',
      projectionBudget:
        someProjection?.budget ?? null,
      projectionBudgetRuntime: null,
    },
  )
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L4 gate ignores test files', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const testFile = path.join(root, 'src/main/modules/agent-control/__tests__/some.test.ts')
  fs.mkdirSync(path.dirname(testFile), { recursive: true })
  fs.writeFileSync(testFile, `
export function badButInTest() {
  return restoreContinuationTaskBudgetRuntime({
    taskType: 'continuation',
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L4 gate fails when router still uses legacy currentTaskContext field', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, `
export function resolveTaskExecutionRoute(params: {
  taskId: string
  currentTaskContext?: { foo: any } | null
}) {
  return null
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /router_legacy_field|router_declaration_missing/)
})

test('L4 gate fails when router declaration is missing continuationContext', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, `
export function resolveTaskExecutionRoute(params: {
  taskId: string
}) {
  return null
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /router_declaration_missing/)
})

test('L4 gate fails when caller of resolveTaskExecutionRoute omits continuationContext', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/some-caller.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function bad() {
  return resolveTaskExecutionRoute({
    taskId: 'x',
    capabilities: caps,
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /call_missing_continuation_context/)
})

test('L4 gate passes when caller of resolveTaskExecutionRoute includes continuationContext', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/some-caller.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function good() {
  return resolveTaskExecutionRoute({
    taskId: 'x',
    continuationContext: null,
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L4 gate fails when continuationContext literal is missing the projection key', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/half.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function half() {
  return resolveTaskExecutionRoute({
    taskId: 'x',
    continuationContext: {
      state: someState,
    },
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /continuationContext_inner_pair_incomplete/)
})

test('L4 gate fails when continuationContext literal is missing the state key', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/half2.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function half() {
  return resolveTaskExecutionRoute({
    taskId: 'x',
    continuationContext: {
      projection: someProjection,
    },
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /continuationContext_inner_pair_incomplete/)
})

test('L4 gate passes paired continuationContext literal', (t) => {
  const root = makeHarnessRoot(t)
  writeHelper(root, VALID_HELPER)
  writeRouter(root, VALID_ROUTER)
  const caller = path.join(root, 'src/main/modules/agent-control/paired.ts')
  fs.mkdirSync(path.dirname(caller), { recursive: true })
  fs.writeFileSync(caller, `
export function paired() {
  return resolveTaskExecutionRoute({
    taskId: 'x',
    continuationContext: {
      state: null,
      projection: null,
    },
  })
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
