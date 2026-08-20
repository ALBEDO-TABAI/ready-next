import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import {
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIModelDef
} from '../../../../shared/ai-providers'
import { hasLocalSendImFileIntent } from '../../../../shared/remote-im-file-intent'
import { PRIMITIVE_TOOL_DEFS } from '../../tools/skill-primitives/tool-defs'
import {
  isCodexSafeHostSkillPrimitiveDefinition,
  isHostFolderExportPrimitive,
} from '../../tools/skill-tool-execution-authority'
import { getSkillsRuntimeManager } from '../../skills-runtime/runtime-manager'
import type { SkillState } from '../../skills-runtime/runtime-manager-types'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type {
  BudgetWarningLevel,
  RunBudgetSeed,
  RunBudgetUsage,
  RunMessage,
  TaskBudgetRuntime
} from '../contracts/run-contracts'
import { isRetryOnlyTurn } from '../skills/skill-detection-inputs'
import { loadReadySystemPrompt } from '../prompt-assets/ready-system-asset'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { buildSelectedSkillToolAuthorization } from '../skills/skill-tool-authorization'
import {
  createTaskBudgetRuntime,
  getBudgetUsagePercent,
  getBudgetWarningLevel,
  rebindTaskBudgetRuntime,
  resumeBudgetRuntime
} from '../task-projection/run-budget-policy'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import {
  messageToText,
  parseAttachmentReferences,
  parseEnvelopeResourceReferences,
  primaryInstructionText
} from './agent-sdk-input-context-utils'
import { asRecord } from './agent-sdk-model-message-utils'
import type {
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics
} from './agent-sdk-types'

export const SDK_CHILD_RESUME_AWAIT_TIMEOUT_MS = 1_500
export const DEFAULT_AGENT_SDK_MAX_TURNS = 24
export const NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS = 4000
const NATIVE_TEXT_TOOL_MARKERS = [
  '<tool_call',
  '<function=',
  '<parameter=',
  ':::tool_call',
  '[tool_call]'
] as const
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
  options: { flushWithoutMarker?: boolean; hardLimit?: number } = {}
): { emitText: string; remainingText: string } {
  const hardLimit = options.hardLimit ?? NATIVE_TEXT_BUFFER_SAFE_FLUSH_CHARS
  const markerIndex = findNativeTextToolMarkerIndex(text)
  if (markerIndex >= 0) {
    return {
      emitText: text.slice(0, markerIndex),
      remainingText: text.slice(markerIndex)
    }
  }
  if (
    text.length > 0 &&
    (options.flushWithoutMarker || text.length > hardLimit) &&
    !hasDanglingNativeTextToolMarker(text)
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
  } = {}
): ToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) return definitions
  const selected = definitions.filter((definition) => allowedTools.includes(definition.name))
  const selectedOrPreserved = definitions.filter(
    (definition) =>
      allowedTools.includes(definition.name) || options.preserveToolName?.(definition.name) === true
  )
  const filtered = definitions.filter(
    (definition) =>
      selectedOrPreserved.includes(definition) || definition.name === 'declare_completion_criteria'
  )
  if (selected.length > 0) return filtered

  const fallback = definitions.filter(
    (definition) => definition.groupId !== 'skills' && definition.domain !== 'skill'
  )
  if (fallback.length === 0) return filtered
  appendToolCapabilityLog(
    [
      '[tool_capability]',
      'stage=sdk_runtime_skill_allowed_tools_fallback',
      `allowedTools=${allowedTools.join('|') || 'none'}`,
      `preservedTools=${fallback.map((definition) => definition.name).join('|') || 'none'}`
    ].join(' ')
  )
  return fallback
}

export function authorizedPrimitiveToolNames(authorization: SkillToolAuthorization): string[] {
  if (authorization.mode === 'selected') {
    return PRIMITIVE_TOOL_DEFS.map((definition) => definition.name).filter((name) =>
      authorization.allowedPrimitives.has(name)
    )
  }
  return authorization.candidateSkillPrimitives
    ? [...authorization.candidateSkillPrimitives.primitives]
    : []
}

/** P0-3(D3) — 技能选中轮的文档读取地板：本轮携带本地文档资源时这些工具不得被技能收窄丢弃。 */
export const LOCAL_DOCUMENT_FLOOR_TOOL_NAMES: ReadonlyArray<string> = [
  'file_locate',
  'file_read_excerpt',
  'document_read_section'
]

/** P0-2 — 技能选中轮的地板工具名（typed actions ∪ primitives）；none 轮为空集。 */
export function selectedSkillFloorToolNames(
  authorization: SkillToolAuthorization
): ReadonlySet<string> {
  if (authorization.mode !== 'selected') return new Set()
  return new Set([...authorization.allowedTypedActions, ...authorization.allowedPrimitives])
}

export function isLocalDocumentToolDefinition(definition: ToolDefinition): boolean {
  return definition.domain === 'document' || definition.domain === 'file'
}

/**
 * P0-2(D2) — 本地文档收窄的唯一实现：只保留本地文档工具（domain document|file）∪ 技能地板。
 * orchestrator 调用此纯函数（而非内联 filter），使收窄行为可被单测按真实代码路径覆盖。
 */
export function narrowToolSurfaceForLocalDocument(
  toolDefinitions: ToolDefinition[],
  authorization: SkillToolAuthorization,
  options: {
    preserveDefinition?: (definition: ToolDefinition) => boolean
  } = {},
): ToolDefinition[] {
  const skillFloor = selectedSkillFloorToolNames(authorization)
  return toolDefinitions.filter(
    (definition) =>
      isLocalDocumentToolDefinition(definition)
      || skillFloor.has(definition.name)
      || options.preserveDefinition?.(definition) === true
  )
}

const TASK_INTENT_GROUPS_THAT_SURVIVE_DOCUMENT_NARROWING = new Set([
  'general_research',
  'browser_interaction',
  'browser_content_tasks',
])

/** Incidental editor context must not delete a capability explicitly admitted for this turn's task. */
export function shouldPreserveTaskIntentToolDuringDocumentNarrowing(
  definition: ToolDefinition,
): boolean {
  return definition.name === 'declare_completion_criteria'
    || definition.name === 'use_skill'
    || TASK_INTENT_GROUPS_THAT_SURVIVE_DOCUMENT_NARROWING.has(String(definition.groupId || ''))
}

/** P0-2 — 收窄管线末端防空：窄化后为空且窄化前非空 → 回退窄化前全量面。 */
export function recoverEmptyToolSurface<T>(
  narrowed: readonly T[],
  preNarrowing: readonly T[]
): { definitions: readonly T[]; recovered: boolean } {
  if (narrowed.length === 0 && preNarrowing.length > 0) {
    return { definitions: preNarrowing, recovered: true }
  }
  return { definitions: narrowed, recovered: false }
}

export function supplementAuthorizedSkillPrimitiveDefinitions(
  definitions: ToolDefinition[],
  authorization: SkillToolAuthorization
): ToolDefinition[] {
  const primitiveNames = authorizedPrimitiveToolNames(authorization)
  if (primitiveNames.length === 0) return definitions
  const seen = new Set(definitions.map((definition) => definition.name))
  const next = [...definitions]
  let liveSkills: readonly SkillState[] = []
  try {
    liveSkills = getSkillsRuntimeManager().listSkills()
  } catch {
    liveSkills = []
  }
  const liveDefinitions = defaultToolRegistry.listToolDefinitions()
  for (const name of primitiveNames) {
    if (seen.has(name)) continue
    const definition = liveDefinitions.find((entry) => entry.name === name)
      || defaultToolRegistry.getToolDefinitionForExecution(name)
    if (!definition) continue
    next.push({
      ...definition,
      codexExecutionSafe: isHostFolderExportPrimitive(name)
        || liveSkills.some((skill) =>
          isCodexSafeHostSkillPrimitiveDefinition(name, skill)),
    })
    seen.add(name)
  }
  return next
}

// ── Group C: Message/text utilities (lines 604-710) ──

export function defaultSystemPrompt(): string {
  return loadReadySystemPrompt()
}

function messageHasMediaAttachment(message: RunMessage): boolean {
  return (
    Array.isArray(message) &&
    message.some((block) => block.type === 'image' || block.type === 'video')
  )
}

export function hasCurrentTurnAttachmentContext(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  if (messageHasMediaAttachment(message)) return true
  if (parseAttachmentReferences(message).length > 0) return true
  return parseEnvelopeResourceReferences(requestEnvelope).resources.length > 0
}

export function hasLocalSendImIntentForTurn(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
  const envelopeRefs = parseEnvelopeResourceReferences(requestEnvelope)
  const primary = envelopeRefs.primaryInstruction || primaryInstructionText(message)
  return hasLocalSendImFileIntent(primary, {
    hasAttachmentContext: hasCurrentTurnAttachmentContext(message, requestEnvelope)
  })
}

export function isLocalSendImRetryFollowup(
  message: RunMessage,
  requestEnvelope?: unknown
): boolean {
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
  if (
    /[?？]|帮我|帮忙|请|整理|写|撰写|搜|搜索|查询|查|分析|总结|提取|翻译|改写|润色|生成|制作|打开|预览|查看/.test(
      normalized
    )
  ) {
    return false
  }
  return (
    /^(?:再|重新)?(?:试试|试一下|试一次|重试|重发|重新发)(?:这个|这个文件|这个附件|它)?$/.test(
      normalized
    ) ||
    /^(?:这个|这个文件|这个附件|它)(?:也|再)?(?:试试|试一下|发(?:一下)?|传(?:一下)?|重发|重新发)$/.test(
      normalized
    )
  )
}

export function stripMediaBlocksForLocalSendIm(
  message: RunMessage,
  requestEnvelope?: unknown,
  forceLocalSendIm = false
): RunMessage {
  if (!Array.isArray(message)) return message
  if (!forceLocalSendIm && !hasLocalSendImIntentForTurn(message, requestEnvelope)) return message
  let stripped = false
  const textForType = (type: string): string =>
    type === 'video'
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
    reason
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
    .replace(/```[\s\S]*?```/g, '').length
}

function requestEnvelopeResourceText(envelope: unknown): string {
  const record = asRecord(envelope)
  if (!record || !Array.isArray(record.resources)) return ''
  return record.resources
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
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
  const remainingIterations = params.taskBudgetRuntime
    ? Math.max(
        0,
        params.taskBudgetRuntime.budget.maxIterations -
          params.taskBudgetRuntime.usage.iterationsUsed
      )
    : null
  const remainingToolCalls = params.taskBudgetRuntime
    ? Math.max(
        0,
        params.taskBudgetRuntime.budget.maxToolCalls -
          (params.taskBudgetRuntime.budget.reservedToolCalls || 0) -
          params.taskBudgetRuntime.usage.toolCallsUsed
      )
    : null
  const budgetSafetyTurns = params.taskBudgetRuntime
    ? (remainingToolCalls || 0) + Math.max(2, Math.ceil((remainingToolCalls || 0) * 0.25))
    : DEFAULT_AGENT_SDK_MAX_TURNS
  const baseTurns = params.requiresLocalDocumentWrite
    ? LOCAL_DOCUMENT_WRITE_MAX_TURNS
    : budgetSafetyTurns
  const readableUnits = Math.max(
    countReadableContentUnits(messageToText(params.message)),
    countReadableContentUnits(requestEnvelopeResourceText(params.requestEnvelope))
  )
  const readableChars = Math.max(
    countReadableContentChars(messageToText(params.message)),
    countReadableContentChars(requestEnvelopeResourceText(params.requestEnvelope))
  )
  if (readableUnits < LONG_READING_TRIGGER_CHARS && readableChars < LONG_READING_TRIGGER_CHARS) {
    return remainingIterations === null
      ? baseTurns
      : Math.max(0, Math.min(baseTurns, remainingIterations))
  }
  const estimatedReadBatches = Math.max(
    1,
    Math.ceil(readableChars / LONG_READING_EXCERPT_BATCH_CHARS)
  )
  const estimatedTurns =
    baseTurns + Math.max(0, estimatedReadBatches - 1) * LONG_READING_EXTRA_TURNS_PER_BATCH
  const longReadingTurns = Math.max(baseTurns, Math.min(LONG_READING_MAX_TURNS, estimatedTurns))
  return remainingIterations === null
    ? longReadingTurns
    : Math.max(0, Math.min(longReadingTurns, remainingIterations))
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
          renewedFingerprints: [...runtime.lease.renewedFingerprints]
        }
      : null
  }
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
  fallback: string
): string {
  if (requestEnvelope && typeof requestEnvelope === 'object') {
    const envelope = requestEnvelope as { pureUserText?: unknown; primaryInstruction?: unknown }
    const pure = typeof envelope.pureUserText === 'string' ? envelope.pureUserText.trim() : ''
    if (pure) return pure
    const primary =
      typeof envelope.primaryInstruction === 'string' ? envelope.primaryInstruction.trim() : ''
    if (primary) return primary
  }
  return fallback
}

export function resolveAgentSdkTaskBudgetRuntime(params: {
  options?: AgentSdkExecutionOptions
  explicitTaskType?: import('../contracts/run-contracts').TaskType | null
  overrideTaskType?: boolean
}): TaskBudgetRuntime | null {
  const inherited = params.options?.taskBudgetRuntime
    ? cloneTaskBudgetRuntime(params.options.taskBudgetRuntime)
    : null
  const taskType = params.explicitTaskType || inherited?.taskType || 'short_task'
  const unfrozen = inherited?.frozen ? resumeBudgetRuntime(inherited) : inherited

  if (unfrozen) {
    if (params.overrideTaskType && taskType !== unfrozen.taskType) {
      return rebindTaskBudgetRuntime(unfrozen, taskType, { bootstrapBudget: false })
    }
    return unfrozen
  }

  const seed = params.options?.budget || null
  if (!seed) return null
  return createTaskBudgetRuntime(taskType, {
    budget: seed,
    usage: params.options?.budgetState || null,
    bootstrapBudget: taskType === 'short_task'
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
        params.scopeId
      )) {
        if (!byName.has(definition.name)) byName.set(definition.name, definition)
      }
    } catch {
      // silent-catch: Missing groups are reported below as missing required tool names.
    }
  }
  const requiredToolNames =
    restore.requiredToolNames.length > 0 ? restore.requiredToolNames : restore.usedToolNames
  const missingToolNames = requiredToolNames.filter((name) => !byName.has(name))
  return {
    // A checkpoint resumes the exact saved surface. Newly legal tools are not
    // silently added; missing saved tools block above instead of broadening.
    toolDefinitions: requiredToolNames
      .map((name) => byName.get(name))
      .filter((definition): definition is ToolDefinition => Boolean(definition)),
    missingToolNames
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
      budgetWarningLevel: null
    }
  }
  const usagePercent = getBudgetUsagePercent(runtime)
  return {
    budget: {
      ...runtime.budget,
      ...runtime.usage
    },
    budgetUsagePercent: usagePercent,
    budgetWarningLevel: runtime.warningLevel || getBudgetWarningLevel(usagePercent)
  }
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
        : 'fallback'
  }
}

export function safeContinuationPathSegment(value: string): string {
  const cleaned = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
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
