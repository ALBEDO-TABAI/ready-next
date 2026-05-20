import type { RecoveryRecord } from '../run-contracts'
import type { ParallelToolCall } from './tool-parallelism-policy'
import type { ToolExecutionOutput } from './tool-result-types'

export interface ToolExecutionHooks {
  onToolStart?: (event: { toolCall: ParallelToolCall }) => void
  onToolResult?: (event: { toolCall: ParallelToolCall; result: ToolExecutionOutput }) => void
  onToolRecovered?: (event: { toolCall: ParallelToolCall; result: ToolExecutionOutput; recoveryHistory: RecoveryRecord[] }) => void
  onBatchInterrupted?: (event: { startedToolCallIds: string[]; skippedToolCalls: ParallelToolCall[] }) => void
}
