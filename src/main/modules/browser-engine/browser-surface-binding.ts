import {
  agentBrowserError,
  type AgentBrowserStructuredError,
  type AgentBrowserSurface,
} from './agent-browser-errors'
import {
  classifyBrowserToolCall,
  type BrowserToolEffect,
} from './browser-tool-write-classification'
import { resolveBrowserCapability } from '../../../shared/browser-capability-registry'

export type BrowserSurfaceIntent =
  | 'user-view-assisted'
  | 'agent-view-background'
  | 'agent-view-foreground'
  | 'read-only-observe'
  | 'control-no-page-write'
  | 'workflow-transport'

export type BrowserSurfaceDispatch =
  | 'tool-executor'
  | 'scoped-facade'

export interface BrowserToolSurfaceBinding {
  toolName: string
  effect: BrowserToolEffect
  intent: BrowserSurfaceIntent
  engineSurface: AgentBrowserSurface | null
  backgroundHandoff: boolean
  requiresTurnLease: boolean
}

export type BrowserToolSurfaceBindingResult =
  | { ok: true; binding: BrowserToolSurfaceBinding }
  | { ok: false; error: AgentBrowserStructuredError }

function binding(params: {
  toolName: string
  effect: BrowserToolEffect
  intent: BrowserSurfaceIntent
  engineSurface: AgentBrowserSurface | null
  backgroundHandoff?: boolean
  requiresTurnLease?: boolean
}): BrowserToolSurfaceBindingResult {
  return {
    ok: true,
    binding: {
      toolName: params.toolName,
      effect: params.effect,
      intent: params.intent,
      engineSurface: params.engineSurface,
      backgroundHandoff: params.backgroundHandoff === true,
      requiresTurnLease: params.requiresTurnLease === true,
    },
  }
}

export function resolveBrowserToolSurfaceBinding(params: {
  toolName: string
  args?: Record<string, unknown>
  dispatch: BrowserSurfaceDispatch
  hasTurnLease?: boolean
  scopedSurface?: AgentBrowserSurface
  agentTabId?: string | null
}): BrowserToolSurfaceBindingResult {
  const args = params.args ?? {}
  const effect = classifyBrowserToolCall(params.toolName, args)
  const capability = resolveBrowserCapability(params.toolName, args)
  if (!capability?.requiresPageLease) {
    return binding({
      toolName: params.toolName,
      effect,
      intent: effect === 'write'
        ? 'workflow-transport'
        : effect === 'control' ? 'control-no-page-write' : 'read-only-observe',
      engineSurface: null,
    })
  }

  if (params.dispatch === 'scoped-facade') {
    const surface = params.scopedSurface ?? 'agent-view'
    if (surface === 'agent-view' && !String(params.agentTabId || '').trim()) {
      return {
        ok: false,
        error: agentBrowserError(
          'browser_surface_binding_violation',
          'agent-view background browser writes require an agent tab binding.',
          { tool: params.toolName, dispatch: params.dispatch, intent: 'agent-view-background' },
        ),
      }
    }
    return binding({
      toolName: params.toolName,
      effect,
      intent: surface === 'agent-view' ? 'agent-view-background' : 'user-view-assisted',
      engineSurface: surface,
      requiresTurnLease: false,
    })
  }

  if (!params.hasTurnLease) {
    return {
      ok: false,
      error: agentBrowserError(
        'browser_surface_undeclared',
        'Agent browser write reached dispatch without a code-derived browser surface binding.',
        { tool: params.toolName, dispatch: params.dispatch },
      ),
    }
  }

  const intent: BrowserSurfaceIntent = params.toolName === 'browser_research'
    ? 'agent-view-foreground'
    : 'user-view-assisted'
  return binding({
    toolName: params.toolName,
    effect,
    intent,
    engineSurface: intent === 'agent-view-foreground' ? 'agent-view' : 'user-view',
    backgroundHandoff: false,
    requiresTurnLease: true,
  })
}
