/**
 * Unified tool dispatcher.
 * Routes tool calls by prefix to the appropriate executor.
 */

import { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from '../agent-control/sidecar-manager'
import type { AgentControlRuntime } from '../agent-control/runtime-core/runtime'
import {
  defaultToolRegistry,
  resolveToolInputSchemaForExecution,
} from '../agent-control/tools-runtime/tool-registry'
import type { ToolDefinition } from '../agent-control/tools-runtime/tool-definition'
import { logAgentMetric } from '../agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../agent-control/tools-runtime/tool-error-metrics'
import type { ConversationScope } from '../agent-control/contracts/types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type { ToolRuntimeActiveFrameContext } from '../agent-control/tools-runtime/tool-runtime'
import type { TurnFeatureFlags } from '../agent-control/runtime-core/turn-feature-flags'
import {
  checkSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../agent-control/skills/skill-tool-authorization'
import { PRIMITIVE_TOOL_DEFS } from './skill-primitives/tool-defs'
import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../skills-runtime/runtime-manager'
import {
  createToolExecutionOutput,
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
  type ToolInteractionHint,
} from '../agent-control/tools-runtime/tool-result-types'
import { executeBrowserTool } from './browser-tools'
import { classifyBrowserToolCall } from '../browser-engine/browser-tool-write-classification'
import { isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import type { BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import type { BrowserTurnLease } from '../browser-engine/agent-browser-turn-lease'
import { executeCalendarTool } from './calendar-tools'
import { executeDocumentTool } from './document-tools'
import { executeGeneralResearchTool } from './general-research-tools'
import { executeMapTool } from './map-tools'
import { executeAskUserQuestions } from './builtins/ask-user-questions'
import { executeInstallSkill } from './builtins/install-skill'
import {
  getAskUserQuestionsCardEmitter,
  getAskUserQuestionsCardPersistor,
} from '../agent-control/ask-user/ask-user-questions-bridge'
import { executeMcpTool } from './mcp-tools'
import { executeRSSTool } from './rss-tools'
import { executeSkillTool, findSkillToolByNameForExecution } from './skills-tools'
import { executeSystemTool } from './system-tools'
import { executeFeishuTool } from './feishu-tools'
import { executeMemoryTool } from './memory-tools'
import { executePetTool } from './pet-tools'
import { executeSessionRecallTool } from './session-recall-tools'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import {
  ToolDomainError,
  errorKindFor,
  errorMessageOf,
  isTerminalInfrastructureError,
} from './tool-errors'
import { validateToolInput } from './tool-input-validator'
import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from './tool-not-allowed-message'
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from './skills-tools-static'
import { ExternalServiceStore } from '../settings-engine/external-service-store'

export interface ToolContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
  runtime?: AgentControlRuntime | null
  scope?: ConversationScope | null
  allowedToolNames?: Set<string> | string[] | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal?: AbortSignal
  sessionId?: string
  scopeId?: string
  currentUserText?: string
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  taskProjectionId?: string
  frameSkillId?: string | null
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
  agentContext?: AgentSpawnContext | null
  /**
   * WP2 — turn-level user-view write lease for free-tool-loop browser writes.
   * Set by the SDK runtime's buildExecutorContext when a browser host exists.
   * The browser dispatch acquires/gates writes through it; run cleanup releases.
   */
  browserLease?: BrowserTurnLease | null
  /**
   * Phase 3 (skill-child-loop) — same-turn live active-frame slot. Forwarded
   * by `toToolExecutorContext` so domain dispatchers (notably
   * `skills-tools.ts` for `skill_read_artifact`) can prefer fresh artifact
   * roots / handles emitted by an earlier tool in the same batch.
   */
  activeFrame?: ToolRuntimeActiveFrameContext | null
  invoker?: 'model' | 'child_runner' | 'host'
  allowInternal?: boolean
  turnFeatureFlags?: TurnFeatureFlags
  skillRuntimeManager?: SkillsRuntimeManager | null
  childInternalSkillAction?: {
    skillId: string
    action: string
    childRunId: string
    outputDir: string | null
    runStatePath: string | null
  } | null
  /**
   * Stage 4 W3 — per-turn skill tool authorization. Stage 10 made this
   * field required in production: every model-visible call site computes
   * a determinate authorization (`mode:'selected'` or `mode:'none'` with
   * an explicit reason) before consulting the model, and admission
   * decisions are always live. A runtime invariant in `executeToolCall`
   * additionally asserts authorization is present for model-issued
   * skill_* calls — defense against `as any` bypasses.
   */
  authorization: SkillToolAuthorization
}

function isFrameScopedInternalSkillActionAllowed(
  toolName: string,
  context: ToolContext,
  allowedToolNames: Set<string> | null,
): boolean {
  if (!allowedToolNames?.has(toolName)) return false
  const skillTool = findSkillToolByNameForExecution(toolName)
  const skillId = skillTool?.kind === 'skill_action'
    ? skillTool.skillId
    : STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]?.skillId || null
  if (!skillId) return false
  const frameSkillId = context.frameSkillId || context.activeFrame?.runContract?.skillId || null
  return Boolean(frameSkillId && frameSkillId === skillId)
}

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionOutput> {
  // Check registration BEFORE admission so the model can distinguish
  // "fabricated tool name" from "real tool but not allowed this turn" —
  // see tool-not-allowed-message.ts for the rationale.
  const definition = defaultToolRegistry.getToolDefinitionForExecution(toolName)
  if (!definition) {
    // Stage U PR U1.1 — `tool_not_registered` is now a top-level errorKind
    // (mutually exclusive with `authorization_denied` per AGENTS.md §3).
    // The previous shape `errorKind: 'host_unavailable', reason: 'tool_not_registered'`
    // conflated "infra unavailable" with "fabricated tool name" — see plan §2 U1.1.
    return createToolExecutionOutput(buildUnknownToolMessage(toolName), {
      shape: 'json',
      data: {
        errorKind: 'tool_not_registered',
        toolName,
      },
    })
  }

  const allowedToolNames = normalizeAllowedToolSet(context.allowedToolNames)
  const invoker = context.invoker ?? 'model'

  // Stage 4 W3 — per-turn skill tool authorization MUST run BEFORE the
  // legacy/internal visibility gates below. `expose_when_hint_armed`
  // intentionally makes selected internal typed actions model-visible; once
  // authorization admits that exact typed action, the internal gate must not
  // reject it as a generic internal-only tool.
  if (invoker === 'model' && toolName.startsWith('skill_') && !context.authorization) {
    throw new Error('Stage 10 invariant: model-issued skill_* tool call missing authorization')
  }
  const authorization = context.authorization
  if (invoker === 'model' && toolName.startsWith('skill_')) {
    const isPrimitive = PRIMITIVE_TOOL_DEFS.some((d) => d.name === toolName)
    const decision = checkSkillToolAuthorization(toolName, authorization, isPrimitive)
    if (!decision.allowed) {
      logAgentMetric(TOOL_ERROR_METRICS.authorizationDenied, {
        toolName,
        reason: decision.reason,
        mode: authorization.mode,
        source: authorization.mode === 'selected' ? authorization.source : null,
        sessionId: context.sessionId || null,
      })
      return createToolExecutionOutput(
        `Tool ${toolName} is not authorized for this turn (${decision.reason}).`,
        {
          shape: 'json',
          data: {
            errorKind: 'authorization_denied',
            reason: decision.reason,
            toolName,
          },
        },
      )
    }
  }

  const allowsChildInternal =
    context.allowInternal === true && context.invoker === 'child_runner'
  const allowsFrameScopedInternal =
    definition.executionVisibility === 'internal'
    && isFrameScopedInternalSkillActionAllowed(toolName, context, allowedToolNames)
  const allowsAuthorizedModelInternal =
    invoker === 'model'
    && toolName.startsWith('skill_')
    && definition.executionVisibility === 'internal'
    && authorization.mode === 'selected'
    && authorization.allowedTypedActions.has(toolName)
  const childInternalStrictAdmission =
    context.turnFeatureFlags?.childInternalStrictAdmission ?? true
  if (
    childInternalStrictAdmission
    && definition.executionVisibility === 'internal'
    && !allowsChildInternal
    && !allowsFrameScopedInternal
    && !allowsAuthorizedModelInternal
  ) {
    return createToolExecutionOutput(`Tool ${toolName} is internal-only and cannot be called from this context.`, {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'internal_tool_not_allowed',
        toolName,
      },
    })
  }

  if (definition.requiresExplicitAllowlist && !allowedToolNames?.has(toolName)) {
    return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames || new Set()), {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'tool_restricted_this_turn',
        toolName,
      },
    })
  }
  if (allowedToolNames && !allowedToolNames.has(toolName)) {
    return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames), {
      shape: 'json',
      data: {
        errorKind: 'host_unavailable',
        reason: 'tool_restricted_this_turn',
        toolName,
      },
    })
  }

  if (context.abortSignal?.aborted) {
    const error = new Error('Operation aborted')
    error.name = 'AbortError'
    throw error
  }

  // Phase 2 (B plan child-loop): single-source schema admission. The
  // resolver in `tool-registry.ts` consults the static registry first
  // (which already includes static-manifest-derived skill action schemas)
  // and falls back to the dynamic `getSkillActionSchemas()` cache for
  // user-installed manifests. The split-schema hazard — where a forced
  // dispatch could pass through `turn-frame-steering` because the dynamic
  // cache was invisible there but be rejected later in the executor — is
  // collapsed into one ordering. Tools with no registered schema pass
  // through unchanged because `validateToolInput` treats a missing entry
  // as `{ ok: true }`.
  {
    const resolvedSchema = resolveToolInputSchemaForExecution(toolName)
    const schemas = resolvedSchema ? { [toolName]: resolvedSchema } : {}
    const outcome = validateToolInput(toolName, args, schemas)
    if (!outcome.ok) {
      logAgentMetric(TOOL_ERROR_METRICS.inputValidation, {
        toolName,
        domain: definition.domain,
        issueCount: outcome.issueCount,
        firstCode: outcome.firstCode,
        firstPath: outcome.firstPath,
        sessionId: context.sessionId || null,
      })
      return outcome.output
    }
    args = outcome.data
  }

  try {
    const rawResult = await (async () => {
      switch (definition.domain) {
        case 'browser': {
          if (!context.browserController) {
            return 'Browser controller is not available'
          }
          // WP2 — gate free-tool-loop browser writes through the turn lease.
          let browserLeaseGate: BrowserLeaseGate | undefined
          const turnLease = context.browserLease
          if (turnLease) {
            if (toolName === 'browser_visible_collect' || toolName === 'browser_collect_notes' || toolName === 'browser_resume_task') {
              // Hand the surface to a background browser task (single writer):
              // release the turn lease so the task can acquire or use its own lane.
              turnLease.releaseForBackgroundHandoff()
            } else if (classifyBrowserToolCall(toolName, args) === 'write') {
              const ensured = turnLease.ensureGate()
              if (isAgentBrowserError(ensured)) {
                return JSON.stringify(ensured)
              }
              browserLeaseGate = ensured
            }
          }
          return executeBrowserTool(
            toolName,
            args,
            context.browserController,
            context.abortSignal,
            context.sessionId,
            browserLeaseGate,
            context.currentUserText,
            context.runtime,
          )
        }

        case 'document':
          return executeDocumentTool(toolName, args, {
            emitToolAction: context.emitToolAction,
            requestModuleToolAction: context.requestModuleToolAction,
          })

        case 'file':
          {
            const { executeFileManagementTool } = await import('./file-management-tools')
            return executeFileManagementTool(toolName, args, { abortSignal: context.abortSignal })
          }

        case 'rss':
          return executeRSSTool(toolName, args, {
            emitToolAction: context.emitToolAction,
            requestModuleToolAction: context.requestModuleToolAction,
          })

        case 'calendar':
          return executeCalendarTool(toolName, args, {
            emitToolAction: context.emitToolAction,
            requestModuleToolAction: context.requestModuleToolAction,
          })

        case 'skill':
          if (definition.executionVisibility === 'internal' && allowsChildInternal) {
            return executeChildInternalSkillTool(toolName, args, definition, context)
          }
          return executeSkillTool(toolName, args, context.sessionId, context.registerRunCleanup, context.abortSignal, context.agentContext, {
            scopeId: context.scopeId || context.scope?.id || context.sessionId,
            runId: context.runId,
            frameSkillId: context.frameSkillId ?? null,
            // Phase 3 — forward the live active-frame slot so the skill
            // dispatcher (`skill_read_artifact`) can prefer fresh artifact
            // roots emitted by earlier tools in the same batch.
            activeFrame: context.activeFrame ?? null,
            // Stage 4 W3b — forward per-turn skill tool authorization so
            // `resolvePrimitiveSkillId` can derive primitive skillId from
            // the identity-driven `authorization.skillId`.
            authorization: context.authorization,
            // Stage Q (Stage 11) — forward per-turn feature flag snapshot
            // so `recordPrimitiveOutcome` can apply the selected-skill
            // primitive fence (referencePrimitiveLifecycleFence) without
            // reading process.env in the hot path.
            turnFeatureFlags: context.turnFeatureFlags,
          })

        case 'system':
          return executeSystemTool(toolName, args)

        case 'feishu':
          return executeFeishuTool(toolName, args, { sidecarManager: context.sidecarManager })

        case 'memory':
          return executeMemoryTool(toolName, args, context)

        case 'session':
          return executeSessionRecallTool(toolName, args, context)

        case 'pet':
          return executePetTool(toolName, args)

        case 'general_research': {
          // Stage R W1.1/W1.2/W6.4 — `outputsRoot` is the single sandbox
          // root for `present_file`. Derived from the skills runtime so we
          // do not leak SkillsRuntimeManager handles into ToolContext;
          // child-runner / model invokers all converge here.
          const runtimeInfo = getSkillsRuntimeManager().getRuntimeInfo()
          let serviceConfig: ReturnType<ExternalServiceStore['getGeneralResearchConfig']> = {
            ddgEnabled: true,
          }
          try {
            const externalServices = new ExternalServiceStore()
            serviceConfig = externalServices.getGeneralResearchConfig()
            if (context.authorization.mode === 'selected' && context.authorization.skillId === 'deep-research') {
              const skillConfig = getSkillsRuntimeManager().getSkillConfiguration('deep-research')
              const searchServiceId = skillConfig?.values.serviceBindings.searchService
              const fetchServiceId = skillConfig?.values.serviceBindings.fetchService
              if (searchServiceId) {
                const searchService = externalServices.getRuntimeService(searchServiceId)
                if (searchService?.kind === 'duckduckgo') {
                  serviceConfig = {
                    ...serviceConfig,
                    tavilyKey: undefined,
                    tavilyBaseUrl: undefined,
                    ddgEnabled: searchService.enabled,
                    ddgBaseUrl: searchService.baseUrl,
                  }
                }
              }
              if (fetchServiceId) {
                const fetchService = externalServices.getRuntimeService(fetchServiceId)
                if (fetchService?.kind === 'tavily') {
                  serviceConfig = {
                    ...serviceConfig,
                    tavilyKey: fetchService.enabled ? fetchService.secrets.apiKey || serviceConfig.tavilyKey : serviceConfig.tavilyKey,
                    tavilyBaseUrl: fetchService.enabled ? fetchService.baseUrl || serviceConfig.tavilyBaseUrl : serviceConfig.tavilyBaseUrl,
                    preferTavilyExtract: true,
                  }
                } else if (fetchService?.kind === 'jina') {
                  serviceConfig = {
                    ...serviceConfig,
                    jinaKey: fetchService.enabled ? fetchService.secrets.apiKey || serviceConfig.jinaKey : serviceConfig.jinaKey,
                    jinaBaseUrl: fetchService.enabled ? fetchService.baseUrl || serviceConfig.jinaBaseUrl : serviceConfig.jinaBaseUrl,
                    preferTavilyExtract: false,
                  }
                }
              }
            }
          } catch {
            // silent-catch: settings unavailable at boot or in tests; tools
            // still work via DDG / Jina-no-auth fallback paths.
          }
          // P1.2 — `web_clip_url` resolves its preset bundle from the synced
          // embedded-skill folder: `<skillsRoot>/obsidian-web-clip/assets/presets/`.
          // We pass it as a separate plain-string field instead of expanding
          // ToolContext (Stage R 8-contract #4 — no new ToolContext fields).
          const obsidianWebClipPresetDir = `${runtimeInfo.skillsRoot}/obsidian-web-clip/assets/presets`
          return executeGeneralResearchTool(toolName, args as Record<string, unknown>, {
            abortSignal: context.abortSignal,
            sessionId: context.sessionId,
            outputsRoot: runtimeInfo.outputsRoot,
            requestModuleToolAction: context.requestModuleToolAction,
            scope: context.scope,
            tavilyKey: serviceConfig.tavilyKey,
            tavilyBaseUrl: serviceConfig.tavilyBaseUrl,
            jinaKey: serviceConfig.jinaKey,
            jinaBaseUrl: serviceConfig.jinaBaseUrl,
            ddgEnabled: serviceConfig.ddgEnabled,
            ddgBaseUrl: serviceConfig.ddgBaseUrl,
            preferTavilyExtract: serviceConfig.preferTavilyExtract,
            obsidianWebClipPresetDir,
          })
        }

        case 'map':
          return executeMapTool(toolName, args as Record<string, unknown>, {
            abortSignal: context.abortSignal,
            sessionId: context.sessionId,
            requestModuleToolAction: context.requestModuleToolAction,
          })

        case 'mcp':
          // Stage T PR-T5 — MCP dispatch. The model-visible list resolver
          // already gated this name through `mcp/registry.isAuthorized`;
          // here we only forward to the per-server `McpClient`.
          return executeMcpTool(toolName, args as Record<string, unknown>, {
            abortSignal: context.abortSignal,
            sessionId: context.sessionId,
            scopeId: context.scopeId,
          })

        case 'agent_interaction':
          // Single tool today: `ask_user_questions`. Emitter + persistor are
          // looked up via the bridge so the handler stays electron-free and
          // testable under `tsx --test`. Conversation id falls back to the
          // session/scope identifier when the caller did not pass one; the
          // renderer uses it only as a grouping key on the DB row, so any
          // stable per-conversation token is acceptable.
          return executeAskUserQuestions(args as unknown as Parameters<typeof executeAskUserQuestions>[0], {
            sessionId: context.sessionId,
            conversationId: context.scope?.id || context.sessionId,
            signal: context.abortSignal,
            emitAskUserQuestionsCard: getAskUserQuestionsCardEmitter(),
            persistCardPending: getAskUserQuestionsCardPersistor(),
          })

        case 'skill_install':
          // Two-phase remote skill installer. Phase 1 resolves read-only; phase 2
          // installs only with trustAck after the user approved via
          // ask_user_questions. The manager enforces the trustAck invariant.
          return executeInstallSkill(args as Parameters<typeof executeInstallSkill>[0], {
            manager: getSkillsRuntimeManager(),
          })

        default:
          return `Unknown tool: ${toolName}`
      }
    })()

    return toStructuredToolResult(toolName, rawResult)
  } catch (error) {
    if (isTerminalInfrastructureError(error)) {
      throw error
    }
    const kind = errorKindFor(error)
    const message = errorMessageOf(error)
    const detail = error instanceof ToolDomainError ? error.detail : null
    logAgentMetric(TOOL_ERROR_METRICS.surfaced, {
      toolName,
      errorKind: kind,
      message: message.slice(0, 200),
    })
    // Phase 4: skill_execution_missing metric retired with the
    // skill_executions state machine. The errorKind still exists for other
    // callers but no longer has a dedicated bucketed metric.
    void detail
    return createToolExecutionOutput(`工具 ${toolName} 失败：${message}`, {
      shape: 'json',
      data: {
        errorKind: kind,
        toolName,
        message,
        detail,
      },
    })
  }
}

function toStructuredToolResult(toolName: string, rawResult: string | ToolExecutionOutput): ToolExecutionOutput {
  const normalized = normalizeToolExecutionOutput(rawResult)
  if (normalized.interactionHint) {
    return normalized
  }

  const interactionHint = inferToolInteractionHint(toolName, normalized.text)
  return interactionHint
    ? {
      ...normalized,
      interactionHint,
    }
    : normalized
}

function inferToolInteractionHint(toolName: string, resultText: string): ToolInteractionHint | null {
  if (!toolName.startsWith('skill_')) return null
  const blockerType = resultText.match(/^Blocker:\s*([^-\n]+)-/m)?.[1]?.trim() || null
  if (blockerType === 'need_confirmation') {
    return 'awaiting_confirmation'
  }
  if (blockerType === 'need_input' || blockerType === 'need_agent_result') {
    return 'awaiting_clarification'
  }
  return null
}

async function executeChildInternalSkillTool(
  toolName: string,
  args: Record<string, unknown>,
  definition: ToolDefinition,
  context: ToolContext,
): Promise<ToolExecutionOutput> {
  const action = context.childInternalSkillAction
  if (!action) {
    return createInternalSkillError({
      errorKind: 'host_unavailable',
      message: 'Child internal skill context is missing',
      detail: { reason: 'child_internal_context_missing', toolName },
    })
  }

  const runtimeManager = context.skillRuntimeManager ?? await getDefaultSkillsRuntimeManager()
  if (!runtimeManager) {
    return createInternalSkillError({
      errorKind: 'host_unavailable',
      message: 'Skills runtime manager is not configured',
      detail: { reason: 'runtime_manager_missing', toolName },
    })
  }

  const request: SkillRunRequest = {
    skillId: action.skillId,
    action: action.action,
    params: {
      ...args,
      __childRunContext: {
        childRunId: action.childRunId,
        scopeId: context.scopeId || context.scope?.id || context.sessionId || null,
        sessionId: context.sessionId || null,
        outputDir: action.outputDir,
        runStatePath: action.runStatePath,
      },
    },
    timeoutMs: definition.executionTimeoutMs,
    signal: context.abortSignal,
    triggerType: 'tool',
    sessionId: context.sessionId,
    agentContext: context.agentContext,
  }

  const fromChild = (runtimeManager as unknown as {
    runSkillFromChildRunner?: (req: SkillRunRequest) => Promise<SkillRunResult>
  }).runSkillFromChildRunner
  if (!fromChild) {
    return createInternalSkillError({
      errorKind: 'host_unavailable',
      message: 'Skills runtime manager does not expose child runner execution',
      detail: {
        reason: 'runSkillFromChildRunner_missing',
        toolName,
        skillId: action.skillId,
        action: action.action,
        childRunId: action.childRunId,
      },
    })
  }

  let result: SkillRunResult
  try {
    result = await fromChild.call(runtimeManager, request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const looksAborted = context.abortSignal?.aborted
      || (error instanceof Error && (error.name === 'AbortError' || /abort|cancel/i.test(error.message)))
    return createInternalSkillError({
      errorKind: looksAborted ? 'aborted' : 'tool_failed',
      message,
      detail: {
        toolName,
        skillId: action.skillId,
        action: action.action,
        childRunId: action.childRunId,
      },
    })
  }

  const text = result.success
    ? `child gateway ok: ${action.skillId}/${action.action}`
    : `child gateway skill_action_failed: ${result.error || 'skill returned success=false'}`
  return createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      ok: result.success,
      skillId: action.skillId,
      action: action.action,
      childRunId: action.childRunId,
      runStatus: result.status ?? null,
      outputDir: result.outputDir ?? null,
      skillRunResult: result as unknown as Record<string, unknown>,
    },
  })
}

function createInternalSkillError(args: {
  errorKind: string
  message: string
  detail?: Record<string, unknown>
}): ToolExecutionOutput {
  return createToolExecutionOutput(`child gateway ${args.errorKind}: ${args.message}`, {
    shape: 'json',
    data: {
      status: 'error',
      errorKind: args.errorKind,
      message: args.message,
      ...(args.detail || {}),
    },
  })
}

async function getDefaultSkillsRuntimeManager(): Promise<SkillsRuntimeManager | null> {
  try {
    const mod = await import('../skills-runtime/runtime-manager')
    return mod.getSkillsRuntimeManager()
  } catch {
    return null
  }
}
