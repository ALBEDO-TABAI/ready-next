import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: agent task runtime wiring spans renderer and main IPC without an isolated harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('agent runtime contracts expose unified task state, recovery history, and projection store contracts', () => {
  const runContracts = readWorkspaceFile('src/main/modules/agent-control/run-contracts.ts')
  const types = readWorkspaceFile('src/main/modules/agent-control/types.ts')

  assert.match(runContracts, /export type TaskType =/)
  assert.match(runContracts, /export type TaskInteractionState =/)
  assert.match(runContracts, /export interface TaskBudget/)
  assert.match(runContracts, /export interface TaskTypeResolution/)
  assert.match(runContracts, /export interface RecoveryRecord/)
  assert.match(runContracts, /export interface ToolResourceTag/)
  assert.match(runContracts, /export interface UnifiedTaskState/)
  assert.match(runContracts, /export interface TaskProjectionRecord/)
  assert.match(runContracts, /export interface TaskProjectionStore/)

  assert.match(types, /taskType\?:/)
  assert.match(types, /interactionState\?:/)
  assert.match(types, /budgetUsagePercent\?:/)
  assert.match(types, /recoveryHistory\?:/)
  assert.match(types, /degradationReason\?:/)
  assert.match(types, /stepBudget\?:/)
  assert.match(types, /taskProjectionId\?:/)
})
