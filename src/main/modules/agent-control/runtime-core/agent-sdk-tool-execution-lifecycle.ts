import type { AgentSdkPreparedTurnState } from './agent-sdk-turn-execution-types'
import type { ToolBridgeRuntimeContext } from './agent-sdk-types'
import type { DynamicDeliveryDeadlineHandle } from './dynamic-delivery/delivery-deadline'

export function createAgentSdkToolExecutionLifecycle(input: {
  runId: string
  abortController: AbortController
  deliveryDeadline: DynamicDeliveryDeadlineHandle
  state: AgentSdkPreparedTurnState
}): Pick<ToolBridgeRuntimeContext, 'beginToolExecution' | 'endToolExecution'> {
  let sequence = 0
  const snapshots = new Map<string, {
    toolName: string
    args: Record<string, unknown>
    startedAtMs: number
    expectedTimeoutMs: number
    deadlineToken: string
  }>()

  return {
    beginToolExecution(definition, args) {
      const expectedTimeoutMs = Math.max(1, definition.executionTimeoutMs ?? 15_000)
      const deadlineToken = input.deliveryDeadline.beginToolExecution({
        toolName: definition.name,
        expectedTimeoutMs,
      })
      const token = deadlineToken || `${input.runId}:tool-local:${++sequence}`
      snapshots.set(token, {
        toolName: definition.name,
        args,
        startedAtMs: Date.now(),
        expectedTimeoutMs,
        deadlineToken,
      })
      return token
    },
    endToolExecution(token, error) {
      const snapshot = snapshots.get(token)
      if (!snapshot) return
      snapshots.delete(token)
      if (snapshot.deadlineToken) input.deliveryDeadline.endToolExecution(snapshot.deadlineToken)
      const abortDetail = `${error instanceof Error ? error.message : String(error || '')}\n${
        input.abortController.signal.reason instanceof Error
          ? input.abortController.signal.reason.message
          : String(input.abortController.signal.reason || '')
      }`
      if (error && /delivery_wall_clock_exceeded/.test(abortDetail)) {
        input.state.interruptedToolExecution = {
          toolName: snapshot.toolName,
          args: snapshot.args,
          startedAtMs: snapshot.startedAtMs,
          expectedTimeoutMs: snapshot.expectedTimeoutMs,
        }
      }
    },
  }
}
