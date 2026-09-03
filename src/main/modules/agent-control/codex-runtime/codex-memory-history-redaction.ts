import {
  READY_MEMORY_ADDITIONAL_CONTEXT_KEY,
  READY_MEMORY_SEARCH_TOOL_NAME,
} from '../ready-memory/ready-memory-contract'
import {
  type currentTurnReadyAdditionalContext,
  digestCanonicalJson,
  type CodexModelGatewayRequestKind,
} from './codex-model-gateway-contract'

type JsonObject = Record<string, unknown>

type ReadyMemoryCall = Readonly<{
  candidate: boolean
  callId: string | null
  valid: boolean
}>

type FunctionCallOutput = Readonly<{
  callId: string | null
  valid: boolean
}>

export type CodexMemoryHistoryRedactionEvidence = Readonly<{
  currentTurnUserIndex: number | null
  currentTurnMemorySnapshotDigest: string | null
  failClosed: boolean
  redactedItemCount: number
  redactedReadyMemoryMessageCount: number
  redactedReadyMemoryFunctionCallCount: number
  redactedReadyMemoryFunctionCallOutputCount: number
  providerInputDigest: string
  redactionDigest: string
}>

export type CodexMemoryHistoryRedactionResult = Readonly<{
  input: unknown[]
  evidence: CodexMemoryHistoryRedactionEvidence
}>

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isReadyMemoryMarker(item: unknown): boolean {
  if (!isRecord(item) || item.type !== 'message' || item.role !== 'developer') return false
  const content = item.content
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0])) return false
  const part = content[0]
  return part.type === 'input_text' && typeof part.text === 'string'
    && part.text.startsWith(`<${READY_MEMORY_ADDITIONAL_CONTEXT_KEY}>`)
    && part.text.endsWith(`</${READY_MEMORY_ADDITIONAL_CONTEXT_KEY}>`)
}

function readyMemoryCall(item: unknown): ReadyMemoryCall {
  if (!isRecord(item) || item.type !== 'function_call' || item.name !== READY_MEMORY_SEARCH_TOOL_NAME) {
    return { candidate: false, callId: null, valid: false }
  }
  const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : null
  let argumentsValid = false
  if (typeof item.arguments === 'string') {
    try {
      argumentsValid = isRecord(JSON.parse(item.arguments))
    } catch {
      argumentsValid = false
    }
  }
  const valid = Boolean(
    callId
    && argumentsValid
    && hasOnlyKeys(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status'])
    && (item.id === undefined || typeof item.id === 'string')
    && (item.status === undefined || typeof item.status === 'string'),
  )
  return { candidate: true, callId, valid }
}

function functionCallOutput(item: unknown): FunctionCallOutput {
  if (!isRecord(item) || item.type !== 'function_call_output') {
    return { callId: null, valid: false }
  }
  const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : null
  return {
    callId,
    valid: Boolean(
      callId
      && Object.hasOwn(item, 'output')
      && hasOnlyKeys(item, ['type', 'id', 'call_id', 'output', 'status'])
      && (item.id === undefined || typeof item.id === 'string')
      && (item.status === undefined || typeof item.status === 'string'),
    ),
  }
}

export function redactPriorReadyMemoryHistory(input: {
  requestKind: CodexModelGatewayRequestKind
  input: readonly unknown[]
  currentTurnContext: ReturnType<typeof currentTurnReadyAdditionalContext> | null
}): CodexMemoryHistoryRedactionResult {
  const context = input.requestKind === 'product' ? input.currentTurnContext : null
  const userIndex = context?.currentUserIndex ?? null
  const marker = { index: context?.readyMemoryIndex ?? null, payload: context?.readyMemory ?? null }
  const failClosed = userIndex === null || marker.index === null || marker.payload === null

  const calls = input.input.map(readyMemoryCall)
  const outputs = input.input.map(functionCallOutput)
  const memoryCallIds = new Set(calls.flatMap((call) => (
    call.candidate && call.callId ? [call.callId] : []
  )))
  const preservedCurrentCallIds = new Set<string>()
  if (!failClosed && userIndex !== null) {
    for (const callId of memoryCallIds) {
      const callIndexes = calls.flatMap((call, index) => (
        call.candidate && call.callId === callId ? [index] : []
      ))
      const outputIndexes = outputs.flatMap((output, index) => (
        output.callId === callId ? [index] : []
      ))
      if (
        callIndexes.length === 1
        && outputIndexes.length === 1
        && callIndexes[0] > userIndex
        && outputs[outputIndexes[0]].valid
        && calls[callIndexes[0]].valid
        && outputIndexes[0] > callIndexes[0]
      ) preservedCurrentCallIds.add(callId)
    }
  }

  const redactedItems: Array<{ index: number; kind: string; digest: string }> = []
  let redactedReadyMemoryMessageCount = 0
  let redactedReadyMemoryFunctionCallCount = 0
  let redactedReadyMemoryFunctionCallOutputCount = 0
  const providerInput = input.input.filter((item, index) => {
    let kind: string | null = null
    if (isReadyMemoryMarker(item) && (failClosed || marker.index !== index)) {
      kind = 'ready_memory_message'
      redactedReadyMemoryMessageCount += 1
    } else if (calls[index].candidate && !(
      calls[index].callId && preservedCurrentCallIds.has(calls[index].callId)
    )) {
      kind = 'ready_memory_function_call'
      redactedReadyMemoryFunctionCallCount += 1
    } else if (
      outputs[index].callId
      && memoryCallIds.has(outputs[index].callId)
      && !preservedCurrentCallIds.has(outputs[index].callId)
    ) {
      kind = 'ready_memory_function_call_output'
      redactedReadyMemoryFunctionCallOutputCount += 1
    }
    if (!kind) return true
    redactedItems.push({ index, kind, digest: digestCanonicalJson(item) })
    return false
  })
  const providerInputDigest = digestCanonicalJson(providerInput)
  const redactionDigest = digestCanonicalJson({
    contract: 'ready-memory-history-redaction:v2',
    requestKind: input.requestKind,
    currentTurnUserIndex: userIndex,
    currentTurnMemorySnapshotDigest: failClosed ? null : marker.payload?.snapshotDigest ?? null,
    failClosed,
    providerInputDigest,
    redactedItems,
  })
  return {
    input: redactedItems.length === 0 ? [...input.input] : providerInput,
    evidence: {
      currentTurnUserIndex: userIndex,
      currentTurnMemorySnapshotDigest: failClosed ? null : marker.payload?.snapshotDigest ?? null,
      failClosed,
      redactedItemCount: redactedItems.length,
      redactedReadyMemoryMessageCount,
      redactedReadyMemoryFunctionCallCount,
      redactedReadyMemoryFunctionCallOutputCount,
      providerInputDigest,
      redactionDigest,
    },
  }
}
