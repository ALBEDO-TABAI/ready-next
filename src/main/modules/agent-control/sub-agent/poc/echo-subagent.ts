import { randomUUID } from 'node:crypto'
import type {
  SubAgent,
  SubAgentContext,
  SubAgentRunResult,
  SubAgentWorkEvent,
} from '../sub-agent-types'

export interface EchoSubAgentOptions {
  readonly messages: readonly string[]
  readonly artifactDir?: string | null
  readonly durableRunId?: string | null
  readonly name?: string
  readonly delayMs?: number
}

export function createEchoSubAgent(options: EchoSubAgentOptions): SubAgent {
  return {
    lifecycleId: `sa-${randomUUID().slice(0, 8)}`,
    durableRunId: options.durableRunId ?? null,
    subagentName: options.name ?? 'EchoSubAgent',
    artifactDir: options.artifactDir ?? null,
    async *run(context: SubAgentContext): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
      for (const message of options.messages) {
        if (context.abortSignal.aborted) {
          return {
            state: 'cancelled',
            terminalReason: 'aborted',
          }
        }
        if (options.delayMs && options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        }
        yield {
          type: 'progress',
          message,
        }
      }
      return {
        state: 'completed',
        terminalReason: 'completed',
      }
    },
  }
}
