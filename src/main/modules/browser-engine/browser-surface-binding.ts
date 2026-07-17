import {
  agentBrowserError,
  type AgentBrowserStructuredError,
  type AgentBrowserSurface,
} from './agent-browser-errors'
import {
  classifyBrowserToolCall,
  type BrowserToolEffect,
} from './browser-tool-write-classification'

export type BrowserSurfaceIntent =
  | 'user-view-assisted'
  | 'agent-view-background'
  | 'agent-view-foreground'
  | 'read-only-observe'

export type BrowserSurfaceDispatch =
  | 'tool-executor'
  | 'browser-agent-runner'
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

export function isBrowserBackgroundHandoffTool(
  toolName: string,
  args: Record<string, unknown> = {},
): boolean {
  if (toolName === 'browser_collect') {
    return ['visible', 'notes', 'research', 'start'].includes(String(args.mode || 'visible'))
  }
  return toolName === 'browser_task' && String(args.action || 'get') === 'resume'
}

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
  hasRunnerLeaseGate?: boolean
  boundSurface?: AgentBrowserSurface
  scopedSurface?: AgentBrowserSurface
  agentTabId?: string | null
}): BrowserToolSurfaceBindingResult {
  const args = params.args ?? {}
  const effect = classifyBrowserToolCall(params.toolName, args)
  if (effect === 'read') {
    return binding({
      toolName: params.toolName,
      effect,
      intent: 'read-only-observe',
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

  if (params.dispatch === 'browser-agent-runner') {
    const surface = params.boundSurface ?? 'user-view'
    if (!params.hasRunnerLeaseGate) {
      return {
        ok: false,
        error: agentBrowserError(
          'browser_surface_undeclared',
          'Deterministic browser workflow write reached dispatch without its lane lease gate.',
          {
            tool: params.toolName,
            dispatch: params.dispatch,
            intent: surface === 'agent-view' ? 'agent-view-foreground' : 'user-view-assisted',
          },
        ),
      }
    }
    if (surface === 'agent-view' && !String(params.agentTabId || '').trim()) {
      return {
        ok: false,
        error: agentBrowserError(
          'browser_surface_binding_violation',
          'Agent-lane browser workflow writes require a bound agent tab.',
          { tool: params.toolName, dispatch: params.dispatch, intent: 'agent-view-foreground' },
        ),
      }
    }
    return binding({
      toolName: params.toolName,
      effect,
      intent: surface === 'agent-view' ? 'agent-view-foreground' : 'user-view-assisted',
      engineSurface: surface,
      requiresTurnLease: true,
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

  const backgroundHandoff = isBrowserBackgroundHandoffTool(params.toolName, args)
  const intent: BrowserSurfaceIntent = params.toolName === 'browser_collect' && String(args.mode || 'visible') === 'notes'
    ? 'agent-view-background'
    : 'user-view-assisted'
  return binding({
    toolName: params.toolName,
    effect,
    intent,
    engineSurface: intent === 'agent-view-background' ? 'agent-view' : 'user-view',
    backgroundHandoff,
    requiresTurnLease: true,
  })
}
