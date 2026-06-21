'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-run-contract-frame-patch-island.cjs')

const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/skill-frame-patch-tool-names.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-contract-frame-patch-island-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function writePassingHarness(root) {
  write(root, RUN_CONTRACTS_REL, `
export interface SkillRunContract {
  skillId: string
}

export { FRAME_PATCH_EMITTING_TOOL_NAMES, isFramePatchEmittingToolName } from './skill-frame-patch-tool-names'
`)
  write(root, ISLAND_REL, `
export const FRAME_PATCH_EMITTING_TOOL_NAMES = [
  'skill_inspect_run_state',
] as const

export function isFramePatchEmittingToolName(toolName) {
  return FRAME_PATCH_EMITTING_TOOL_NAMES.includes(toolName)
}
`)
}

test('gate passes for split frame-patch island with stable run-contracts re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate strips comments before checking old definition names', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
/*
 * old docs mentioned const FRAME_PATCH_EMITTING_TOOL_NAMES
 * and function isFramePatchEmittingToolName without defining them.
 */
export { FRAME_PATCH_EMITTING_TOOL_NAMES, isFramePatchEmittingToolName } from './skill-frame-patch-tool-names'
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails for old shape where run-contracts owns both exports', (t) => {
  const root = makeRoot(t)
  write(root, RUN_CONTRACTS_REL, `
export const FRAME_PATCH_EMITTING_TOOL_NAMES = ['skill_inspect_run_state'] as const
export function isFramePatchEmittingToolName(toolName) {
  return FRAME_PATCH_EMITTING_TOOL_NAMES.includes(toolName)
}
`)
  write(root, ISLAND_REL, '')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_FRAME_PATCH_EMITTING_TOOL_NAMES')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_isFramePatchEmittingToolName')))
})

test('gate fails when run-contracts keeps non-exported local definitions', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export { FRAME_PATCH_EMITTING_TOOL_NAMES, isFramePatchEmittingToolName } from './skill-frame-patch-tool-names'

const FRAME_PATCH_EMITTING_TOOL_NAMES = ['skill_inspect_run_state'] as const
function isFramePatchEmittingToolName(toolName) {
  return FRAME_PATCH_EMITTING_TOOL_NAMES.includes(toolName)
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_FRAME_PATCH_EMITTING_TOOL_NAMES')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_isFramePatchEmittingToolName')))
})

test('gate fails when run-contracts re-adds predicate as a const arrow function', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export { FRAME_PATCH_EMITTING_TOOL_NAMES, isFramePatchEmittingToolName } from './skill-frame-patch-tool-names'

const isFramePatchEmittingToolName = (toolName) => toolName.startsWith('skill_')
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_isFramePatchEmittingToolName')))
})

test('gate fails when run-contracts forgets the value re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export interface SkillRunContract {
  skillId: string
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_frame_patch_reexport')))
})

test('gate fails when island omits FRAME_PATCH_EMITTING_TOOL_NAMES', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export function isFramePatchEmittingToolName(toolName) {
  return toolName === 'skill_inspect_run_state'
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_FRAME_PATCH_EMITTING_TOOL_NAMES_export')))
})

test('gate fails when island omits isFramePatchEmittingToolName', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export const FRAME_PATCH_EMITTING_TOOL_NAMES = [
  'skill_inspect_run_state',
] as const
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_isFramePatchEmittingToolName_export')))
})
