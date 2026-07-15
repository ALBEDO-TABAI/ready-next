import { tool } from '@openai/agents'
import type { AgentInputItem, Tool as AgentSdkTool } from '@openai/agents'
import type { RunMessage } from '../contracts/run-contracts'
import { TARGET_DOCUMENT_ERROR_KINDS } from '../contracts/error-kinds'
import { buildTextToolResultMessage } from '../../claude-bridge/tool-bridge'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import { DEFAULT_CONTEXT_WINDOW } from '../../../../shared/context-budget-types'
import { defaultToolRegistry } from '../tools-runtime/tool-registry'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { resolveCapabilityResolution } from '../domain-adapters/capability-resolver'
import {
  computeCapabilityFloors,
  recoverAbsentFloorsFromRegistry,
  TAG_FORGE_FOLDER_RUNTIME_TOOL_NAMES,
} from '../domain-adapters/capability-floors'
import {
  isReadOnlyResearchSkillToolSet,
  resolveActiveSkillAllowedTools,
  resolveCapabilityGroupIdsForAllowedTools
} from '../domain-adapters/run-capability-controller'
import { isHandoffTakeoverToolOutput, runWithHandoffToolGate } from '../agents/handoff-control'
import { resolvePolicyConflictFacts } from '../policy-arbitration'
import {
  isBrowserBatchCollectionWorkflowTool,
  isBrowserCollectionSubsetTool
} from '../../../../shared/browser-collection-intent'
import {
  BROWSER_CONTENT_TASK_TOOL_NAMES,
  BROWSER_INTERACTION_TOOL_NAMES
} from '../../tools/browser-tool-catalog'
import { GENERAL_RESEARCH_TOOL_NAMES } from '../../tools/general-research-tool-defs'
import { activeNegations } from '../safety/negation-state'
import { createBrowserTurnLease } from '../../browser-engine/agent-browser-turn-lease'
import { filterToolsByVisionCapability } from '../tools-runtime/tool-gateway'
import {
  buildToolRuntimeContext,
  toToolExecutorContext
} from '../tools-runtime/tool-runtime-context-builder'
import { snapshotTurnFeatureFlags } from './turn-feature-flags'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput
} from '../tools-runtime/tool-result-types'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { noteToolResultForActivePlan } from '../system-reminders/active-plan-step-reminder'
import type {
  AgentSdkRuntimeDeps,
  CompactReason,
  CompactSessionResult,
  RunHandle,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import {
  DOCUMENT_TARGET_MUTATION_TOOL_NAMES,
  appendBudgetWarningSteering,
  authorizedPrimitiveToolNames,
  documentToolMutatedContent,
  errorMessage,
  filterSelectedSkillToolSurface,
  formatToolCallTrace,
  formatToolResultTrace,
  hasCurrentDocumentContextResource,
  hasLocalDocumentResource,
  hasLocalSendImIntentForTurn,
  isDocumentToolFailure,
  isDocumentToolFailureText,
  mapToolFailureClose,
  messageHasBrowserBatchCollectionIntent,
  messageHasBrowserCollectionIntent,
  normalizeExplicitDocumentTargetToolArgs,
  publicAgentName,
  resolveBrowserDecisionMode,
  resolveSdkDefaultIntentSurface,
  scopeRunModuleForTool,
  shouldSuppressAskUserQuestionsForOpenConversation,
  stringifyToolResult,
  supplementAuthorizedSkillPrimitiveDefinitions,
  validatePreservedDocumentMutation
} from './agent-sdk-utils'
import { buildToolCallDetail, buildToolResultDetail } from './tool-trace-detail'
import { log } from './agent-sdk-provider'
import { AgentSdkSessionManager } from './agent-sdk-session'
import { getRemainingToolCallBudget } from '../task-projection/run-budget-policy'

const BROWSER_INTERACTION_TOOL_NAME_SET = new Set<string>(BROWSER_INTERACTION_TOOL_NAMES)
const BROWSER_CONTENT_TASK_TOOL_NAME_SET = new Set<string>(BROWSER_CONTENT_TASK_TOOL_NAMES)
const GENERAL_RESEARCH_TOOL_NAME_SET = new Set<string>(GENERAL_RESEARCH_TOOL_NAMES)

export function isToolEnabledForCurrentAuthorization(
  toolName: string,
  authorization: SkillToolAuthorization,
): boolean {
  if (toolName === 'use_skill') return authorization.mode === 'none'
  if (!toolName.startsWith('skill_')) return true
  return authorization.mode === 'selected'
    && (
      authorization.allowedTypedActions.has(toolName)
      || authorization.allowedPrimitives.has(toolName)
    )
}

function createVisibleBrowserToolPreserver(params: {
  visibleCapabilityGroupIds: ReadonlyArray<string>
  collectionExposure: boolean
  batchCollectionExposure: boolean
}): ((name: string) => boolean) | undefined {
  const browserInteractionVisible = params.visibleCapabilityGroupIds.includes('browser_interaction')
  const browserContentTasksVisible =
    params.visibleCapabilityGroupIds.includes('browser_content_tasks')
  if (!browserInteractionVisible && !browserContentTasksVisible) return undefined

  return (name: string): boolean => {
    if (params.collectionExposure) {
      return params.batchCollectionExposure
        ? isBrowserBatchCollectionWorkflowTool(name)
        : isBrowserCollectionSubsetTool(name)
    }
    return (
      (browserInteractionVisible && BROWSER_INTERACTION_TOOL_NAME_SET.has(name)) ||
      (browserContentTasksVisible && BROWSER_CONTENT_TASK_TOOL_NAME_SET.has(name))
    )
  }
}

export interface ToolExecutorHost {
  readonly executeToolCall: NonNullable<AgentSdkRuntimeDeps['executeToolCall']>
  readonly sessionManager: AgentSdkSessionManager
  readonly browserController: BrowserController | null
  readonly sidecarManager: SidecarManager | null
  readonly runtime: AgentControlRuntime | null
  readonly runCleanupRegistry: {
    registerRunCleanup: (runId: string, cleanup: () => void | Promise<void>) => void
  } | null
  compactCapturedSession(
    name: string,
    runHandle: RunHandle,
    baseItems: AgentInputItem[] | undefined,
    reason: CompactReason,
    windowTokens: number
  ): Promise<CompactSessionResult>
  resolveMapPlaceAmbiguityIfNeeded(params: {
    bridgeResults: ToolBridgeResultItem[]
    definitionByName: Map<string, ToolDefinition>
    runtimeContext: ToolBridgeRuntimeContext
  }): Promise<boolean>
}

/**
 * Tool building + execution + event publishing, extracted from AgentSdkRuntime
 * (V3 Phase 5-A). Collaborators are reached through {@link ToolExecutorHost};
 * the only owned state is the renderer tool-action requester callback.
 *
 * The tool-event ordering contract (action -> call trace -> execute ->
 * recordToolResult -> result trace, with document guards / browser lease /
 * learning signals around it) is preserved verbatim from the original methods.
 */
export class AgentSdkToolExecutor {
  constructor(private readonly host: ToolExecutorHost) {}

  private rendererToolActionRequester:
    | ((payload: {
        agent?: string
        sessionId?: string
        runId?: string
        tool: string
        args: Record<string, unknown>
      }) => Promise<Record<string, unknown>>)
    | null = null

  setRendererToolActionRequester(
    requester:
      | ((payload: {
          agent?: string
          sessionId?: string
          runId?: string
          tool: string
          args: Record<string, unknown>
        }) => Promise<Record<string, unknown>>)
      | null
  ): void {
    this.rendererToolActionRequester = requester
  }

  /**
   * Latent definitions are installed into the SDK Agent once, but each definition's
   * `isEnabled` predicate keeps it invisible until `use_skill` refreshes this run's
   * immutable authorization. Dispatch authorization remains the final gate.
   */
  listLatentSkillToolDefinitions(): ToolDefinition[] {
    try {
      return defaultToolRegistry
        .listToolDefinitions()
        .filter((definition) => definition.groupId === 'skills' && definition.name.startsWith('skill_'))
    } catch (error) {
      appendToolCapabilityLog(
        `[tool_capability] stage=same_run_skill_latent_list_failed reason=${errorMessage(error)}`,
      )
      return []
    }
  }

  listDefaultToolDefinitionsForTurn(params: {
    message: RunMessage
    sessionId?: string
    scopeId?: string
    config: AIModelConfig
    browserHostAvailable: boolean
    feishuConnected: boolean
    /** Phase I —— scope 绑定远程渠道线程时暴露 channel_outbound（channel_send_file）。 */
    channelScopeBound?: boolean
    authorization: SkillToolAuthorization
    /** Continuity: a recent explicit local Send IM turn can be retried directly. */
    localSendImIntent?: boolean
    /** Continuity: a recent turn in this session expressed collection intent. */
    recentCollectionIntent?: boolean
    /** Continuity: a recent turn expressed multi-item collection intent. */
    recentBatchCollectionIntent?: boolean
    /** Request envelope — used to read the canonical user instruction. */
    requestEnvelope?: unknown
    /** P2-2 — the L1 skill catalog is non-empty this turn (gates use_skill exposure). */
    skillCatalogAvailable?: boolean
  }): ToolDefinition[] {
    const browserDecisionMode = resolveBrowserDecisionMode(
      params.message,
      params.browserHostAvailable,
      params.requestEnvelope
    )
    const manifestSkillAllowedTools = resolveActiveSkillAllowedTools(params.authorization)
    const readOnlyResearchSkill = isReadOnlyResearchSkillToolSet(manifestSkillAllowedTools)
    const requiredCapabilityGroupIds = resolveCapabilityGroupIdsForAllowedTools(
      manifestSkillAllowedTools,
      (toolName) => defaultToolRegistry.getToolDefinitionForExecution(toolName)?.groupId || null
    )
    const sdkIntentSurface = resolveSdkDefaultIntentSurface({
      message: params.message,
      requestEnvelope: params.requestEnvelope,
      authorization: params.authorization,
      browserDecisionMode,
      requiredCapabilityGroupIds
    })
    const policyConflict = resolvePolicyConflictFacts({
      forceDocumentTool: sdkIntentSurface.forceDocumentTool,
      allowBrowserTools: sdkIntentSurface.allowBrowserTools,
      preferredSkillToolNames: sdkIntentSurface.preferredSkillToolNames,
      browserDecisionMode,
      documentWidgetTaskKind: sdkIntentSurface.documentWidgetTaskKind,
      explicitWidgetCreateIntent: sdkIntentSurface.explicitWidgetCreateIntent
    })
    const effectiveBrowserDecisionMode =
      policyConflict.demotedBrowserDecisionMode || browserDecisionMode
    // WP1: decouple browser collection exposure from the deterministic workflow
    // decision. Expose the browser groups (via intentGroupModes, WITHOUT changing
    // the decision mode) when this turn — or a recent turn — shows browser
    // collection intent. messageHasBrowserCollectionIntent uses the "### 浏览页面
    // 引用" reference marker plus the predicate over the PRIMARY instruction text
    // (not the full text, so context markers don't over-trigger); recentCollection
    // Intent carries the TTL continuity so a bare follow-up ("再试一次") stays
    // exposed.
    const msgIntent = messageHasBrowserCollectionIntent(params.message, params.requestEnvelope)
    const msgBatchIntent = messageHasBrowserBatchCollectionIntent(
      params.message,
      params.requestEnvelope
    )
    const localSendImIntent =
      params.localSendImIntent === true ||
      hasLocalSendImIntentForTurn(params.message, params.requestEnvelope)
    const skillResumeOrRepairContext =
      params.authorization.mode === 'selected' && params.authorization.source !== 'explicit'
    const explicitBrowserCollectionIntent = msgIntent || msgBatchIntent
    const suppressBrowserContentTasks =
      skillResumeOrRepairContext &&
      browserDecisionMode === 'free_tool_loop' &&
      !explicitBrowserCollectionIntent
    const collectionExposure =
      params.browserHostAvailable &&
      browserDecisionMode === 'free_tool_loop' &&
      !localSendImIntent &&
      (msgIntent || params.recentCollectionIntent === true) &&
      !suppressBrowserContentTasks
    const batchCollectionExposure =
      collectionExposure && (msgBatchIntent || params.recentBatchCollectionIntent === true)
    appendToolCapabilityLog(
      [
        '[collection_exposure]',
        `host=${params.browserHostAvailable}`,
        `mode=${browserDecisionMode}`,
        `effectiveMode=${effectiveBrowserDecisionMode}`,
        `msgIntent=${msgIntent}`,
        `recentIntent=${params.recentCollectionIntent === true}`,
        `batchIntent=${msgBatchIntent}`,
        `recentBatch=${params.recentBatchCollectionIntent === true}`,
        `localSendIm=${localSendImIntent}`,
        `skillResumeSuppress=${suppressBrowserContentTasks}`,
        `exposure=${collectionExposure}`,
        `batchExposure=${batchCollectionExposure}`
      ].join(' ')
    )
    const browserConflictGroupModes = policyConflict.demotedBrowserDecisionMode
      ? { browser_interaction: false, browser_content_tasks: false }
      : {}
    // P2-2 — use_skill (skill_activation group) is defaultMode:'on' so the provider supplies its
    // schema through the normal enrichment path. Exposure is CODE-controlled here: expose it ONLY on
    // a mode:'none' turn with a non-empty catalog; suppress it otherwise (selected turns → no recursive
    // activation; legacy callers without the flag → explicit false → zero perturbation).
    const exposeSkillActivation =
      params.authorization.mode === 'none' && params.skillCatalogAvailable === true
    const intentGroupModes = {
      ...sdkIntentSurface.intentGroupModes,
      ...(collectionExposure
        ? { browser_interaction: true, browser_content_tasks: true }
        : suppressBrowserContentTasks
          ? { browser_content_tasks: false }
          : {}),
      ...browserConflictGroupModes,
      skill_activation: exposeSkillActivation
    }
    const capabilityResolution = resolveCapabilityResolution({
      config: params.config,
      profile: 'local_chat',
      browserDecisionMode: effectiveBrowserDecisionMode,
      runtimeAvailability: {
        browserHostAvailable: params.browserHostAvailable,
        feishuConnected: params.feishuConnected,
        channelScopeBound: params.channelScopeBound === true
      },
      intentGroupModes
    })
    appendToolCapabilityLog(
      [
        '[tool_capability]',
        'stage=sdk_runtime_default_tools',
        'profile=local_chat',
        'preferredSkillTools=none',
        `visibleCapabilityGroups=${capabilityResolution.visibleCapabilityGroupIds.join('|') || 'none'}`,
        `suppressedCapabilityGroups=${capabilityResolution.suppressedCapabilityGroupIds.join('|') || 'none'}`,
        `hostOnlyCapabilityGroups=${capabilityResolution.hostOnlyCapabilityIds.join('|') || 'none'}`,
        `supportsVision=${capabilityResolution.supportsVision === true}`
      ].join(' ')
    )
    let definitions = capabilityResolution.visibleCapabilityGroupIds.flatMap((groupId) =>
      defaultToolRegistry.getToolDefinitionsForGroup(
        groupId,
        params.sessionId,
        params.authorization,
        params.scopeId
      )
    )
    if (
      shouldSuppressAskUserQuestionsForOpenConversation({
        message: params.message,
        requestEnvelope: params.requestEnvelope,
        authorization: params.authorization
      })
    ) {
      definitions = definitions.filter((definition) => definition.name !== 'ask_user_questions')
    }
    // WP1: when browser tools are surfaced by collection intent (not by a
    // browser_workflow decision), narrow the browser groups to the collection
    // subset. getToolDefinitionsForGroup expands a whole group, so the subset
    // filter must live here at the tool-definition layer (Codex R2).
    if (collectionExposure) {
      definitions = definitions.filter((definition) => {
        const name = (definition as { name?: unknown }).name
        if (typeof name !== 'string' || !name.startsWith('browser_')) return true
        if (batchCollectionExposure) return isBrowserBatchCollectionWorkflowTool(name)
        return isBrowserCollectionSubsetTool(name)
      })
    }
    if (capabilityResolution.visibleCapabilityGroupIds.includes('skills')) {
      definitions = supplementAuthorizedSkillPrimitiveDefinitions(definitions, params.authorization)
    }
    const fallbackSkillAllowedTools =
      params.authorization.mode === 'selected' &&
      sdkIntentSurface.preferredSkillToolNames &&
      sdkIntentSurface.preferredSkillToolNames.length > 0
        ? sdkIntentSurface.preferredSkillToolNames
        : null
    const allowedPrimitiveNames = authorizedPrimitiveToolNames(params.authorization)
    const resolvedSkillAllowedTools = manifestSkillAllowedTools || fallbackSkillAllowedTools
    const activeSkillAllowedTools =
      resolvedSkillAllowedTools && allowedPrimitiveNames.length > 0
        ? Array.from(new Set([...resolvedSkillAllowedTools, ...allowedPrimitiveNames]))
        : resolvedSkillAllowedTools
    // P1-3：能力地板在唯一裁决面（executor）计算一次；技能收窄只做减法、不移除地板项，
    //   管线末端再按地板硬补回缺席项（组不可见/意图压制也不能吃掉地板）。
    const capabilityFloors = computeCapabilityFloors({
      authorization: params.authorization,
      hasLocalDocumentResource: hasLocalDocumentResource(params.message, params.requestEnvelope),
      hasCurrentDocumentContext: hasCurrentDocumentContextResource(params.requestEnvelope)
    })
    if (activeSkillAllowedTools) {
      const preserveVisibleBrowserTool = readOnlyResearchSkill
        ? undefined
        : createVisibleBrowserToolPreserver({
            visibleCapabilityGroupIds: capabilityResolution.visibleCapabilityGroupIds,
            collectionExposure,
            batchCollectionExposure
          })
      const preserveVisibleResearchTool =
        !readOnlyResearchSkill &&
        capabilityResolution.visibleCapabilityGroupIds.includes('general_research')
          ? (name: string) => GENERAL_RESEARCH_TOOL_NAME_SET.has(name)
          : undefined
      definitions = filterSelectedSkillToolSurface(definitions, activeSkillAllowedTools, {
        preserveToolName: (name) =>
          preserveVisibleBrowserTool?.(name) === true
          || preserveVisibleResearchTool?.(name) === true
          || name === 'agent_propose_handoff'
          || capabilityFloors.toolNames.has(name)
      })
    }
    if (readOnlyResearchSkill) {
      definitions = definitions.filter(
        (definition) => definition.name !== 'declare_completion_criteria',
      )
    }
    // P1-3 硬地板：地板工具即便被组不可见/意图压制而缺席，也从注册表补回（取不到则记 reason 跳过）。
    const floorRecovery = recoverAbsentFloorsFromRegistry(
      definitions,
      capabilityFloors,
      (name) => defaultToolRegistry.getToolDefinitionForExecution(name) ?? null
    )
    for (const unavailableName of floorRecovery.unavailable) {
      appendToolCapabilityLog(
        [
          '[tool_capability]',
          'stage=sdk_runtime_floor_tool_unavailable',
          `tool=${unavailableName}`
        ].join(' ')
      )
    }
    definitions = floorRecovery.definitions
    if (capabilityFloors.reasons.includes('tag_forge_folder_batch')) {
      const tagForgeToolNames = new Set(TAG_FORGE_FOLDER_RUNTIME_TOOL_NAMES)
      definitions = definitions.filter((definition) => tagForgeToolNames.has(definition.name))
    }
    return filterToolsByVisionCapability(definitions as unknown as Array<Record<string, unknown>>, {
      supportsVision: capabilityResolution.supportsVision === true
    }) as unknown as ToolDefinition[]
  }

  private activateSkillForSameRun(
    output: ToolExecutionOutput,
    runtimeContext: ToolBridgeRuntimeContext,
  ): ToolExecutionOutput {
    const normalized = normalizeToolExecutionOutput(output)
    const skillId = typeof normalized.data?.skill_id === 'string'
      ? normalized.data.skill_id.trim()
      : ''
    if (!skillId || typeof runtimeContext.activateSkillForCurrentRun !== 'function') {
      return createToolExecutionOutput(
        `${normalized.text}\n\n技能方法论已读取，但本次运行未能刷新技能工具；不能声称技能工具已经可用。`,
        {
          shape: 'json',
          data: {
            ...(normalized.data || {}),
            ok: false,
            activation: 'same_run_refresh_failed',
            errorKind: 'authorization_denied',
          },
          projectionPatch: normalized.projectionPatch,
          interactionHint: normalized.interactionHint,
          framePatch: normalized.framePatch,
          contextModifier: normalized.contextModifier,
          envelope: normalized.envelope,
        },
      )
    }
    const enabledDefinitions = runtimeContext.activateSkillForCurrentRun(skillId)
    if (!enabledDefinitions || runtimeContext.authorization.mode !== 'selected') {
      return createToolExecutionOutput(
        `${normalized.text}\n\n技能方法论已读取，但本次运行的技能授权刷新失败；请继续使用现有通用工具，不要伪造技能结果。`,
        {
          shape: 'json',
          data: {
            ...(normalized.data || {}),
            ok: false,
            activation: 'same_run_refresh_failed',
            errorKind: 'authorization_denied',
          },
          projectionPatch: normalized.projectionPatch,
          interactionHint: normalized.interactionHint,
          framePatch: normalized.framePatch,
          contextModifier: normalized.contextModifier,
          envelope: normalized.envelope,
        },
      )
    }
    const names = enabledDefinitions.map((definition) => definition.name)
    const activationSummary = skillId === 'tag-forge'
      ? `已切换到 Tag Forge 受控打标流程；当前仅可使用：${names.join(', ')}。列表外工具已关闭。请立即继续当前任务，不要等待用户再发消息。`
      : `技能工具已在本次运行中开放：${names.join(', ') || '无专属工具（仅使用方法论）'}。请立即继续当前任务，不要等待用户再发消息。`
    const textBridgeCatalog = runtimeContext.useTextToolBridge
      ? enabledDefinitions.map((definition) => [
          `- ${definition.name}: ${definition.description}`,
          `  parameters=${JSON.stringify(definition.schema || { type: 'object', properties: {} })}`,
        ].join('\n')).join('\n').slice(0, 12_000)
      : ''
    return createToolExecutionOutput(
      [
        normalized.text,
        activationSummary,
        textBridgeCatalog ? `文本工具调用定义：\n${textBridgeCatalog}` : '',
      ].filter(Boolean).join('\n\n'),
      {
        shape: 'json',
        data: {
          ...(normalized.data || {}),
          ok: true,
          activation: 'active_same_run',
          availableTools: names,
        },
        projectionPatch: normalized.projectionPatch,
        interactionHint: normalized.interactionHint,
        framePatch: normalized.framePatch,
        contextModifier: normalized.contextModifier,
        envelope: normalized.envelope,
      },
    )
  }

  buildSdkTool(definition: ToolDefinition, runtimeContext: ToolBridgeRuntimeContext): AgentSdkTool {
    const schema =
      definition.schema && definition.schema.type === 'object'
        ? definition.schema
        : { type: 'object', properties: {}, additionalProperties: false }
    return tool({
      name: definition.name,
      description: definition.description,
      parameters: schema as never,
      strict: false,
      timeoutMs: definition.executionTimeoutMs,
      isEnabled: async () => runtimeContext.allowedToolNames.includes(definition.name)
        && isToolEnabledForCurrentAuthorization(definition.name, runtimeContext.authorization),
      execute: async (input) => runWithHandoffToolGate(runtimeContext, async () => {
        const args =
          input && typeof input === 'object' && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {}
        if (
          definition.name === 'ask_user_questions' &&
          runtimeContext.nativeMapAmbiguityResolved &&
          typeof args.questions === 'string'
        ) {
          return stringifyToolResult(
            createToolExecutionOutput('地图地点歧义已经通过结构化问题卡处理完成，无需再次反问。', {
              shape: 'json',
              data: {
                ok: true,
                skipped: true,
                reason: 'map_ambiguity_already_resolved'
              }
            })
          )
        }
        const output = await this.executeReadyToolDefinition(definition, args, runtimeContext)
        if (definition.name === 'map_plan_route') {
          const bridgeResults: ToolBridgeResultItem[] = [
            {
              id: `native-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: definition.name,
              args,
              result: output
            }
          ]
          const handledMapAmbiguity = await this.host.resolveMapPlaceAmbiguityIfNeeded({
            bridgeResults,
            definitionByName: runtimeContext.definitionByName,
            runtimeContext
          })
          if (handledMapAmbiguity) {
            runtimeContext.nativeMapAmbiguityResolved = true
          }
          const criticalClose = mapToolFailureClose(bridgeResults)
          runtimeContext.nativeMapCriticalClose = criticalClose
          if (criticalClose) {
            return buildTextToolResultMessage(bridgeResults)
          }
          if (handledMapAmbiguity) {
            return buildTextToolResultMessage(bridgeResults)
          }
        }
        return stringifyToolResult(output)
      }, () => stringifyToolResult(createToolExecutionOutput('当前任务已由新 Agent 接管，旧身份不再执行后续工具。', {
        shape: 'json', data: { errorKind: 'handoff_takeover', skipped: true },
      }))),
      errorFunction: (_context, error) =>
        stringifyToolResult(
          createToolExecutionOutput(`工具 ${definition.name} 失败：${errorMessage(error)}`, {
            shape: 'json',
            data: {
              errorKind: 'tool_failed',
              toolName: definition.name,
              message: errorMessage(error)
            }
          })
        )
    }) as AgentSdkTool
  }

  buildExecutorContext(
    runtimeContext: ToolBridgeRuntimeContext
  ): ReturnType<typeof toToolExecutorContext> {
    const executorContext = toToolExecutorContext(
      buildToolRuntimeContext({
        browserController: this.host.browserController,
        sidecarManager: this.host.sidecarManager,
        runtime: this.host.runtime,
        scope: runtimeContext.sessionId
          ? this.host.runtime?.getConversationScope?.(runtimeContext.sessionId) || undefined
          : undefined,
        agent: publicAgentName(runtimeContext.agentName),
        executionBinding: runtimeContext.executionBinding ?? null,
        executionProfile: runtimeContext.executionProfile ?? null,
        allowedToolNames: runtimeContext.allowedToolNames,
        // SDK runtime executes renderer-mediated tools through the request/ack
        // path below. Forwarding tool handlers' advisory emitToolAction here
        // would make document/rss/calendar actions run twice in the renderer.
        emitToolAction: () => undefined,
        requestModuleToolAction: this.rendererToolActionRequester
          ? (toolName, toolArgs) =>
              this.rendererToolActionRequester!({
                agent: runtimeContext.agentName,
                sessionId: runtimeContext.sessionId,
                runId: runtimeContext.runId,
                tool: toolName,
                args: toolArgs
              })
          : undefined,
        abortSignal: runtimeContext.signal,
        sessionId: runtimeContext.sessionId,
        scopeId: runtimeContext.sessionId,
        // EP2-I2 — standing user negations for dispatch interception.
        activeNegations: activeNegations(runtimeContext.sessionId),
        currentUserText: runtimeContext.currentUserText,
        sourceMessageId: runtimeContext.sourceMessageId ?? null,
        sourceMessageUnavailableReason: runtimeContext.sourceMessageUnavailableReason ?? null,
        requestEnvelope: runtimeContext.requestEnvelope,
        runId: runtimeContext.runId,
        taskId: runtimeContext.taskId,
        parentTaskId: runtimeContext.taskId,
        parentStepId: runtimeContext.taskId,
        taskProjectionId: runtimeContext.taskId,
        frameSkillId: null,
        registerRunCleanup: (cleanup) => {
          this.host.runCleanupRegistry?.registerRunCleanup(runtimeContext.runId, cleanup)
        },
        agentContext: runtimeContext.agentContext ?? null,
        turnFeatureFlags: snapshotTurnFeatureFlags(),
        activeFrame: runtimeContext.activeFrame,
        authorization: runtimeContext.authorization
      })
    )
    // WP2 — attach a turn-level user-view write lease so free-tool-loop browser
    // writes are gated and a user takeover suspends them. Lazy (no acquire until
    // a write); released on run cleanup (normal end / cancel / session close).
    if (this.host.browserController && runtimeContext.runId) {
      if (!runtimeContext.browserTurnLease) {
        const turnLease = createBrowserTurnLease({
          taskId: runtimeContext.taskId ?? runtimeContext.runId,
          runId: runtimeContext.runId
        })
        runtimeContext.browserTurnLease = turnLease
        this.host.runCleanupRegistry?.registerRunCleanup(runtimeContext.runId, () => {
          turnLease.release()
          if (runtimeContext.browserTurnLease === turnLease) {
            runtimeContext.browserTurnLease = null
          }
        })
      }
      executorContext.browserLease = runtimeContext.browserTurnLease
    }
    return executorContext
  }

  private async executeGuardDocumentTool(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext
  ): Promise<ToolExecutionOutput> {
    const budgetBlocker = this.rejectToolWhenBudgetExhausted(definition, args, runtimeContext, true)
    if (budgetBlocker) return budgetBlocker
    const callTrace = formatToolCallTrace(definition.name, args)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
      detail: buildToolCallDetail(args)
    })
    runtimeContext.emitToolAction(definition.name, args)
    const output = await this.host.executeToolCall(
      definition.name,
      args,
      this.buildExecutorContext(runtimeContext)
    )
    runtimeContext.recordToolResult(definition.name, output)
    noteToolResultForActivePlan(runtimeContext.sessionId, definition.name, args, Date.now(), output)
    const outputWithSteering = appendBudgetWarningSteering(output, runtimeContext)
    const normalized = normalizeToolExecutionOutput(outputWithSteering)
    const resultTrace = formatToolResultTrace(definition.name, normalized)
    runtimeContext.emitOutput(resultTrace, 'tool_result', normalized.projectionPatch || null)
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'result',
      text: resultTrace,
      detail: buildToolResultDetail(normalized),
      projectionPatch: normalized.projectionPatch
    })
    return outputWithSteering
  }

  private rejectToolWhenBudgetExhausted(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext,
    allowReserved = false
  ): ToolExecutionOutput | null {
    const budgetRuntime = runtimeContext.taskBudgetRuntime
    const remainingCalls = budgetRuntime
      ? allowReserved
        ? Math.max(0, budgetRuntime.budget.maxToolCalls - budgetRuntime.usage.toolCallsUsed)
        : getRemainingToolCallBudget(budgetRuntime)
      : 1
    if (!budgetRuntime || (!budgetRuntime.frozen && remainingCalls > 0)) {
      return null
    }
    const callTrace = formatToolCallTrace(definition.name, args)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
      detail: buildToolCallDetail(args)
    })
    const output = createToolExecutionOutput('本轮工具预算已用完，未执行该工具。', {
      shape: 'json',
      data: {
        ok: false,
        status: 'checkpoint_required',
        errorKind: 'budget_exhausted',
        toolName: definition.name
      }
    })
    const resultTrace = formatToolResultTrace(definition.name, output)
    runtimeContext.emitOutput(resultTrace, 'tool_result')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'result',
      text: resultTrace,
      detail: buildToolResultDetail(output)
    })
    return output
  }

  /**
   * W10-F1 — guard 的开/存工具定义在 turn-preparation 早绑（先于地板兜底），技能收窄轮
   * 常绑空。guard 自动开/存本就不经模型（模型不可见），因此缺失时从注册表就地解析，
   * 免疫任何轮的工具面收窄；解析成功回写 guard 避免重复解析，并落可观测日志。
   */
  private resolveGuardDocumentToolDefinition(
    bound: ToolDefinition | undefined,
    toolName: 'document_open_tab' | 'document_save_tab',
    targetPath: string
  ): ToolDefinition | null {
    if (bound) return bound
    const recovered = defaultToolRegistry.getToolDefinitionForExecution(toolName) ?? null
    if (recovered) {
      appendToolCapabilityLog(
        [
          '[tool_capability]',
          'stage=document_target_guard_tool_recovered',
          `tool=${toolName}`,
          `targetPath=${targetPath}`
        ].join(' ')
      )
    }
    return recovered
  }

  private async ensureExplicitDocumentTargetOpened(
    runtimeContext: ToolBridgeRuntimeContext
  ): Promise<ToolExecutionOutput | null> {
    const guard = runtimeContext.documentTargetGuard
    if (!guard || guard.opened) return null
    const definition = this.resolveGuardDocumentToolDefinition(
      guard.openToolDefinition,
      'document_open_tab',
      guard.targetPath
    )
    if (!definition) {
      return createToolExecutionOutput(
        `无法打开目标文档 ${guard.targetName}：本轮未开放 document_open_tab。`,
        {
          shape: 'json',
          data: {
            errorKind: TARGET_DOCUMENT_ERROR_KINDS.openUnavailable.code,
            targetPath: guard.targetPath
          }
        }
      )
    }
    guard.openToolDefinition = definition

    const args = { path: guard.targetPath }
    const output = await this.executeGuardDocumentTool(definition, args, runtimeContext)
    const normalized = normalizeToolExecutionOutput(output)
    if (isDocumentToolFailure(normalized)) {
      return createToolExecutionOutput(
        `无法打开目标文档 ${guard.targetName}，已停止写入，避免写错文件。`,
        {
          shape: 'json',
          data: {
            errorKind: TARGET_DOCUMENT_ERROR_KINDS.openFailed.code,
            targetPath: guard.targetPath,
            openResult: normalized.text
          }
        }
      )
    }
    guard.opened = true
    return null
  }

  private async ensureExplicitDocumentTargetSaved(
    runtimeContext: ToolBridgeRuntimeContext
  ): Promise<ToolExecutionOutput | null> {
    const guard = runtimeContext.documentTargetGuard
    if (!guard) return null
    const definition = this.resolveGuardDocumentToolDefinition(
      guard.saveToolDefinition,
      'document_save_tab',
      guard.targetPath
    )
    if (!definition) {
      return createToolExecutionOutput(
        `目标文档 ${guard.targetName} 已修改，但本轮未开放 document_save_tab，无法确认落盘。`,
        {
          shape: 'json',
          data: {
            errorKind: TARGET_DOCUMENT_ERROR_KINDS.saveUnavailable.code,
            targetPath: guard.targetPath
          }
        }
      )
    }
    guard.saveToolDefinition = definition
    const output = await this.executeGuardDocumentTool(definition, {}, runtimeContext)
    if (isDocumentToolFailure(output)) {
      return createToolExecutionOutput(`目标文档 ${guard.targetName} 保存失败，不能声明完成。`, {
        shape: 'json',
        data: {
          errorKind: TARGET_DOCUMENT_ERROR_KINDS.saveFailed.code,
          targetPath: guard.targetPath,
          saveResult: normalizeToolExecutionOutput(output).text
        }
      })
    }
    return null
  }

  async executeReadyToolDefinition(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext
  ): Promise<ToolExecutionOutput> {
    if (runtimeContext.hostControl === 'handoff_takeover') {
      return createToolExecutionOutput('当前任务已由新 Agent 接管，旧身份不再执行后续工具。', {
        shape: 'json', data: { errorKind: 'handoff_takeover', skipped: true },
      })
    }
    const documentClosureTool = Boolean(
      runtimeContext.documentTargetGuard &&
      (DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name) ||
        definition.name === 'document_open_tab' ||
        definition.name === 'document_save_tab')
    )
    const initialBudgetBlocker = this.rejectToolWhenBudgetExhausted(
      definition,
      args,
      runtimeContext,
      documentClosureTool
    )
    if (initialBudgetBlocker) return initialBudgetBlocker
    if (definition.name === 'skill_compact_context') {
      const callTrace = formatToolCallTrace(definition.name, args)
      runtimeContext.emitOutput(callTrace, 'tool_use')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'call',
        text: callTrace,
        detail: buildToolCallDetail(args)
      })
      runtimeContext.emitToolAction(definition.name, args)
      const compacted = await this.host.compactCapturedSession(
        runtimeContext.agentName,
        runtimeContext.runHandle,
        undefined,
        'manual',
        this.host.sessionManager.get(runtimeContext.agentName)?.contextWindowTokens ??
          DEFAULT_CONTEXT_WINDOW
      )
      const output = createToolExecutionOutput(
        compacted.status === 'superseded'
          ? '当前运行已被新消息接管，未压缩新的会话。'
          : compacted.status === 'compacted'
            ? `已压缩当前会话上下文：${compacted.report.beforeTokens} → ${compacted.report.afterTokens} tokens。`
            : compacted.status === 'noop'
              ? '当前会话上下文尚未达到压缩阈值。'
              : '已排队，当前运行结束后会压缩上下文。',
        {
          shape: 'json',
          data: compacted
        }
      )
      runtimeContext.recordToolResult(definition.name, output)
      noteToolResultForActivePlan(
        runtimeContext.sessionId,
        definition.name,
        args,
        Date.now(),
        output
      )
      const outputWithSteering = appendBudgetWarningSteering(output, runtimeContext)
      const resultTrace = formatToolResultTrace(definition.name, outputWithSteering)
      runtimeContext.emitOutput(resultTrace, 'tool_result')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'result',
        text: resultTrace,
        detail: buildToolResultDetail(outputWithSteering)
      })
      return outputWithSteering
    }
    const guard = runtimeContext.documentTargetGuard
    if (guard && definition.name === 'document_new_tab') {
      return createToolExecutionOutput(
        `用户已明确要求写入 ${guard.targetName}，不能新建临时文档替代。请打开目标文档后再修改。`,
        {
          shape: 'json',
          data: {
            errorKind: TARGET_DOCUMENT_ERROR_KINDS.required.code,
            targetPath: guard.targetPath
          }
        }
      )
    }
    if (guard && definition.name === 'document_switch_tab') {
      return createToolExecutionOutput(
        `目标文档已固定为 ${guard.targetName}，本轮不需要切换到其他标签。`,
        {
          shape: 'json',
          data: {
            ok: true,
            targetPath: guard.targetPath,
            ignoredTool: definition.name
          }
        }
      )
    }
    if (
      guard &&
      (DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name) ||
        definition.name === 'document_save_tab')
    ) {
      const blocker = await this.ensureExplicitDocumentTargetOpened(runtimeContext)
      if (blocker) return blocker
    }
    const effectiveArgs = guard
      ? normalizeExplicitDocumentTargetToolArgs(definition.name, args)
      : args
    const postGuardBudgetBlocker = this.rejectToolWhenBudgetExhausted(
      definition,
      effectiveArgs,
      runtimeContext,
      documentClosureTool
    )
    if (postGuardBudgetBlocker) return postGuardBudgetBlocker

    const callTrace = formatToolCallTrace(definition.name, effectiveArgs)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
      detail: buildToolCallDetail(effectiveArgs)
    })
    const preservationBlocker = DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name)
      ? validatePreservedDocumentMutation(guard, definition.name, effectiveArgs)
      : null
    if (preservationBlocker) {
      runtimeContext.recordToolResult(definition.name, preservationBlocker)
      const blockerWithSteering = appendBudgetWarningSteering(preservationBlocker, runtimeContext)
      const resultTrace = formatToolResultTrace(
        definition.name,
        normalizeToolExecutionOutput(blockerWithSteering)
      )
      runtimeContext.emitOutput(resultTrace, 'tool_result')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'result',
        text: resultTrace,
        detail: buildToolResultDetail(blockerWithSteering)
      })
      return blockerWithSteering
    }
    runtimeContext.emitToolAction(definition.name, effectiveArgs)
    let output = await this.host.executeToolCall(
      definition.name,
      effectiveArgs,
      this.buildExecutorContext(runtimeContext)
    )
    if (definition.name === 'use_skill') {
      output = this.activateSkillForSameRun(output, runtimeContext)
    }
    runtimeContext.recordToolResult(definition.name, output)
    noteToolResultForActivePlan(runtimeContext.sessionId, definition.name, args, Date.now(), output)
    const outputWithSteering = appendBudgetWarningSteering(output, runtimeContext)
    const normalized = normalizeToolExecutionOutput(outputWithSteering)
    if (isHandoffTakeoverToolOutput(outputWithSteering)) {
      runtimeContext.hostControl = 'handoff_takeover'
    }
    if (
      guard &&
      definition.name === 'document_open_tab' &&
      String(effectiveArgs.path || '').trim() === guard.targetPath &&
      !(normalized.data && typeof normalized.data === 'object' && 'errorKind' in normalized.data) &&
      !isDocumentToolFailureText(normalized.text)
    ) {
      guard.opened = true
    }
    const resultTrace = formatToolResultTrace(definition.name, normalized)
    runtimeContext.emitOutput(resultTrace, 'tool_result', normalized.projectionPatch || null)
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'result',
      text: resultTrace,
      detail: buildToolResultDetail(normalized),
      projectionPatch: normalized.projectionPatch
    })
    if (
      guard &&
      DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name) &&
      !isDocumentToolFailure(normalized) &&
      documentToolMutatedContent(normalized)
    ) {
      const saveBlocker = await this.ensureExplicitDocumentTargetSaved(runtimeContext)
      if (saveBlocker) return saveBlocker
    }
    return outputWithSteering
  }

  private publishSdkToolEvent(params: {
    runtimeContext: ToolBridgeRuntimeContext
    definition: ToolDefinition
    kind: 'call' | 'result'
    text: string
    /** L3 详情（tool-trace-detail 构建）；必填以防调用点静默漏接。 */
    detail: string | null
    projectionPatch?: Record<string, unknown> | null
  }): void {
    if (!params.runtimeContext.sessionId) return
    const timestamp = new Date().toISOString()
    const projectionPatch = params.projectionPatch || null
    try {
      this.host.runtime?.publishScopeRunEvent?.(
        {
          type: 'updated',
          scopeId: params.runtimeContext.sessionId,
          agent: publicAgentName(params.runtimeContext.agentName),
          runId: params.runtimeContext.runId,
          taskId: params.runtimeContext.taskId,
          phase: params.kind === 'call' ? 'tool_running' : 'responding',
          module: scopeRunModuleForTool(params.definition),
          taskType: params.definition.domain === 'general_research' ? 'research' : undefined,
          taskProjectionId: params.runtimeContext.taskId,
          latestText: params.kind === 'result' ? params.text : undefined,
          taskTitle:
            typeof projectionPatch?.taskTitle === 'string' ? projectionPatch.taskTitle : undefined,
          taskSummary:
            typeof projectionPatch?.taskSummary === 'string'
              ? projectionPatch.taskSummary
              : undefined,
          toolEvent: {
            id: `sdk-tool-${params.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: params.kind,
            text: params.text,
            timestamp,
            toolName: params.definition.name,
            ...(params.detail ? { detail: params.detail } : {})
          },
          timestamp
        },
        projectionPatch ? { projectionPatch, transcriptEvents: [] } : null
      )
    } catch (publishError) {
      // Event publication must never poison the tool result that triggered
      // it (same contract as hooks/reminders: observer failure stays out of
      // the main flow). Loud log, no rethrow.
      log(`publishScopeRunEvent failed: ${errorMessage(publishError)}`)
    }
  }
}
