import {
  Agent,
  RunContext,
  Runner,
  type AgentOutputType,
  type AgentInputItem,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type Tool
} from '@openai/agents'

import { compactAgentInputItems } from '../compaction/compact-agent-input'
import { logAgentMetric } from '../metrics'
import {
  emitProviderEstimateReconciliation,
  recordProviderDiagnosticRequestBill,
  recordProviderWireRequestBill,
  type ProviderRequestBills
} from './agent-sdk-provider-request-instrumentation'
import { extractToolCallFromStreamEvent } from './agent-sdk-provider-utils'
import type { ReadyAgentSdkRunParams, ReadyAgentSdkRunResult } from './agent-sdk-types'

function log(message: string): void {
  console.log(`[agent-sdk-provider] ${message}`)
}

export function createReadyAgentForRun(params: ReadyAgentSdkRunParams): Agent {
  return new Agent({
    name: params.agentName,
    instructions: params.instructions,
    model: params.model,
    modelSettings: { maxTokens: params.maxOutputTokens },
    tools: params.tools
  })
}

export async function resolveEnabledSdkToolsForRequest<
  TContext,
  TOutput extends AgentOutputType
>(
  agent: Agent<TContext, TOutput>,
  context: TContext | undefined
): Promise<Tool<TContext>[]> {
  return agent.getAllTools(new RunContext(context))
}

interface PendingProviderRequestBill {
  beforeInput: AgentInputItem[]
  compacted: boolean
}

function modelRequestInputItems(input: ModelRequest['input']): AgentInputItem[] {
  return typeof input === 'string'
    ? [{ role: 'user', content: input }]
    : input
}

function instrumentProviderRequests(
  provider: ModelProvider,
  onRequest: (request: ModelRequest) => void,
): ModelProvider {
  return {
    async getModel(modelName?: string): Promise<Model> {
      const model = await provider.getModel(modelName)
      const instrumented: Model = {
        getResponse(request) {
          onRequest(request)
          return model.getResponse(request)
        },
        getStreamedResponse(request) {
          onRequest(request)
          return model.getStreamedResponse(request)
        },
      }
      if (model.getRetryAdvice) {
        instrumented.getRetryAdvice = (args) => model.getRetryAdvice!(args)
      }
      return instrumented
    },
  }
}

export async function runWithOpenAIAgentsSdk(
  params: ReadyAgentSdkRunParams
): Promise<ReadyAgentSdkRunResult> {
  const requestBills: ProviderRequestBills[] = []
  const pendingRequestBills: PendingProviderRequestBill[] = []
  const agent = createReadyAgentForRun(params)
  const billContext = {
    agentName: params.agentName,
    sessionId: params.sessionId || null,
    runId: params.runId,
    taskId: params.taskId || null,
    contextWindowTokens: params.contextWindowTokens,
  }
  const modelProvider = instrumentProviderRequests(params.provider, (request) => {
    const pending = pendingRequestBills.shift()
    if (!pending) return
    const configuredToolSchemaCount = params.tools.length
    const diagnostic = recordProviderDiagnosticRequestBill({
      ...billContext,
      beforeInput: pending.beforeInput,
      instructions: request.systemInstructions,
      tools: request.tools,
      configuredToolSchemaCount,
    })
    requestBills.push(recordProviderWireRequestBill({
      ...billContext,
      diagnostic,
      wireInput: modelRequestInputItems(request.input),
      instructions: request.systemInstructions,
      tools: request.tools,
      configuredToolSchemaCount,
      compacted: pending.compacted,
    }))
  })
  const runner = new Runner({
    modelProvider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: 'Ready Agent SDK Runtime',
    groupId: params.sessionId
  })
  const stream = await runner.run(agent, params.input, {
    stream: true,
    signal: params.signal,
    session: params.session,
    maxTurns: params.maxTurns,
    callModelInputFilter: async ({ modelData }) => {
      const result = await compactAgentInputItems(modelData.input, {
        windowTokens: params.contextWindowTokens
      })
      const filteredItems = params.callModelInputFilter
        ? await params.callModelInputFilter(result.items, {
            sourceItems: modelData.input,
            compacted: result.compacted,
          })
        : result.items
      pendingRequestBills.push({
        beforeInput: modelData.input,
        compacted: result.compacted,
      })
      if (!result.compacted && filteredItems === modelData.input) return modelData
      logAgentMetric('agent_sdk_auto_context_compacted', {
        agentName: params.agentName,
        sessionId: params.sessionId || null,
        runId: params.runId,
        taskId: params.taskId,
        contextWindowTokens: params.contextWindowTokens,
        beforeTokens: result.report.beforeTokens,
        afterTokens: result.report.afterTokens,
        droppedItems: result.report.droppedItems,
        truncatedToolResults: result.report.truncatedToolResults,
        summarized: result.report.summarized,
        itemsBefore: modelData.input.length,
        itemsAfter: result.items.length
      })
      log(
        `auto context compacted agent=${params.agentName} run=${params.runId} before=${result.report.beforeTokens} after=${result.report.afterTokens} dropped=${result.report.droppedItems} truncated=${result.report.truncatedToolResults}`
      )
      return { ...modelData, input: filteredItems }
    },
    toolExecution: {
      maxFunctionToolConcurrency: 1
    }
  })
  try {
    try {
      for await (const event of stream) {
        if (
          event.type === 'raw_model_stream_event' &&
          event.data.type === 'output_text_delta' &&
          typeof event.data.delta === 'string'
        ) {
          params.onTextDelta(event.data.delta)
          continue
        }
        const toolCall = extractToolCallFromStreamEvent(event)
        if (toolCall) log(`sdk tool_called name=${toolCall.name}`)
      }
      await stream.completed
      if (stream.error) throw stream.error
    } finally {
      const streamLoopPromise = (
        stream as { _getStreamLoopPromise?: () => Promise<unknown> }
      )._getStreamLoopPromise?.()
      if (streamLoopPromise) await streamLoopPromise
    }
  } catch (error) {
    if (error && typeof error === 'object') {
      ;(error as { iterationsUsed?: number }).iterationsUsed = Math.max(
        Number((error as { iterationsUsed?: unknown }).iterationsUsed || 0),
        requestBills.length,
        stream.rawResponses.length
      )
    }
    throw error
  }
  const rawResponses = stream.rawResponses
  rawResponses.forEach((response, index) => {
    const bill = requestBills[index]?.wire
    if (!bill || !response?.usage) return
    emitProviderEstimateReconciliation({
      agentName: params.agentName,
      sessionId: params.sessionId || null,
      runId: params.runId,
      taskId: params.taskId || null,
      requestIndex: index,
      estimatedTokens: bill.totalTokens,
      actualInputTokens: Number(response.usage.inputTokens || 0),
      visionItems: bill.visionItems
    })
  })
  return {
    finalText: typeof stream.finalOutput === 'string' ? stream.finalOutput : '',
    iterationsUsed: rawResponses.length,
    usage: usageFromModelResponses(rawResponses),
    lastResponseId: stream.lastResponseId
  }
}

/** One SDK run may call the provider multiple times around tool execution.
 * Budgets and performance evidence must count every request, not only the
 * final response. */
export function usageFromModelResponses(
  responses: readonly ModelResponse[]
): ReadyAgentSdkRunResult['usage'] {
  let inputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let lastRequestInputTokens: number | undefined
  let sawUsage = false
  for (const response of responses) {
    const current = usageFromModelResponse(response)
    if (!current) continue
    sawUsage = true
    inputTokens += current.inputTokens
    outputTokens += current.outputTokens
    totalTokens += current.totalTokens
    lastRequestInputTokens = current.inputTokens
  }
  return sawUsage
    ? { inputTokens, outputTokens, totalTokens, lastRequestInputTokens }
    : undefined
}

export function usageFromModelResponse(
  response: ModelResponse | undefined
): ReadyAgentSdkRunResult['usage'] {
  if (!response?.usage) return undefined
  return {
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens
  }
}
