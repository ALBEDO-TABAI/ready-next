import type { AgentInputItem } from '@openai/agents'
import type { RunMessage, TaskBudgetRuntime } from '../contracts/run-contracts'
import { consumeIterationBudget } from '../task-projection/run-budget-policy'
import {
  ROLLING_BUDGET_CHECKPOINT_TOOL_INTERVAL,
  resolveAgentSdkMaxTurns,
} from './agent-sdk-foundation-utils'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type { RunHandle } from './agent-sdk-types'

export function createModelLoopBudgetController(input: {
  providerContent: RunMessage
  requestEnvelope?: unknown
  requiresLocalDocumentWrite: boolean
  getRuntime: () => TaskBudgetRuntime | null
  setRuntime: (runtime: TaskBudgetRuntime) => void
}) {
  return {
    maxTurns(): number {
      return resolveAgentSdkMaxTurns({
        message: input.providerContent,
        requestEnvelope: input.requestEnvelope,
        requiresLocalDocumentWrite: input.requiresLocalDocumentWrite,
        taskBudgetRuntime: input.getRuntime(),
      })
    },

    consumeIterations(amount: number): number {
      const current = input.getRuntime()
      if (!current) return 0
      const remaining = Math.max(
        0,
        current.budget.maxIterations - current.usage.iterationsUsed,
      )
      const count = Math.min(remaining, Math.max(0, Math.round(amount || 0)))
      let runtime = current
      for (let index = 0; index < count; index += 1) {
        runtime = consumeIterationBudget(runtime)
      }
      input.setRuntime(runtime)
      return count
    },
  }
}

interface RollingBudgetCheckpointState {
  liveTaskBudgetRuntime: TaskBudgetRuntime | null
  lastRollingCheckpointToolCalls: number
  runMetaContinuationRef: Record<string, unknown> | null
}

export function createRollingBudgetCheckpointWriter(input: {
  state: RollingBudgetCheckpointState
  host: Pick<TurnOrchestratorHost, 'runLifecycle'>
  agentName: string
  sessionId?: string
  runId: string
  taskId: string
  runHandle: RunHandle
  usedTools: string[]
  requiredCapabilityGroups: string[]
  requiredToolNames: string[]
  lastUserMessage: string
  checkpointSnapshotProvider?: () => Promise<AgentInputItem[] | null>
  onError: (error: unknown) => void
}) {
  return async (): Promise<void> => {
    const runtime = input.state.liveTaskBudgetRuntime
    if (
      !runtime
      || runtime.warningLevel === 'exhausted'
      || runtime.usage.toolCallsUsed - input.state.lastRollingCheckpointToolCalls
        < ROLLING_BUDGET_CHECKPOINT_TOOL_INTERVAL
    ) return

    input.state.lastRollingCheckpointToolCalls = runtime.usage.toolCallsUsed
    try {
      const rolling = await input.host.runLifecycle.writeBudgetCheckpointState({
        agentName: input.agentName,
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        taskBudgetRuntime: runtime,
        runHandle: input.runHandle,
        usedTools: input.usedTools,
        requiredCapabilityGroups: input.requiredCapabilityGroups,
        requiredToolNames: input.requiredToolNames,
        lastUserMessage: input.lastUserMessage,
        resumeKind: 'snapshot',
        sessionSnapshotOverride: await input.checkpointSnapshotProvider?.() ?? null,
      })
      const continuation = rolling.projectionPatch.taskContinuation
      if (continuation && typeof continuation === 'object') {
        input.state.runMetaContinuationRef = continuation as Record<string, unknown>
      }
    } catch (error) {
      input.onError(error)
    }
  }
}
