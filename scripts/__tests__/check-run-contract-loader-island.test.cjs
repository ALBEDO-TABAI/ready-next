'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-run-contract-loader-island.cjs')

const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const LOADER_REL = 'src/main/modules/agent-control/contracts/skill-run-contract-loader.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-contract-loader-island-'))
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

export type { LoadSkillRunContractParams } from './skill-run-contract-loader'
export { buildContractFramePatch, loadSkillRunContract } from './skill-run-contract-loader'
`)
  write(root, LOADER_REL, `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadSkillRunContractParams {
  outputDir?: string | null
}

export function loadSkillRunContract(params: LoadSkillRunContractParams) {
  return params.outputDir ? readFileSync(join(params.outputDir, 'run_state.json'), 'utf8') : null
}

export function buildContractFramePatch() {
  return {}
}
`)
}

test('gate passes for split loader island with stable run-contracts re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails for the old shape where run-contracts owns fs/path and loader functions', (t) => {
  const root = makeRoot(t)
  write(root, RUN_CONTRACTS_REL, `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadSkillRunContractParams {}
export function loadSkillRunContract() { return readFileSync(join('/tmp', 'run_state.json'), 'utf8') }
export function buildContractFramePatch() { return {} }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_node_fs')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_node_path')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_loadSkillRunContract')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_buildContractFramePatch')))
})

test('gate fails when run-contracts uses bare fs/path imports', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
import fs from 'fs'
const path = await import('path')

export interface SkillRunContract {
  skillId: string
}

export type { LoadSkillRunContractParams } from './skill-run-contract-loader'
export { buildContractFramePatch, loadSkillRunContract } from './skill-run-contract-loader'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_node_fs')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_imports_node_path')))
})

test('gate fails when run-contracts forgets the value re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export interface SkillRunContract {
  skillId: string
}

export type { LoadSkillRunContractParams } from './skill-run-contract-loader'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_loader_value_reexport')))
})

test('gate fails when run-contracts forgets the type re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export interface SkillRunContract {
  skillId: string
}

export { buildContractFramePatch, loadSkillRunContract } from './skill-run-contract-loader'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_loader_type_reexport')))
})

test('gate fails when loader module does not own fs/path imports', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, LOADER_REL, `
export interface LoadSkillRunContractParams {}
export function loadSkillRunContract() { return null }
export function buildContractFramePatch() { return {} }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('loader_missing_node_fs_import')))
  assert.ok(result.errors.some((error) => error.includes('loader_missing_node_path_import')))
})

test('gate fails when loader module omits loadSkillRunContract', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, LOADER_REL, `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadSkillRunContractParams {}
export function buildContractFramePatch() { return {} }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('loader_missing_loadSkillRunContract_export')))
})

test('gate fails when loader module omits LoadSkillRunContractParams', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, LOADER_REL, `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function loadSkillRunContract() { return readFileSync(join('/tmp', 'run_state.json'), 'utf8') }
export function buildContractFramePatch() { return {} }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('loader_missing_LoadSkillRunContractParams_export')))
})

test('gate fails when loader module omits buildContractFramePatch', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, LOADER_REL, `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadSkillRunContractParams {}
export function loadSkillRunContract() { return readFileSync(join('/tmp', 'run_state.json'), 'utf8') }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('loader_missing_buildContractFramePatch_export')))
})
