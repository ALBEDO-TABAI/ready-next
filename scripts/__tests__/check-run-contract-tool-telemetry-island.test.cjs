'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-run-contract-tool-telemetry-island.cjs')

const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/tool-telemetry-contracts.ts'
const TURN_RESPONSE_REL = 'src/main/modules/agent-control/contracts/turn-response-contracts.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-contract-tool-telemetry-island-'))
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
export type TaskInteractionState = 'running'
export interface TaskBudget {}
export interface ToolResourceTag {}

export type {
  RecoveryRecord,
  ToolSnapshot,
} from './tool-telemetry-contracts'
`)
  write(root, ISLAND_REL, `
import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'

export interface RecoveryRecord { kind: 'timeout_tool'; source: 'runtime'; message: string; attempt: number; recovered: boolean; timestamp: string }
export interface ToolSnapshot { visibleCapabilityGroupIds: CapabilityGroupId[]; suppressedCapabilityGroupIds: CapabilityGroupId[] }
`)
  write(root, TURN_RESPONSE_REL, `
import type { RecoveryRecord, ToolSnapshot } from './tool-telemetry-contracts'
import type { TaskInteractionState } from './run-contracts'

export interface TurnToolBatchResult { recoveryHistory: RecoveryRecord[] }
export interface TurnModelResponse { toolSnapshots?: ToolSnapshot[] }
export interface TurnShortcutResult { interactionState?: TaskInteractionState }
`)
}

test('gate passes for split tool telemetry island with compatibility type re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate strips comments before checking moved definitions', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
/*
 * old docs mentioned export interface RecoveryRecord without defining it.
 */
export type {
  RecoveryRecord,
  ToolSnapshot,
} from './tool-telemetry-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when run-contracts still defines ToolSnapshot', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export interface ToolSnapshot {}
export type {
  RecoveryRecord,
  ToolSnapshot,
} from './tool-telemetry-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_ToolSnapshot')))
})

test('gate fails when run-contracts omits telemetry re-export', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export type TaskInteractionState = 'running'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_tool_telemetry_type_reexport')))
})

test('gate fails when telemetry re-export omits a name', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export type {
  RecoveryRecord,
} from './tool-telemetry-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_reexport_missing_ToolSnapshot')))
})

test('gate fails when run-contracts value-exports telemetry island', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export {
  RecoveryRecord,
  ToolSnapshot,
} from './tool-telemetry-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_tool_telemetry_type_reexport')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_value_reexports_tool_telemetry_contracts')))
})

test('gate fails when island omits RecoveryRecord', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export interface ToolSnapshot {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_RecoveryRecord_export')))
})

test('gate fails when island imports fs or path', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { readFileSync } from 'node:fs'
import path from 'path'

export interface RecoveryRecord {}
export interface ToolSnapshot {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_imports_node_fs')))
  assert.ok(result.errors.some((error) => error.includes('island_imports_path')))
})

test('gate fails when island imports run-contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import type { TaskInteractionState } from './run-contracts'

export interface RecoveryRecord {}
export interface ToolSnapshot { state?: TaskInteractionState }
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_imports_run_contracts')))
})

test('gate fails when island redefines do-not-move contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export type TaskInteractionState = 'running'
export interface RecoveryRecord {}
export interface ToolSnapshot {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_defines_do_not_move_TaskInteractionState')))
})

test('gate fails when turn-response imports telemetry names from run-contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TURN_RESPONSE_REL, `
import type {
  RecoveryRecord,
  ToolSnapshot,
  TaskInteractionState,
} from './run-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('turn_response_imports_RecoveryRecord_from_run_contracts')))
  assert.ok(result.errors.some((error) => error.includes('turn_response_imports_ToolSnapshot_from_run_contracts')))
})

test('gate fails when turn-response imports aliased telemetry names from run-contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TURN_RESPONSE_REL, `
import type { ToolSnapshot as Snapshot } from './run-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('turn_response_imports_ToolSnapshot_from_run_contracts')))
})

test('gate fails when turn-response uses import type query back to run-contracts', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TURN_RESPONSE_REL, `
export interface TurnModelResponse {
  toolSnapshots?: import('./run-contracts').ToolSnapshot[]
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('turn_response_imports_ToolSnapshot_from_run_contracts')))
})

test('gate fails when turn-response uses namespace import back to run-contracts telemetry names', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, TURN_RESPONSE_REL, `
import type * as RunContracts from './run-contracts'

export interface TurnModelResponse {
  toolSnapshots?: RunContracts.ToolSnapshot[]
  recoveryHistory?: RunContracts.RecoveryRecord[]
}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('turn_response_imports_ToolSnapshot_from_run_contracts')))
  assert.ok(result.errors.some((error) => error.includes('turn_response_imports_RecoveryRecord_from_run_contracts')))
})
