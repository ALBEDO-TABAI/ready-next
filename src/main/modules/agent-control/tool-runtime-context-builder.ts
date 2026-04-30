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
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'

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
  /**
   * Phase 3 — initial active-frame snapshot. When the caller has a
   * TurnFrame snapshot to seed the slot from (active artifact roots,
   * latest run contract, discovered handles), pass it here. When omitted
   * (cold path / legacy callers), an empty default is used so the slot
   * is never undefined.
   */
  activeFrame?: ToolRuntimeActiveFrameContext | null
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
    activeFrame: params.activeFrame ?? createEmptyActiveFrameContext(),
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
    // Phase 3 — forward the live active-frame slot so dispatched tools
    // (skills-tools.ts read-artifact, etc.) can read fresh artifact roots.
    activeFrame: context.activeFrame ?? createEmptyActiveFrameContext(),
  }
}
