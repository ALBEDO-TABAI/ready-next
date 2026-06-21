'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-run-contract-skill-contract-island.cjs')

const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/skill-run-contract.ts'
const LOADER_REL = 'src/main/modules/agent-control/contracts/skill-run-contract-loader.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-contract-skill-contract-island-'))
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
import type { SkillRunContract } from './skill-run-contract'

export interface TaskProjectionRecord {
  status: SkillRunContract['status'] | null
}

export type { SkillRunContract } from './skill-run-contract'
export type { LoadSkillRunContractParams } from './skill-run-contract-loader'
export { buildContractFramePatch, loadSkillRunContract } from './skill-run-contract-loader'
`)
  write(root, ISLAND_REL, `
import type { TurnFrame } from '../runtime-core/turn-frame'

export interface SkillRunContract {
  skillId: string
  status: 'running' | 'completed'
  liveness: TurnFrame['liveness']
}
`)
  write(root, LOADER_REL, `
import type { TaskProjectionRecord } from './run-contracts'
import type { SkillRunContract } from './skill-run-contract'

export interface LoadSkillRunContractParams {
  projectionSibling?: TaskProjectionRecord | null
}

export function loadSkillRunContract(): SkillRunContract | null {
  return null
}

export function buildContractFramePatch() {
  return {}
}
`)
}

test('gate passes for split SkillRunContract island with stable type re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate strips comments before checking old declaration names', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
/*
 * old docs mentioned export interface SkillRunContract without defining it.
 */
export type { SkillRunContract } from './skill-run-contract'
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when run-contracts still defines SkillRunContract', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export interface SkillRunContract {
  skillId: string
}

export type { SkillRunContract } from './skill-run-contract'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_SkillRunContract')))
})

test('gate fails when run-contracts forgets the SkillRunContract type re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export type { LoadSkillRunContractParams } from './skill-run-contract-loader'
export { buildContractFramePatch, loadSkillRunContract } from './skill-run-contract-loader'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_SkillRunContract_type_reexport')))
})

test('gate fails when island omits the exported SkillRunContract interface', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export interface OtherContract {
  skillId: string
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_SkillRunContract_export')))
})

test('gate fails when island imports fs or path', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { readFileSync } from 'node:fs'
const pathModule = require('path')

export interface SkillRunContract {
  skillId: string
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_imports_node_fs')))
  assert.ok(result.errors.some((error) => error.includes('island_imports_path')))
})

test('gate fails when island owns loader functions', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export interface SkillRunContract {
  skillId: string
}

export function loadSkillRunContract() {
  return null
}

function buildContractFramePatch() {
  return {}
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_defines_loadSkillRunContract')))
  assert.ok(result.errors.some((error) => error.includes('island_defines_buildContractFramePatch')))
})

test('gate fails when loader imports SkillRunContract from run-contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, LOADER_REL, `
import type { SkillRunContract, TaskProjectionRecord } from './run-contracts'

export interface LoadSkillRunContractParams {
  projectionSibling?: TaskProjectionRecord | null
}

export function loadSkillRunContract(): SkillRunContract | null {
  return null
}

export function buildContractFramePatch() {
  return {}
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('loader_imports_SkillRunContract_from_run_contracts')))
})

test('gate fails when loader aliases SkillRunContract from run-contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, LOADER_REL, `
import type {
  SkillRunContract as Contract,
  TaskProjectionRecord,
} from './run-contracts'

export interface LoadSkillRunContractParams {
  projectionSibling?: TaskProjectionRecord | null
}

export function loadSkillRunContract(): Contract | null {
  return null
}

export function buildContractFramePatch() {
  return {}
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('loader_imports_SkillRunContract_from_run_contracts')))
})
