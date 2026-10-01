import { Agent, Runner, MaxTurnsExceededError, type ModelResponse } from '@openai/agents'

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
import { isProviderOutputIncomplete, ProviderOutputIncompleteError, ProviderOutputMissingTextError } from './provider-output-status'

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

export async function runWithOpenAIAgentsSdk(
  params: ReadyAgentSdkRunParams
): Promise<ReadyAgentSdkRunResult> {
  const requestBills: ProviderRequestBills[] = []
  let outputIncomplete = false
  let lastTerminal: { id: string; providerData: Record<string, unknown> | undefined } | null = null
  const agent = createReadyAgentForRun(params)
  const runner = new Runner({
    modelProvider: params.provider,
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
      const billContext = {
        agentName: params.agentName,
        sessionId: params.sessionId || null,
        runId: params.runId,
        taskId: params.taskId || null,
        contextWindowTokens: params.contextWindowTokens
      }
      const diagnostic = recordProviderDiagnosticRequestBill({
        ...billContext,
        beforeInput: modelData.input,
        instructions: modelData.instructions,
        tools: params.tools
      })
      const result = await compactAgentInputItems(modelData.input, {
        windowTokens: params.contextWindowTokens
      })
      const wireInput = result.compacted ? result.items : modelData.input
      requestBills.push(
        recordProviderWireRequestBill({
          ...billContext,
          diagnostic,
          wireInput,
          instructions: modelData.instructions,
          tools: params.tools,
          compacted: result.compacted
        })
      )
      if (!result.compacted) return modelData
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
      return { ...modelData, input: result.items }
    },
    toolExecution: {
      maxFunctionToolConcurrency: 1
    }
  })
  try {
    try {
      for await (const event of stream) {
        if (event.type === 'raw_model_stream_event' && event.data.type === 'response_done') {
          lastTerminal = { id: event.data.response.id, providerData: event.data.response.providerData }
          outputIncomplete = isProviderOutputIncomplete(event.data.response.providerData)
        }
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
    // A one-shot response may contain only reasoning; the SDK then hits its turn cap before returning a result.
    // A later started request without its own receipt must never inherit the previous response's terminal facts.
    if (!params.signal.aborted && params.maxTurns === 1 && params.tools.length === 0 && error instanceof MaxTurnsExceededError
      && requestBills.length === stream.rawResponses.length && lastTerminal?.id
      && lastTerminal.id === stream.rawResponses.at(-1)?.responseId) {
      if (outputIncomplete) error = new ProviderOutputIncompleteError()
      else if (lastTerminal.providerData?.status === 'completed') error = new ProviderOutputMissingTextError()
    }
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
  const lastResponse = rawResponses[rawResponses.length - 1]
  return {
    finalText: typeof stream.finalOutput === 'string' ? stream.finalOutput : '',
    outputIncomplete,
    iterationsUsed: rawResponses.length,
    usage: usageFromModelResponse(lastResponse),
    lastResponseId: stream.lastResponseId
  }
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
