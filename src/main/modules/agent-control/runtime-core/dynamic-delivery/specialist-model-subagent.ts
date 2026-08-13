import { MemorySession, type ModelProvider } from '@openai/agents'
import type { WorkerReport } from '../../quality/worker-report'
import { parseWorkerReportJson } from '../../quality/worker-report'
import type { SubAgent, SubAgentContext, SubAgentRunResult, SubAgentWorkEvent } from '../../sub-agent/sub-agent-types'
import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from '../agent-sdk-types'
import { buildSpecialistWorkerPrompt, type SpecialistWorkerInput } from './worker-input'
import { assertWorkerResourceBundle } from './worker-resource-bundle'

export interface WorkerExecutionResult {
  report: WorkerReport
  usage: ReadyAgentSdkRunResult['usage']
  durationMs: number
}

export class SpecialistModelSubAgent implements SubAgent {
  readonly artifactDir = null
  readonly durableRunId = null

  constructor(
    readonly lifecycleId: string,
    readonly subagentName: string,
    private readonly input: SpecialistWorkerInput,
    private readonly host: {
      runAgent: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
      provider: ModelProvider
      model: string
      contextWindowTokens: number
      maxOutputTokens: number
    },
  ) {}

  // eslint-disable-next-line require-yield -- retired one-shot worker returns only its terminal result
  async *run(context: SubAgentContext): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult, void> {
    assertWorkerResourceBundle(this.input.resourceBundle)
    if (context.userRequestVerbatim !== undefined && context.userRequestVerbatim !== this.input.userRequestVerbatim) {
      throw new Error('[dynamic-delivery] subagent context verbatim does not match the work package')
    }
    const startedAt = Date.now()
    const result = await this.host.runAgent({
      agentName: this.subagentName,
      runId: this.input.binding.runId,
      taskId: this.input.workPackage.packageId,
      sessionId: this.lifecycleId,
      input: buildSpecialistWorkerPrompt(this.input),
      instructions: 'Return only the strict WorkerReport JSON. Do not call tools or claim host-owned proof.',
      model: this.host.model,
      provider: this.host.provider,
      session: new MemorySession({ sessionId: this.lifecycleId }),
      tools: [],
      signal: context.abortSignal,
      maxTurns: 1,
      contextWindowTokens: this.host.contextWindowTokens,
      maxOutputTokens: this.host.maxOutputTokens,
      onTextDelta: () => undefined,
    })
    const execution: WorkerExecutionResult = {
      report: parseWorkerReportJson(result.finalText),
      usage: result.usage,
      durationMs: Date.now() - startedAt,
    }
    return {
      state: 'completed',
      terminalReason: 'completed',
      metadata: { workerExecution: execution },
    }
  }
}
