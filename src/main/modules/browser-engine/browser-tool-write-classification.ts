import {
  BROWSER_TOOL_SURFACE_MANIFEST,
  browserToolSurfaceEntry,
} from '../../../shared/browser-tool-surface'

export type BrowserToolEffect = 'read' | 'write'

const CONDITIONAL: Record<string, (args: Record<string, unknown>) => BrowserToolEffect> = {
  browser_tabs: (args) => String(args.action || 'list') === 'list' ? 'read' : 'write',
  browser_task: (args) => ['get', 'result'].includes(String(args.action || 'get')) ? 'read' : 'write',
  browser_dialog: (args) => String(args.action || 'get') === 'get' ? 'read' : 'write',
  browser_console: (args) => String(args.action || 'list') === 'list' ? 'read' : 'write',
  browser_network: (args) => ['list', 'details'].includes(String(args.action || 'list')) ? 'read' : 'write',
  browser_resources: (args) => typeof args.url === 'string' && args.url.trim().length > 0 ? 'write' : 'read',
  browser_session: (args) => String(args.action || 'status') === 'status' ? 'read' : 'write',
  browser_permission: (args) => String(args.action || 'status') === 'status' ? 'read' : 'write',
}

const ALWAYS_READ = new Set(
  BROWSER_TOOL_SURFACE_MANIFEST
    .filter((entry) => entry.defaultAccess === 'read' && !CONDITIONAL[entry.name])
    .map((entry) => entry.name),
)

const ALWAYS_WRITE = new Set(
  BROWSER_TOOL_SURFACE_MANIFEST
    .filter((entry) => entry.defaultAccess === 'write' && !CONDITIONAL[entry.name])
    .map((entry) => entry.name),
)

export function classifyBrowserToolCall(
  toolName: string,
  args: Record<string, unknown> = {},
): BrowserToolEffect {
  const conditional = CONDITIONAL[toolName]
  if (conditional) return conditional(args)
  return browserToolSurfaceEntry(toolName)?.defaultAccess || 'write'
}

export function isClassifiedBrowserTool(toolName: string): boolean {
  return browserToolSurfaceEntry(toolName) !== null
}

export const BROWSER_TOOL_WRITE_CLASSIFICATION = {
  alwaysRead: ALWAYS_READ,
  alwaysWrite: ALWAYS_WRITE,
  conditional: CONDITIONAL,
}
