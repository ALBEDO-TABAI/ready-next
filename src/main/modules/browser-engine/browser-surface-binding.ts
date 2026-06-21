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

const BACKGROUND_HANDOFF_TOOLS = new Set([
  'browser_visible_collect',
  'browser_collect_notes',
  'browser_resume_task',
])

export function isBrowserBackgroundHandoffTool(toolName: string): boolean {
  return BACKGROUND_HANDOFF_TOOLS.has(toolName)
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
    if (!params.hasRunnerLeaseGate) {
      return {
        ok: false,
        error: agentBrowserError(
          'browser_surface_undeclared',
          'Deterministic browser workflow write reached dispatch without its user-view lease gate.',
          { tool: params.toolName, dispatch: params.dispatch, intent: 'user-view-assisted' },
        ),
      }
    }
    return binding({
      toolName: params.toolName,
      effect,
      intent: 'user-view-assisted',
      engineSurface: 'user-view',
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

  const backgroundHandoff = isBrowserBackgroundHandoffTool(params.toolName)
  const intent: BrowserSurfaceIntent = params.toolName === 'browser_collect_notes'
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
