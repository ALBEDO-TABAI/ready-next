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
import {
  ACTION_CONFIRMATION_ERROR_KINDS,
  BROWSER_TOOL_ERROR_KINDS,
  TOOL_ADMISSION_ERROR_KINDS,
} from '../agent-control/contracts/error-kinds'
import type { ConversationScope } from '../agent-control/contracts/types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type { SpecialistBlueprintSourceMessageUnavailableReason } from '../../../shared/agent-specialist-blueprint'
import type { ToolRuntimeActiveFrameContext } from '../agent-control/tools-runtime/tool-runtime'
import type { TurnFeatureFlags } from '../agent-control/runtime-core/turn-feature-flags'
import {
  checkSkillToolAuthorization,
  type SkillToolAuthorization,
} from '../agent-control/skills/skill-tool-authorization'
import { resolveConfirmationGate, m3GrantCandidateOf } from '../agent-control/safety/action-confirmation-policy'
import { matchToolNegationFamily } from '../agent-control/safety/negation-state'
import { createTaskProofSink, collectTaskEventProof } from '../agent-control/quality/proof-collector'
import type { FollowupNegationFamily } from '../../../shared/agent-followup-intent'
import { getFrozenCallStore } from '../agent-control/safety/frozen-call-bridge'
import { runFrozenCallConfirmation } from '../agent-control/safety/frozen-call-confirmation'
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
import { isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import type { BrowserLeaseGate } from '../browser-engine/agent-browser-lease-gate'
import type { BrowserTurnLease } from '../browser-engine/agent-browser-turn-lease'
import {
  isBrowserBackgroundHandoffTool,
  resolveBrowserToolSurfaceBinding,
} from '../browser-engine/browser-surface-binding'
import { executeCalendarTool } from './calendar-tools'
import { executeDocumentTool } from './document-tools'
import { executeGeneralResearchTool } from './general-research-tools'
import { executeMapTool } from './map-tools'
import { executeAskUserQuestions } from './builtins/ask-user-questions'
import { executeConfirmSpecialistBlueprint } from './builtins/confirm-specialist-blueprint'
import { executeProposeHandoff } from './builtins/propose-handoff'
import { executeProposeSpecialistBlueprint } from './builtins/propose-specialist-blueprint'
import { executeRenameSpecialistAgent } from './builtins/rename-specialist-agent'
import { resolveSpecialistFoundationSemanticJudge } from '../agent-control/agents/specialist-foundation-semantic-judge-provider'
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
import {
  getSpecialistBlueprintConfirmationStore,
  getSpecialistBlueprintStore,
} from '../agent-control/agents/specialist-blueprint-runtime'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import {
  ToolDomainError,
  errorKindFor,
  errorMessageOf,
  isTerminalInfrastructureError,
} from './tool-errors'
import { deriveEnvelopeForToolOutput } from './tool-result-envelope'
import { validateToolInput } from './tool-input-validator'
import {
  buildToolNotAllowedMessage,
  buildUnknownToolMessage,
  normalizeAllowedToolSet,
} from './tool-not-allowed-message'
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from './skills-tools-static'
import { ExternalServiceStore } from '../settings-engine/external-service-store'
import { createBrowserStructuredOutput as browserFailureOutput } from './browser-failure-output'

export interface ToolContext {
  browserController?: BrowserController | null
  sidecarManager?: SidecarManager | null
  runtime?: AgentControlRuntime | null
  scope?: ConversationScope | null
  allowedToolNames?: Set<string> | string[] | null
  emitToolAction?: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal?: AbortSignal
  /** EP2-I2 — standing user negation families for this scope (dispatch interception). */
  activeNegations?: ReadonlyArray<FollowupNegationFamily>
  sessionId?: string
  scopeId?: string
  currentUserText?: string
  sourceMessageId?: string | null
  sourceMessageUnavailableReason?: SpecialistBlueprintSourceMessageUnavailableReason | null
  requestEnvelope?: unknown
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

function workspaceRootsFromRequestEnvelope(envelope: unknown): string[] | null {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null
  const environmentHints = (envelope as { environmentHints?: unknown }).environmentHints
  if (!environmentHints || typeof environmentHints !== 'object' || Array.isArray(environmentHints)) return null
  const workspaceRoots = (environmentHints as { workspaceRoots?: unknown }).workspaceRoots
  if (!Array.isArray(workspaceRoots)) return null
  const roots = workspaceRoots
    .filter((root): root is string => typeof root === 'string' && root.trim().length > 0)
    .map((root) => root.trim())
  return roots.length > 0 ? roots : null
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

/**
 * EP1-T4-2 — single envelope-assembly point. Every structured result leaving
 * the dispatcher (success, domain error, admission denial, confirmation-gate
 * denial) gets an action-oriented `envelope` derived from its legacy fields.
 * Additive only: legacy text/data/errorKind are returned byte-identical; a
 * handler that pre-built its own envelope keeps it. Terminal infrastructure
 * errors keep throwing past this wrapper unchanged.
 */
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionOutput> {
  const output = await executeToolCallInner(toolName, args, context)
  if (output.envelope) return output
  return { ...output, envelope: deriveEnvelopeForToolOutput(output) }
}

/**
 * EP1-I3-2 — internal release grant. Present ONLY on the dispatcher's own
 * re-entry after `frozen-call-store.release()` consumed the one-shot token:
 * it skips exactly the confirmation gate, nothing else. Deliberately not a
 * ToolContext field so no caller (model, host wiring, tests via `as any`)
 * can fabricate it from outside this module.
 */
interface FrozenCallReleaseGrant {
  frozenCallId: string
}

async function executeToolCallInner(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
  releaseGrant?: FrozenCallReleaseGrant,
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
        errorKind: TOOL_ADMISSION_ERROR_KINDS.toolNotRegistered.code,
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
            errorKind: TOOL_ADMISSION_ERROR_KINDS.authorizationDenied.code,
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
        errorKind: TOOL_ADMISSION_ERROR_KINDS.internalToolNotAllowed.code,
        toolName,
      },
    })
  }

  if (definition.requiresExplicitAllowlist && !allowedToolNames?.has(toolName)) {
    return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames || new Set()), {
      shape: 'json',
      data: {
        errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code,
        toolName,
      },
    })
  }
  if (allowedToolNames && !allowedToolNames.has(toolName)) {
    return createToolExecutionOutput(buildToolNotAllowedMessage(toolName, allowedToolNames), {
      shape: 'json',
      data: {
        errorKind: TOOL_ADMISSION_ERROR_KINDS.toolRestrictedThisTurn.code,
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

  // EP1-I3-1/I3-2 — action-confirmation gate (05 §3.1/§3.2). Sits AFTER
  // registration / authorization / internal-visibility / allowlist admission
  // and input validation, immediately before dispatch: admission signals must
  // win (an unauthorized or restricted call reports as such, never as "needs
  // confirmation"), and the args classified here are the exact validated args
  // that get frozen and later released byte-identical. Host-invoked calls
  // bypass the gate — same precedent as the authorization gate above: a host
  // call is the app acting on the user's own action, not a model decision.
  // A release grant (dispatcher-internal re-entry after the one-shot token
  // was consumed) skips ONLY this gate — every admission check above already
  // reran on the way here (确认 ≠ 提权). The gate consumes ONLY (toolName,
  // args) — phase 1 forbids intent-based pre-approval and any confirmation
  // caching (no I-auth yet).
  // EP2-I2 — dispatch-layer negation interception, BEFORE the confirmation
  // gate: 拒绝权优先于确认权. A standing user negation ("不要采集") hard-stops
  // matching tool families with a structured denial the model must route
  // around — it never falls through to "needs confirmation", and no frozen
  // call is created. Host calls bypass (the user acting is not the model).
  if (invoker !== 'host' && !releaseGrant && context.activeNegations && context.activeNegations.length > 0) {
    const negatedFamily = matchToolNegationFamily(toolName, context.activeNegations)
    if (negatedFamily) {
      logAgentMetric(TOOL_ERROR_METRICS.userNegationDenied, {
        toolName,
        family: negatedFamily,
        sessionId: context.sessionId || null,
      })
      return createToolExecutionOutput(
        `用户已明确表示不要执行${negatedFamily === 'collection' ? '采集' : '该类'}动作（${negatedFamily}）。请改道或向用户澄清；用户明确说"可以${negatedFamily === 'collection' ? '采集' : '继续'}了"后方可恢复。`,
        {
          shape: 'json',
          data: {
            errorKind: TOOL_ADMISSION_ERROR_KINDS.deniedByUserNegation.code,
            family: negatedFamily,
            toolName,
          },
        },
      )
    }
  }

  if (invoker !== 'host' && !releaseGrant) {
    const confirmation = resolveConfirmationGate(toolName, args, { scopeId: context.scopeId || context.scope?.id || context.sessionId || null })
    const deniedOutput = (
      errorKind: string,
      text: string,
      extra?: Record<string, unknown>,
    ): ToolExecutionOutput => {
      logAgentMetric(TOOL_ERROR_METRICS.confirmationGateDenied, {
        toolName,
        mode: confirmation.mode,
        ruleId: confirmation.ruleId,
        errorKind,
        sessionId: context.sessionId || null,
      })
      return createToolExecutionOutput(text, {
        shape: 'json',
        data: {
          errorKind,
          toolName,
          mode: confirmation.mode,
          ruleId: confirmation.ruleId,
          reason: confirmation.reason,
          ...(extra || {}),
        },
      })
    }
    if (confirmation.action === 'manual_only') {
      return deniedOutput(
        ACTION_CONFIRMATION_ERROR_KINDS.deniedManualOnly.code,
        `工具 ${toolName} 被行动确认策略拦截（M1：必须由用户亲手完成）。${confirmation.reason}。`
        + '请把当前进度与下一步操作位置告诉用户，引导用户亲自完成这一步；不要代替用户执行或尝试绕过。',
      )
    }
    if (confirmation.action === 'confirm') {
      const pendingDeniedText = `工具 ${toolName} 需要用户确认后才能执行（${confirmation.mode}：${confirmation.reason}）。`
        + '本次调用未执行；请先向用户说明你要做什么并征得明确同意，或改用只读/不落地的替代路径。'
      const frozenCallStore = getFrozenCallStore()
      if (!frozenCallStore) {
        // No confirmation channel wired (boot order / headless) — keep the
        // I3-1 placeholder denial: an unconfirmable call NEVER executes.
        return deniedOutput(ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code, pendingDeniedText)
      }
      // EP1-I3-2 — freeze the validated args and suspend INSIDE this run's
      // execution context until the user decides on the confirmation card
      // (原 run 内同步等待). All runtime state stays alive across the wait.
      const outcome = await runFrozenCallConfirmation(toolName, args, confirmation, {
        store: frozenCallStore,
        sessionId: context.sessionId ?? null,
        conversationId: context.scope?.id || context.scopeId || context.sessionId || null,
        runId: context.runId ?? null,
        taskId: context.taskId ?? null,
        scopeId: context.scopeId || context.scope?.id || null,
        signal: context.abortSignal,
        emitCard: getAskUserQuestionsCardEmitter(),
        persistCard: getAskUserQuestionsCardPersistor(),
        // EP2-I-auth — M3 rules offer the session-effective option; choosing
        // it mints the confirmation grant (write entry 2). M2 never offers.
        sessionEffectiveGrant: confirmation.mode === 'M3'
          ? m3GrantCandidateOf(confirmation.ruleId, args)
          : null,
        // EP2-Q4a — confirmation audit events become task_event proofs.
        appendProof: (taskId, ref) => {
          try {
            const store = context.runtime?.getTaskProjectionStoreForFinalize?.()
            if (!store) return
            createTaskProofSink(store).append(taskId, [collectTaskEventProof({ taskId: ref, status: 'confirmation' }, new Date())])
          } catch { /* proof append must never break the confirmation path */ }
        },
      })
      switch (outcome.kind) {
        case 'released':
          // One-shot token consumed inside `frozen-call-store.release()`;
          // re-enter the SAME dispatch path with the FROZEN params. All
          // admission checks rerun; only this gate is skipped.
          return executeToolCallInner(toolName, outcome.params, context, {
            frozenCallId: outcome.frozenCallId,
          })
        case 'denied_by_user':
          return deniedOutput(
            ACTION_CONFIRMATION_ERROR_KINDS.confirmationDeniedByUser.code,
            `用户拒绝了本次操作（${toolName}）。请不要重试同一动作；如有替代方案，先向用户说明再行动。`,
            { frozenCallId: outcome.frozenCallId },
          )
        case 'expired':
          return deniedOutput(
            ACTION_CONFIRMATION_ERROR_KINDS.confirmationExpired.code,
            `确认超时已取消：工具 ${toolName} 的确认请求未在时限内得到用户确认（${outcome.reason}）。`
            + '该调用未执行；如仍需要，请重新发起并等待用户确认。',
            { frozenCallId: outcome.frozenCallId },
          )
        case 'pending_exists':
        case 'unavailable':
        default:
          return deniedOutput(ACTION_CONFIRMATION_ERROR_KINDS.deniedPendingConfirmation.code, pendingDeniedText)
      }
    }
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
          const surfaceBinding = resolveBrowserToolSurfaceBinding({
            toolName,
            args,
            dispatch: 'tool-executor',
            hasTurnLease: Boolean(turnLease),
          })
          if (!surfaceBinding.ok) {
            return browserFailureOutput(surfaceBinding.error as unknown as Record<string, unknown>)
          }
          if (turnLease && surfaceBinding.binding.effect === 'write') {
            if (isBrowserBackgroundHandoffTool(toolName)) {
              // Hand the surface to a background browser task (single writer):
              // release the turn lease so the task can acquire or use its own lane.
              turnLease.releaseForBackgroundHandoff()
            } else {
              const ensured = turnLease.ensureGate()
              if (isAgentBrowserError(ensured)) {
                return browserFailureOutput(ensured as unknown as Record<string, unknown>)
              }
              browserLeaseGate = ensured
            }
          }
          const browserResult = await executeBrowserTool(
            toolName,
            args,
            context.browserController,
            context.abortSignal,
            context.sessionId,
            browserLeaseGate,
            context.currentUserText,
            context.runtime,
          )
          if (typeof browserResult === 'string' && browserResult.startsWith('Error:')) {
            return browserFailureOutput({
              ok: false,
              errorKind: BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code,
              toolName,
              message: browserResult.slice('Error:'.length).trim(),
            })
          }
          return browserResult
        }

        case 'document':
          return executeDocumentTool(toolName, args, {
            emitToolAction: context.emitToolAction,
            requestModuleToolAction: context.requestModuleToolAction,
          })

        case 'file':
          {
            const { executeFileManagementTool } = await import('./file-management-tools')
            return executeFileManagementTool(toolName, args, {
              abortSignal: context.abortSignal,
              workspaceRoots: workspaceRootsFromRequestEnvelope(context.requestEnvelope),
            })
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
            taskId: context.taskId,
            taskProjectionId: context.taskProjectionId,
            frameSkillId: context.frameSkillId ?? null,
            // EP3-I4 — user's words this turn, byte-for-byte (05 §4).
            currentUserText: context.currentUserText,
            requestEnvelope: context.requestEnvelope,
            runtime: context.runtime,
            sidecarManager: context.sidecarManager,
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
          const semanticJudge = toolName === 'confirm_specialist_blueprint' || toolName === 'propose_specialist_blueprint'
            ? resolveSpecialistFoundationSemanticJudge()
            : null
          if (toolName === 'confirm_specialist_blueprint') {
            const runtime = context.runtime
            if (!runtime) {
              return createToolExecutionOutput('专项 agent 创建未执行：runtime 不可用。', {
                shape: 'json',
                data: {
                  errorKind: 'runtime_unavailable',
                  toolName,
                },
              })
            }
            const specialistSemanticJudge = semanticJudge as NonNullable<typeof semanticJudge>
            return executeConfirmSpecialistBlueprint(
              args as Parameters<typeof executeConfirmSpecialistBlueprint>[0],
              {
                getBlueprintStore: getSpecialistBlueprintStore,
                getConfirmationStore: getSpecialistBlueprintConfirmationStore,
                getBeliefCardStore: () => runtime.getBeliefCardStore(),
                getAgentRegistry: () => runtime.getAgentRegistry(),
                runSemanticFoundationJudge: specialistSemanticJudge.judge,
                semanticFoundationJudgeUnavailableReason: specialistSemanticJudge.unavailableReason,
                sessionId: context.sessionId ?? context.scope?.id ?? null,
                runId: context.runId ?? null,
                currentUserText: context.currentUserText ?? null,
              },
            )
          }
          if (toolName === 'rename_specialist_agent') {
            const runtime = context.runtime
            if (!runtime) {
              return createToolExecutionOutput('专项 agent 未改名：runtime 不可用。', {
                shape: 'json',
                data: {
                  errorKind: 'runtime_unavailable',
                  toolName,
                },
              })
            }
            return executeRenameSpecialistAgent(
              args as Parameters<typeof executeRenameSpecialistAgent>[0],
              {
                registry: runtime.getAgentRegistry(),
                currentUserText: context.currentUserText ?? null,
              },
            )
          }
          if (toolName === 'propose_specialist_blueprint') {
            const runtime = context.runtime
            if (!runtime) {
              return createToolExecutionOutput('专项 agent 蓝图未保存：runtime 不可用。', {
                shape: 'json',
                data: {
                  errorKind: 'runtime_unavailable',
                  toolName,
                },
              })
            }
            const specialistSemanticJudge = semanticJudge as NonNullable<typeof semanticJudge>
            const sourceMessageId = typeof context.sourceMessageId === 'string' && context.sourceMessageId.trim()
              ? context.sourceMessageId.trim()
              : null
            return executeProposeSpecialistBlueprint(
              args as Parameters<typeof executeProposeSpecialistBlueprint>[0],
              {
                blueprintStore: getSpecialistBlueprintStore(),
                registry: runtime.getAgentRegistry(),
                sessionId: context.sessionId ?? null,
                runId: context.runId ?? null,
                sourceMessageId,
                sourceMessageUnavailableReason: sourceMessageId
                  ? null
                  : context.sourceMessageUnavailableReason || 'message_id_unavailable',
                currentUserText: context.currentUserText ?? null,
                runSemanticFoundationJudge: specialistSemanticJudge.judge,
                semanticFoundationJudgeUnavailableReason: specialistSemanticJudge.unavailableReason,
              },
            )
          }
          // EP3-A4 — handoff proposal: same card machinery, plus registry
          // lookup and the codebase's ONLY ownerAgentId value write (via
          // the runtime's projection repository).
          if (toolName === 'agent_propose_handoff') {
            const runtime = context.runtime
            if (!runtime) {
              return createToolExecutionOutput('转办提议无效：runtime 不可用', {
                shape: 'json',
                data: { outcome: { kind: 'invalid', reason: 'runtime_unavailable' } },
              })
            }
            return executeProposeHandoff(args as Parameters<typeof executeProposeHandoff>[0], {
              getAgent: (id) => runtime.getAgentRegistry().get(id),
              updateTaskOwner: (taskId, ownerAgentId) =>
                runtime.getTaskProjectionStore().update(taskId, { ownerAgentId }),
              sessionId: context.sessionId,
              conversationId: context.scope?.id || context.sessionId,
              scopeId: context.scopeId,
              signal: context.abortSignal,
              emitCard: getAskUserQuestionsCardEmitter(),
              persistCard: getAskUserQuestionsCardPersistor(),
              taskId: context.taskId ?? null,
            })
          }
          // `ask_user_questions`. Emitter + persistor are looked up via the
          // bridge so the handler stays electron-free and testable under
          // `tsx --test`. Conversation id falls back to the session/scope
          // identifier when the caller did not pass one; the renderer uses
          // it only as a grouping key on the DB row, so any stable
          // per-conversation token is acceptable.
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
