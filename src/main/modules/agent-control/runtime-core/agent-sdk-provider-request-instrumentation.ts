import type { AgentInputItem } from '@openai/agents'

import { billProviderRequestSections } from '../../../../shared/context-budget-types'
import { logAgentMetric } from '../metrics'

export type ProviderRequestBill = ReturnType<typeof billProviderRequestSections>

export interface ProviderRequestBills {
  diagnostic: ProviderRequestBill
  wire: ProviderRequestBill
}

interface ProviderRequestBillContext {
  agentName: string
  sessionId: string | null
  runId: string
  taskId: string | null
  contextWindowTokens: number
}

function metricContext(params: ProviderRequestBillContext): ProviderRequestBillContext {
  return {
    agentName: params.agentName,
    sessionId: params.sessionId,
    runId: params.runId,
    taskId: params.taskId,
    contextWindowTokens: params.contextWindowTokens
  }
}

function billModelInput(
  input: AgentInputItem[],
  instructions?: string,
  tools?: unknown[],
): ProviderRequestBill {
  const instructionItem = instructions?.trim()
    ? ([{ role: 'system', content: instructions }] as AgentInputItem[])
    : []
  return billProviderRequestSections([...instructionItem, ...input], { toolSchemas: tools })
}

export function recordProviderDiagnosticRequestBill(
  params: ProviderRequestBillContext & {
    beforeInput: AgentInputItem[]
    instructions?: string
    tools?: unknown[]
  }
): ProviderRequestBill {
  const diagnostic = billModelInput(params.beforeInput, params.instructions, params.tools)
  logAgentMetric('provider_request_bill', {
    ...metricContext(params),
    totalTokens: diagnostic.totalTokens,
    itemCount: diagnostic.itemCount,
    visionItems: diagnostic.visionItems,
    toolSchemaCount: diagnostic.toolSchemaCount,
    sections: diagnostic.sections,
    estimatedCoverage: 'instructions_input_and_tool_schemas',
    omittedSections: []
  })
  return diagnostic
}

export function recordProviderWireRequestBill(
  params: ProviderRequestBillContext & {
    diagnostic: ProviderRequestBill
    wireInput: AgentInputItem[]
    instructions?: string
    tools?: unknown[]
    compacted: boolean
  }
): ProviderRequestBills {
  const wire = billModelInput(params.wireInput, params.instructions, params.tools)
  logAgentMetric('provider_wire_request_bill', {
    ...metricContext(params),
    totalTokens: wire.totalTokens,
    itemCount: wire.itemCount,
    visionItems: wire.visionItems,
    toolSchemaCount: wire.toolSchemaCount,
    sections: wire.sections,
    compacted: params.compacted,
    savedTokens: Math.max(0, params.diagnostic.totalTokens - wire.totalTokens),
    estimatedCoverage: 'instructions_input_and_tool_schemas',
    omittedSections: []
  })
  return { diagnostic: params.diagnostic, wire }
}

export function recordProviderRequestBills(
  params: ProviderRequestBillContext & {
    beforeInput: AgentInputItem[]
    wireInput: AgentInputItem[]
    instructions?: string
    tools?: unknown[]
    compacted: boolean
  }
): ProviderRequestBills {
  const diagnostic = recordProviderDiagnosticRequestBill(params)
  return recordProviderWireRequestBill({ ...params, diagnostic })
}

export function emitProviderEstimateReconciliation(params: {
  agentName: string
  sessionId: string | null
  runId: string
  taskId: string | null
  requestIndex: number
  estimatedTokens: number
  actualInputTokens: number
  visionItems: number
}): void {
  logAgentMetric('provider_estimate_reconciliation', {
    ...params,
    ratio: params.actualInputTokens > 0 ? params.estimatedTokens / params.actualInputTokens : null
  })
}
