import {
  tool,
} from '@openai/agents'
import type {
  AgentInputItem,
  Tool as AgentSdkTool,
} from '@openai/agents'
import type {
  RunMessage,
} from '../contracts/run-contracts'
import {
  TARGET_DOCUMENT_ERROR_KINDS,
} from '../contracts/error-kinds'
import {
  buildTextToolResultMessage,
} from '../../claude-bridge/tool-bridge'
import type {
  AIModelConfig,
} from '../../../../shared/ai-providers'
import {
  DEFAULT_CONTEXT_WINDOW,
} from '../../../../shared/context-budget-types'
import {
  defaultToolRegistry,
} from '../tools-runtime/tool-registry'
import type {
  ToolDefinition,
} from '../tools-runtime/tool-definition'
import type {
  SkillToolAuthorization,
} from '../skills/skill-tool-authorization'
import {
  resolveCapabilityResolution,
} from '../domain-adapters/capability-resolver'
import {
  resolveActiveSkillAllowedTools,
} from '../domain-adapters/run-capability-controller'
import {
  resolvePolicyConflictFacts,
} from '../policy-arbitration'
import {
  isBrowserBatchCollectionWorkflowTool,
  isBrowserCollectionSubsetTool,
} from '../../../../shared/browser-collection-intent'
import {
  BROWSER_CONTENT_TASK_TOOL_NAMES,
  BROWSER_INTERACTION_TOOL_NAMES,
} from '../../tools/browser-tool-catalog'
import {
  activeNegations,
} from '../safety/negation-state'
import {
  createBrowserTurnLease,
} from '../../browser-engine/agent-browser-turn-lease'
import {
  filterToolsByVisionCapability,
} from '../tools-runtime/tool-gateway'
import {
  buildToolRuntimeContext,
  toToolExecutorContext,
} from '../tools-runtime/tool-runtime-context-builder'
import {
  snapshotTurnFeatureFlags,
} from './turn-feature-flags'
import {
  appendToolCapabilityLog,
} from '../../tools/tool-event-log'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
} from '../tools-runtime/tool-result-types'
import type {
  ToolExecutionOutput,
} from '../tools-runtime/tool-result-types'
import {
  noteToolResultForActivePlan,
} from '../system-reminders/active-plan-step-reminder'
import type {
  AgentSdkRuntimeDeps,
  CompactReason,
  CompactSessionResult,
  RunHandle,
  ToolBridgeResultItem,
  ToolBridgeRuntimeContext,
} from './agent-sdk-types'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import {
  DOCUMENT_TARGET_MUTATION_TOOL_NAMES,
  LOCAL_DOCUMENT_FLOOR_TOOL_NAMES,
  appendBudgetWarningSteering,
  authorizedPrimitiveToolNames,
  documentToolMutatedContent,
  errorMessage,
  filterSelectedSkillToolSurface,
  formatToolCallTrace,
  formatToolResultTrace,
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
  validatePreservedDocumentMutation,
} from './agent-sdk-utils'
import {
  log,
} from './agent-sdk-provider'
import { AgentSdkSessionManager } from './agent-sdk-session'

const BROWSER_INTERACTION_TOOL_NAME_SET = new Set<string>(BROWSER_INTERACTION_TOOL_NAMES)
const BROWSER_CONTENT_TASK_TOOL_NAME_SET = new Set<string>(BROWSER_CONTENT_TASK_TOOL_NAMES)

function createVisibleBrowserToolPreserver(params: {
  visibleCapabilityGroupIds: ReadonlyArray<string>
  collectionExposure: boolean
  batchCollectionExposure: boolean
}): ((name: string) => boolean) | undefined {
  const browserInteractionVisible = params.visibleCapabilityGroupIds.includes('browser_interaction')
  const browserContentTasksVisible = params.visibleCapabilityGroupIds.includes('browser_content_tasks')
  if (!browserInteractionVisible && !browserContentTasksVisible) return undefined

  return (name: string): boolean => {
    if (params.collectionExposure) {
      return params.batchCollectionExposure
        ? isBrowserBatchCollectionWorkflowTool(name)
        : isBrowserCollectionSubsetTool(name)
    }
    return (browserInteractionVisible && BROWSER_INTERACTION_TOOL_NAME_SET.has(name))
      || (browserContentTasksVisible && BROWSER_CONTENT_TASK_TOOL_NAME_SET.has(name))
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
    windowTokens: number,
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

  private rendererToolActionRequester: ((payload: {
    agent?: string
    sessionId?: string
    runId?: string
    tool: string
    args: Record<string, unknown>
  }) => Promise<Record<string, unknown>>) | null = null


  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.rendererToolActionRequester = requester
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
  }): ToolDefinition[] {
    const browserDecisionMode = resolveBrowserDecisionMode(
      params.message,
      params.browserHostAvailable,
      params.requestEnvelope,
    )
    const sdkIntentSurface = resolveSdkDefaultIntentSurface({
      message: params.message,
      requestEnvelope: params.requestEnvelope,
      authorization: params.authorization,
      browserDecisionMode,
    })
    const policyConflict = resolvePolicyConflictFacts({
      forceDocumentTool: sdkIntentSurface.forceDocumentTool,
      allowBrowserTools: sdkIntentSurface.allowBrowserTools,
      preferredSkillToolNames: sdkIntentSurface.preferredSkillToolNames,
      browserDecisionMode,
      documentWidgetTaskKind: sdkIntentSurface.documentWidgetTaskKind,
      explicitWidgetCreateIntent: sdkIntentSurface.explicitWidgetCreateIntent,
    })
    const effectiveBrowserDecisionMode = policyConflict.demotedBrowserDecisionMode || browserDecisionMode
    // WP1: decouple browser collection exposure from the deterministic workflow
    // decision. Expose the browser groups (via intentGroupModes, WITHOUT changing
    // the decision mode) when this turn — or a recent turn — shows browser
    // collection intent. messageHasBrowserCollectionIntent uses the "### 浏览页面
    // 引用" reference marker plus the predicate over the PRIMARY instruction text
    // (not the full text, so context markers don't over-trigger); recentCollection
    // Intent carries the TTL continuity so a bare follow-up ("再试一次") stays
    // exposed.
    const msgIntent = messageHasBrowserCollectionIntent(params.message, params.requestEnvelope)
    const msgBatchIntent = messageHasBrowserBatchCollectionIntent(params.message, params.requestEnvelope)
    const localSendImIntent = params.localSendImIntent === true
      || hasLocalSendImIntentForTurn(params.message, params.requestEnvelope)
    const skillResumeOrRepairContext = params.authorization.mode === 'selected' && params.authorization.source !== 'explicit'
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
    const batchCollectionExposure = collectionExposure && (msgBatchIntent || params.recentBatchCollectionIntent === true)
    appendToolCapabilityLog([
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
      `batchExposure=${batchCollectionExposure}`,
    ].join(' '))
    const browserConflictGroupModes = policyConflict.demotedBrowserDecisionMode
      ? { browser_interaction: false, browser_content_tasks: false }
      : {}
    const intentGroupModes = {
      ...sdkIntentSurface.intentGroupModes,
      ...(collectionExposure
        ? { browser_interaction: true, browser_content_tasks: true }
        : suppressBrowserContentTasks
          ? { browser_content_tasks: false }
          : {}),
      ...browserConflictGroupModes,
    }
    const capabilityResolution = resolveCapabilityResolution({
      config: params.config,
      profile: 'local_chat',
      browserDecisionMode: effectiveBrowserDecisionMode,
      runtimeAvailability: {
        browserHostAvailable: params.browserHostAvailable,
        feishuConnected: params.feishuConnected,
        channelScopeBound: params.channelScopeBound === true,
      },
      intentGroupModes,
    })
    appendToolCapabilityLog([
      '[tool_capability]',
      'stage=sdk_runtime_default_tools',
      'profile=local_chat',
      'preferredSkillTools=none',
      `visibleCapabilityGroups=${capabilityResolution.visibleCapabilityGroupIds.join('|') || 'none'}`,
      `suppressedCapabilityGroups=${capabilityResolution.suppressedCapabilityGroupIds.join('|') || 'none'}`,
      `hostOnlyCapabilityGroups=${capabilityResolution.hostOnlyCapabilityIds.join('|') || 'none'}`,
      `supportsVision=${capabilityResolution.supportsVision === true}`,
    ].join(' '))
    let definitions = capabilityResolution.visibleCapabilityGroupIds.flatMap((groupId) =>
      defaultToolRegistry.getToolDefinitionsForGroup(
        groupId,
        params.sessionId,
        params.authorization,
        params.scopeId,
      ))
    if (shouldSuppressAskUserQuestionsForOpenConversation({
      message: params.message,
      requestEnvelope: params.requestEnvelope,
      authorization: params.authorization,
    })) {
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
      params.authorization.mode === 'selected'
      && sdkIntentSurface.preferredSkillToolNames
      && sdkIntentSurface.preferredSkillToolNames.length > 0
        ? sdkIntentSurface.preferredSkillToolNames
        : null
    const allowedPrimitiveNames = authorizedPrimitiveToolNames(params.authorization)
    const resolvedSkillAllowedTools = resolveActiveSkillAllowedTools(params.authorization) || fallbackSkillAllowedTools
    const activeSkillAllowedTools = resolvedSkillAllowedTools && allowedPrimitiveNames.length > 0
      ? Array.from(new Set([...resolvedSkillAllowedTools, ...allowedPrimitiveNames]))
      : resolvedSkillAllowedTools
    if (activeSkillAllowedTools) {
      const preserveVisibleBrowserTool = createVisibleBrowserToolPreserver({
        visibleCapabilityGroupIds: capabilityResolution.visibleCapabilityGroupIds,
        collectionExposure,
        batchCollectionExposure,
      })
      // P0-3(D3)：skill+本地文档同轮时，文档读取工具是地板，不随技能收窄丢弃。
      const preserveLocalDocumentFloor = hasLocalDocumentResource(params.message, params.requestEnvelope)
      definitions = filterSelectedSkillToolSurface(definitions, activeSkillAllowedTools, {
        preserveToolName: (name) =>
          preserveVisibleBrowserTool?.(name) === true
          || (preserveLocalDocumentFloor && LOCAL_DOCUMENT_FLOOR_TOOL_NAMES.includes(name)),
      })
    }
    return filterToolsByVisionCapability(
      definitions as unknown as Array<Record<string, unknown>>,
      { supportsVision: capabilityResolution.supportsVision === true },
    ) as unknown as ToolDefinition[]
  }


  buildSdkTool(
    definition: ToolDefinition,
    runtimeContext: ToolBridgeRuntimeContext,
  ): AgentSdkTool {
    const schema = definition.schema && definition.schema.type === 'object'
      ? definition.schema
      : { type: 'object', properties: {}, additionalProperties: false }
    return tool({
      name: definition.name,
      description: definition.description,
      parameters: schema as never,
      strict: false,
      timeoutMs: definition.executionTimeoutMs,
      execute: async (input) => {
        const args = input && typeof input === 'object' && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {}
        if (
          definition.name === 'ask_user_questions'
          && runtimeContext.nativeMapAmbiguityResolved
          && typeof args.questions === 'string'
        ) {
          return stringifyToolResult(createToolExecutionOutput(
            '地图地点歧义已经通过结构化问题卡处理完成，无需再次反问。',
            {
              shape: 'json',
              data: {
                ok: true,
                skipped: true,
                reason: 'map_ambiguity_already_resolved',
              },
            },
          ))
        }
        const output = await this.executeReadyToolDefinition(definition, args, runtimeContext)
        if (definition.name === 'map_plan_route') {
          const bridgeResults: ToolBridgeResultItem[] = [{
            id: `native-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: definition.name,
            args,
            result: output,
          }]
          const handledMapAmbiguity = await this.host.resolveMapPlaceAmbiguityIfNeeded({
            bridgeResults,
            definitionByName: runtimeContext.definitionByName,
            runtimeContext,
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
      },
      errorFunction: (_context, error) => stringifyToolResult(createToolExecutionOutput(
        `工具 ${definition.name} 失败：${errorMessage(error)}`,
        {
          shape: 'json',
          data: {
            errorKind: 'tool_failed',
            toolName: definition.name,
            message: errorMessage(error),
          },
        },
      )),
    }) as AgentSdkTool
  }


  buildExecutorContext(
    runtimeContext: ToolBridgeRuntimeContext,
  ): ReturnType<typeof toToolExecutorContext> {
    const executorContext = toToolExecutorContext(buildToolRuntimeContext({
      browserController: this.host.browserController,
      sidecarManager: this.host.sidecarManager,
      runtime: this.host.runtime,
      scope: runtimeContext.sessionId
        ? this.host.runtime?.getConversationScope?.(runtimeContext.sessionId) || undefined
        : undefined,
      agent: publicAgentName(runtimeContext.agentName),
      allowedToolNames: runtimeContext.allowedToolNames,
      // SDK runtime executes renderer-mediated tools through the request/ack
      // path below. Forwarding tool handlers' advisory emitToolAction here
      // would make document/rss/calendar actions run twice in the renderer.
      emitToolAction: () => undefined,
      requestModuleToolAction: this.rendererToolActionRequester
        ? (toolName, toolArgs) => this.rendererToolActionRequester!({
          agent: runtimeContext.agentName,
          sessionId: runtimeContext.sessionId,
          runId: runtimeContext.runId,
          tool: toolName,
          args: toolArgs,
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
      authorization: runtimeContext.authorization,
    }))
    // WP2 — attach a turn-level user-view write lease so free-tool-loop browser
    // writes are gated and a user takeover suspends them. Lazy (no acquire until
    // a write); released on run cleanup (normal end / cancel / session close).
    if (this.host.browserController && runtimeContext.runId) {
      if (!runtimeContext.browserTurnLease) {
        const turnLease = createBrowserTurnLease({
          taskId: runtimeContext.taskId ?? runtimeContext.runId,
          runId: runtimeContext.runId,
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
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput> {
    const callTrace = formatToolCallTrace(definition.name, args)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
    })
    runtimeContext.emitToolAction(definition.name, args)
    const output = await this.host.executeToolCall(
      definition.name,
      args,
      this.buildExecutorContext(runtimeContext),
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
      projectionPatch: normalized.projectionPatch,
    })
    return outputWithSteering
  }



  private async ensureExplicitDocumentTargetOpened(
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput | null> {
    const guard = runtimeContext.documentTargetGuard
    if (!guard || guard.opened) return null
    const definition = guard.openToolDefinition
    if (!definition) {
      return createToolExecutionOutput(`无法打开目标文档 ${guard.targetName}：本轮未开放 document_open_tab。`, {
        shape: 'json',
        data: {
          errorKind: TARGET_DOCUMENT_ERROR_KINDS.openUnavailable.code,
          targetPath: guard.targetPath,
        },
      })
    }

    const args = { path: guard.targetPath }
    const output = await this.executeGuardDocumentTool(definition, args, runtimeContext)
    const normalized = normalizeToolExecutionOutput(output)
    if (isDocumentToolFailure(normalized)) {
      return createToolExecutionOutput(`无法打开目标文档 ${guard.targetName}，已停止写入，避免写错文件。`, {
        shape: 'json',
        data: {
          errorKind: TARGET_DOCUMENT_ERROR_KINDS.openFailed.code,
          targetPath: guard.targetPath,
          openResult: normalized.text,
        },
      })
    }
    guard.opened = true
    return null
  }


  private async ensureExplicitDocumentTargetSaved(
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput | null> {
    const guard = runtimeContext.documentTargetGuard
    if (!guard) return null
    const definition = guard.saveToolDefinition
    if (!definition) {
      return createToolExecutionOutput(`目标文档 ${guard.targetName} 已修改，但本轮未开放 document_save_tab，无法确认落盘。`, {
        shape: 'json',
        data: {
          errorKind: TARGET_DOCUMENT_ERROR_KINDS.saveUnavailable.code,
          targetPath: guard.targetPath,
        },
      })
    }
    const output = await this.executeGuardDocumentTool(definition, {}, runtimeContext)
    if (isDocumentToolFailure(output)) {
      return createToolExecutionOutput(`目标文档 ${guard.targetName} 保存失败，不能声明完成。`, {
        shape: 'json',
        data: {
          errorKind: TARGET_DOCUMENT_ERROR_KINDS.saveFailed.code,
          targetPath: guard.targetPath,
          saveResult: normalizeToolExecutionOutput(output).text,
        },
      })
    }
    return null
  }


  async executeReadyToolDefinition(
    definition: ToolDefinition,
    args: Record<string, unknown>,
    runtimeContext: ToolBridgeRuntimeContext,
  ): Promise<ToolExecutionOutput> {
    if (definition.name === 'skill_compact_context') {
      const callTrace = formatToolCallTrace(definition.name, args)
      runtimeContext.emitOutput(callTrace, 'tool_use')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'call',
        text: callTrace,
      })
      runtimeContext.emitToolAction(definition.name, args)
      const compacted = await this.host.compactCapturedSession(
        runtimeContext.agentName,
        runtimeContext.runHandle,
        undefined,
        'manual',
        this.host.sessionManager.get(runtimeContext.agentName)?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW,
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
          data: compacted,
        },
      )
      runtimeContext.recordToolResult(definition.name, output)
    noteToolResultForActivePlan(runtimeContext.sessionId, definition.name, args, Date.now(), output)
      const outputWithSteering = appendBudgetWarningSteering(output, runtimeContext)
      const resultTrace = formatToolResultTrace(definition.name, outputWithSteering)
      runtimeContext.emitOutput(resultTrace, 'tool_result')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'result',
        text: resultTrace,
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
            targetPath: guard.targetPath,
          },
        },
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
            ignoredTool: definition.name,
          },
        },
      )
    }
    if (guard && (DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name) || definition.name === 'document_save_tab')) {
      const blocker = await this.ensureExplicitDocumentTargetOpened(runtimeContext)
      if (blocker) return blocker
    }
    const effectiveArgs = guard
      ? normalizeExplicitDocumentTargetToolArgs(definition.name, args)
      : args

    const callTrace = formatToolCallTrace(definition.name, effectiveArgs)
    runtimeContext.emitOutput(callTrace, 'tool_use')
    this.publishSdkToolEvent({
      runtimeContext,
      definition,
      kind: 'call',
      text: callTrace,
    })
    const preservationBlocker = DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name)
      ? validatePreservedDocumentMutation(guard, definition.name, effectiveArgs)
      : null
    if (preservationBlocker) {
      runtimeContext.recordToolResult(definition.name, preservationBlocker)
      const blockerWithSteering = appendBudgetWarningSteering(preservationBlocker, runtimeContext)
      const resultTrace = formatToolResultTrace(definition.name, normalizeToolExecutionOutput(blockerWithSteering))
      runtimeContext.emitOutput(resultTrace, 'tool_result')
      this.publishSdkToolEvent({
        runtimeContext,
        definition,
        kind: 'result',
        text: resultTrace,
      })
      return blockerWithSteering
    }
    runtimeContext.emitToolAction(definition.name, effectiveArgs)
    const output = await this.host.executeToolCall(
      definition.name,
      effectiveArgs,
      this.buildExecutorContext(runtimeContext),
    )
    runtimeContext.recordToolResult(definition.name, output)
    noteToolResultForActivePlan(runtimeContext.sessionId, definition.name, args, Date.now(), output)
    const outputWithSteering = appendBudgetWarningSteering(output, runtimeContext)
    const normalized = normalizeToolExecutionOutput(outputWithSteering)
    if (
      guard
      && definition.name === 'document_open_tab'
      && String(effectiveArgs.path || '').trim() === guard.targetPath
      && !(normalized.data && typeof normalized.data === 'object' && 'errorKind' in normalized.data)
      && !isDocumentToolFailureText(normalized.text)
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
      projectionPatch: normalized.projectionPatch,
    })
    if (
      guard
      && DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(definition.name)
      && !isDocumentToolFailure(normalized)
      && documentToolMutatedContent(normalized)
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
    projectionPatch?: Record<string, unknown> | null
  }): void {
    if (!params.runtimeContext.sessionId) return
    const timestamp = new Date().toISOString()
    const projectionPatch = params.projectionPatch || null
    try {
      this.host.runtime?.publishScopeRunEvent?.({
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
      taskTitle: typeof projectionPatch?.taskTitle === 'string' ? projectionPatch.taskTitle : undefined,
      taskSummary: typeof projectionPatch?.taskSummary === 'string' ? projectionPatch.taskSummary : undefined,
      toolEvent: {
        id: `sdk-tool-${params.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: params.kind,
        text: params.text,
        timestamp,
      },
      timestamp,
      }, projectionPatch ? { projectionPatch, transcriptEvents: [] } : null)
    } catch (publishError) {
      // Event publication must never poison the tool result that triggered
      // it (same contract as hooks/reminders: observer failure stays out of
      // the main flow). Loud log, no rethrow.
      log(`publishScopeRunEvent failed: ${errorMessage(publishError)}`)
    }
  }
}
