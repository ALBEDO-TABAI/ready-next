import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  getProviderDef,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  resolveMaxOutputTokens,
  type AIModelConfig,
  type AIReasoningEffort,
  type AIWireAPI,
} from '../../../../shared/ai-providers'
import type { MultiTurnThinkingPolicy } from '../../../../shared/ai-providers/types'
import { resolveModelContextWindow } from '../../../../shared/context-budget-types'
import { resolveProviderPatchProfile } from '../../../../shared/ai-providers/index'
import { READY_GATEWAY_MAX_CONTROLLED_RETRIES } from './codex-model-gateway-retry'
import type { CodexDeliveredUserTail } from './codex-turn-input-builder'
import {
  parseReadyMemoryPromptText,
  readyMemoryPromptText,
  type ReadyMemoryPromptPayload,
} from '../ready-memory'

type JsonObject = Record<string, unknown>

export type CodexModelGatewayRequestKind = 'product' | 'automatic_compaction' | 'manual_compaction'

export type CodexModelGatewayRequestEvidence = Readonly<{
  instructionDigest: string
  inputDigest: string
  inputItems: readonly Readonly<{
    digest: string
    totalStringCharacters: number
    maxStringCharacters: number
  }>[]
  inputTotalStringCharacters: number
  inputMaxStringCharacters: number
  toolsDigest: string
  toolCount: number
  bodyBytes: number
  memoryHistoryRedactionDigest: string
  memoryHistoryRedactedItemCount: number
}>

export type CodexModelGatewayResponseEvidence = Readonly<{
  responseId: string
  terminalDigest: string
  outputDigest: string
  usageDigest: string
}>

export type CodexModelGatewayFailureEvidence = Readonly<{
  failureClass: 'provider' | 'transport' | 'protocol' | 'context'
  failureStage: 'connect' | 'headers' | 'stream-before-item' | 'stream-after-item' | 'terminal-validation' | 'post-terminal'
  responseIdentitySeen: boolean
  partialAssistantItemSeen: boolean
  toolCallItemSeen: boolean
  elapsedMs: number
  eventCount: number
  wireByteCount: number
  causeCode: string
}>

export type CodexUpstreamProfileSnapshot = Readonly<{
  profileId: string
  providerId: string
  model: string
  baseUrl: string
  agentProtocol: 'openai' | 'anthropic'
  wireApi: AIWireAPI | 'messages'
  reasoningEffort: AIReasoningEffort | null
  contextWindowTokens?: number
  maxOutputTokens?: number
  supportsToolCalls: boolean
  supportsNativeToolCalls: boolean
  supportsVision: boolean
  supportsThinking: boolean
  multiTurnThinkingPolicy: MultiTurnThinkingPolicy
  patchProfileId: string | null
  authHeader: string
  authPrefix: string
  extraHeaders: Readonly<Record<string, string>>
  credentialReferenceId: string
  retryPolicy: Readonly<{
    owner: 'ready_gateway'
    maxRetries: number
    semantic4xxRetries: 0
  }>
}>

export type CodexNativeModelSettings = Readonly<{
  reasoningEffort: AIReasoningEffort | null
  threadConfig: { model_context_window: number } | null
}>

export function resolveCodexNativeModelSettings(
  snapshot: CodexUpstreamProfileSnapshot,
): CodexNativeModelSettings {
  if (
    snapshot.contextWindowTokens !== undefined
    && (!Number.isSafeInteger(snapshot.contextWindowTokens) || snapshot.contextWindowTokens < 1)
  ) throw new CodexModelGatewayContractError('gateway_context_window_invalid')
  return {
    reasoningEffort: snapshot.reasoningEffort,
    threadConfig: snapshot.contextWindowTokens === undefined
      ? null
      : { model_context_window: snapshot.contextWindowTokens },
  }
}

export class CodexModelGatewayContractError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexModelGatewayContractError'
  }
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

export function digestCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function digestText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// Codex compacts automatically before a turn starts and, when the context fills inside a long tool loop, mid-turn.
const AUTOMATIC_COMPACTION_SIGNATURES = (['pre_turn', 'mid_turn'] as const).map((phase) => canonicalJson({
  trigger: 'auto',
  reason: 'context_limit',
  implementation: 'responses',
  phase,
  strategy: 'memento',
}))

const MANUAL_COMPACTION_SIGNATURE = {
  trigger: 'manual',
  reason: 'user_requested',
  implementation: 'responses',
  phase: 'standalone_turn',
  strategy: 'memento',
}

export function classifyCodexModelGatewayRequest(metadata: JsonObject): CodexModelGatewayRequestKind {
  if (metadata.request_kind === 'turn' && metadata.compaction === undefined) return 'product'
  if (metadata.request_kind !== 'compaction' || !isRecord(metadata.compaction)) {
    throw new CodexModelGatewayContractError('gateway_request_unclassified')
  }
  const signature = canonicalJson(metadata.compaction)
  if (AUTOMATIC_COMPACTION_SIGNATURES.includes(signature)) return 'automatic_compaction'
  if (signature === canonicalJson(MANUAL_COMPACTION_SIGNATURE)) return 'manual_compaction'
  throw new CodexModelGatewayContractError('gateway_request_unclassified')
}

const READY_RESOURCE_REFERENCE_KEYS = [
  'currentDigest',
  'currentVersion',
  'logicalResourceId',
  'policyEpoch',
  'supersedesVersion',
]

function parseReadyResourceReference(value: string, expectedId?: string): JsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexModelGatewayContractError('gateway_resource_reference_invalid')
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join(',') !== READY_RESOURCE_REFERENCE_KEYS.join(',')
    || typeof parsed.logicalResourceId !== 'string' || !parsed.logicalResourceId
    || (expectedId !== undefined && parsed.logicalResourceId !== expectedId)
    || typeof parsed.currentVersion !== 'string' || !parsed.currentVersion
    || typeof parsed.currentDigest !== 'string' || !parsed.currentDigest
    || (parsed.supersedesVersion !== null
      && (typeof parsed.supersedesVersion !== 'string' || !parsed.supersedesVersion))
    || !Number.isSafeInteger(parsed.policyEpoch) || Number(parsed.policyEpoch) <= 0) {
    throw new CodexModelGatewayContractError('gateway_resource_reference_invalid')
  }
  return parsed
}

function parseReadyResourcePayload(payload: string): JsonObject[] {
  const lines = payload.trim().split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.map((line) => parseReadyResourceReference(line))
}

function readyResourceReferencesFromText(text: string): {
  recognized: boolean
  references: JsonObject[]
  readyRunId?: string
} {
  const snapshot = text.match(/^<ready-resource-context>([\s\S]*)<\/ready-resource-context>$/)
  if (snapshot) {
    let value: unknown
    try { value = JSON.parse(snapshot[1]) } catch { throw new CodexModelGatewayContractError('gateway_resource_context_invalid') }
    if (!isRecord(value) || value.contract !== 'ready_resource_context_v1'
      || Object.keys(value).sort().join(',') !== 'contract,readyRunId,references'
      || typeof value.readyRunId !== 'string' || !value.readyRunId
      || !Array.isArray(value.references)) throw new CodexModelGatewayContractError('gateway_resource_context_invalid')
    const references = value.references.map((reference) => parseReadyResourceReference(JSON.stringify(reference)))
    if (new Set(references.map((reference) => reference.logicalResourceId)).size !== references.length) {
      throw new CodexModelGatewayContractError('gateway_resource_context_invalid')
    }
    return { recognized: true, references, readyRunId: value.readyRunId }
  }
  const application = text.match(/^<ready_resources>([\s\S]*)<\/ready_resources>$/)
  if (application) {
    return {
      recognized: true,
      references: parseReadyResourcePayload(application[1]),
    }
  }
  const batch = text.match(/^<external_ready_resources>([\s\S]*)<\/external_ready_resources>$/)
  if (batch) {
    return {
      recognized: true,
      references: parseReadyResourcePayload(batch[1]),
    }
  }
  const single = text.match(/^<ready-resource:([^>\s]+)>([\s\S]*)<\/ready-resource:\1>$/)
  if (single) {
    return {
      recognized: true,
      references: [parseReadyResourceReference(single[2], single[1])],
    }
  }
  return { recognized: false, references: [] }
}

function readyExplicitRetryContextFromText(text: string): {
  recognized: boolean
  context: JsonObject | null
} {
  const match = text.match(/^<ready-explicit-retry>([\s\S]*)<\/ready-explicit-retry>$/)
  if (!match) return { recognized: false, context: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    throw new CodexModelGatewayContractError('gateway_explicit_retry_context_invalid')
  }
  if (!isRecord(parsed)) {
    throw new CodexModelGatewayContractError('gateway_explicit_retry_context_invalid')
  }
  return { recognized: true, context: parsed }
}

function readyReplacedTurnContextFromText(text: string): {
  recognized: boolean
  context: JsonObject | null
} {
  const match = text.match(/^<ready-replaced-turn>([\s\S]*)<\/ready-replaced-turn>$/)
  if (!match) return { recognized: false, context: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    throw new CodexModelGatewayContractError('gateway_replaced_turn_context_invalid')
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join(',') !== 'contract,notice,readyRunId,replacedOriginUserMessageId'
    || parsed.contract !== 'ready_replaced_turn_v1'
    || typeof parsed.readyRunId !== 'string' || !parsed.readyRunId
    || typeof parsed.replacedOriginUserMessageId !== 'string' || !parsed.replacedOriginUserMessageId
    || typeof parsed.notice !== 'string' || !parsed.notice) {
    throw new CodexModelGatewayContractError('gateway_replaced_turn_context_invalid')
  }
  return { recognized: true, context: parsed }
}

function readyDocumentWidgetGuidanceFromText(text: string): {
  recognized: boolean
  readyRunId: string | null
  guidance: string | null
} {
  const match = text.match(/^<ready-document-widget-guidance>([\s\S]*)<\/ready-document-widget-guidance>$/)
  if (!match) return { recognized: false, readyRunId: null, guidance: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    throw new CodexModelGatewayContractError('gateway_document_widget_guidance_invalid')
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).sort().join(',') !== 'contract,guidance,readyRunId'
    || parsed.contract !== 'ready_document_widget_guidance_v1'
    || typeof parsed.readyRunId !== 'string' || !parsed.readyRunId
    || typeof parsed.guidance !== 'string' || !parsed.guidance) {
    throw new CodexModelGatewayContractError('gateway_document_widget_guidance_invalid')
  }
  return { recognized: true, readyRunId: parsed.readyRunId, guidance: parsed.guidance }
}

function readyMemoryContextFromText(text: string): {
  recognized: boolean
  context: ReadyMemoryPromptPayload | null
} {
  try {
    const context = parseReadyMemoryPromptText(text)
    return context ? { recognized: true, context } : { recognized: false, context: null }
  } catch {
    throw new CodexModelGatewayContractError('gateway_memory_context_invalid')
  }
}

export function instructionTranscriptDigest(instructions: unknown, input: unknown): string {
  if (typeof instructions !== 'string' || !Array.isArray(input)) {
    throw new CodexModelGatewayContractError('gateway_instruction_transcript_invalid')
  }
  const developerMessages: Array<{
    type: 'message'; role: 'developer'; content: unknown[]
  }> = []
  input.forEach((item) => {
    if (!isRecord(item)) return
    if (item.role === 'system') {
      throw new CodexModelGatewayContractError('gateway_system_message_unsupported')
    }
    if (item.role !== 'developer') return
    if (
      item.type !== 'message'
      || !Array.isArray(item.content)
      || Object.keys(item).some((key) => !['type', 'id', 'role', 'content'].includes(key))
      || item.content.some((part) => (
        !isRecord(part)
        || part.type !== 'input_text'
        || typeof part.text !== 'string'
        || Object.keys(part).some((key) => key !== 'type' && key !== 'text')
      ))
    ) throw new CodexModelGatewayContractError('gateway_developer_message_invalid')
    const developerText = item.content.map((part) => String((part as JsonObject).text)).join('')
    if (
      developerText === '<ready_continuation>EMPTY_SUCCESSOR_CONTEXT</ready_continuation>'
      || readyResourceReferencesFromText(developerText).recognized
      || readyExplicitRetryContextFromText(developerText).recognized
      || readyMemoryContextFromText(developerText).recognized
      || readyDocumentWidgetGuidanceFromText(developerText).recognized
      || readyReplacedTurnContextFromText(developerText).recognized
    ) return
    developerMessages.push({ type: 'message', role: 'developer', content: item.content })
  })
  return digestCanonicalJson({ nativeBase: instructions, developerMessages })
}

export function createCodexUpstreamProfileSnapshot(input: {
  profileId: string
  config: AIModelConfig
  maxRetries: number
}): {
  snapshotRef: string
  snapshotDigest: string
  snapshot: CodexUpstreamProfileSnapshot
} {
  const profileId = input.profileId.trim()
  if (!profileId) throw new CodexModelGatewayContractError('gateway_profile_id_invalid')
  if (
    !Number.isSafeInteger(input.maxRetries)
    || input.maxRetries < 0
    || input.maxRetries > READY_GATEWAY_MAX_CONTROLLED_RETRIES
  ) {
    throw new CodexModelGatewayContractError('gateway_retry_policy_invalid')
  }
  const config = normalizeAIConfig(input.config)
  const capabilities = resolveAIConfigCapabilities(config)
  if (!capabilities) {
    throw new CodexModelGatewayContractError('gateway_agent_protocol_unsupported')
  }
  if (capabilities.agentProtocol !== 'anthropic' && capabilities.wireApi !== 'responses' && capabilities.wireApi !== 'chat/completions') {
    throw new CodexModelGatewayContractError('gateway_wire_api_unsupported')
  }
  if (capabilities.reasoningEffort && !capabilities.supportsThinking) {
    throw new CodexModelGatewayContractError('gateway_reasoning_capability_unsupported')
  }
  if (
    capabilities.supportsThinking
    && (
      (capabilities.wireApi === 'chat/completions'
        && capabilities.multiTurnThinkingPolicy !== 'proven_safe')
      || (capabilities.wireApi === 'responses'
        && !['proven_safe', 'echo_required'].includes(capabilities.multiTurnThinkingPolicy))
    )
  ) throw new CodexModelGatewayContractError('gateway_reasoning_policy_unsupported')
  const baseUrl = capabilities.baseUrl.replace(/\/+$/, '')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new CodexModelGatewayContractError('gateway_upstream_url_invalid')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new CodexModelGatewayContractError('gateway_upstream_url_invalid')
  }
  if (!config.model.trim()) throw new CodexModelGatewayContractError('gateway_upstream_model_invalid')
  const provider = capabilities.provider || getProviderDef(config.provider, baseUrl)
  if (!provider) throw new CodexModelGatewayContractError('gateway_provider_not_found')
  const patchProfile = resolveProviderPatchProfile(config, baseUrl, config.model)
  const modelDef = provider.models.find((model) => model.id === config.model)
  const snapshot = deepFreeze({
    profileId,
    providerId: provider.id,
    model: config.model,
    baseUrl,
    agentProtocol: capabilities.agentProtocol,
    wireApi: capabilities.agentProtocol === 'anthropic' ? 'messages' as const : capabilities.wireApi!,
    reasoningEffort: capabilities.reasoningEffort || null,
    ...(config.contextWindowOverride != null ? {
      contextWindowTokens: resolveModelContextWindow(config, modelDef),
    } : {}),
    ...(config.maxOutputTokensOverride != null || capabilities.agentProtocol === 'anthropic' ? {
      maxOutputTokens: resolveMaxOutputTokens(config),
    } : {}),
    supportsToolCalls: capabilities.supportsToolCalls,
    supportsNativeToolCalls: capabilities.supportsNativeToolCalls,
    supportsVision: capabilities.supportsVision,
    supportsThinking: capabilities.supportsThinking,
    multiTurnThinkingPolicy: capabilities.multiTurnThinkingPolicy,
    patchProfileId: patchProfile?.profileId || null,
    authHeader: capabilities.isKimiCoding ? 'x-api-key' : provider.authHeader,
    authPrefix: capabilities.isKimiCoding ? '' : provider.authPrefix,
    extraHeaders: {
      ...(capabilities.agentProtocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
      ...(provider.extraHeaders || {}),
    },
    credentialReferenceId: `ai-profile:${profileId}`,
    retryPolicy: {
      owner: 'ready_gateway' as const,
      maxRetries: input.maxRetries,
      semantic4xxRetries: 0 as const,
    },
  }) satisfies CodexUpstreamProfileSnapshot
  const snapshotDigest = digestCanonicalJson(snapshot)
  return {
    snapshotRef: `ready-upstream:${profileId}:${snapshotDigest.slice(0, 32)}`,
    snapshotDigest,
    snapshot,
  }
}

export function responsesToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) throw new CodexModelGatewayContractError('gateway_tools_invalid')
  const names = tools.map((tool) => {
    if (
      !isRecord(tool)
      || tool.type !== 'function'
      || typeof tool.name !== 'string'
      || !tool.name.trim()
      || !isRecord(tool.parameters)
      || Object.keys(tool).some((key) => (
        !['type', 'name', 'description', 'parameters', 'strict'].includes(key)
      ))
      || (tool.description !== undefined && typeof tool.description !== 'string')
      || (tool.strict !== undefined && typeof tool.strict !== 'boolean')
    ) {
      throw new CodexModelGatewayContractError('gateway_tool_schema_invalid')
    }
    return tool.name
  })
  if (new Set(names).size !== names.length) {
    throw new CodexModelGatewayContractError('gateway_tool_name_duplicate')
  }
  return names
}

export type CodexToolArgumentValidator = {
  safeParse(value: unknown): { success: boolean }
}

export function responsesToolArgumentValidators(
  tools: unknown,
): ReadonlyMap<string, CodexToolArgumentValidator> {
  const names = responsesToolNames(tools)
  const values = tools as JsonObject[]
  return new Map(names.map((name, index) => {
    try {
      const schema = z.fromJSONSchema(
        values[index].parameters as Parameters<typeof z.fromJSONSchema>[0],
      )
      return [name, schema] as const
    } catch {
      throw new CodexModelGatewayContractError('gateway_tool_argument_schema_unsupported')
    }
  }))
}

function textFromContent(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => (
    isRecord(part) && typeof part.text === 'string' ? [part.text] : []
  ))
}

function sortReadyResourceReferences(references: JsonObject[]): JsonObject[] {
  return [...references].sort((left, right) => (
    String(left.logicalResourceId || '').localeCompare(String(right.logicalResourceId || ''))
  ))
}

function collectReadyResourceReferencesFromItem(
  item: unknown,
  latest: Map<string, JsonObject>,
): 'resource' | 'mixed' | 'other' {
  if (!isRecord(item) || (item.role !== 'user' && item.role !== 'developer')) return 'other'
  const texts = textFromContent(item.content)
  if (texts.length === 0) return 'other'
  let sawResource = false
  let sawOther = false
  for (const text of texts) {
    const parsed = readyResourceReferencesFromText(text)
    if (!parsed.recognized) {
      sawOther = true
      continue
    }
    sawResource = true
    for (const reference of parsed.references) {
      latest.set(String(reference.logicalResourceId), reference)
    }
  }
  if (sawResource && !sawOther) return 'resource'
  if (sawResource) return 'mixed'
  return 'other'
}

export function latestReadyResourceReferences(input: unknown): unknown[] {
  if (!Array.isArray(input)) throw new CodexModelGatewayContractError('gateway_input_invalid')
  const latest = new Map<string, JsonObject>()
  for (const item of input) collectReadyResourceReferencesFromItem(item, latest)
  return sortReadyResourceReferences([...latest.values()])
}

export function currentTurnReadyResourceReferences(input: unknown): unknown[] {
  if (!Array.isArray(input)) throw new CodexModelGatewayContractError('gateway_input_invalid')
  let lastUser = -1
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isRecord(input[index]) && input[index].role === 'user') {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) return []
  const latest = new Map<string, JsonObject>()
  collectReadyResourceReferencesFromItem(input[lastUser], latest)
  for (let index = lastUser - 1; index >= 0; index -= 1) {
    const older = new Map<string, JsonObject>()
    if (collectReadyResourceReferencesFromItem(input[index], older) !== 'resource') break
    for (const [logicalResourceId, reference] of older) {
      if (!latest.has(logicalResourceId)) latest.set(logicalResourceId, reference)
    }
  }
  return sortReadyResourceReferences([...latest.values()])
}

export function currentTurnReadyAdditionalContext(
  input: unknown,
  expectedDeliveredUserTail: readonly CodexDeliveredUserTail[],
  readyRunId: string,
): {
  resourceReferences: unknown[]
  explicitRetry: JsonObject | null
  readyMemory: ReadyMemoryPromptPayload | null
  documentWidgetGuidance: string | null
  replacedTurn: JsonObject | null
  currentUserIndex: number | null
  readyMemoryIndex: number | null
} {
  if (!Array.isArray(input)) throw new CodexModelGatewayContractError('gateway_input_invalid')
  let lastUser = -1
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (isRecord(input[index]) && input[index].role === 'user') {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) {
    if (expectedDeliveredUserTail.length > 0) throw new CodexModelGatewayContractError('gateway_uncommitted_user_tail_mismatch')
    return {
      resourceReferences: [], explicitRetry: null, readyMemory: null, documentWidgetGuidance: null,
      replacedTurn: null, currentUserIndex: null, readyMemoryIndex: null,
    }
  }
  if (textFromContent(input[lastUser].content).some((text) => text.startsWith('<external_ready-uncommitted-user-tail:'))) {
    throw new CodexModelGatewayContractError('gateway_uncommitted_user_tail_mismatch')
  }
  const latest = new Map<string, JsonObject>()
  let resourceSnapshotSeen = false
  let explicitRetry: JsonObject | null = null
  let readyMemory: ReadyMemoryPromptPayload | null = null
  let readyMemoryIndex: number | null = null
  let documentWidgetGuidance: string | null = null
  let replacedTurn: JsonObject | null = null
  let nextTailIndex = expectedDeliveredUserTail.length - 1
  for (let index = lastUser - 1; index >= 0; index -= 1) {
    const item = input[index]
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'developer')) break
    const texts = textFromContent(item.content)
    if (texts.length === 0) break
    if (texts.some((text) => text.startsWith('<external_ready-uncommitted-user-tail:'))) {
      const match = texts.length === 1
        ? texts[0].match(/^<external_ready-uncommitted-user-tail:([0-7])>([\s\S]*)<\/external_ready-uncommitted-user-tail:\1>$/)
        : null
      let payload: unknown
      try { payload = match ? JSON.parse(match[2]) : null }
      catch { throw new CodexModelGatewayContractError('gateway_uncommitted_user_tail_mismatch') }
      if (!match || !isRecord(payload) || payload.readyRunId !== readyRunId
        || item.type !== 'message' || item.role !== 'user'
        || Object.keys(item).some((key) => !['type', 'id', 'role', 'content'].includes(key))
        || (item.id !== undefined && typeof item.id !== 'string')
        || !Array.isArray(item.content) || item.content.length !== 1
        || !isRecord(item.content[0]) || item.content[0].type !== 'input_text'
        || Object.keys(item.content[0]).some((key) => key !== 'type' && key !== 'text')
        || Number(match[1]) !== nextTailIndex || nextTailIndex < 0
        || digestCanonicalJson(payload) !== digestCanonicalJson(expectedDeliveredUserTail[nextTailIndex])) {
        throw new CodexModelGatewayContractError('gateway_uncommitted_user_tail_mismatch')
      }
      nextTailIndex -= 1
      continue
    }
    if (nextTailIndex !== -1) throw new CodexModelGatewayContractError('gateway_uncommitted_user_tail_mismatch')
    let recognized = true
    for (const text of texts) {
      const resources = readyResourceReferencesFromText(text)
      if (resources.recognized) {
        // Old tags remain readable history, never authority for the current run.
        if (resources.readyRunId !== readyRunId || resourceSnapshotSeen
          || item.type !== 'message' || item.role !== 'developer'
          || Object.keys(item).some((key) => !['type', 'id', 'role', 'content'].includes(key))
          || (item.id !== undefined && typeof item.id !== 'string')
          || !Array.isArray(item.content) || item.content.length !== 1
          || !isRecord(item.content[0]) || item.content[0].type !== 'input_text'
          || Object.keys(item.content[0]).some((key) => key !== 'type' && key !== 'text')) {
          throw new CodexModelGatewayContractError('gateway_resource_context_invalid')
        }
        resourceSnapshotSeen = true
        for (const reference of resources.references) {
          if (!latest.has(String(reference.logicalResourceId))) {
            latest.set(String(reference.logicalResourceId), reference)
          }
        }
        continue
      }
      const retry = readyExplicitRetryContextFromText(text)
      if (retry.recognized && retry.context && explicitRetry === null) {
        explicitRetry = retry.context
        continue
      }
      const memory = readyMemoryContextFromText(text)
      if (memory.recognized && memory.context) {
        if (readyMemory !== null || item.type !== 'message' || item.role !== 'developer'
          || Object.keys(item).some((key) => !['type', 'id', 'role', 'content'].includes(key))
          || (item.id !== undefined && typeof item.id !== 'string')
          || !Array.isArray(item.content) || item.content.length !== 1
          || !isRecord(item.content[0]) || item.content[0].type !== 'input_text'
          || Object.keys(item.content[0]).some((key) => key !== 'type' && key !== 'text')) {
          throw new CodexModelGatewayContractError('gateway_memory_context_invalid')
        }
        readyMemory = memory.context
        readyMemoryIndex = index
        continue
      }
      const widgetGuidance = readyDocumentWidgetGuidanceFromText(text)
      if (widgetGuidance.recognized) {
        if (widgetGuidance.readyRunId !== readyRunId || documentWidgetGuidance !== null
          || item.type !== 'message' || item.role !== 'developer'
          || Object.keys(item).some((key) => !['type', 'id', 'role', 'content'].includes(key))
          || (item.id !== undefined && typeof item.id !== 'string')
          || !Array.isArray(item.content) || item.content.length !== 1
          || !isRecord(item.content[0]) || item.content[0].type !== 'input_text'
          || Object.keys(item.content[0]).some((key) => key !== 'type' && key !== 'text')) {
          throw new CodexModelGatewayContractError('gateway_document_widget_guidance_invalid')
        }
        documentWidgetGuidance = widgetGuidance.guidance
        continue
      }
      const replaced = readyReplacedTurnContextFromText(text)
      if (replaced.recognized && replaced.context) {
        if (replaced.context.readyRunId !== readyRunId || replacedTurn !== null
          || item.type !== 'message' || item.role !== 'developer'
          || Object.keys(item).some((key) => !['type', 'id', 'role', 'content'].includes(key))
          || (item.id !== undefined && typeof item.id !== 'string')
          || !Array.isArray(item.content) || item.content.length !== 1
          || !isRecord(item.content[0]) || item.content[0].type !== 'input_text'
          || Object.keys(item.content[0]).some((key) => key !== 'type' && key !== 'text')) {
          throw new CodexModelGatewayContractError('gateway_replaced_turn_context_invalid')
        }
        replacedTurn = replaced.context
        continue
      }
      recognized = false
      break
    }
    if (!recognized) break
  }
  if (nextTailIndex !== -1) throw new CodexModelGatewayContractError('gateway_uncommitted_user_tail_mismatch')
  return {
    resourceReferences: sortReadyResourceReferences([...latest.values()]),
    explicitRetry,
    readyMemory,
    documentWidgetGuidance,
    replacedTurn,
    currentUserIndex: lastUser,
    readyMemoryIndex,
  }
}

/**
 * After an automatic compaction Codex rebuilds the request from its summary and drops the turn's Ready context.
 * True when anything of that context is still present anywhere in the request: an entry bound to this run, or a retry
 * or memory entry. Older runs' and legacy resource tags are only history. Unreadable Ready entries count as present.
 */
export function hasCurrentTurnReadyContext(input: unknown, readyRunId: string): boolean {
  if (!Array.isArray(input)) return true
  return input.some((item) => isRecord(item) && textFromContent(item.content).some((text) => {
    try {
      const resources = readyResourceReferencesFromText(text)
      // Legacy resource tags carry no run and are history only, like other runs' snapshots.
      if (resources.recognized) return resources.readyRunId === readyRunId
      if (readyExplicitRetryContextFromText(text).recognized) return true
      if (readyMemoryContextFromText(text).recognized) return true
      const guidance = readyDocumentWidgetGuidanceFromText(text)
      if (guidance.recognized) return guidance.readyRunId === readyRunId
      const replaced = readyReplacedTurnContextFromText(text)
      if (replaced.recognized) return replaced.context?.readyRunId === readyRunId
      return text.startsWith('<external_ready-uncommitted-user-tail:') && text.includes(JSON.stringify(readyRunId))
    } catch {
      // silent-catch: per the contract above, an unreadable Ready context entry counts as still present
      return true
    }
  }))
}

function canonicalReadyResourceReferences(references: readonly unknown[]): JsonObject[] {
  if (!Array.isArray(references)) {
    throw new CodexModelGatewayContractError('gateway_resource_reference_invalid')
  }
  const latest = new Map<string, JsonObject>()
  for (const reference of references) {
    if (!isRecord(reference) || typeof reference.logicalResourceId !== 'string' || !reference.logicalResourceId) {
      throw new CodexModelGatewayContractError('gateway_resource_reference_invalid')
    }
    latest.set(reference.logicalResourceId, reference)
  }
  return sortReadyResourceReferences([...latest.values()])
}

export function digestReadyResourceReferences(references: readonly unknown[]): string {
  return digestCanonicalJson(canonicalReadyResourceReferences(references))
}

export function digestReadyAdditionalContext(input: {
  resourceReferences: readonly unknown[]
  explicitRetry: unknown | null
  readyMemory?: unknown | null
  documentWidgetGuidance?: string | null
  replacedTurn?: unknown | null
}): string {
  if (input.explicitRetry !== null && !isRecord(input.explicitRetry)) {
    throw new CodexModelGatewayContractError('gateway_explicit_retry_context_invalid')
  }
  const references = canonicalReadyResourceReferences(input.resourceReferences)
  let memory: ReadyMemoryPromptPayload | null = null
  if (input.readyMemory != null) {
    try {
      memory = parseReadyMemoryPromptText(readyMemoryPromptText(
        input.readyMemory as ReadyMemoryPromptPayload,
      ))
    } catch {
      throw new CodexModelGatewayContractError('gateway_memory_context_invalid')
    }
    if (!memory) throw new CodexModelGatewayContractError('gateway_memory_context_invalid')
  }
  return digestCanonicalJson([
    ...references,
    ...(input.explicitRetry === null ? [] : [{ kind: 'explicit_retry', value: input.explicitRetry }]),
    ...(memory === null ? [] : [{ kind: 'ready_memory', value: memory }]),
    ...(input.documentWidgetGuidance ? [{ kind: 'document_widget_guidance', value: input.documentWidgetGuidance }] : []),
    // Absent for every run that replaced nothing, so their digests are unchanged.
    ...(input.replacedTurn ? [{ kind: 'replaced_turn', value: input.replacedTurn }] : []),
  ])
}

export function upstreamEndpoint(snapshot: CodexUpstreamProfileSnapshot): string {
  const suffix = snapshot.agentProtocol === 'anthropic'
    ? (snapshot.baseUrl.endsWith('/v1') ? '/messages' : '/v1/messages')
    : snapshot.wireApi === 'responses' ? '/responses' : '/chat/completions'
  return snapshot.baseUrl.endsWith(suffix) ? snapshot.baseUrl : `${snapshot.baseUrl}${suffix}`
}
