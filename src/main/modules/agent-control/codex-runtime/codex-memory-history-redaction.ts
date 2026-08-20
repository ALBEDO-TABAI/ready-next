import {
  parseReadyMemoryPromptText,
  READY_MEMORY_ADDITIONAL_CONTEXT_KEY,
  READY_MEMORY_SEARCH_TOOL_NAME,
  type ReadyMemoryPromptPayload,
} from '../ready-memory/ready-memory-contract'
import {
  currentTurnReadyAdditionalContext,
  digestCanonicalJson,
  type CodexModelGatewayRequestKind,
} from './codex-model-gateway-contract'

type JsonObject = Record<string, unknown>

type ReadyMemoryMarker = Readonly<{
  candidate: boolean
  payload: ReadyMemoryPromptPayload | null
  valid: boolean
}>

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

function readyMemoryMarker(item: unknown): ReadyMemoryMarker {
  if (!isRecord(item) || item.type !== 'message' || item.role !== 'developer') {
    return { candidate: false, payload: null, valid: false }
  }
  const content = item.content
  if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0])) {
    return { candidate: false, payload: null, valid: false }
  }
  const part = content[0]
  if (part.type !== 'input_text' || typeof part.text !== 'string') {
    return { candidate: false, payload: null, valid: false }
  }
  const open = `<${READY_MEMORY_ADDITIONAL_CONTEXT_KEY}>`
  const close = `</${READY_MEMORY_ADDITIONAL_CONTEXT_KEY}>`
  const candidate = part.text.startsWith(open) && part.text.endsWith(close)
  if (!candidate) return { candidate: false, payload: null, valid: false }
  if (
    !hasOnlyKeys(item, ['type', 'id', 'role', 'content'])
    || (item.id !== undefined && typeof item.id !== 'string')
    || !hasOnlyKeys(part, ['type', 'text'])
  ) return { candidate: true, payload: null, valid: false }
  try {
    const payload = parseReadyMemoryPromptText(part.text)
    return { candidate: true, payload, valid: payload !== null }
  } catch {
    return { candidate: true, payload: null, valid: false }
  }
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

function lastUserIndex(input: readonly unknown[]): number | null {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (isRecord(item) && item.role === 'user') return index
  }
  return null
}

function recognizedNonMemoryAdditionalContext(item: unknown): boolean {
  try {
    const context = currentTurnReadyAdditionalContext([
      item,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] },
    ])
    return context.resourceReferences.length > 0 || context.explicitRetry !== null
  } catch {
    return false
  }
}

function currentTurnMarker(input: readonly unknown[], userIndex: number): {
  index: number | null
  payload: ReadyMemoryPromptPayload | null
  invalid: boolean
} {
  const markers: Array<{ index: number; payload: ReadyMemoryPromptPayload }> = []
  let invalid = false
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    const marker = readyMemoryMarker(input[index])
    if (marker.candidate) {
      if (!marker.valid || !marker.payload) {
        invalid = true
        break
      }
      markers.push({ index, payload: marker.payload })
      continue
    }
    if (recognizedNonMemoryAdditionalContext(input[index])) continue
    break
  }
  if (invalid || markers.length !== 1) {
    return { index: null, payload: null, invalid: invalid || markers.length > 1 }
  }
  try {
    const contractMarker = currentTurnReadyAdditionalContext(input).readyMemory
    if (!contractMarker || digestCanonicalJson(contractMarker) !== digestCanonicalJson(markers[0].payload)) {
      return { index: null, payload: null, invalid: true }
    }
  } catch {
    return { index: null, payload: null, invalid: true }
  }
  return { index: markers[0].index, payload: markers[0].payload, invalid: false }
}

export function redactPriorReadyMemoryHistory(input: {
  requestKind: CodexModelGatewayRequestKind
  input: readonly unknown[]
}): CodexMemoryHistoryRedactionResult {
  const userIndex = lastUserIndex(input.input)
  const marker = input.requestKind === 'product' && userIndex !== null
    ? currentTurnMarker(input.input, userIndex)
    : { index: null, payload: null, invalid: false }
  const failClosed = input.requestKind !== 'product'
    || userIndex === null
    || marker.invalid
    || marker.index === null

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
    const itemMarker = readyMemoryMarker(item)
    let kind: string | null = null
    if (itemMarker.candidate && (failClosed || marker.index !== index)) {
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
