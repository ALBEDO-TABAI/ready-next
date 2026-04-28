import type { BrowserController } from '../browser-engine/ipc-handler'
import type { SidecarManager } from './sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ConversationScope } from './types'
import type { ToolContext } from '../tools/tool-executor'
import type { ToolRuntimeContext } from './tool-runtime'
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
  registerRunCleanup?: (cleanup: () => void | Promise<void>) => void
  agentContext?: AgentSpawnContext | null
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
    registerRunCleanup: params.registerRunCleanup,
    agentContext: params.agentContext ?? null,
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
    registerRunCleanup: context.registerRunCleanup,
    agentContext: context.agentContext ?? null,
  }
}
