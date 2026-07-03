import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import {
  Usage,
  type AgentInputItem,
  type AgentOutputItem,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RunStreamEvent,
} from '@openai/agents'
import type {
  BudgetWarningLevel,
  RunBudgetSeed,
  RunBudgetUsage,
  RunMessage,
  TaskBudgetRuntime,
} from '../contracts/run-contracts'
import {
  TARGET_DOCUMENT_ERROR_KINDS,
  TOOL_ADMISSION_ERROR_KINDS,
} from '../contracts/error-kinds'
import type { TurnTerminalReason } from './turn-frame'
import {
  isCompletedChildCloseStatus,
  isFailedChildCloseStatus,
  isKilledChildCloseStatus,
  type SkillChildCloseEvent,
} from '../skills/skill-child-run-types'
import { buildRequestEnvelope } from '../contracts/request-envelope'
import { classifyIntent } from '../intent-classifier'
import { resolveIntentCapabilityGroupModes } from '../execution-intent-resolver'
import {
  applyMapSemanticIntentToIntentClassification,
  classifyMapSemanticIntentFallback,
} from '../map-semantic-intent'
import {
  resolveBrowserCollectionIntent,
  resolveBrowserBatchCollectionIntent,
} from '../../../../shared/browser-collection-intent'
import {
  browserWorkflowIntentToDecisionMode,
  isBrowserTransactionIntent,
  resolveBrowserWorkflowIntent,
} from '../../../../shared/browser-workflow-intent'
import { hasLocalSendImFileIntent } from '../../../../shared/remote-im-file-intent'
import { classifyFollowupIntent, hasContinuableTaskRef, type FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import { isRetryOnlyTurn } from '../skills/skill-detection-inputs'
import { peekLastReferenceSkill } from '../skills/skill-reference-hints'
import { shouldDisplayReferenceSkillHintForLatestUserText } from '../reference-skill-hint-display'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import {
  buildExplicitNoSkillAuthorization,
  buildSelectedSkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
} from '../tools-runtime/tool-result-types'
import {
  buildModelVisibleToolResultPayload,
  redactModelVisibleToolText,
} from '../tools-runtime/model-visible-tool-output'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import { filterToolsByAllowedTools } from '../tools-runtime/tool-gateway'
import { PRIMITIVE_TOOL_DEFS } from '../../tools/skill-primitives/tool-defs'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import {
  getProviderDef,
  
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIModelDef,
  type AIProviderDef,
} from '../../../../shared/ai-providers'
import {
  applyProviderRequestPatch,
  applyProviderResponsePatch,
  resolveProviderDefaultPatchers,
  resolveProviderPatchProfile,
  type PatchContext,
} from '../../../../shared/ai-providers/index'
import {
  sanitizeHistoricalMessagesByCapability,
  type CapabilityMessage,
  type MessageCapabilitySnapshot,
} from '../domain-adapters/message-capability-filter'
import { logAgentMetric } from '../metrics'
import {
  createTaskBudgetRuntime,
  getBudgetUsagePercent,
  getBudgetWarningLevel,
  rebindTaskBudgetRuntime,
  resumeBudgetRuntime,
} from '../task-projection/run-budget-policy'
import {
} from '../compaction/compact-agent-input'
import { followupConsultsRecalledContext } from '../../../../shared/agent-followup-intent'
import { hasExplicitDocumentWidgetCreateIntent, inferDocumentWidgetTaskKind } from '../../claude-bridge/tool-policy-heuristics'
import { findDocumentVisualSyntaxIssue } from '../../../../shared/document-visual-syntax'
import type { AgentSdkExecutionOptions, DocumentTargetGuard, ObservedDocumentSaveState, ObservedDocumentToolTarget, SkillContextOrchestratorLike, TerminalFailureReason, AgentSdkProviderDiagnostics, AgentSdkBudgetCheckpointRestore, SdkLongSkillCheckpoint, ToolBridgeRuntimeContext } from './agent-sdk-types'
import type { BrowserTaskDecisionMode } from '../../../../shared/browser-agent-task'

export const SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS = 1_500
export const DEFAULT_AGENT_SDK_MAX_TURNS = 24
export const NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS = 4000
const NATIVE_TEXT_TOOL_MARKERS = ['<tool_call', '<function=', '<parameter=', ':::tool_call', '[tool_call]'] as const
export const ROLLING_BUDGET_CHECKPOINT_TOOL_INTERVAL = 4
export const LOCAL_DOCUMENT_WRITE_MAX_TURNS = 40
export const LONG_READING_TRIGGER_CHARS = 12_000
export const LONG_READING_EXCERPT_BATCH_CHARS = 32_000
export const LONG_READING_EXTRA_TURNS_PER_BATCH = 8
export const LONG_READING_MAX_TURNS = 48
export const PREEMPT_SETTLE_TIMEOUT_MS = 4_000
export const MAX_ORPHAN_RUNS = 3
export const activeBudgetCheckpointFlights = new Set<string>()

// ── Group A: Text buffer helpers (lines 265-318) ──

export function splitNativeTextBufferForSafeFlush(
  text: string,
  options: { flushWithoutMarker?: boolean; hardLimit?: number } = {},
): { emitText: string; remainingText: string } {
  const hardLimit = options.hardLimit ?? NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS
  const markerIndex = findNativeTextToolMarkerIndex(text)
  if (markerIndex >= 0) {
    return {
      emitText: text.slice(0, markerIndex),
      remainingText: text.slice(markerIndex),
    }
  }
  if (
    text.length > 0
    && (options.flushWithoutMarker || text.length > hardLimit)
    && !hasDanglingNativeTextToolMarker(text)
  ) {
    return { emitText: text, remainingText: '' }
  }
  return { emitText: '', remainingText: text }
}

export function removeAlreadyEmittedNativeText(text: string, emittedText: string): string {
  if (!emittedText) return text
  if (text.startsWith(emittedText)) return text.slice(emittedText.length)
  const trimmedEmitted = emittedText.trim()
  if (!trimmedEmitted) return text
  const leadingWhitespace = text.length - text.trimStart().length
  const trimmedText = text.slice(leadingWhitespace)
  if (trimmedText.startsWith(trimmedEmitted)) {
    return trimmedText.slice(trimmedEmitted.length)
  }
  return text
}

function findNativeTextToolMarkerIndex(text: string): number {
  const lower = text.toLowerCase()
  let index = -1
  for (const marker of NATIVE_TEXT_TOOL_MARKERS) {
    const found = lower.indexOf(marker)
    if (found >= 0 && (index < 0 || found < index)) index = found
  }
  return index
}

function hasDanglingNativeTextToolMarker(text: string): boolean {
  const lower = text.toLowerCase()
  return NATIVE_TEXT_TOOL_MARKERS.some((marker) => {
    const maxPrefix = Math.min(marker.length - 1, lower.length)
    for (let length = 1; length <= maxPrefix; length += 1) {
      if (lower.endsWith(marker.slice(0, length))) return true
    }
    return false
  })
}

// ── Group B: Skill tool filtering (lines 321-363) ──

export function filterSelectedSkillToolSurface(
  definitions: ToolDefinition[],
  allowedTools: ReadonlyArray<string> | null | undefined,
  options: {
    preserveToolName?: (name: string) => boolean
  } = {},
): ToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) return definitions
  const filtered = options.preserveToolName
    ? definitions.filter((definition) =>
      allowedTools.includes(definition.name) || options.preserveToolName?.(definition.name) === true)
    : filterToolsByAllowedTools(definitions, allowedTools)
  if (filtered.length > 0) return filtered

  const fallback = definitions.filter((definition) => definition.groupId !== 'skills' && definition.domain !== 'skill')
  if (fallback.length === 0) return filtered
  appendToolCapabilityLog([
    '[tool_capability]',
    'stage=sdk_runtime_skill_allowed_tools_fallback',
    `allowedTools=${allowedTools.join('|') || 'none'}`,
    `preservedTools=${fallback.map((definition) => definition.name).join('|') || 'none'}`,
  ].join(' '))
  return fallback
}

export function authorizedPrimitiveToolNames(authorization: SkillToolAuthorization): string[] {
  if (authorization.mode !== 'selected') return []
  return PRIMITIVE_TOOL_DEFS
    .map((definition) => definition.name)
    .filter((name) => authorization.allowedPrimitives.has(name))
}

export function supplementAuthorizedSkillPrimitiveDefinitions(
  definitions: ToolDefinition[],
  authorization: SkillToolAuthorization,
): ToolDefinition[] {
  const primitiveNames = authorizedPrimitiveToolNames(authorization)
  if (primitiveNames.length === 0) return definitions
  const seen = new Set(definitions.map((definition) => definition.name))
  const next = [...definitions]
  for (const name of primitiveNames) {
    if (seen.has(name)) continue
    const definition = defaultToolRegistry.getToolDefinitionForExecution(name)
    if (!definition) continue
    next.push(definition)
    seen.add(name)
  }
  return next
}

// ── Group C: Message/text utilities (lines 604-710) ──

export function defaultSystemPrompt(): string {
  return '你是 Ready 应用中的 AI 助手，面向自媒体创作者。你擅长内容策划、文案写作、数据分析和创意建议。请使用简洁清晰的中文回答。'
}

export function messageToText(message: RunMessage): string {
  if (typeof message === 'string') return message
  return message
    .map((block) => typeof block.text === 'string' ? block.text : '')
    .join('\n')
    .trim()
}

export function resolveSourceMessageProvenance(params: {
  sourceMessageId?: string | null
  requestEnvelope?: unknown
}): {
  sourceMessageId: string | null
  sourceMessageUnavailableReason: import('../../../../shared/agent-specialist-blueprint').SpecialistBlueprintSourceMessageUnavailableReason | null
} {
  const sourceMessageId = typeof params.sourceMessageId === 'string' && params.sourceMessageId.trim()
    ? params.sourceMessageId.trim()
    : null
  if (sourceMessageId) {
    return { sourceMessageId, sourceMessageUnavailableReason: null }
  }
  if (params.requestEnvelope && typeof params.requestEnvelope === 'object' && !Array.isArray(params.requestEnvelope)) {
    return { sourceMessageId: null, sourceMessageUnavailableReason: 'request_envelope_missing_message_id' }
  }
  return { sourceMessageId: null, sourceMessageUnavailableReason: 'message_id_unavailable' }
}

function messageHasMediaAttachment(message: RunMessage): boolean {
  return Array.isArray(message) && message.some((block) => block.type === 'image' || block.type === 'video')
}

function hasCurrentTurnAttachmentContext(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (messageHasMediaAttachment(message)) return true
  if (parseAttachmentReferences(message).length > 0) return true
  return parseEnvelopeResourceReferences(requestEnvelope).resources.length > 0
}

export function hasLocalSendImIntentForTurn(message: RunMessage, requestEnvelope?: unknown): boolean {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  return hasLocalSendImFileIntent(primary, {
    hasAttachmentContext: hasCurrentTurnAttachmentContext(message, requestEnvelope),
  })
}

export function isLocalSendImRetryFollowup(message: RunMessage, requestEnvelope?: unknown): boolean {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (isRetryOnlyTurn(primary)) return true
  if (!hasCurrentTurnAttachmentContext(message, requestEnvelope)) return false
  return isLocalSendImAttachmentFollowup(primary)
}

function isLocalSendImAttachmentFollowup(text: string): boolean {
  const normalized = String(text || '')
    .replace(/@\[[^\]]+\]/g, '')
    .replace(/\s+/g, '')
    .trim()
  if (!normalized || normalized.length > 24) return false
  if (/[?？]|帮我|帮忙|请|整理|写|撰写|搜|搜索|查询|查|分析|总结|提取|翻译|改写|润色|生成|制作|打开|预览|查看/.test(normalized)) {
    return false
  }
  return /^(?:再|重新)?(?:试试|试一下|试一次|重试|重发|重新发)(?:这个|这个文件|这个附件|它)?$/.test(normalized)
    || /^(?:这个|这个文件|这个附件|它)(?:也|再)?(?:试试|试一下|发(?:一下)?|传(?:一下)?|重发|重新发)$/.test(normalized)
}

export function stripMediaBlocksForLocalSendIm(
  message: RunMessage,
  requestEnvelope?: unknown,
  forceLocalSendIm = false,
): RunMessage {
  if (!Array.isArray(message)) return message
  if (!forceLocalSendIm && !hasLocalSendImIntentForTurn(message, requestEnvelope)) return message
  let stripped = false
  const textForType = (type: string): string => type === 'video'
    ? '[视频附件已作为 Send IM 待发送文件处理，不发送给模型解析。]'
    : '[图片附件已作为 Send IM 待发送文件处理，不发送给模型解析。]'
  const next = message.map((block) => {
    if (block.type !== 'image' && block.type !== 'video') return block
    stripped = true
    return { type: 'text', text: textForType(block.type) }
  })
  return stripped ? next : message
}

export function buildLocalSendImSkillAuthorization(reason: string): SkillToolAuthorization {
  return buildSelectedSkillToolAuthorization({
    skillId: 'send-im',
    allowedTypedActions: ['skill_send_im_file'],
    allowedPrimitives: [],
    source: 'explicit',
    reason,
  })
}

function countReadableContentUnits(text: string): number {
  const stripped = String(text || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[\s*_`~#[\]()|>-]/g, '')
  const cjkChars = (stripped.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length
  const latinWords = (stripped.match(/[A-Za-z0-9]+/g) || []).length
  return cjkChars + latinWords
}

function countReadableContentChars(text: string): number {
  return String(text || '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .length
}

function requestEnvelopeResourceText(envelope: unknown): string {
  const record = asRecord(envelope)
  if (!record || !Array.isArray(record.resources)) return ''
  return record.resources
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter((text) => text.trim().length > 0)
    .join('\n')
}

// ── Group D: Runtime helpers (lines 731-947) ──

export function resolveAgentSdkMaxTurns(params: {
  message: RunMessage
  requestEnvelope?: unknown
  requiresLocalDocumentWrite: boolean
  taskBudgetRuntime?: TaskBudgetRuntime | null
}): number {
  const budgetSafetyTurns = params.taskBudgetRuntime
    ? params.taskBudgetRuntime.budget.maxToolCalls + Math.max(8, Math.ceil(params.taskBudgetRuntime.budget.maxToolCalls * 0.25))
    : DEFAULT_AGENT_SDK_MAX_TURNS
  const baseTurns = params.requiresLocalDocumentWrite
    ? LOCAL_DOCUMENT_WRITE_MAX_TURNS
    : budgetSafetyTurns
  const readableUnits = Math.max(
    countReadableContentUnits(messageToText(params.message)),
    countReadableContentUnits(requestEnvelopeResourceText(params.requestEnvelope)),
  )
  const readableChars = Math.max(
    countReadableContentChars(messageToText(params.message)),
    countReadableContentChars(requestEnvelopeResourceText(params.requestEnvelope)),
  )
  if (readableUnits < LONG_READING_TRIGGER_CHARS && readableChars < LONG_READING_TRIGGER_CHARS) return baseTurns
  const estimatedReadBatches = Math.max(1, Math.ceil(readableChars / LONG_READING_EXCERPT_BATCH_CHARS))
  const estimatedTurns = baseTurns + Math.max(0, estimatedReadBatches - 1) * LONG_READING_EXTRA_TURNS_PER_BATCH
  const longReadingTurns = Math.max(baseTurns, Math.min(LONG_READING_MAX_TURNS, estimatedTurns))
  return params.taskBudgetRuntime
    ? Math.max(longReadingTurns, params.taskBudgetRuntime.budget.maxToolCalls + 8)
    : longReadingTurns
}

function cloneTaskBudgetRuntime(runtime: TaskBudgetRuntime): TaskBudgetRuntime {
  return {
    ...runtime,
    budget: { ...runtime.budget },
    usage: { ...runtime.usage },
    stepBudget: runtime.stepBudget ? { ...runtime.stepBudget } : null,
    lease: runtime.lease
      ? {
        ...runtime.lease,
        renewedFingerprints: [...runtime.lease.renewedFingerprints],
      }
      : null,
  }
}

export function resolveTaskTypeFromToolDefinitions(definitions: ToolDefinition[]): import('../contracts/run-contracts').TaskType | null {
  if (definitions.some((definition) => definition.domain === 'general_research' || definition.name === 'browser_research_topic')) {
    return 'research'
  }
  if (definitions.some((definition) => definition.domain === 'skill' || definition.name.startsWith('skill_'))) {
    return 'multi_step_task'
  }
  if (definitions.some((definition) => definition.domain === 'browser')) {
    return 'short_task'
  }
  return null
}

export function resolveTaskTypeFromBrowserWorkflowText(text: string | null | undefined): import('../contracts/run-contracts').TaskType | null {
  return resolveBrowserWorkflowIntent(text).kind === 'transaction' ? 'browser_transaction' : null
}

/**
 * 2026-07-04 真机回归第二轮根因修复 — 意图/交易判定的输入必须是**用户话语**，
 * 不是注入后的完整消息。
 *
 * 实锚：采集原话「采集@[...]头 5 个笔记的图片到@[cos]」在词表下正确判
 * collection，但 orchestrator 用 `messageToText(content)`（bootstrap 注入后
 * 文本）做判定——注入的站点卡/纪律含「发布/长文笔记/creator.xiaohongshu.com」
 * 等词命中 PUBLISH_RE → 采集 run 被判 browser_transaction（错误判据模板、
 * 前台 19s 假 done、后台任务孤儿化）。同一污染流进 currentUserText，让全部
 * browser 工具把该轮当交易轮（act_on_target 的交易确认检测/建议由此而来）。
 *
 * 取纯文本优先级：envelope.pureUserText → envelope.primaryInstruction →
 * 调用方提供的回退（无 envelope 的旧路径保持原行为）。
 */
export function resolvePureUserTextForClassification(
  requestEnvelope: unknown,
  fallback: string,
): string {
  if (requestEnvelope && typeof requestEnvelope === 'object') {
    const envelope = requestEnvelope as { pureUserText?: unknown; primaryInstruction?: unknown }
    const pure = typeof envelope.pureUserText === 'string' ? envelope.pureUserText.trim() : ''
    if (pure) return pure
    const primary = typeof envelope.primaryInstruction === 'string' ? envelope.primaryInstruction.trim() : ''
    if (primary) return primary
  }
  return fallback
}

export function resolveAgentSdkTaskBudgetRuntime(params: {
  options?: AgentSdkExecutionOptions
  inferredTaskType?: import('../contracts/run-contracts').TaskType | null
}): TaskBudgetRuntime | null {
  const inherited = params.options?.taskBudgetRuntime
    ? cloneTaskBudgetRuntime(params.options.taskBudgetRuntime)
    : null
  const inferredTaskType = params.inferredTaskType || inherited?.taskType || 'short_task'
  const unfrozen = inherited?.frozen ? resumeBudgetRuntime(inherited) : inherited

  if (unfrozen) {
    if (unfrozen.bootstrapBudget && inferredTaskType !== unfrozen.taskType) {
      return rebindTaskBudgetRuntime(unfrozen, inferredTaskType, { bootstrapBudget: false })
    }
    return inferredTaskType !== unfrozen.taskType && unfrozen.bootstrapBudget
      ? rebindTaskBudgetRuntime(unfrozen, inferredTaskType, { bootstrapBudget: false })
      : unfrozen
  }

  const seed = params.options?.budget || null
  if (!seed) return null
  return createTaskBudgetRuntime(inferredTaskType, {
    budget: seed,
    usage: params.options?.budgetState || null,
    bootstrapBudget: inferredTaskType === 'short_task',
  })
}

export function restoreCheckpointToolSurface(params: {
  toolDefinitions: ToolDefinition[]
  checkpointRestore: AgentSdkBudgetCheckpointRestore | null
  sessionId?: string
  scopeId?: string
  authorization: SkillToolAuthorization
}): { toolDefinitions: ToolDefinition[]; missingToolNames: string[] } {
  const restore = params.checkpointRestore
  if (!restore) return { toolDefinitions: params.toolDefinitions, missingToolNames: [] }
  const byName = new Map(params.toolDefinitions.map((definition) => [definition.name, definition]))
  for (const groupId of restore.requiredCapabilityGroups) {
    if (!groupId || typeof groupId !== 'string') continue
    try {
      for (const definition of defaultToolRegistry.getToolDefinitionsForGroup(
        groupId as CapabilityGroupId,
        params.sessionId,
        params.authorization,
        params.scopeId,
      )) {
        if (!byName.has(definition.name)) byName.set(definition.name, definition)
      }
    } catch {
      // Missing groups are reported below as missing required tool names.
    }
  }
  const requiredToolNames = restore.requiredToolNames.length > 0
    ? restore.requiredToolNames
    : restore.usedToolNames
  const missingToolNames = requiredToolNames.filter((name) => !byName.has(name))
  return {
    toolDefinitions: Array.from(byName.values()),
    missingToolNames,
  }
}

export function taskBudgetDiagnostics(runtime: TaskBudgetRuntime | null): {
  budget: Partial<RunBudgetSeed & RunBudgetUsage> | null
  budgetUsagePercent: number | null
  budgetWarningLevel: BudgetWarningLevel | null
} {
  if (!runtime) {
    return {
      budget: null,
      budgetUsagePercent: null,
      budgetWarningLevel: null,
    }
  }
  const usagePercent = getBudgetUsagePercent(runtime)
  return {
    budget: {
      ...runtime.budget,
      ...runtime.usage,
    },
    budgetUsagePercent: usagePercent,
    budgetWarningLevel: runtime.warningLevel || getBudgetWarningLevel(usagePercent),
  }
}

function buildBudgetWarningSteering(level: BudgetWarningLevel): string {
  if (level === 'warning') {
    return '预算提醒：工具预算已接近上限。下一步请优先收敛结果，避免展开新分支。'
  }
  if (level === 'converge') {
    return '预算提醒：工具预算已经很紧。除非缺少关键证据，否则请总结当前结果；如必须继续，请说明需要用户确认继续。'
  }
  return ''
}

export function appendBudgetWarningSteering(
  output: ToolExecutionOutput,
  runtimeContext: ToolBridgeRuntimeContext,
): ToolExecutionOutput {
  const nextWarning = runtimeContext.budgetWarningMessages.shift()
  const steering = nextWarning ? buildBudgetWarningSteering(nextWarning) : ''
  if (!steering) return output
  const normalized = normalizeToolExecutionOutput(output)
  return createToolExecutionOutput(
    [normalized.text, steering].filter(Boolean).join('\n\n'),
    {
      shape: normalized.shape,
      data: {
        ...(normalized.data && typeof normalized.data === 'object' && !Array.isArray(normalized.data)
          ? normalized.data as Record<string, unknown>
          : {}),
        budgetWarningLevel: nextWarning,
        budgetSteeringInjected: true,
      },
      projectionPatch: normalized.projectionPatch || undefined,
      interactionHint: normalized.interactionHint || undefined,
      framePatch: normalized.framePatch || undefined,
      contextModifier: normalized.contextModifier || undefined,
    },
  )
}

export function resolveAgentSdkProviderDiagnostics(params: {
  config: AIModelConfig
  capabilities: NonNullable<ReturnType<typeof resolveAIConfigCapabilities>>
  modelDef?: AIModelDef | null
  contextWindowTokens: number
}): AgentSdkProviderDiagnostics {
  return {
    provider: params.config.provider || null,
    agentProtocol: params.capabilities.agentProtocol || null,
    wireApi: params.capabilities.wireApi || null,
    contextWindow: params.contextWindowTokens,
    protocolSource: params.config.agentProtocol ? 'explicit' : 'inferred',
    contextWindowSource: params.config.contextWindowOverride
      ? 'explicit'
      : params.modelDef?.contextWindow
        ? 'model'
        : 'fallback',
  }
}

export function safeContinuationPathSegment(value: string): string {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'run'
}

export function acquireBudgetCheckpointFlight(runStatePath: string): boolean {
  const key = String(runStatePath || '').trim()
  if (!key) return true
  if (activeBudgetCheckpointFlights.has(key)) return false
  activeBudgetCheckpointFlights.add(key)
  return true
}

export function releaseBudgetCheckpointFlight(runStatePath: string | null): void {
  const key = String(runStatePath || '').trim()
  if (key) activeBudgetCheckpointFlights.delete(key)
}

export const SDK_CONTEXT_MARKERS = [
  '## 环境信息',
  '## 当前 Scope',
  '## 最近会话摘要',
  '### Widget 更新上下文',
  '### 当前文档上下文',
  '### 文档引用',
  '### 浏览页面引用',
  '### 文件夹引用',
  '### 技能目录引用',
  '--- 测试模式附件路径 ---',
  '--- 引用文件:',
  '--- 附件:',
] as const

// ── Group E: Skill context & intent helpers (lines 964-1359) ──

export function explicitReferenceSkillHasScripts(
  skill: { managedPath?: string } | null,
  typedActions: ReadonlyArray<string>,
): boolean {
  if (!skill || typedActions.length > 0) return false
  const managedPath = typeof skill.managedPath === 'string' ? skill.managedPath : ''
  if (!managedPath) return false
  try {
    return existsSync(join(managedPath, 'scripts'))
  } catch {
    return false
  }
}

export function skillContextMessagesToInstruction(
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>,
): string {
  const sections = messages
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.map((item) => {
          if (typeof item.text === 'string') return item.text
          return JSON.stringify(item)
        }).join('\n')
        : message.content
      const text = String(content || '').trim()
      if (!text) return ''
      return `【skill context / ${message.role || 'system'}】\n${text}`
    })
    .filter(Boolean)
  return sections.join('\n\n')
}

export function allowedPrimitiveToolsForSdkSkillTurn(options: {
  allowRunShell?: boolean
  allowAskUser?: boolean
} = {}): string[] {
  const safeSkillPrimitives = new Set([
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_export_artifact',
    'skill_inspect_run_state',
  ])
  if (options.allowAskUser !== false) {
    safeSkillPrimitives.add('skill_ask_user')
  }
  if (options.allowRunShell) {
    safeSkillPrimitives.add('skill_run_shell')
  }
  return PRIMITIVE_TOOL_DEFS
    .map((definition) => definition.name)
    .filter((name) => safeSkillPrimitives.has(name))
}

export function shouldSuppressSkillAskUserForArtifactDelivery(textCandidates: string[]): boolean {
  const joined = textCandidates.join('\n')
  if (!/(?:输出到|保存到|写入|写到|导出到|存到|落到|文件名|output\s+to|save\s+to|write\s+to|export\s+to)/i.test(joined)) {
    return false
  }
  if (/(?:不要|不用|无需|不必|别|禁止).{0,8}(?:追问|问我|询问|提问|澄清|确认)|(?:直接|立刻|马上).{0,12}(?:生成|输出|保存|写入|完成)/i.test(joined)) {
    return true
  }
  if (/(?:先问|追问|澄清|确认一下|问我|intake|clarify|ask\s+me)/i.test(joined)) {
    return false
  }
  return true
}

export function messageHasBrowserCollectionIntent(message: RunMessage, requestEnvelope?: unknown): boolean {
  const fullText = messageToText(message)
  const envelopePrimary = parseEnvelopeResourceReferences(requestEnvelope).primaryInstruction
  const primary = envelopePrimary || primaryInstructionText(message)
  const hasActiveTaskContext = hasRecalledTaskContext(fullText)
  const primaryIntent = resolveBrowserWorkflowIntent(primary)
  const fullIntent = followupConsultsRecalledContext(primary, { hasActiveTaskContext })
    ? resolveBrowserWorkflowIntent(`${primary}\n${fullText}`)
    : primaryIntent
  if (isBrowserTransactionIntent(primaryIntent) || isBrowserTransactionIntent(fullIntent)) {
    return false
  }
  if (fullText.includes('### 浏览页面引用')) return true
  if (resolveBrowserCollectionIntent(primary)) {
    const negated = classifyFollowupIntent(primary, { hasActiveTaskContext })
    if (negated.negations.includes('collection')) return false
    return true
  }
  if (
    followupConsultsRecalledContext(primary, { hasActiveTaskContext })
    && resolveBrowserCollectionIntent(fullText)
  ) return true
  return false
}

export function hasRecalledTaskContext(fullText: string): boolean {
  return fullText.includes('## 最近会话摘要') || fullText.includes('### 浏览页面引用')
}

export function messageHasBrowserBatchCollectionIntent(message: RunMessage, requestEnvelope?: unknown): boolean {
  const fullText = messageToText(message)
  const envelopePrimary = parseEnvelopeResourceReferences(requestEnvelope).primaryInstruction
  const primary = envelopePrimary || primaryInstructionText(message)
  if (resolveBrowserBatchCollectionIntent(primary)) {
    const negated = classifyFollowupIntent(primary, { hasActiveTaskContext: hasRecalledTaskContext(fullText) })
    if (negated.negations.includes('collection')) return false
    return true
  }
  if (
    followupConsultsRecalledContext(primary, { hasActiveTaskContext: hasRecalledTaskContext(fullText) })
    && resolveBrowserBatchCollectionIntent(fullText)
  ) return true
  return false
}

export function primaryInstructionText(message: RunMessage): string {
  const text = messageToText(message)
  let end = text.length
  for (const marker of SDK_CONTEXT_MARKERS) {
    const index = text.indexOf(marker)
    if (index >= 0 && index < end) end = index
  }
  const primary = text.slice(0, end).trim()
  return primary || text
}

function normalizedReferenceName(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .replace(/^@\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()
}

function parseAttachmentReferences(message: RunMessage): Array<{ name: string; path: string }> {
  const text = messageToText(message)
  const references: Array<{ name: string; path: string }> = []
  const pattern = /--- 附件:\s*([^\n-][^\n]*?)\s*---\s*\n-\s*路径:\s*([^\n]+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]?.trim()
    const path = match[2]?.trim()
    if (name && path) references.push({ name, path })
  }
  const harnessMarker = '--- 测试模式附件路径 ---'
  const harnessIndex = text.indexOf(harnessMarker)
  if (harnessIndex >= 0) {
    const afterMarker = text.slice(harnessIndex + harnessMarker.length)
    const nextSectionIndex = afterMarker.search(/\n--- (?!测试模式附件路径)/)
    const harnessSection = nextSectionIndex >= 0 ? afterMarker.slice(0, nextSectionIndex) : afterMarker
    const harnessPattern = /^-\s*([^:\n]+?)\s*:\s*(\/[^\n]+)$/gm
    let harnessMatch: RegExpExecArray | null
    while ((harnessMatch = harnessPattern.exec(harnessSection)) !== null) {
      const name = harnessMatch[1]?.trim()
      const path = harnessMatch[2]?.trim()
      if (name && path) references.push({ name, path })
    }
  }
  return references
}

export function parseEnvelopeResourceReferences(envelope: unknown): {
  primaryInstruction: string | null
  resources: Array<{ name: string; path: string; kind?: string; source?: string; tabId?: string }>
} {
  const record = asRecord(envelope)
  if (!record) return { primaryInstruction: null, resources: [] }
  const primaryInstruction = typeof record.primaryInstruction === 'string' && record.primaryInstruction.trim()
    ? record.primaryInstruction.trim()
    : typeof record.pureUserText === 'string' && record.pureUserText.trim()
      ? record.pureUserText.trim()
      : typeof record.rawUserText === 'string' && record.rawUserText.trim()
        ? primaryInstructionText(record.rawUserText)
        : null
  const rawResources = Array.isArray(record.resources) ? record.resources : []
  const resources = rawResources
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: String(item.name || '').trim(),
      path: String(item.path || item.documentPath || '').trim(),
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      source: typeof item.source === 'string' ? item.source : undefined,
      tabId: typeof item.tabId === 'string' ? item.tabId.trim() : undefined,
    }))
    .filter((item) => item.name && item.path)
  return { primaryInstruction, resources }
}

export function skillAuthorizationTextCandidates(message: RunMessage, envelope: unknown): string[] {
  const record = asRecord(envelope)
  const rawUserText = stringField(record, 'rawUserText')
  const rawExplicitMention =
    rawUserText
    && /@\[[^\]]+\]/.test(rawUserText)
    && !SDK_CONTEXT_MARKERS.some((marker) => rawUserText.includes(marker))
      ? rawUserText.trim()
      : ''
  const envelopeCandidates = [
    parseEnvelopeResourceReferences(envelope).primaryInstruction,
    stringField(record, 'primaryInstruction'),
    stringField(record, 'pureUserText'),
    rawExplicitMention,
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  if (envelopeCandidates.length > 0) return Array.from(new Set(envelopeCandidates))

  if (rawUserText && !SDK_CONTEXT_MARKERS.some((marker) => rawUserText.includes(marker))) {
    return [rawUserText.trim()]
  }

  const fallback = primaryInstructionText(message).trim()
  return fallback ? [fallback] : []
}

interface SkillHintRelevanceDecision {
  relevant: boolean
  reason: string
}

export function resolveSkillHintRelevanceForTurn(params: {
  message: RunMessage
  requestEnvelope?: unknown
  sessionId?: string
  orchestrator: SkillContextOrchestratorLike | null
  localSendImIntent: boolean
  continuationIntent?: import('../contracts/continuation-state').ContinuationIntent | null
  continuationState?: import('../contracts/continuation-state').ContinuationState | null
  checkpointRestore?: AgentSdkBudgetCheckpointRestore | null
  taskRefs?: ReadonlyArray<FollowupTaskRef>
}): SkillHintRelevanceDecision {
  if (params.localSendImIntent) return { relevant: true, reason: 'local_send_im' }
  const userTextCandidates = skillAuthorizationTextCandidates(params.message, params.requestEnvelope)
  if (params.checkpointRestore || params.continuationIntent || params.continuationState) {
    return { relevant: true, reason: 'continuation' }
  }
  if (userTextCandidates.length === 0 || !params.orchestrator) {
    return { relevant: false, reason: 'no_skill_signal' }
  }
  for (const text of userTextCandidates) {
    const explicitSkills = params.orchestrator.findExplicitlyRequestedSkills?.(text) || []
    if (explicitSkills.some((skill) => skill?.id || skill?.skillId)) {
      return { relevant: true, reason: 'explicit_skill' }
    }
  }
  const referenceHint = resolveReferenceHintSnapshot(params.orchestrator, params.sessionId)
  if (!referenceHint) return { relevant: false, reason: 'no_reference_hint' }
  // P1 fix (2026-07-03, live regression) — a continuable task keeps the reduced
  // skill/collection continuation surface warm UNLESS the new turn starts its
  // OWN concrete browser action (a publish/upload/submit transaction or a
  // collection/download). Before, ANY turn with a reference hint + continuable
  // task hit continuable_task, so a fresh "把这条视频下载到X" after a paused
  // collection got the 12-tool skill set and lost
  // browser_media_download_advanced / browser_power_eval / resolve_video — the
  // agent then reported it "lacked the tools". A skill-resume follow-up with no
  // browser intent (e.g. "跑 finalize") still keeps the skill surface; genuine
  // resumes also come through the continuationIntent branch above.
  const startsFreshBrowserWork = userTextCandidates.some((text) => {
    const kind = resolveBrowserWorkflowIntent(text).kind
    return kind === 'transaction' || kind === 'collection'
  })
  if (params.taskRefs && hasContinuableTaskRef(params.taskRefs) && !startsFreshBrowserWork) {
    return { relevant: true, reason: 'continuable_task' }
  }
  for (const text of userTextCandidates) {
    if (shouldDisplayReferenceSkillHintForLatestUserText({
      latestUserText: text,
      skillId: referenceHint.id,
      skillName: referenceHint.name,
    })) {
      return { relevant: true, reason: 'reference_hint_text' }
    }
    if (looksLikeNaturalReferenceSkillFollowup(text)) {
      return { relevant: true, reason: 'natural_followup' }
    }
  }
  return { relevant: false, reason: 'unrelated_turn' }
}

function resolveReferenceHintSnapshot(
  orchestrator: SkillContextOrchestratorLike,
  sessionId?: string,
): { id: string; name: string } | null {
  const fromOrchestrator = orchestrator.peekCurrentReferenceSkillHint?.(sessionId)
  if (fromOrchestrator?.id) return fromOrchestrator
  const hint = peekLastReferenceSkill(sessionId)
  return hint ? { id: hint.id, name: hint.name } : null
}

function looksLikeNaturalReferenceSkillFollowup(text: string): boolean {
  const normalized = String(text || '').replace(/\s+/g, '').trim()
  if (!normalized || normalized.length > 80) return false
  if (/[?？]/.test(normalized)) return false
  if (/^(?:那就|就按|按(?:这个|那个|第[一二三四五六七八九十0-9]+|第一|第二|第三)|开始吧|执行吧|推进吧)/i.test(normalized)) {
    return true
  }
  if (!/^(?:好|好的|可以|行|嗯|对|没问题|ok|yes|sure)[，,。.!！、]?(?:那|就|按|继续|开始|推进|执行|做|跑|用|走|来|把|从)?/i.test(normalized)) {
    return false
  }
  return /(?:按|照|这个|那个|第[一二三四五六七八九十0-9]+|方案|方向|推进|执行|做|开始|继续|跑|预算|面积|主推|产品)/i.test(normalized)
}

function isOpenConversationInvitationTurn(message: RunMessage, requestEnvelope?: unknown): boolean {
  const primary = parseEnvelopeResourceReferences(requestEnvelope).primaryInstruction
    || primaryInstructionText(message)
  const text = String(primary || '').trim()
  if (!text) return false
  if (/(?:帮我|请|搜索|查询|查一下|打开|生成|制作|保存|写入|整理|分析(?:一下)?|下载|发给)/.test(text)) {
    return false
  }
  return /(?:让你(?:跟|和)我聊|陪我聊|(?:跟|和)我聊|聊聊|聊天).{0,24}(?:你会|怎么|如何|开头|开始|开场)/i.test(text)
    || /^(?:hi|hello|hey|你好|嗨|哈喽)[，,\s].{0,40}(?:聊|哲学|怎么开头|你会怎么)/i.test(text)
}

export function shouldSuppressAskUserQuestionsForOpenConversation(params: {
  message: RunMessage
  requestEnvelope?: unknown
  authorization: SkillToolAuthorization
}): boolean {
  if (params.authorization.mode === 'selected') return false
  return isOpenConversationInvitationTurn(params.message, params.requestEnvelope)
}

function resolveAuthorizationPreferredToolNames(authorization: SkillToolAuthorization): string[] | null {
  if (authorization.mode !== 'selected') return null
  return Array.from(new Set([
    ...Array.from(authorization.allowedTypedActions),
    ...Array.from(authorization.allowedPrimitives),
  ]))
}

interface SdkDefaultIntentSurface {
  intentGroupModes: Partial<Record<CapabilityGroupId, boolean>>
  forceDocumentTool: boolean
  allowBrowserTools: boolean
  preferredSkillToolNames: string[] | null
  documentWidgetTaskKind: ReturnType<typeof inferDocumentWidgetTaskKind>
  explicitWidgetCreateIntent: boolean
}

export function resolveSdkDefaultIntentSurface(params: {
  message: RunMessage
  requestEnvelope?: unknown
  authorization: SkillToolAuthorization
  browserDecisionMode: import('../../../../shared/browser-agent-task').BrowserTaskDecisionMode
}): SdkDefaultIntentSurface {
  const envelopeRefs = parseEnvelopeResourceReferences(params.requestEnvelope)
  const userInstructionText = envelopeRefs.primaryInstruction || primaryInstructionText(params.message)
  const envelopeRecord = asRecord(params.requestEnvelope)
  const environmentHints = asRecord(envelopeRecord?.environmentHints)
  const rawUserText = stringField(envelopeRecord, 'rawUserText') || messageToText(params.message)
  const hasWidgetTargetContext = environmentHints?.hasWidgetTargetContext === true
    || envelopeRefs.resources.some((resource) => resource.kind === 'widget_target' || resource.source === 'widget_target')
  const hasDocumentEnvironment = environmentHints?.hasDocumentContext === true
    || rawUserText.includes('### 当前文档上下文')
    || rawUserText.includes('### 文档引用')
    || envelopeRefs.resources.some((resource) => (
      resource.kind === 'document_context'
      || resource.source === 'current_document'
      || /\.(?:md|markdown|txt|docx?)$/i.test(`${resource.path || ''}\n${resource.name || ''}`)
    ))
  const explicitWidgetCreateIntent = hasExplicitDocumentWidgetCreateIntent(userInstructionText)
  const documentWidgetTaskKind = hasWidgetTargetContext && !explicitWidgetCreateIntent
    ? 'update'
    : inferDocumentWidgetTaskKind(userInstructionText)
  const preferredSkillToolNames = resolveAuthorizationPreferredToolNames(params.authorization)
  const requestEnvelope = buildRequestEnvelope({ userText: rawUserText || userInstructionText })
  const mapSemanticIntent = classifyMapSemanticIntentFallback(userInstructionText)
  const intentClassification = applyMapSemanticIntentToIntentClassification(
    classifyIntent(requestEnvelope),
    mapSemanticIntent,
  )

  const intentModes = resolveIntentCapabilityGroupModes({
    hasTools: true,
    capabilityProfile: 'local_chat',
    contextualUserInput: userInstructionText,
    userInstructionText,
    intentClassification,
    hasDocumentEnvironment: hasDocumentEnvironment || (rawUserText.includes('## 环境信息') && rawUserText.includes('当前模式: 文档模式')),
    hasWidgetTargetContext,
    explicitWidgetCreateIntent,
    documentWidgetTaskKind,
    preferredSkillToolNames,
    mapSemanticIntent,
  })

  return {
    intentGroupModes: intentModes.intentGroupModes,
    forceDocumentTool: intentModes.forceDocumentTool,
    allowBrowserTools:
      params.browserDecisionMode === 'browser_workflow'
      || params.browserDecisionMode === 'browser_upload_workflow'
      || intentModes.intentGroupModes.browser_interaction === true
      || intentModes.intentGroupModes.browser_content_tasks === true,
    preferredSkillToolNames,
    documentWidgetTaskKind,
    explicitWidgetCreateIntent,
  }
}

// ── Group F: Document target helpers (lines 1361-1799) ──

function findAttachmentByMention(
  attachments: Array<{ name: string; path: string }>,
  mention: string,
): { name: string; path: string } | null {
  const wanted = normalizedReferenceName(mention)
  return attachments.find((attachment) => {
    const name = normalizedReferenceName(attachment.name)
    const fileName = normalizedReferenceName(basename(attachment.path))
    return name === wanted || fileName === wanted
  }) || null
}

function isEditableDocumentPath(path: string): boolean {
  return /\.(?:md|markdown|txt|docx?)$/i.test(path)
}

function collectUniqueEditableAttachments(
  attachments: Array<{ name: string; path: string }>,
): Array<{ name: string; path: string }> {
  const seen = new Set<string>()
  const result: Array<{ name: string; path: string }> = []
  for (const attachment of attachments) {
    if (!isEditableDocumentPath(attachment.path)) continue
    const key = attachment.path || attachment.name
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(attachment)
  }
  return result
}

function isImplicitSingleDocumentEditInstruction(primary: string): boolean {
  return /(?:修复|修正|修一下|修改|改一下|改成|改写|编辑|润色|优化|替换|删除|删掉|调整|排版)/.test(primary)
}

export function resolveDocumentTargetGuard(message: RunMessage, requestEnvelope?: unknown): DocumentTargetGuard | null {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  const attachments = [
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ]
  if (attachments.length === 0) return null

  const targetPatterns = [
    /(?:在|到|写(?:入|到)|放(?:到|在)|整理(?:到|进)|生成(?:到|在)|保存(?:到|在))@\[(.+?)\](?:里|中|内|下面)?/g,
    /@\[(.+?)\](?:里|中|内|下面).{0,12}(?:生成|写入|整理|制作|放|保存)/g,
    /把@\[(.+?)\].{0,18}(?:改得|改成|改写|编辑|润色|优化|整理成|写成|删掉|删除)/g,
  ]
  for (const pattern of targetPatterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(primary)) !== null) {
      const attachment = findAttachmentByMention(attachments, match[1] || '')
      if (!attachment) continue
      if (!isEditableDocumentPath(attachment.path)) continue
      return {
        targetName: attachment.name,
        targetPath: attachment.path,
        opened: false,
        preserveExistingContent: shouldPreserveExistingDocumentContent(primary),
      }
    }
  }
  const editableAttachments = collectUniqueEditableAttachments(attachments)
  if (editableAttachments.length === 1 && isImplicitSingleDocumentEditInstruction(primary)) {
    const attachment = editableAttachments[0]
    return {
      targetName: attachment.name,
      targetPath: attachment.path,
      opened: false,
      preserveExistingContent: shouldPreserveExistingDocumentContent(primary),
    }
  }
  return null
}

export function buildDocumentTargetInstruction(guard: DocumentTargetGuard | null): string {
  if (!guard) return ''
  const preservedSnippets = guard.preserveExistingContent && guard.requiredPreservedSnippets?.length
    ? [
      '本轮还要求保留目标文档已有内容。以下原有片段必须原样留在最终文档中：',
      ...guard.requiredPreservedSnippets.slice(0, 8).map((snippet) => `- ${snippet}`),
      '如果需要在某个小节下面补充内容，优先把新增内容插入到原有片段之后；不要用替换操作删除原有片段。',
    ].join('\n')
    : ''
  return [
    `本轮用户已明确目标文档：${guard.targetName} (${guard.targetPath})。`,
    '任何写入、追加、插入 widget 或保存前，必须把该路径作为目标文档处理；不要新建临时文档来替代这个目标。',
    '如果需要改内容，先使用 document_open_tab 打开该路径，再执行内容修改，最后调用 document_save_tab 保存。',
    '在目标文档实际写入并保存前，不要用"我将要写入/我准备插入"作为最终回复。',
    '确认目标文档已有结果并保存后，直接用中文说明完成位置，不要继续重复切换标签或重复写入。',
    preservedSnippets,
  ].join('\n')
}

function shouldPreserveExistingDocumentContent(primaryInstruction: string): boolean {
  return /(?:保留(?:原有|已有|原文|原来的|现有).{0,12}(?:内容|笔记|段落|章节|说明)?|不要(?:覆盖|删除|替换)|不能(?:覆盖|删除|替换)|不可(?:覆盖|删除|替换)|不(?:覆盖|删除)|追加|插入|补充到|整理到|放到|写入已有|已有(?:文档|笔记|内容)|原有(?:文档|笔记|内容|段落|章节))/.test(primaryInstruction)
}

function collectRequiredPreservedSnippets(content: string): string[] {
  const seen = new Set<string>()
  const snippets: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^#{1,6}\s/.test(trimmed)) continue
    if (trimmed.length < 4 || trimmed.length > 240) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    snippets.push(trimmed)
    if (snippets.length >= 40) break
  }
  if (snippets.length > 0) return snippets
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || seen.has(trimmed)) continue
    if (trimmed.length < 2 || trimmed.length > 240) continue
    seen.add(trimmed)
    snippets.push(trimmed)
    if (snippets.length >= 20) break
  }
  return snippets
}

export async function hydrateDocumentTargetPreservation(guard: DocumentTargetGuard | null): Promise<void> {
  if (!guard?.preserveExistingContent) return
  if (!/\.(?:md|markdown|txt)$/i.test(guard.targetPath)) return
  try {
    const content = await readFile(guard.targetPath, 'utf-8')
    guard.initialContent = content
    guard.requiredPreservedSnippets = collectRequiredPreservedSnippets(content)
  } catch {
    // silent-catch: preservation snippets are best-effort; save validation still runs without them.
    guard.requiredPreservedSnippets = []
  }
}

function findMissingPreservedSnippets(
  guard: DocumentTargetGuard,
  content: string,
): string[] {
  if (!guard.preserveExistingContent || !guard.requiredPreservedSnippets?.length) return []
  return guard.requiredPreservedSnippets.filter((snippet) => !content.includes(snippet))
}

function formatPreservedSnippetList(snippets: string[]): string {
  return snippets.slice(0, 6).map((snippet) => `- ${snippet}`).join('\n')
}

function buildPreservedContentRepairContext(guard: DocumentTargetGuard): string {
  if (!guard.preserveExistingContent) return ''
  const snippets = guard.requiredPreservedSnippets?.length
    ? `必须恢复并保留的原有片段：\n${formatPreservedSnippetList(guard.requiredPreservedSnippets)}`
    : ''
  const initial = guard.initialContent && guard.initialContent.length <= 8000
    ? `原始目标文档全文：\n${guard.initialContent}`
    : ''
  return [snippets, initial].filter(Boolean).join('\n\n')
}

function createPreservedContentViolationOutput(
  guard: DocumentTargetGuard,
  missingSnippets: string[],
): ToolExecutionOutput {
  return createToolExecutionOutput(
    [
      `这次工具调用会删除 ${guard.targetName} 的原有内容，已拦截以避免覆盖用户笔记。`,
      '请保留原有片段，并把新增内容插入或追加到它们后面。',
      formatPreservedSnippetList(missingSnippets),
    ].filter(Boolean).join('\n'),
    {
      shape: 'json',
      data: {
        errorKind: TARGET_DOCUMENT_ERROR_KINDS.preservedContentMissing.code,
        targetPath: guard.targetPath,
        missingSnippets: missingSnippets.slice(0, 6),
      },
    },
  )
}

function extractMarkdownSection(content: string, sectionTitle: string): string {
  const titleKey = normalizedReferenceName(sectionTitle)
  if (!titleKey) return ''
  const lines = content.split(/\r?\n/)
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] || '')
    if (!match) continue
    const heading = normalizedReferenceName(match[2] || '')
    if (heading === titleKey || heading.includes(titleKey) || titleKey.includes(heading)) {
      start = i + 1
      level = match[1]?.length || 1
      break
    }
  }
  if (start < 0) return ''
  let end = lines.length
  for (let i = start; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[i] || '')
    if (match && (match[1]?.length || 1) <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

export function validatePreservedDocumentMutation(
  guard: DocumentTargetGuard | null | undefined,
  toolName: string,
  args: Record<string, unknown>,
): ToolExecutionOutput | null {
  if (!guard?.preserveExistingContent || !guard.requiredPreservedSnippets?.length) return null
  const snippets = guard.requiredPreservedSnippets
  if (toolName === 'document_set_content') {
    const content = typeof args.content === 'string' ? args.content : ''
    const missing = snippets.filter((snippet) => !content.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  if (toolName === 'document_replace_exact' || toolName === 'document_replace_text') {
    const target = typeof args.target === 'string'
      ? args.target
      : typeof args.from === 'string'
        ? args.from
        : ''
    const replacement = typeof args.replacement === 'string'
      ? args.replacement
      : typeof args.to === 'string'
        ? args.to
        : ''
    const touched = snippets.filter((snippet) => target.includes(snippet) || snippet.includes(target.trim()))
    const missing = touched.filter((snippet) => !replacement.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  if (toolName === 'document_rewrite_section') {
    const sectionTitle = typeof args.sectionTitle === 'string' ? args.sectionTitle : ''
    const newContent = typeof args.content === 'string' ? args.content : ''
    const originalSection = guard.initialContent ? extractMarkdownSection(guard.initialContent, sectionTitle) : ''
    const touched = originalSection
      ? snippets.filter((snippet) => originalSection.includes(snippet))
      : []
    const missing = touched.filter((snippet) => !newContent.includes(snippet))
    return missing.length > 0 ? createPreservedContentViolationOutput(guard, missing) : null
  }
  return null
}

export const DOCUMENT_TARGET_MUTATION_TOOL_NAMES = new Set([
  'document_set_content',
  'document_append_content',
  'document_insert_widget',
  'document_update_widget',
  'document_remove_widget',
  'document_replace_text',
  'document_replace_exact',
  'document_format_section',
  'document_rewrite_section',
])

function isDocumentNoMutationText(text: string): boolean {
  return /(?:内容未变化|无变化|未做改动|已跳过|已是目标格式)/i.test(text)
}

export function isDocumentToolFailureText(text: string): boolean {
  return /(?:^Error:|Document action failed|failed|失败|无法|没有可|未匹配到|未找到|缺少|已拒绝|被拒绝|已取消|被取消)/i.test(text)
}

/** Whether a tool output represents a document-tool failure (error kind or failure text). */
export function isDocumentToolFailure(output: ToolExecutionOutput): boolean {
  const normalized = normalizeToolExecutionOutput(output)
  const data = normalized.data && typeof normalized.data === 'object'
    ? normalized.data as Record<string, unknown>
    : {}
  return (
    typeof data.errorKind === 'string'
    || isDocumentToolFailureText(normalized.text)
  )
}

/** Shallow-merge a list of projection patch records; null when the list is empty. */
export function mergeProjectionPatches(patches: Record<string, unknown>[]): Record<string, unknown> | null {
  if (patches.length === 0) return null
  return patches.reduce<Record<string, unknown>>((acc, patch) => ({ ...acc, ...patch }), {})
}

function getToolDataRecord(output: ToolExecutionOutput): Record<string, unknown> {
  return output.data && typeof output.data === 'object'
    ? output.data as Record<string, unknown>
    : {}
}

export function documentToolMutatedContent(output: ToolExecutionOutput): boolean {
  const data = getToolDataRecord(output)
  if (typeof data.mutated === 'boolean') return data.mutated
  return !isDocumentToolFailureText(output.text) && !isDocumentNoMutationText(output.text)
}

export function documentSaveSucceeded(output: ToolExecutionOutput): boolean {
  const data = getToolDataRecord(output)
  if (typeof data.documentSaved === 'boolean') return data.documentSaved
  return !isDocumentToolFailureText(output.text)
}

function readDocumentToolTargetFromData(data: Record<string, unknown>): ObservedDocumentToolTarget | null {
  const nested = asRecord(data.document)
  const tabId = readTextField(nested || data, 'tabId') || readTextField(data, 'documentTabId')
  const title = readTextField(nested || data, 'title') || readTextField(data, 'documentTitle')
  if (!tabId || !title) return null
  const path = readTextField(nested || data, 'path') || readTextField(data, 'documentPath')
  const dirtyValue = (nested || data).dirty ?? data.documentDirty
  const requiresSaveValue = (nested || data).requiresSave ?? data.documentRequiresSave
  const rawSaveState = readTextField(nested || data, 'saveState') || readTextField(data, 'documentSaveState')
  const dirty = typeof dirtyValue === 'boolean' ? dirtyValue : false
  const inferredSaveState: ObservedDocumentSaveState = path ? (dirty ? 'dirty' : 'saved') : 'unsaved'
  const saveState: ObservedDocumentSaveState =
    rawSaveState === 'saved' || rawSaveState === 'dirty' || rawSaveState === 'unsaved'
      ? rawSaveState
      : inferredSaveState
  const requiresSave = typeof requiresSaveValue === 'boolean'
    ? requiresSaveValue
    : saveState !== 'saved'
  return {
    tabId,
    title,
    path,
    dirty,
    requiresSave,
    saveState,
  }
}

export function readDocumentToolTarget(output: ToolExecutionOutput): ObservedDocumentToolTarget | null {
  return readDocumentToolTargetFromData(readStructuredResultRecord(output))
}

export function isSameObservedDocumentTarget(
  left: ObservedDocumentToolTarget,
  right: ObservedDocumentToolTarget,
): boolean {
  if (left.tabId && right.tabId && left.tabId === right.tabId) return true
  if (left.path && right.path && left.path === right.path) return true
  return false
}

export function normalizeExplicitDocumentTargetToolArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === 'document_save_tab') return {}
  const next = { ...args }
  delete next.tabId
  return next
}

export function buildDocumentTargetRepairInput(guard: DocumentTargetGuard): string {
  return [
    '系统检查：目标文档尚未发生实际写入，上一轮不能算完成。',
    `请现在直接把结果写入目标文档 ${guard.targetName} (${guard.targetPath})。`,
    '如果是在修已有 widget 或信息卡，必须调用 document_update_widget；其他文本内容请调用 document_set_content、document_append_content 或 document_insert_widget 完成写入，并确保 document_save_tab 保存成功。',
    '不要只说明计划，不要输出伪工具调用文本；完成工具调用后再用中文简短确认。',
  ].join('\n')
}

export function buildNewDocumentSaveRepairInput(): string {
  return [
    '系统检查：你已经创建并修改了新文档，但还没有调用 document_save_tab 保存，不能算完成。',
    '请现在只调用 document_save_tab 保存当前文档；保存成功后，用中文简短说明结果并给出保存路径。',
    '不要再新建文档，不要只口头说明，不要输出伪工具调用文本。',
  ].join('\n')
}

export function finalTextIndicatesIncompleteDocument(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/(?:已|已经).{0,12}(?:补完|补全|补充完整|完成补充)/.test(normalized)) return false
  return /(?:被截断|内容截断|未完成|不完整|还没完成|没有完成|我(?:来|会|要).{0,12}补(?:完|全|充)|继续.{0,12}(?:写|补|完成)|需要.{0,12}(?:补|继续))/.test(normalized)
}

export function buildDocumentTargetContinuationRepairInput(guard: DocumentTargetGuard): string {
  return [
    '系统检查：上一轮回复表示目标文档还没补完，因此不能进入完成态。',
    `请现在继续修正目标文档 ${guard.targetName} (${guard.targetPath})，把未完成或截断的部分补完整。`,
    '必须调用 document_set_content、document_append_content、document_replace_text 或 document_replace_exact 完成修正；如果是在修已有 widget，请改用 document_update_widget。最后调用 document_save_tab 保存。',
    '完成后只简短确认，不要再说"我会补完"。',
  ].join('\n')
}

export async function inspectDocumentTargetContent(
  guard: DocumentTargetGuard,
  options: { forbidFutureLeakage?: boolean } = {},
): Promise<string | null> {
  if (!/\.(?:md|markdown|txt)$/i.test(guard.targetPath)) return null
  let content = ''
  try {
    content = await readFile(guard.targetPath, 'utf-8')
  } catch {
    return null
  }
  if (/```show-widget/i.test(content)) {
    const widgetFence = /```show-widget\s*\n([\s\S]*?)(?:\n```|$)/gi
    let match: RegExpExecArray | null
    while ((match = widgetFence.exec(content)) !== null) {
      const raw = (match[1] || '').trim()
      if (!raw) return '目标文档里有空的 show-widget 代码块'
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return '目标文档里的 show-widget JSON 不完整或无法解析'
      }
      const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
      const widgetCode = typeof record?.widget_code === 'string' ? record.widget_code : ''
      if (/<svg[\s>]/i.test(widgetCode) && !/<\/svg>/i.test(widgetCode)) {
        return '目标文档里的 show-widget SVG 没有闭合'
      }
    }
  }
  const visualSyntaxIssue = findDocumentVisualSyntaxIssue(content)
  if (visualSyntaxIssue) return visualSyntaxIssue
  if (
    options.forbidFutureLeakage
    && /(?:日后|将来|未来|后续剧情|后续章节|后续待展开|情感纠葛|争夺)/.test(content)
  ) {
    return '目标文档包含超出指定章节的后续剧情或未来话术'
  }
  const missingPreserved = findMissingPreservedSnippets(guard, content)
  if (missingPreserved.length > 0) {
    return `目标文档缺少原有内容：${missingPreserved.slice(0, 3).join(' / ')}`
  }
  return null
}

export function buildDocumentTargetContentRepairInput(guard: DocumentTargetGuard, issue: string): string {
  return [
    `系统检查：${issue}，目标文档不能进入完成态。`,
    `请修正目标文档 ${guard.targetName} (${guard.targetPath})。`,
    buildPreservedContentRepairContext(guard),
    '如果用户没有明确要求 widget、信息卡或交互式图表，请把损坏的 show-widget 改成稳定的 Markdown 表格、文本关系图或 Mermaid 图。',
    '如果问题是 Mermaid/关系图源码裸露，请把所有 graph/flowchart 节点和连线合并到一个完整的 ```mermaid 代码块里；如果不确定语法能通过，就改成 Markdown 表格或文本关系图。',
    '如果 Mermaid 代码块语法不兼容，请优先改成 Markdown 表格；若继续用 Mermaid，连线标签用 A -->|关系| B，不要用 A -- "关系" --- B。',
    '修复后，```mermaid 代码块外不能再留下 graph/flowchart、%% 注释、节点声明或 -- / --> / --- 这类连线源码。',
    '如果问题是 show-widget 或信息卡损坏，优先调用 document_update_widget 修复已有 widget；不要用 document_replace_text 或 document_replace_exact 修改 show-widget 围栏内部。',
    '如果问题是后续剧情或未来话术，请删除这些内容，只保留指定章节内已经发生或已明示的信息。',
    '如果问题是原有内容缺失，请先恢复原有内容，再把新增内容放在目标位置，不要覆盖原有笔记。',
    '必须调用 document_update_widget、document_set_content、document_replace_text、document_replace_exact 或 document_append_content 完成修正，并调用 document_save_tab 保存。',
    '完成后只简短确认。',
  ].join('\n')
}

// ── Group G: Tool and execution helpers (lines 1801-2122) ──

export function recoverLooseXmlToolCallText(text: string): {
  visibleText: string
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
} {
  const start = text.search(/<tool_call>/i)
  if (start < 0) return { visibleText: text, toolCalls: [] }
  const endMatch = /<\/tool_call>/i.exec(text.slice(start))
  const blockEnd = endMatch ? start + endMatch.index + endMatch[0].length : text.length
  const block = text.slice(start, blockEnd)
  const before = text.slice(0, start).trim()
  const after = endMatch ? text.slice(blockEnd).trim() : ''
  const fnMatch = /<function=([^>\s]+)\s*>/i.exec(block)
  if (!fnMatch) return { visibleText: text, toolCalls: [] }
  const name = String(fnMatch[1] || '').trim()
  if (!name) return { visibleText: text, toolCalls: [] }
  const fnBodyStart = (fnMatch.index || 0) + fnMatch[0].length
  const fnClose = /<\/function>/i.exec(block.slice(fnBodyStart))
  const fnBody = fnClose
    ? block.slice(fnBodyStart, fnBodyStart + fnClose.index)
    : block.slice(fnBodyStart)
  const paramRegex = /<parameter=([^>\s]+)\s*>/ig
  const starts: Array<{ key: string; start: number; end: number }> = []
  let match: RegExpExecArray | null
  while ((match = paramRegex.exec(fnBody)) !== null) {
    const key = String(match[1] || '').trim()
    if (!key) continue
    starts.push({ key, start: match.index, end: match.index + match[0].length })
  }
  const args: Record<string, unknown> = {}
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index]
    const nextStart = starts[index + 1]?.start ?? fnBody.length
    const rawValue = fnBody.slice(current.end, nextStart)
    const explicitEnd = rawValue.search(new RegExp(`</parameter>`, 'i'))
    const value = (explicitEnd >= 0 ? rawValue.slice(0, explicitEnd) : rawValue)
      .replace(/<\/function>\s*$/i, '')
      .replace(/<\/tool_call>\s*$/i, '')
      .trim()
    args[current.key] = value
  }
  return {
    visibleText: [before, after].filter(Boolean).join('\n').trim(),
    toolCalls: [{ name, args }],
  }
}

export function shouldSuppressVisibleTextOnToolCall(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return true
  return /^(?:now|let me|good,|okay,|ok,|i will|i'll|i need|next,|然后|接下来|现在|我先|我会|让我|好的)[\s\S]{0,240}$/i.test(normalized)
}

function hasLocalDocumentResource(message: RunMessage, requestEnvelope?: unknown): boolean {
  const references = collectLocalDocumentReferences(message, requestEnvelope)
  return references.length > 0
}

function hasCurrentDocumentContextResource(requestEnvelope?: unknown): boolean {
  return parseEnvelopeResourceReferences(requestEnvelope).resources.some((reference) =>
    reference.kind === 'document_context' || reference.source === 'current_document'
  )
}

export function shouldPreferCurrentDocumentRead(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (!hasCurrentDocumentContextResource(requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (/(?:当前|这份|这个|本文档|打开的|编辑器|当前打开|当前项目计划文档)/.test(primary)) {
    return true
  }
  const nonCurrentResources = envelopeRefs.resources.filter((reference) =>
    reference.kind !== 'document_context'
    && reference.source !== 'current_document'
    && /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name)
  )
  return nonCurrentResources.length === 0 && parseAttachmentReferences(message).length === 0
}

function collectLocalDocumentReferences(
  message: RunMessage,
  requestEnvelope?: unknown,
): Array<{ name: string; path: string }> {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  return [
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ].filter((reference) => /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name))
}

function hasNonTargetLocalDocumentResource(message: RunMessage, requestEnvelope?: unknown): boolean {
  const target = resolveDocumentTargetGuard(message, requestEnvelope)
  const targetPath = target?.targetPath || ''
  return collectLocalDocumentReferences(message, requestEnvelope)
    .some((reference) => {
      const key = reference.path || reference.name
      return key && key !== targetPath
    })
}

export function shouldUseLocalDocumentToolSet(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (!hasLocalDocumentResource(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (hasLocalSendImFileIntent(primary, {
    hasAttachmentContext: hasCurrentTurnAttachmentContext(message, requestEnvelope),
  })) {
    return false
  }
  if (/(?:网页|浏览器|网站|url|https?:\/\/|www\.|网上|网络|搜索|检索|最新|今天|新闻|官网|公告|source|citation|research|search|latest|today|news)/i.test(primary)) {
    return false
  }
  return /(?:文档|文稿|章节|段落|部分|人物关系|关系图|信息卡|卡片|图表|写入|整理|生成|保存|编辑|改写|润色|排版|@\[[^\]]+\.(?:md|markdown|txt|docx?)\])/i.test(primary)
}

export function shouldRequireLocalDocumentExcerpt(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (!shouldUseLocalDocumentToolSet(message, requestEnvelope)) return false
  if (!hasNonTargetLocalDocumentResource(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  if (/(?:根据|基于|读取|读完|参考|原文|章节|部分|前\s*[一二三四五六七八九十\d]+\s*(?:章|节|部分)|第\s*[一二三四五六七八九十\d]+\s*(?:章|节|部分)|证据|出处|来源)/i.test(primary)) {
    return true
  }
  const documentResourceKeys = new Set([
    ...envelopeRefs.resources,
    ...parseAttachmentReferences(message),
  ]
    .filter((reference) => /\.(?:md|markdown|txt|docx?)$/i.test(reference.path || reference.name))
    .map((reference) => reference.path || reference.name))
  return documentResourceKeys.size > 1 && /(?:总结|梳理|分析|人物|关系)/i.test(primary)
}

export function shouldRequireLocalDocumentWriteOutput(message: RunMessage, requestEnvelope?: unknown): boolean {
  if (!shouldUseLocalDocumentToolSet(message, requestEnvelope)) return false
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  return /(?:新建|创建|另存|保存|写入|写到|写进|整理到|放到|输出到|目录下|文件夹下|@\[[^\]]+\](?:目录|文件夹)|生成(?:一个|一份)?.{0,20}文档|文档.{0,12}(?:保存|写好|写完)|笔记.{0,12}保存)/i.test(primary)
}

export function buildLocalDocumentExcerptInstruction(required: boolean, preferCurrentDocumentRead = false): string {
  if (!required) return ''
  if (preferCurrentDocumentRead) {
    return [
      '本轮是当前编辑器文档依据任务：生成结论前必须先调用 document_read_section 读取当前打开文档的指定章节或片段。',
      '如果用户限定"第 N 章 / 第 N 部分 / 某节 / 某章节"，优先调用 document_read_section，tabId 传 current，range 传 section:N、chapter:N 或 full。',
      '不要因为当前文档路径不在工作区索引里，就要求用户粘贴原文；当前编辑器已打开的内容应通过 document_read_section 读取。',
      '只有用户明确引用其他附件或工作区文件时，才用 file_locate / file_read_excerpt。',
      '只根据读取到的片段写结果；不要使用附件外信息。',
      '如果用户要求写入或保存文档，读取到足够依据后要优先执行真实文档修改并保存。',
    ].join('\n')
  }
  return [
    '本轮是本地文档依据任务：生成结论前必须先调用 file_read_excerpt 读取用户指定章节或片段。',
    '如果用户限定"前几章/某几章"，先用 file_locate 定位章节，再用 file_read_excerpt 读取对应章节正文。',
    '如果用户要求学习、总结、重排或分析整篇长文，优先顺序大块读取：第一次不要传 lineStart/lineEnd，让 file_read_excerpt 返回默认大块和 nextLine；如果 truncated=true，再从 nextLine 接着读。',
    '不要反复读取互相重叠的小行段；只有核对特定章节、标题或引用时才缩小范围。',
    '只根据读取到的片段写结果；不要使用书本常识、后续剧情或附件外信息。不确定的关系要标注"不确定"。',
    '不要写"后续待展开""后续剧情""日后""未来"等超出指定章节的提示语；章节外内容一律省略。',
    '如果用户要求新建、写入或保存文档，读取到足够章节依据后要优先写入并保存目标文档；不要为了读完整本或整章而无限继续读取。',
    '除非用户明确要求 widget、信息卡、卡片或交互式图表，否则关系图优先用 Markdown 表格、文本框图或 Mermaid，不要生成 show-widget。',
  ].join('\n')
}

export function buildLocalDocumentExcerptRepairInput(preferCurrentDocumentRead = false): string {
  if (preferCurrentDocumentRead) {
    return [
      '系统检查：你还没有成功读取当前编辑器文档正文，上一轮不能算完成。',
      '请先调用 document_read_section 读取当前打开文档的相关章节或片段，再基于读取内容重新生成结果。',
      '如果刚才 file_locate 或 file_read_excerpt 因工作区索引失败，不要让用户粘贴原文；改用 document_read_section 读取当前编辑器内容。',
      '如果已经写入了目标文档，请用读取后的依据修正并替换为可靠版本，然后保存。',
    ].join('\n')
  }
  return [
    '系统检查：你还没有成功读取用户指定文档正文，上一轮不能算完成。',
    '请先调用 file_read_excerpt 读取相关章节或片段，再基于读取内容重新生成结果。',
    '如果已经写入了目标文档，请用读取后的依据修正并替换为可靠版本，然后保存。',
  ].join('\n')
}

export function isLocalDocumentToolDefinition(definition: ToolDefinition): boolean {
  return definition.domain === 'document' || definition.domain === 'file'
}

function shouldExposeResearchTools(text: string): boolean {
  return /(?:搜索|查找|查一下|检索|研究|资料|来源|引用|最新|今天|新闻|天气|股价|汇率|比分|赛程|官网|公告|价格|source|citation|research|search|latest|today|news)/i.test(text)
}

export function hasBrowserPublishOperationIntent(text: string): boolean {
  const intent = resolveBrowserWorkflowIntent(text)
  return intent.kind === 'transaction' && intent.transactionKind === 'publish'
}

function shouldPreferBrowserCollectionToolLoop(text: string): boolean {
  return resolveBrowserWorkflowIntent(text).kind === 'collection'
}

export function resolveBrowserDecisionMode(
  message: RunMessage,
  browserHostAvailable: boolean,
  requestEnvelope?: unknown,
): import('../../../../shared/browser-agent-task').BrowserTaskDecisionMode {
  if (!browserHostAvailable) return 'free_tool_loop'
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  const envelopeRecord = asRecord(requestEnvelope)
  const rawUserText = stringField(envelopeRecord, 'rawUserText') || messageToText(message)
  const text = followupConsultsRecalledContext(primary, { hasActiveTaskContext: hasRecalledTaskContext(rawUserText) })
    ? `${primary}\n${rawUserText}`
    : primary
  const workflowIntent = resolveBrowserWorkflowIntent(text)
  if (workflowIntent.kind === 'transaction' || workflowIntent.kind === 'collection') {
    return browserWorkflowIntentToDecisionMode(workflowIntent)
  }
  const hasBrowserPublishOperation = hasBrowserPublishOperationIntent(text)
  const hasExplicitBrowserSurface =
    hasBrowserPublishOperation
    || /(?:网页|浏览器|网站|当前页|页面|链接|url|https?:\/\/|www\.|browser|website|web page|current page|click|download)/i.test(text)
  const hasDocumentSurface =
    /(?:文档|文稿|原文|文章|段落|章节|markdown|\.md\b|@\[.*?\.(?:md|txt|docx?)\]|widget|show-widget|图表|趋势图|人物关系图|卡片|信息卡|表格|保存|写入|追加|替换|编辑|改写|润色|排版|格式)/i.test(text)
  const hasBrowserUploadIntent =
    hasExplicitBrowserSurface &&
    /(?:上传|提交|发布|发送|选择).{0,30}(?:附件|文件|图片|图像|视频|upload|attach|file|image|video)|(?:附件|文件|图片|图像|视频|file|image|video).{0,30}(?:上传|提交|发布|发送|upload|attach)|(?:upload|attach).{0,30}(?:file|image|video)/i.test(text)
  if (hasBrowserUploadIntent) return 'browser_upload_workflow'
  if (hasBrowserPublishOperation) return 'browser_workflow'
  if (shouldPreferBrowserCollectionToolLoop(text)) return 'free_tool_loop'
  if (hasDocumentSurface && !hasExplicitBrowserSurface) return 'free_tool_loop'
  if (
    shouldExposeResearchTools(text)
    || hasExplicitBrowserSurface
    || /(?:打开|点击|输入|下载)/i.test(text)
  ) {
    return 'browser_workflow'
  }
  return 'free_tool_loop'
}

export function toSdkInput(message: RunMessage): string | AgentInputItem[] {
  if (typeof message === 'string') return message

  const content = message.map((block) => {
    if (block.type === 'image' && block.base64) {
      return {
        type: 'input_image',
        image: `data:${block.mimeType || 'image/png'};base64,${block.base64}`,
        detail: 'auto',
      }
    }
    const fallbackText = block.type === 'video'
      ? '[视频附件已接收；当前 SDK 实验路径会先把视频作为附件说明处理。]'
      : block.text || ''
    return {
      type: 'input_text',
      text: fallbackText,
    }
  })

  return [
    {
      role: 'user',
      content,
    } as AgentInputItem,
  ]
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError'
    || /abort|cancel/i.test(error.message)
  )
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function raceWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<'settled' | 'timeout'> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function defaultFetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal,
  })
}

export function classifySdkRuntimeError(error: unknown): {
  terminalReason: TurnTerminalReason
  userMessagePrefix: string
} {
  const message = errorMessage(error)
  if (/(?:api key|authentication|unauthorized|invalid.*key|forbidden|401|403|只支持 OpenAI 协议)/i.test(message)) {
    return {
      terminalReason: 'blocked_config',
      userMessagePrefix: 'SDK 配置失败',
    }
  }
  if (/(?:context[\s_-]*(?:length|window)|maximum context|prompt (?:is )?too long|too many tokens|context_length_exceeded|request too large|http 413|\b413\b)/i.test(message)) {
    return {
      terminalReason: 'context_overflow',
      userMessagePrefix: 'SDK 上下文已超限',
    }
  }
  if (extractSdkMissingToolName(error)) {
    return {
      terminalReason: 'blocked_tool_error',
      userMessagePrefix: 'SDK 工具未注册',
    }
  }
  if (/(?:quota|rate limit|429|fetch failed|network|timeout|timed out|ENOTFOUND|ECONN|ETIMEDOUT)/i.test(message)) {
    return {
      terminalReason: 'blocked_external',
      userMessagePrefix: 'SDK 外部服务暂时不可用',
    }
  }
  return {
    terminalReason: 'blocked_external',
    userMessagePrefix: 'SDK 请求失败',
  }
}

export function extractSdkMissingToolName(error: unknown): string | null {
  const message = errorMessage(error)
  const quoted = message.match(/Tool\s+["'`]([^"'`]+)["'`]\s+not found in agent/i)
  if (quoted?.[1]) return quoted[1].trim()
  const bare = message.match(/Tool\s+([A-Za-z0-9_.:-]+)\s+not found in agent/i)
  return bare?.[1]?.trim() || null
}

// ── Group H: Provider resolution helpers (lines 2124-2388) ──


export function resolveConfiguredModelDef(config: AIModelConfig, baseUrl?: string): AIModelDef | null {
  const providerDef = getProviderDef(config.provider, String(baseUrl || config.baseUrl || '').trim())
  return providerDef?.models.find((modelDef) => modelDef.id === config.model) || null
}

export function extractToolCallFromStreamEvent(event: RunStreamEvent): {
  name: string
  args: Record<string, unknown>
} | null {
  if (event.type !== 'run_item_stream_event' || event.name !== 'tool_called') return null
  const rawItem = (event.item as { rawItem?: unknown }).rawItem
  if (!rawItem || typeof rawItem !== 'object') return null
  const record = rawItem as { type?: unknown; name?: unknown; arguments?: unknown }
  if (record.type !== 'function_call' || typeof record.name !== 'string') return null
  if (typeof record.arguments !== 'string') {
    return { name: record.name, args: {} }
  }
  try {
    const parsed = JSON.parse(record.arguments) as unknown
    return {
      name: record.name,
      args: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {},
    }
  } catch {
    return { name: record.name, args: {} }
  }
}

export function stringifyModelVisibleFunctionResult(output: unknown): string {
  const text = typeof output === 'string'
    ? output
    : JSON.stringify(output || '')
  return redactModelVisibleToolText(text)
}

export function stringifyToolResult(output: ToolExecutionOutput): string {
  return JSON.stringify(buildModelVisibleToolResultPayload(output))
}

export function readStructuredResultRecord(output: ToolExecutionOutput): Record<string, unknown> {
  const normalized = normalizeToolExecutionOutput(output)
  if (normalized.data && typeof normalized.data === 'object' && !Array.isArray(normalized.data)) {
    return normalized.data as Record<string, unknown>
  }
  if (normalized.text) {
    try {
      const parsed = JSON.parse(normalized.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

export const RECOVERABLE_SKILL_PATH_ERROR_KINDS = new Set([
  'absolute_path',
  'path_escape',
  'home_path',
  'empty_path',
  'no_root_match',
])

export const SKILL_ARTIFACT_TOOLS = new Set([
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
])

function isRelativePathInputValidationFailure(
  toolName: string,
  structuredData: Record<string, unknown>,
): boolean {
  if (!SKILL_ARTIFACT_TOOLS.has(toolName)) return false
  if (structuredData.errorKind !== 'input_validation') return false
  const issues = Array.isArray(structuredData.issues) ? structuredData.issues : []
  return issues.some((issue) => {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return false
    const path = (issue as { path?: unknown }).path
    return Array.isArray(path) && path.map((segment) => String(segment)).includes('relativePath')
  })
}

function isRecoverableSkillPathFailure(
  toolName: string,
  structuredData: Record<string, unknown>,
  errorKind: string,
): boolean {
  if (!toolName.startsWith('skill_')) return false
  return RECOVERABLE_SKILL_PATH_ERROR_KINDS.has(errorKind)
    || isRelativePathInputValidationFailure(toolName, structuredData)
}

function terminalFailureReasonFromToolFailure(
  toolName: string,
  structuredData: Record<string, unknown>,
): TerminalFailureReason | null {
  const errorKind = typeof structuredData.errorKind === 'string'
    ? structuredData.errorKind.trim()
    : ''
  if (isRecoverableSkillPathFailure(toolName, structuredData, errorKind)) return null
  if (errorKind === 'send_failed' || errorKind === 'blocked_external') return 'delivery_failed'
  if (
    errorKind === 'sidecar_unavailable'
    || errorKind === 'channel_not_ready'
    || errorKind === TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code
    || errorKind === TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code
    || errorKind === TOOL_ADMISSION_ERROR_KINDS.authorizationDenied.code
  ) {
    return 'tool_unavailable'
  }
  if (
    errorKind === 'file_not_found'
    || errorKind === 'file_ambiguous'
    || errorKind === 'directory_not_supported'
    || errorKind === 'path_missing'
  ) {
    return 'no_artifact'
  }
  if (toolName === 'skill_send_im_file' && errorKind) return 'delivery_failed'
  return 'proof_gap'
}

// ── Group I: Projection & terminal helpers (lines 2390-3002) ──

export function buildTerminalFailureProjectionPatch(
  toolName: string,
  structuredData: Record<string, unknown>,
): Record<string, unknown> {
  const errorKind = typeof structuredData.errorKind === 'string' ? structuredData.errorKind : null
  const errorCode = typeof structuredData.errorCode === 'string' ? structuredData.errorCode : null
  const terminalFailureReason = terminalFailureReasonFromToolFailure(toolName, structuredData)
  return {
    ...(terminalFailureReason ? { terminalFailureReason } : {}),
    terminalFailureTool: toolName,
    ...(errorKind ? { terminalFailureErrorKind: errorKind } : {}),
    ...(errorCode ? { terminalFailureErrorCode: errorCode } : {}),
  }
}

export function readTextField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  const text = typeof value === 'string' ? value.trim() : ''
  return text || null
}

export function mapToolFailureClose(
  results: Array<{ id: string; name: string; args: Record<string, unknown>; result: ToolExecutionOutput }>,
): import('./agent-sdk-types').MapToolFailureClose | null {
  for (const item of [...results].reverse()) {
    if (item.name !== 'map_plan_route') continue
    const normalized = normalizeToolExecutionOutput(item.result)
    const data = readStructuredResultRecord(normalized)
    if (data.ok !== false && typeof data.errorKind !== 'string') return null
    const message = typeof data.message === 'string' && data.message.trim()
      ? data.message.trim()
      : normalized.text || '地图规划没有完成。'
    if (data.errorKind === 'place_ambiguous') {
      return {
        message,
        status: 'checkpoint',
        terminalReason: 'checkpoint_user_input',
        success: true,
      }
    }
    return {
      message,
      status: 'error',
      terminalReason: 'blocked_tool_error',
      success: false,
    }
  }
  return null
}

export function resolveToolFailurePageUrl(
  controller: {
    getTabList?: () => Array<{ id: string; url: string }> | undefined
    getActiveTab?: () => { url: string } | undefined
  } | null | undefined,
  args: Record<string, unknown> | undefined,
): string | null {
  if (!controller) return null
  try {
    const targetedTabId = typeof args?.tab_id === 'string' ? args.tab_id : null
    if (targetedTabId) {
      return controller.getTabList?.()?.find((tab) => tab.id === targetedTabId)?.url ?? null
    }
    return controller.getActiveTab?.()?.url ?? null
  } catch {
    return null
  }
}

export function projectionPatchFromChildClose(close: SkillChildCloseEvent | null): Record<string, unknown> | null {
  const existing = asRecord(close?.projectionPatch)
  if (!close) return existing ? { ...existing } : null
  const handle: Record<string, unknown> = {}
  if (close.runStatePath) handle.runStatePath = close.runStatePath
  if (close.outputDir) handle.outputDir = close.outputDir
  if (close.deliveryReportPath) handle.deliveryReportPath = close.deliveryReportPath
  if (close.sceneScoresPath) handle.sceneScoresPath = close.sceneScoresPath
  const synthesized = Object.keys(handle).length > 0 ? { continuationRef: handle } : {}
  const merged = { ...synthesized, ...(existing ?? {}) }
  return Object.keys(merged).length > 0 ? merged : null
}

function turnTerminalReasonFromChildClose(close: SkillChildCloseEvent): TurnTerminalReason {
  if (isCompletedChildCloseStatus(close.status)) return 'done'
  if (isKilledChildCloseStatus(close.status)) return 'cancelled_user'
  switch (close.terminalReason) {
    case 'checkpoint_budget':
      return 'checkpoint_budget'
    case 'checkpoint_background':
    case 'queued_global_concurrency':
    case 'launch_stuck':
      return 'checkpoint_background'
    case 'blocked_config':
      return 'blocked_config'
    case 'blocked_external':
      return 'blocked_external'
    case 'cancelled_user':
      return 'cancelled_user'
    case 'failed_skill':
    case 'child_process_crashed':
    case 'host_unavailable':
    case 'nested_child_run_not_supported':
      return 'failed_skill'
    case 'resume_launch_failed':
      return 'resume_launch_failed'
    case 'persistence_failed':
      return 'persistence_failed'
    case TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code:
    case 'input_validation':
      return 'blocked_tool_error'
    case 'process_restarted':
      return 'checkpoint_background'
    case 'completed':
      return 'done'
    default:
      return 'checkpoint_user_input'
  }
}

export function sdkStatusFromTerminalReason(
  reason: TurnTerminalReason,
  success = true,
): 'done' | 'error' | 'cancelled' | 'checkpoint' {
  if (reason === 'done') return 'done'
  if (reason === 'adjudication_degraded') return success ? 'done' : 'error'
  if (reason === 'cancelled_user' || reason === 'cancelled_runtime' || reason === 'main_no_progress_timeout') return 'cancelled'
  if (
    reason === 'failed_skill'
    || reason === 'resume_launch_failed'
    || reason === 'persistence_failed'
    || reason === 'blocked_tool_error'
    || reason === 'browser_transaction_unconfirmed'
    || reason === 'delivery_failed'
    || reason === 'tool_unavailable'
    || reason === 'no_artifact'
    || reason === 'proof_gap'
  ) {
    return 'error'
  }
  return 'checkpoint'
}

export function isCheckpointTerminalReason(reason: TurnTerminalReason): boolean {
  return reason === 'checkpoint_budget'
    || reason === 'checkpoint_background'
    || reason === 'checkpoint_user_input'
    || reason === 'checkpoint_steered'
    || reason === 'manual_suspend'
}

export function summarizeChildResume(
  childRunId: string,
  close: SkillChildCloseEvent | null,
): {
  message: string
  terminalReason: TurnTerminalReason
  status: 'done' | 'error' | 'cancelled' | 'checkpoint'
} {
  if (!close) {
    return {
      message: `已继续技能任务 ${childRunId}，后台仍在运行。`,
      terminalReason: 'checkpoint_background',
      status: 'checkpoint',
    }
  }
  if (isCompletedChildCloseStatus(close.status)) {
    return {
      message: `技能任务 ${childRunId} 已完成。`,
      terminalReason: 'done',
      status: 'done',
    }
  }
  if (isKilledChildCloseStatus(close.status)) {
    return {
      message: `技能任务 ${childRunId} 已取消。`,
      terminalReason: 'cancelled_user',
      status: 'cancelled',
    }
  }
  const terminalReason = turnTerminalReasonFromChildClose(close)
  const detail = close.error?.message || close.terminalReason
  return {
    message: isFailedChildCloseStatus(close.status)
      ? `继续技能任务 ${childRunId} 失败：${detail}`
      : `技能任务 ${childRunId} 仍在等待：${detail}`,
    terminalReason,
    status: sdkStatusFromTerminalReason(terminalReason, isCompletedChildCloseStatus(close.status)),
  }
}


function isChildSkillEnvelopeStatus(status: string | null): boolean {
  return status === 'child_launched'
    || status === 'child_reused'
    || status === 'child_paused'
    || status === 'child_terminal'
}

export function shouldRecoverLongSkillCheckpoint(
  checkpoint: SdkLongSkillCheckpoint | null,
): checkpoint is SdkLongSkillCheckpoint {
  if (!checkpoint) return false
  if (checkpoint.terminalReason === 'blocked_config' || checkpoint.terminalReason === 'failed_skill') return false
  return Boolean(checkpoint.childRunId || checkpoint.outputDir || checkpoint.runStatePath)
}

export function summarizeLongSkillCheckpoint(checkpoint: SdkLongSkillCheckpoint): string {
  const output = checkpoint.outputDir
    ? `输出目录：${checkpoint.outputDir}`
    : checkpoint.runStatePath
      ? `run_state：${checkpoint.runStatePath}`
      : checkpoint.childRunId
        ? `子任务：${checkpoint.childRunId}`
        : ''
  const action = checkpoint.action || checkpoint.toolName
  return [
    `技能任务已启动并进入后台/暂停状态（${action}）。`,
    output,
    '可以从任务卡继续、取消或查看产物。',
  ].filter(Boolean).join('\n')
}

export function continuationHandleFromLongSkillCheckpoint(checkpoint: SdkLongSkillCheckpoint): string | null {
  return checkpoint.runStatePath || checkpoint.outputDir || checkpoint.childRunId || null
}

export function extractLongSkillCheckpoint(
  toolName: string,
  output: ToolExecutionOutput,
  previous: SdkLongSkillCheckpoint | null,
): SdkLongSkillCheckpoint | null {
  const normalized = normalizeToolExecutionOutput(output)
  const data = normalized.data
  const status = stringField(data, 'status')
  if (!toolName.startsWith('skill_') || !isChildSkillEnvelopeStatus(status)) return previous

  const closeEvent = asRecord(data?.closeEvent)
  const closeReason = stringField(closeEvent, 'terminalReason')
  const terminalReason: TurnTerminalReason = closeReason === 'blocked_config'
    ? 'blocked_config'
    : closeReason === 'failed_skill'
      ? 'failed_skill'
      : closeReason === 'checkpoint_budget'
        ? 'checkpoint_budget'
        : 'checkpoint_background'
  const next: SdkLongSkillCheckpoint = {
    toolName,
    skillId: stringField(data, 'skillId'),
    action: stringField(data, 'action'),
    childRunId: stringField(data, 'childRunId'),
    outputDir: stringField(data, 'outputDir'),
    runStatePath: stringField(data, 'runStatePath'),
    terminalReason,
  }
  if (!previous) return next
  if ((next.outputDir || next.runStatePath) && !(previous.outputDir || previous.runStatePath)) return next
  return previous
}

export function readReasoningContentFromRecord(record: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(record, 'reasoning_content')) {
    return record.reasoning_content
  }
  if (Object.prototype.hasOwnProperty.call(record, 'reasoningContent')) {
    return record.reasoningContent
  }
  const additional = asRecord(record.additional_kwargs) || asRecord(record.additionalKwargs)
  if (additional && Object.prototype.hasOwnProperty.call(additional, 'reasoning_content')) {
    return additional.reasoning_content
  }
  const providerData = asRecord(record.providerData)
  if (providerData) {
    const fromProviderData = readReasoningContentFromRecord(providerData)
    if (fromProviderData !== undefined) return fromProviderData
  }
  return undefined
}

export function reasoningProviderData(reasoningContent: unknown): Record<string, unknown> | undefined {
  return reasoningContent !== undefined ? { reasoning_content: reasoningContent } : undefined
}

// ── Group J: Model message builders (lines 3004-3247) ──

export function sanitizeMessagesForModelClient(
  rawMessages: ReadonlyArray<Record<string, unknown>>,
  config: AIModelConfig,
  route: 'openai-chat' | 'openai-responses' | 'anthropic',
): Array<Record<string, unknown>> {
  const resolved = resolveAIConfigCapabilities(config)
  const snapshot: MessageCapabilitySnapshot = {
    supportsVision: resolved?.supportsVision === true,
    supportsVideo: resolved?.supportsNativeVideo === true,
  }
  if (snapshot.supportsVision && snapshot.supportsVideo) {
    return rawMessages.slice()
  }
  const decision = sanitizeHistoricalMessagesByCapability(
    rawMessages as unknown as CapabilityMessage[],
    snapshot,
  )
  if (decision.removedImageBlocks > 0 || decision.removedVideoBlocks > 0) {
    logAgentMetric('provider_request_capability_filter', {
      route,
      removedImageBlocks: decision.removedImageBlocks,
      removedVideoBlocks: decision.removedVideoBlocks,
      replacedWithPlaceholders: decision.replacedWithPlaceholders,
      model: config.model,
      provider: config.provider,
    })
  }
  return decision.filtered as unknown as Array<Record<string, unknown>>
}

export function modelInputToOpenAIChatMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      const callId = String(item.callId || item.call_id || item.id || `call-${randomUUID()}`)
      const reasoningContent = readReasoningContentFromRecord(item)
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: String(item.name || ''),
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments || {}),
          },
        }],
        ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = stringifyModelVisibleFunctionResult(item.output)
      messages.push({
        role: 'tool',
        tool_call_id: String(item.callId || item.call_id || item.id || ''),
        content: output,
      })
      continue
    }
    const role = item.role === 'assistant' || item.role === 'user' || item.role === 'system'
      ? item.role
      : null
    if (!role) continue
    const reasoningContent = readReasoningContentFromRecord(item)
    messages.push({
      role,
      content: normalizeOpenAIChatContent(item.content),
      ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

export function normalizeOpenAIChatContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        return { type: 'text', text: String(part.text || '') }
      }
      if (part.type === 'input_image' && typeof part.image === 'string') {
        return { type: 'image_url', image_url: { url: part.image } }
      }
      return { type: 'text', text: '' }
    })
  return parts.length > 0 ? parts : ''
}

export function normalizeOpenAIResponsesContent(content: unknown, role: 'user' | 'assistant'): Array<Record<string, unknown>> {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return [{ type: textType, text: content }]
  if (!Array.isArray(content)) return [{ type: textType, text: '' }]
  const parts = content
    .map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((part) => {
      if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
        return { type: textType, text: String(part.text || '') }
      }
      if (part.type === 'input_image' && typeof part.image === 'string') {
        return { type: 'input_image', image_url: part.image }
      }
      return { type: textType, text: '' }
    })
  return parts.length > 0 ? parts : [{ type: textType, text: '' }]
}

export function modelInputToOpenAIResponsesInput(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: [{ type: 'input_text', text: input }] }]
  }
  const items: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      items.push({
        type: 'function_call',
        call_id: String(item.callId || item.call_id || item.id || `call-${randomUUID()}`),
        name: String(item.name || ''),
        arguments: typeof item.arguments === 'string'
          ? item.arguments
          : JSON.stringify(item.arguments || {}),
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = stringifyModelVisibleFunctionResult(item.output)
      items.push({
        type: 'function_call_output',
        call_id: String(item.callId || item.call_id || item.id || ''),
        output,
      })
      continue
    }
    const role = item.role === 'assistant' ? 'assistant' : 'user'
    items.push({
      role,
      content: normalizeOpenAIResponsesContent(item.content, role),
    })
  }
  return items.length > 0 ? items : [{ role: 'user', content: [{ type: 'input_text', text: '' }] }]
}

export function serializeSdkOpenAITools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      type: 'function',
      function: {
        name: item.name,
        description: item.description || item.name,
        parameters: item.parameters && typeof item.parameters === 'object'
          ? item.parameters
          : { type: 'object', properties: {}, additionalProperties: false },
      },
    }))
}

export function serializeSdkOpenAIResponsesTools(request: ModelRequest): Array<Record<string, unknown>> {
  return serializeSdkOpenAITools(request).map((item) => {
    const fn = item.function as Record<string, unknown>
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    }
  })
}

export function textFromAgentOutputItem(item: AgentOutputItem): string {
  if (item.type !== 'message') return ''
  if (typeof item.content === 'string') return item.content
  if (!Array.isArray(item.content)) return ''
  return item.content
    .map((part) => part && typeof part === 'object' && part.type === 'output_text' ? String(part.text || '') : '')
    .join('')
}

export function extractResponsesText(payload: Record<string, unknown>): string {
  const output = Array.isArray(payload.output) ? payload.output as Array<Record<string, unknown>> : []
  const texts: string[] = []
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : []
    for (const part of content) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  if (texts.length > 0) return texts.join('')
  return typeof payload.output_text === 'string' ? payload.output_text : ''
}

export function openAIUsageFromJson(json: Record<string, unknown>): Usage {
  const usage = json.usage && typeof json.usage === 'object'
    ? json.usage as Record<string, unknown>
    : {}
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || 0)
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || usage.outputTokens || 0)
  const totalTokens = Number(usage.total_tokens || usage.totalTokens || inputTokens + outputTokens || 0)
  return new Usage({
    inputTokens,
    outputTokens,
    totalTokens,
  })
}

export function toOpenAIMessageOutput(
  text: string,
  id: string,
  providerData?: Record<string, unknown>,
): AgentOutputItem[] {
  if (!text) return []
  return [{
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
    ...(providerData ? { providerData } : {}),
  } as AgentOutputItem]
}

export function toOpenAIFunctionCallOutput(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  id: string,
  providerData?: Record<string, unknown>,
): AgentOutputItem[] {
  return calls.map((call) => ({
    id,
    type: 'function_call',
    callId: call.id || `call-${randomUUID()}`,
    name: call.name,
    status: 'completed',
    arguments: JSON.stringify(call.input || {}),
    ...(providerData ? { providerData } : {}),
  } as AgentOutputItem))
}

export function buildProviderPatchContext(params: {
  config: AIModelConfig
  baseUrl: string
  model: string
}): PatchContext {
  const defaults = resolveProviderDefaultPatchers(params.config.provider)
  return {
    config: params.config,
    baseUrl: params.baseUrl,
    model: params.model,
    profile: resolveProviderPatchProfile(params.config, params.baseUrl, params.model),
    providerDefaultRequestPatcher: defaults.defaultRequestPatcher,
    providerDefaultResponsePatcher: defaults.defaultResponsePatcher,
  }
}

export function buildProviderHeaders(config: AIModelConfig, provider: AIProviderDef | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
  return headers
}

export function isEventStreamLikeResponse(response: Response, rawText: string): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (contentType.includes('text/event-stream')) return true
  const trimmed = rawText.trimStart()
  return trimmed.startsWith('event:') || trimmed.startsWith('data:') || trimmed.startsWith(':')
}

export function buildProviderProtocolMismatchError(requestUrl: string): Error {
  const error = new Error(
    `供应商协议不匹配：当前按 OpenAI chat/completions 请求，但 ${requestUrl} 返回了事件流。请把供应商协议切到 Anthropic，或把 API 地址改成 OpenAI chat/completions 兼容地址。`,
  )
  const typed = error as Error & { code?: string; terminalReason?: string }
  typed.code = 'provider_protocol_mismatch'
  typed.terminalReason = 'provider_protocol_mismatch'
  return error
}

export function resolveOpenAIProtocolModel(config: AIModelConfig): string {
  if (config.provider === 'volcengine' && config.endpointId) return config.endpointId
  return config.model
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function continuationChildRunId(options?: AgentSdkExecutionOptions): string | null {
  return nonEmptyString(options?.continuationIntent?.childRunId)
    || nonEmptyString(options?.continuationState?.continuationRef?.childRunId)
}

export function continuationRunStatePath(options?: AgentSdkExecutionOptions): string | null {
  return nonEmptyString(options?.continuationIntent?.runStatePath)
    || nonEmptyString(options?.continuationState?.continuationRef?.runStatePath)
}

export function toOpenAIToolSchemas(definitions: ToolDefinition[]): Array<Record<string, unknown>> {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description || definition.name,
      parameters: definition.schema && definition.schema.type === 'object'
        ? definition.schema
        : { type: 'object', properties: {}, additionalProperties: false },
    },
  }))
}

// ── Group K: Post-class helpers (lines 3702-3740) ──

export function publicAgentName(agentName: string): string {
  const marker = agentName.indexOf('::')
  return marker === -1 ? agentName : agentName.slice(0, marker)
}

export function scopeRunModuleForTool(definition: ToolDefinition): import('../contracts/types').ScopeRunEventPayload['module'] {
  if (definition.domain === 'general_research') return 'research'
  if (
    definition.domain === 'file'
    || definition.domain === 'memory'
    || definition.domain === 'session'
    || definition.domain === 'mcp'
    || definition.domain === 'pet'
    || definition.domain === 'agent_interaction'
    || definition.domain === 'skill_install'
  ) {
    return 'system'
  }
  return definition.domain
}

export function formatToolCallTrace(toolName: string, args: Record<string, unknown>): string {
  const keys = Object.keys(args)
    .filter((key) => !/(?:key|token|secret|password|authorization)/i.test(key))
    .slice(0, 6)
  return `${toolName}(${keys.join(', ')})`
}

export function formatToolResultTrace(toolName: string, output: ToolExecutionOutput): string {
  const normalized = normalizeToolExecutionOutput(output)
  const text = redactModelVisibleToolText(String(normalized.text || '')).trim()
  return text ? `${toolName}: ${text.slice(0, 240)}` : `${toolName}: 已完成`
}

// ── Anthropic helper functions needed by model builders ──

export function safeJsonParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export function dataUrlToAnthropicImage(value: string): Record<string, unknown> | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) return null
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  }
}

export function contentPartToAnthropic(part: Record<string, unknown>): Record<string, unknown> | null {
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return { type: 'text', text: String(part.text || '') }
  }
  if (part.type === 'input_image' && typeof part.image === 'string') {
    return dataUrlToAnthropicImage(part.image) || { type: 'text', text: '[图片附件]' }
  }
  return null
}

export function sanitizeAnthropicThinkingBlock(block: Record<string, unknown>): Record<string, unknown> | null {
  if (block.type !== 'thinking' || typeof block.thinking !== 'string') return null
  return {
    type: 'thinking',
    thinking: block.thinking,
    ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
  }
}

export function readAnthropicThinkingBlocksFromRecord(record: Record<string, unknown>): Record<string, unknown>[] {
  const direct = Array.isArray(record.anthropicThinkingBlocks)
    ? record.anthropicThinkingBlocks
    : null
  if (direct) {
    return direct
      .map((item) => item && typeof item === 'object'
        ? sanitizeAnthropicThinkingBlock(item as Record<string, unknown>)
        : null)
      .filter((item): item is Record<string, unknown> => Boolean(item))
  }
  const providerData = asRecord(record.providerData)
  if (!providerData) return []
  return readAnthropicThinkingBlocksFromRecord(providerData)
}

export function normalizeAnthropicContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = content
    .map((item) => item && typeof item === 'object' ? contentPartToAnthropic(item as Record<string, unknown>) : null)
    .filter((item): item is Record<string, unknown> => Boolean(item))
  return parts.length > 0 ? parts : ''
}

export function modelInputToAnthropicMessages(input: ModelRequest['input']): Array<Record<string, unknown>> {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }
  const messages: Array<Record<string, unknown>> = []
  for (const rawItem of input || []) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    if (item.type === 'function_call') {
      const thinkingBlocks = readAnthropicThinkingBlocksFromRecord(item)
      messages.push({
        role: 'assistant',
        content: [
          ...thinkingBlocks,
          {
            type: 'tool_use',
            id: String(item.callId || item.id || ''),
            name: String(item.name || ''),
            input: typeof item.arguments === 'string' ? safeJsonParseObject(item.arguments) : {},
          },
        ],
      })
      continue
    }
    if (item.type === 'function_call_result') {
      const output = stringifyModelVisibleFunctionResult(item.output)
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.callId || item.id || ''),
          content: output,
        }],
      })
      continue
    }
    const role = item.role === 'assistant' || item.role === 'user'
      ? item.role
      : item.role === 'system'
        ? 'user'
        : null
    if (!role) continue
    messages.push({
      role,
      content: normalizeAnthropicContent(item.content),
    })
  }
  return messages.length > 0 ? messages : [{ role: 'user', content: '' }]
}

export function serializeAnthropicTools(request: ModelRequest): Array<Record<string, unknown>> {
  return (request.tools || [])
    .filter((item) => item.type === 'function')
    .map((item) => ({
      name: item.name,
      description: item.description || item.name,
      input_schema: item.parameters && typeof item.parameters === 'object'
        ? item.parameters
        : { type: 'object', properties: {}, additionalProperties: false },
    }))
}

export function extractAnthropicOutput(json: Record<string, unknown>, fallbackId: string): AgentOutputItem[] {
  const output: AgentOutputItem[] = []
  const content = Array.isArray(json.content) ? json.content as Array<Record<string, unknown>> : []
  const thinkingBlocks = content
    .map(sanitizeAnthropicThinkingBlock)
    .filter((block): block is Record<string, unknown> => Boolean(block))
  const providerData = thinkingBlocks.length > 0
    ? { anthropicThinkingBlocks: thinkingBlocks }
    : undefined
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text || ''))
    .join('')
  if (text) {
    output.push({
      id: String(json.id || fallbackId),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    } as AgentOutputItem)
  }
  for (const block of content) {
    if (block.type !== 'tool_use') continue
    output.push({
      id: String(json.id || fallbackId),
      type: 'function_call',
      callId: String(block.id || `call-${randomUUID()}`),
      name: String(block.name || ''),
      status: 'completed',
      arguments: JSON.stringify(
        block.input && typeof block.input === 'object' && !Array.isArray(block.input)
          ? block.input
          : {},
      ),
      ...(providerData ? { providerData } : {}),
    } as AgentOutputItem)
  }
  return output
}
