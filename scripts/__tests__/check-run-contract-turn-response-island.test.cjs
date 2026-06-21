'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { check } = require('../check-run-contract-turn-response-island.cjs')

const RUN_CONTRACTS_REL = 'src/main/modules/agent-control/contracts/run-contracts.ts'
const ISLAND_REL = 'src/main/modules/agent-control/contracts/turn-response-contracts.ts'

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-contract-turn-response-island-'))
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
export interface RecoveryRecord {}
export interface ToolSnapshot {}
export type TaskInteractionState = 'running'
export interface TurnEngineHost {}
export interface TurnEngineRequest {}
export interface RunMessage {}
export interface TurnEngineSession {}

export type {
  TurnProviderContext,
  TurnSimpleResponse,
  TurnToolCall,
  TurnToolExecutionResult,
  TurnToolBatchResult,
  TurnToolCallParseError,
  TurnModelResponse,
  TurnShortcutResult,
} from './turn-response-contracts'
`)
  write(root, ISLAND_REL, `
import type { AIModelConfig } from '../../../../shared/ai-providers'
import type { RecoveryRecord, TaskInteractionState, ToolSnapshot } from './run-contracts'

export interface TurnProviderContext { config: AIModelConfig }
export interface TurnSimpleResponse { text: string }
export interface TurnToolCall { id: string; name: string; input: Record<string, unknown> }
export interface TurnToolExecutionResult { result: { text: string } }
export interface TurnToolBatchResult { results: TurnToolExecutionResult[]; recoveryHistory: RecoveryRecord[] }
export interface TurnToolCallParseError { reason: 'corrupt' }
export interface TurnModelResponse extends TurnSimpleResponse { toolCalls: TurnToolCall[]; toolSnapshots?: ToolSnapshot[] }
export interface TurnShortcutResult { interactionState?: TaskInteractionState }
`)
}

test('gate passes for split turn-response island with stable type re-export', (t) => {
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
 * old docs mentioned export interface TurnModelResponse without defining it.
 */
export interface RecoveryRecord {}
export interface ToolSnapshot {}
export type TaskInteractionState = 'running'
export type {
  TurnProviderContext,
  TurnSimpleResponse,
  TurnToolCall,
  TurnToolExecutionResult,
  TurnToolBatchResult,
  TurnToolCallParseError,
  TurnModelResponse,
  TurnShortcutResult,
} from './turn-response-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate handles unrelated type re-exports before turn-response island', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export type {
  SkillRunContract,
} from './skill-run-contract'

export type {
  TurnProviderContext,
  TurnSimpleResponse,
  TurnToolCall,
  TurnToolExecutionResult,
  TurnToolBatchResult,
  TurnToolCallParseError,
  TurnModelResponse,
  TurnShortcutResult,
} from './turn-response-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('gate fails when run-contracts still defines a moved declaration', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export interface TurnModelResponse { text: string }
export type {
  TurnProviderContext,
  TurnSimpleResponse,
  TurnToolCall,
  TurnToolExecutionResult,
  TurnToolBatchResult,
  TurnToolCallParseError,
  TurnModelResponse,
  TurnShortcutResult,
} from './turn-response-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_defines_TurnModelResponse')))
})

test('gate fails when island omits a moved declaration', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export interface TurnProviderContext {}
export interface TurnSimpleResponse {}
export interface TurnToolCall {}
export interface TurnToolExecutionResult {}
export interface TurnToolBatchResult {}
export interface TurnToolCallParseError {}
export interface TurnShortcutResult {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_missing_TurnModelResponse_export')))
})

test('gate fails when run-contracts value-exports the island', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, RUN_CONTRACTS_REL, `
export {
  TurnProviderContext,
  TurnSimpleResponse,
  TurnToolCall,
  TurnToolExecutionResult,
  TurnToolBatchResult,
  TurnToolCallParseError,
  TurnModelResponse,
  TurnShortcutResult,
} from './turn-response-contracts'
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('run_contracts_missing_turn_response_type_reexport')))
  assert.ok(result.errors.some((error) => error.includes('run_contracts_value_reexports_turn_response_contracts')))
})

test('gate fails when island imports fs or path', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
import { readFileSync } from 'node:fs'
import path from 'path'

export interface TurnProviderContext {}
export interface TurnSimpleResponse {}
export interface TurnToolCall {}
export interface TurnToolExecutionResult {}
export interface TurnToolBatchResult {}
export interface TurnToolCallParseError {}
export interface TurnModelResponse {}
export interface TurnShortcutResult {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_imports_node_fs')))
  assert.ok(result.errors.some((error) => error.includes('island_imports_path')))
})

test('gate fails when island redefines do-not-move leaves', (t) => {
  const root = makeRoot(t)
  writePassingHarness(root)
  write(root, ISLAND_REL, `
export interface RecoveryRecord {}
export interface ToolSnapshot {}
export type TaskInteractionState = 'running'
export interface TurnProviderContext {}
export interface TurnSimpleResponse {}
export interface TurnToolCall {}
export interface TurnToolExecutionResult {}
export interface TurnToolBatchResult {}
export interface TurnToolCallParseError {}
export interface TurnModelResponse {}
export interface TurnShortcutResult {}
`)
  const result = check({ root })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('island_defines_do_not_move_RecoveryRecord')))
  assert.ok(result.errors.some((error) => error.includes('island_defines_do_not_move_ToolSnapshot')))
  assert.ok(result.errors.some((error) => error.includes('island_defines_do_not_move_TaskInteractionState')))
})
