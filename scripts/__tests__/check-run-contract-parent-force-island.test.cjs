'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-run-contract-parent-force-island.cjs')

const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/skill-parent-force-fence.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-contract-parent-force-island-'))
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

export { shouldParentForceLongSkillTool, isParentForceForbiddenByManifest } from './skill-parent-force-fence'
`)
  write(root, ISLAND_REL, `
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

export function shouldParentForceLongSkillTool(contract) {
  return !contract?.childRunId
}

export function isParentForceForbiddenByManifest(toolName) {
  const entry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
  return !!entry && isConfiguredChildLoopSkillAction(entry.skillId, entry.actionName)
}
`)
}

test('gate passes for split parent-force island with stable run-contracts re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails for old shape where run-contracts owns both helpers and imports', (t) => {
  const root = makeRoot(t)
  write(root, RUN_CONTRACTS_REL, `
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

export function shouldParentForceLongSkillTool(contract) { return !contract?.childRunId }
export function isParentForceForbiddenByManifest(toolName) {
  const entry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
  return !!entry && isConfiguredChildLoopSkillAction(entry.skillId, entry.actionName)
}
`)
  write(root, ISLAND_REL, '')
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_shouldParentForceLongSkillTool')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_isParentForceForbiddenByManifest')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_skills-tools-static')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_child-loop-skill-actions')))
})

test('gate fails when run-contracts keeps non-exported local helper definitions', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export { shouldParentForceLongSkillTool, isParentForceForbiddenByManifest } from './skill-parent-force-fence'

function shouldParentForceLongSkillTool(contract) { return !contract?.childRunId }
function isParentForceForbiddenByManifest(toolName) { return toolName === 'x' }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_shouldParentForceLongSkillTool')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_isParentForceForbiddenByManifest')))
})

test('gate fails when run-contracts keeps a skills-tools import after the move', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
import { isChildLoopSkillAction } from '../../tools/skills-tools'

export { shouldParentForceLongSkillTool, isParentForceForbiddenByManifest } from './skill-parent-force-fence'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_skills-tools')))
})

test('gate fails when run-contracts keeps the child-loop action import after the move', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

export { shouldParentForceLongSkillTool, isParentForceForbiddenByManifest } from './skill-parent-force-fence'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_child-loop-skill-actions')))
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
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_parent_force_reexport')))
})

test('gate fails when island omits shouldParentForceLongSkillTool', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

export function isParentForceForbiddenByManifest(toolName) {
  const entry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
  return !!entry && isConfiguredChildLoopSkillAction(entry.skillId, entry.actionName)
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_shouldParentForceLongSkillTool_export')))
})

test('gate fails when island omits isParentForceForbiddenByManifest', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

export function shouldParentForceLongSkillTool(contract) {
  return !contract?.childRunId
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_isParentForceForbiddenByManifest_export')))
})

test('gate fails when island does not own the static skill action import', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'

export function shouldParentForceLongSkillTool(contract) {
  return !contract?.childRunId
}

export function isParentForceForbiddenByManifest(toolName) {
  return isConfiguredChildLoopSkillAction('x', toolName)
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_static_skill_actions_import')))
})

test('gate fails when island does not own the child-loop action import', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'

export function shouldParentForceLongSkillTool(contract) {
  return !contract?.childRunId
}

export function isParentForceForbiddenByManifest(toolName) {
  return !!STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_child_loop_action_import')))
})
