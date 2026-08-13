import { resolveAIConfigCapabilities } from '../../../../shared/ai-providers'
import { buildTextToolBridgePrompt } from '../../claude-bridge/tool-bridge'
import {
  getSkillShellConsent,
  isEmbeddedSkill,
} from '../../skills-runtime/skill-shell-consent'
import { skillDirHasScripts } from '../../skills-runtime/skill-executable-surface'
import { RUNTIME_PREAMBLE_STAGE, buildRuntimePreambleBill, emitContextBill } from '../context-bill'
import type {
  ExecutionTurnResult,
  MultimodalBlock,
  RunMessage,
  TaskBudgetRuntime
} from '../contracts/run-contracts'
import { assertCurrentMessageCapability } from '../domain-adapters/message-capability-filter'
import type { RequestedCapabilityConflict } from '../domain-adapters/capability-resolver'
import { buildBrowserDisciplineBundle } from '../domain-adapters/browser-discipline-asset'
import { logAgentMetric } from '../metrics'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { buildCurrentDateReminderText } from '../system-reminders/current-date-reminder'
import { moveResponseStyleReminderToEnd } from '../user-profile-prompt'
import { registerSkillCatalogReminder } from '../system-reminders/skill-catalog-reminder'
import { registerSkillShellConsentReminder } from '../system-reminders/skill-shell-consent-reminder'
import { createSystemReminderRegistry } from '../system-reminders/system-reminder-registry'
import { registerToolCapabilityConflictReminder } from '../system-reminders/tool-capability-conflict-reminder'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { TOOL_ERROR_METRICS } from '../tools-runtime/tool-error-metrics'
import { buildDocumentSurfaceGuidance } from '../tool-policy/execution-tool-config'
import { buildDocumentTargetInstruction } from './agent-sdk-document-utils'
import { buildLocalDocumentExcerptInstruction, toSdkInput } from './agent-sdk-execution-utils'
import { primaryInstructionText } from './agent-sdk-input-context-utils'
import { toOpenAIToolSchemas } from './agent-sdk-model-message-utils'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type {
  AgentSdkProviderDiagnostics,
  AgentSdkSession,
  AgentSdkSkillCatalogSnapshotEntry,
  DocumentTargetGuard,
  ReadyAgentSdkRunParams,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import type { TurnTerminalReason } from './turn-frame'

export interface AgentSdkTurnInputAssemblyContext {
  host: TurnOrchestratorHost
  session: AgentSdkSession
  sessionId?: string
  runId: string
  providerContent: RunMessage
  useTextToolBridge: boolean
  toolDefinitions: ToolDefinition[]
  latentToolDefinitions?: ToolDefinition[]
  toolBridgeRuntimeContext: ToolBridgeRuntimeContext
  hasVeaPipelineTool: boolean
  hasMapAmbiguityQuestionTools: boolean
  skillContextInstruction: string
  documentTargetGuard: DocumentTargetGuard | null
  requiresLocalDocumentExcerpt: boolean
  preferCurrentDocumentRead: boolean
  capabilities: ReturnType<typeof resolveAIConfigCapabilities>
  authorization: SkillToolAuthorization
  skillCatalogSnapshot: readonly AgentSdkSkillCatalogSnapshotEntry[]
  requestedCapabilityConflicts: readonly RequestedCapabilityConflict[]
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  finalizeEarlyReturn: (params: {
    status: 'done' | 'checkpoint' | 'error' | 'cancelled'
    terminalReason: TurnTerminalReason
    finalText: string
    error?: string
    continuationHandle?: string | null
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
    initiator?: string
  }) => Promise<ExecutionTurnResult>
}

export interface AgentSdkTurnInputAssemblyResult {
  terminalResult: Promise<ExecutionTurnResult> | null
  sdkTools: ReadyAgentSdkRunParams['tools']
  instructions: string
  nextInput: ReadyAgentSdkRunParams['input']
}

export function assembleAgentSdkTurnInput(
  ctx: AgentSdkTurnInputAssemblyContext
): AgentSdkTurnInputAssemblyResult {
  const {
    host,
    session,
    sessionId,
    runId,
    providerContent,
    useTextToolBridge,
    toolDefinitions,
    latentToolDefinitions = [],
    toolBridgeRuntimeContext,
    hasVeaPipelineTool,
    hasMapAmbiguityQuestionTools,
    skillContextInstruction,
    documentTargetGuard,
    requiresLocalDocumentExcerpt,
    preferCurrentDocumentRead,
    capabilities,
    authorization,
    skillCatalogSnapshot,
    requestedCapabilityConflicts,
    emitOutput,
    finalizeEarlyReturn
  } = ctx
  const sdkToolDefinitions = Array.from(
    new Map(
      [...toolDefinitions, ...latentToolDefinitions]
        .map((definition) => [definition.name, definition]),
    ).values(),
  )
  const sdkTools = useTextToolBridge
    ? []
    : sdkToolDefinitions.map((definition) =>
        host.toolExecutor.buildSdkTool(definition, toolBridgeRuntimeContext)
      )

  const hasBrowserTools = toolDefinitions.some(
    (definition) =>
      definition.groupId === 'browser_interaction'
      || definition.groupId === 'browser_content_tasks'
  )
  const hasBrowserVisibleCollectTool = toolDefinitions.some(
    (definition) => definition.name === 'browser_collect'
  )
  const hasBrowserPowerTools = toolDefinitions.some(
    (definition) => ['browser_eval', 'browser_cdp', 'browser_network', 'browser_resources'].includes(definition.name)
  )
  const canActivateSkill = toolDefinitions.some(
    (definition) => definition.name === 'use_skill'
  )

  const turnRegistry = createSystemReminderRegistry()
  if (canActivateSkill || authorization.mode === 'selected') {
    if (canActivateSkill) {
      registerSkillCatalogReminder(turnRegistry, skillCatalogSnapshot)
    }
    if (authorization.mode === 'selected') {
      const activeSkill = skillCatalogSnapshot.find((skill) => skill.id === authorization.skillId)
      if (activeSkill) {
        try {
          registerSkillShellConsentReminder(turnRegistry, {
            skillName: String(activeSkill.name || authorization.skillId),
            hasScripts: skillDirHasScripts(activeSkill.managedPath),
            isEmbedded: isEmbeddedSkill(authorization.skillId),
            hasConsent: getSkillShellConsent(authorization.skillId)
          })
        } catch {
          // silent-catch: 授权存储不可读时只跳过动态警告，不丢失技能目录
        }
      }
    }
  }
  registerToolCapabilityConflictReminder(turnRegistry, requestedCapabilityConflicts)
  const skillReminderText = turnRegistry.compose() || ''
  const browserInstruction = hasBrowserTools
    ? [
        '本轮已开放浏览器工具：只使用实际列出的工具；下方规则中的工具示例不代表未列出的工具可用。可操作或采集用户当前登录且可正常访问的页面；用户随时可接管，接管后写操作会被拒绝，应立即停止。',
        hasBrowserVisibleCollectTool
          ? '本轮可用 browser_collect 采集信息流、评论和长列表。'
          : '本轮未开放 browser_collect；使用已列出的页面观察工具分批采集。',
        hasBrowserPowerTools
          ? '本轮已开放列出的 Browser Power 工具；安全等级、授权与审计仍由代码执行。'
          : '本轮未开放 Browser Power 工具；不要声称可用自由脚本或 Power 能力。',
        buildBrowserDisciplineBundle({
          definitions: toolDefinitions.filter((definition) => definition.domain === 'browser'),
          requestEnvelope: toolBridgeRuntimeContext.requestEnvelope,
          activation: 'initial',
          includeCompleteTextCatalog: false,
        }).text,
      ].filter(Boolean).join('\n')
    : ''

  const {
    systemPrompt: systemPromptWithoutResponseStyleReminder,
    responseStyleReminder,
  } = moveResponseStyleReminderToEnd(session.systemPrompt)
  const instructions = [
    systemPromptWithoutResponseStyleReminder,
    toolDefinitions.length > 0
      ? '本轮可用工具已经按 Ready 的策略过滤。不要声称使用不存在的工具。'
      : '本轮没有开放工具；直接回答或说明缺口。',
    hasVeaPipelineTool
      ? '本轮 VEA 长任务必须优先调用 skill_video_expert_pipeline；不要用 skill_run_shell、手工建目录或口头说明替代真实启动。'
      : '',
    skillContextInstruction,
    skillReminderText,
    hasMapAmbiguityQuestionTools
      ? '地图路线工具返回 errorKind=place_ambiguous 时，必须使用 ask_user_questions 让用户从候选地点中选择；不要把失败结果改写成路线成功。'
      : '',
    browserInstruction,
    buildDocumentTargetInstruction(documentTargetGuard),
    buildDocumentSurfaceGuidance({
      toolNames: new Set(toolDefinitions.map((definition) => definition.name)),
      userText: primaryInstructionText(providerContent)
    }),
    buildLocalDocumentExcerptInstruction(requiresLocalDocumentExcerpt, preferCurrentDocumentRead),
    useTextToolBridge && toolDefinitions.length > 0
      ? buildTextToolBridgePrompt(toOpenAIToolSchemas(toolDefinitions))
      : '',
    buildCurrentDateReminderText(),
    responseStyleReminder,
  ].join('\n')

  // B6 (N-CTX-01 budget) — the prompt-assembly context budget is computed
  // before these instructions are appended, so it is not what is actually
  // sent. Emit the runtime preamble bill once per run so the delta is
  // observable by joining stage=runtime_preamble with the context bill on
  // scopeId/runId. Dynamic per-turn reminders are part of `instructions`, so
  // their actual bytes are included without persisting them into session input.
  emitContextBill(buildRuntimePreambleBill(sessionId || '', { instructions }), {
    stage: RUNTIME_PREAMBLE_STAGE,
    runId
  })

  // PR 2 (Phase C.2 first segment) — current-turn capability pre-check.
  // If `content` is a multimodal block array (image/video/...), validate
  // it BEFORE entering the SDK. Vision-off + image → throws
  // `ToolDomainError('provider_request_failed')` with recoverable:false.
  // Subsequent provider request builders can then assume any remaining
  // image/video blocks are historical residue and strip them silently
  // (the second SDK-side segment lives in the provider Model classes).
  if (Array.isArray(providerContent)) {
    // MultimodalBlock shapes vary by `block.type`; treat each as a
    // record-with-type for the capability check (helper only inspects
    // `type`). The cast keeps the helper free of MultimodalBlock import.
    const blocksForCheck = providerContent
      .filter((b): b is MultimodalBlock => Boolean(b && typeof b === 'object'))
      .map((b) => ({ ...(b as unknown as Record<string, unknown>) })) as Array<{
      type: string
      [key: string]: unknown
    }>
    try {
      assertCurrentMessageCapability(blocksForCheck, {
        supportsVision: capabilities?.supportsVision === true,
        // PR 2 review patch — `supportsNativeVideo` is the existing
        // capability flag that tracks "this provider accepts native
        // video blocks". Hardcoding `false` here blocked legitimate
        // multi-turn video tasks at SDK entry.
        supportsVideo: capabilities?.supportsNativeVideo === true
      })
    } catch (capErr) {
      const userMessage = capErr instanceof Error ? capErr.message : String(capErr)
      logAgentMetric(TOOL_ERROR_METRICS.providerRequestImageBlockedAtAttach, {
        sessionId,
        errorMessage: userMessage.slice(0, 200)
      })
      emitOutput(userMessage, 'error')
      return {
        terminalResult: finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_config',
          error: userMessage,
          finalText: ''
        }),
        sdkTools: [],
        instructions: '',
        nextInput: toSdkInput(providerContent)
      }
    }
  }
  const nextInput = toSdkInput(providerContent)
  return { terminalResult: null, sdkTools, instructions, nextInput }
}
