import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: agent task runtime wiring spans renderer and main IPC without an isolated harness
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('agent runtime contracts expose unified task state, recovery history, and projection store contracts', () => {
  const runContracts = readWorkspaceFile('src/main/modules/agent-control/contracts/run-contracts.ts')
  const toolTelemetryContracts = readWorkspaceFile('src/main/modules/agent-control/contracts/tool-telemetry-contracts.ts')
  const types = readWorkspaceFile('src/main/modules/agent-control/contracts/types.ts')

  assert.match(runContracts, /export type TaskType =/)
  assert.match(runContracts, /export type TaskInteractionState =/)
  assert.match(runContracts, /export interface TaskBudget/)
  assert.match(runContracts, /export interface TaskTypeResolution/)
  assert.doesNotMatch(runContracts, /export interface RecoveryRecord/)
  assert.match(toolTelemetryContracts, /export interface RecoveryRecord/)
  assert.match(toolTelemetryContracts, /export interface ToolSnapshot/)
  assert.match(runContracts, /export type \{\s*RecoveryRecord,\s*ToolSnapshot,\s*\} from '\.\/tool-telemetry-contracts'/)
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
