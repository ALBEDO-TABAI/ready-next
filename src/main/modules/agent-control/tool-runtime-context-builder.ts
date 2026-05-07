import type { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from './sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ConversationScope } from './types'
import type { ToolContext } from '../tools/tool-executor'
import {
  createEmptyActiveFrameContext,
  type ToolRuntimeActiveFrameContext,
  type ToolRuntimeContext,
} from './tool-runtime'
import type { TurnFrame } from './turn-frame'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import {
  snapshotTurnFeatureFlags,
  type TurnFeatureFlags,
} from './turn-feature-flags'
import type { SkillToolAuthorization } from './skill-tool-authorization'

/**
 * Phase 3 (Team T7) — derive the initial `ToolRuntimeActiveFrameContext`
 * snapshot from the current `TurnFrame`. The first tool dispatched in a
 * turn must already see the frame's durable signals (active artifact roots,
 * latest run contract) before any same-batch `contextModifier` mutates the
 * slot.
 *
 * Shape mapping:
 *   - `frame.activeArtifactRoots` → `activeArtifactRoots`
 *   - `frame.skill?.runContract` → `runContract`
 *   - `discoveredHandles` is always `[]` here — `TurnFrame` folds discovered
 *     handles into the skill slice fields rather than carrying a top-level
 *     array, so the runtime context starts empty and accumulates additive
 *     handles via `applyContextModifier` during the batch.
 */
export function buildActiveFrameContextFromTurnFrame(
  frame: TurnFrame | null | undefined,
): ToolRuntimeActiveFrameContext {
  if (!frame) return createEmptyActiveFrameContext()
  return {
    activeArtifactRoots: Array.isArray(frame.activeArtifactRoots)
      ? [...frame.activeArtifactRoots]
      : [],
    runContract: frame.skill?.runContract ?? null,
    discoveredHandles: [],
  }
}

export function buildToolRuntimeContext(params: {
  browserController: BrowserController | null
  sidecarManager: SidecarManager | null
  runtime: AgentControlRuntime | null
  scope?: ConversationScope
  allowedToolNames?: Set<string> | string[] | null
  emitToolAction: (tool: string, args: Record<string, unknown>) => void
  requestModuleToolAction?: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  abortSignal: AbortSignal
  sessionId?: string
  scopeId?: string
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  taskProjectionId?: string
  frameSkillId?: string | null
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
  agentContext?: AgentSpawnContext | null
  turnFeatureFlags?: TurnFeatureFlags
  /**
   * Phase 3 — initial active-frame snapshot. When the caller has a
   * TurnFrame snapshot to seed the slot from (active artifact roots,
   * latest run contract, discovered handles), pass it here. When omitted
   * (cold path / legacy callers), an empty default is used so the slot
   * is never undefined.
   */
  activeFrame?: ToolRuntimeActiveFrameContext | null
  /**
   * Stage 4 W3 — per-turn skill tool authorization. Required: every
   * caller must compute a determinate authorization (Stage 10 retired
   * the `'not_set'` back-compat shortcut).
   */
  authorization: SkillToolAuthorization
}): ToolRuntimeContext {
  const scopeId = params.scopeId || params.scope?.id || params.sessionId
  return {
    browserController: params.browserController,
    sidecarManager: params.sidecarManager,
    runtime: params.runtime,
    scope: params.scope,
    allowedToolNames: params.allowedToolNames || null,
    emitToolAction: params.emitToolAction,
    requestModuleToolAction: params.requestModuleToolAction,
    abortSignal: params.abortSignal,
    sessionId: params.sessionId,
    scopeId,
    runId: params.runId,
    taskId: params.taskId,
    parentTaskId: params.parentTaskId,
    parentStepId: params.parentStepId,
    taskProjectionId: params.taskProjectionId,
    frameSkillId: params.frameSkillId ?? null,
    registerRunCleanup: params.registerRunCleanup,
    agentContext: params.agentContext ?? null,
    turnFeatureFlags: params.turnFeatureFlags ?? snapshotTurnFeatureFlags(),
    activeFrame: params.activeFrame ?? createEmptyActiveFrameContext(),
    authorization: params.authorization,
  }
}

export function toToolExecutorContext(context: ToolRuntimeContext): ToolContext {
  return {
    browserController: context.browserController,
    sidecarManager: context.sidecarManager,
    runtime: context.runtime,
    scope: context.scope,
    allowedToolNames: context.allowedToolNames || null,
    emitToolAction: context.emitToolAction,
    requestModuleToolAction: context.requestModuleToolAction,
    abortSignal: context.abortSignal,
    sessionId: context.sessionId,
    scopeId: context.scopeId || context.scope?.id || context.sessionId,
    runId: context.runId,
    taskId: context.taskId,
    parentTaskId: context.parentTaskId,
    parentStepId: context.parentStepId,
    taskProjectionId: context.taskProjectionId,
    frameSkillId: context.frameSkillId ?? null,
    registerRunCleanup: context.registerRunCleanup,
    agentContext: context.agentContext ?? null,
    turnFeatureFlags: context.turnFeatureFlags,
    // Phase 3 — forward the live active-frame slot so dispatched tools
    // (skills-tools.ts read-artifact, etc.) can read fresh artifact roots.
    activeFrame: context.activeFrame ?? createEmptyActiveFrameContext(),
    // Stage 4 W3 — forward the per-turn skill tool authorization so
    // tool-executor admission can enforce it for model-issued skill_*
    // tool calls.
    authorization: context.authorization,
  }
}
