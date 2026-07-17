import { randomUUID } from 'node:crypto'
import type { MultimodalBlock } from '../contracts/run-contracts'
import type { AgentSdkExecutionOptions, AgentSdkRuntimeDeps } from './agent-sdk-types'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'

interface PendingToolConsentRetry {
  sourceRunId: string
  agentName: string
  content: string | MultimodalBlock[]
  taskId: string
  executionOptions?: AgentSdkExecutionOptions
  createdAt: number
}

export class ToolConsentRetryCoordinator {
  private readonly pending = new Map<string, PendingToolConsentRetry>()
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 10 * 60_000,
  ) {}

  remember(input: Omit<PendingToolConsentRetry, 'createdAt'> & { scopeId: string }): void {
    this.pending.set(input.scopeId, {
      sourceRunId: input.sourceRunId,
      agentName: input.agentName.includes('::')
        ? input.agentName.slice(0, input.agentName.indexOf('::'))
        : input.agentName,
      content: input.content,
      taskId: input.taskId,
      executionOptions: input.executionOptions,
      createdAt: this.now(),
    })
  }

  discard(scopeId: string): void {
    this.pending.delete(scopeId)
  }

  createDispatch(
    scopeId: string,
    dispatch: NonNullable<AgentSdkRuntimeDeps['dispatchToolConsentRetry']>,
  ): (() => void) | undefined {
    const pending = this.pending.get(scopeId)
    if (!pending || this.now() - pending.createdAt > this.ttlMs) {
      this.pending.delete(scopeId)
      return undefined
    }
    return () => {
      if (this.inFlight.has(pending.sourceRunId)) return
      this.inFlight.add(pending.sourceRunId)
      const requestId = `tool-consent-retry-${pending.sourceRunId}-${randomUUID()}`
      const runAttempt = async (attempt: number): Promise<void> => {
        try {
          const result = await dispatch({
            scopeId,
            agent: pending.agentName,
            message: pending.content,
            requestId,
            taskId: pending.taskId,
            deliveryMode: pending.executionOptions?.deliveryMode,
            runOrigin: 'continuation',
          })
          if (result && typeof result === 'object' && (result as { success?: unknown }).success === false) {
            throw new Error(String((result as { error?: unknown }).error || 'tool consent retry was rejected'))
          }
          if (this.pending.get(scopeId)?.sourceRunId === pending.sourceRunId) this.pending.delete(scopeId)
          this.inFlight.delete(pending.sourceRunId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          appendToolCapabilityLog(
            `[tool_capability] stage=tool_calling_auto_retry_failed sourceRunId=${pending.sourceRunId} attempt=${attempt} reason=${message}`
          )
          if (attempt < 3 && this.now() - pending.createdAt <= this.ttlMs) {
            const timer = setTimeout(() => { void runAttempt(attempt + 1) }, 50 * (2 ** (attempt - 1)))
            timer.unref?.()
            return
          }
          if (this.pending.get(scopeId)?.sourceRunId === pending.sourceRunId) this.pending.delete(scopeId)
          this.inFlight.delete(pending.sourceRunId)
        }
      }
      const timer = setTimeout(() => { void runAttempt(1) }, 0)
      timer.unref?.()
    }
  }
}
