'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '../check-task-card-single-source.cjs')

function runIn(cwd) {
  return spawnSync('node', [SCRIPT], { cwd, encoding: 'utf8' })
}

function makeHarnessRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l6-gate-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeRendererFile(rootDir, rel, body) {
  const p = path.join(rootDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

const VALID_HELPER_FILE = `
const TASK_CARD_BRAND: unique symbol = Symbol('TaskCardRun')
export interface TaskCardRun { readonly __brand?: typeof TASK_CARD_BRAND; taskId: string }
export function taskProjectionToTaskCardRun(base: any): TaskCardRun {
  return { ...base, __brand: TASK_CARD_BRAND } as TaskCardRun
}
`

function writeValidHelper(rootDir) {
  writeRendererFile(rootDir, 'src/renderer/components/agent/task-card-from-projection.ts', VALID_HELPER_FILE)
}

const VALID_DEBUG_ROW = `
/**
 * Stage 6 debug-only synthesis. control-only — do not promote to primary task source.
 */
function activeChildRunDebugRow(row: any) {
  return null
}
export { activeChildRunDebugRow }
`

test('L6 gate passes when only the debug-named function exists with proper doc', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHelper(root)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', VALID_DEBUG_ROW)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L6 gate fails when the legacy synthesis name appears', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', `
${VALID_DEBUG_ROW}

function activeChildRunToTaskRun(row: any) { return null }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /legacy_synthesis_name/)
})

test('L6 gate fails when no debug-named function exists at all', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', `// nothing here\n`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /debug_synthesis_missing/)
})

test('L6 gate fails when debug-named function lacks a "debug" + "control-only" doc', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', `
function activeChildRunDebugRow(row: any) { return null }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /debug_synthesis_doc_missing/)
})

test('L6 gate ignores test files', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHelper(root)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', VALID_DEBUG_ROW)
  writeRendererFile(root, 'src/renderer/__tests__/some.test.tsx', `
function activeChildRunToTaskRun(row: any) { return null }
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L6 gate fails when activeChildRunDebugRow is called without projection-coverage guard', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', `
${VALID_DEBUG_ROW}

function consumer(rows: any[]) {
  for (const row of rows) {
    const card = activeChildRunDebugRow(row, 'scope')
    if (card) merged.set(card.taskId, card)
  }
}
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unguarded_debug_call/)
})

test('L6 gate passes when activeChildRunDebugRow call is preceded by projectionsCoverChildRunId guard', (t) => {
  const root = makeHarnessRoot(t)
  writeValidHelper(root)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', `
${VALID_DEBUG_ROW}

function consumer(rows: any[]) {
  const projectionsCoverChildRunId = (id: string) => false
  for (const row of rows) {
    if (projectionsCoverChildRunId(row.childRunId)) continue
    const card = activeChildRunDebugRow(row, 'scope')
    if (card) merged.set(card.taskId, card)
  }
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('L6 gate fails when TASK_CARD_BRAND appears outside helper file', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', VALID_DEBUG_ROW)
  // Helper exists with brand declared
  writeRendererFile(root, 'src/renderer/components/agent/task-card-from-projection.ts', `
const TASK_CARD_BRAND: unique symbol = Symbol('TaskCardRun')
export interface TaskCardRun { __brand?: typeof TASK_CARD_BRAND }
`)
  // Some OTHER file references TASK_CARD_BRAND — forbidden
  writeRendererFile(root, 'src/renderer/components/agent/some-rogue.ts', `
const TASK_CARD_BRAND = 'fake'
export const v = TASK_CARD_BRAND
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /task_card_brand_outside_helper/)
})

test('L6 gate fails when helper file lacks brand declaration', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', VALID_DEBUG_ROW)
  writeRendererFile(root, 'src/renderer/components/agent/task-card-from-projection.ts', `
export interface TaskCardRun { taskId: string }
export function taskProjectionToTaskCardRun(): TaskCardRun { return { taskId: '' } }
`)
  const r = runIn(root)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /brand_declaration_missing/)
})

test('L6 gate passes when brand lives only in helper file', (t) => {
  const root = makeHarnessRoot(t)
  writeRendererFile(root, 'src/renderer/components/agent/ChatPanel.tsx', VALID_DEBUG_ROW)
  writeRendererFile(root, 'src/renderer/components/agent/task-card-from-projection.ts', `
const TASK_CARD_BRAND: unique symbol = Symbol('TaskCardRun')
export interface TaskCardRun { __brand?: typeof TASK_CARD_BRAND; taskId: string }
export function taskProjectionToTaskCardRun(base: any): TaskCardRun {
  return { ...base, __brand: TASK_CARD_BRAND } as TaskCardRun
}
`)
  const r = runIn(root)
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
