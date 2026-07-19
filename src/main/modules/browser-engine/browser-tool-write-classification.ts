import {
  BROWSER_CAPABILITY_REGISTRY,
  BROWSER_PUBLIC_TOOL_NAMES,
  browserOperationCapability,
  resolveBrowserCapability,
  type BrowserPublicToolName,
} from '../../../shared/browser-capability-registry'

export type BrowserToolEffect = 'read' | 'control' | 'write'

/**
 * Compatibility adapter for existing lease callers. All classification comes
 * from the canonical operation registry; unknown tools or operation variants
 * fail loudly instead of silently acquiring a write lease.
 */
export function classifyBrowserToolCall(
  toolName: string,
  args: Record<string, unknown> = {},
): BrowserToolEffect {
  const capability = resolveBrowserCapability(toolName, args)
  if (!capability) throw new Error(`browser_operation_not_registered:${toolName}`)
  return capability.mode === 'mutate'
    ? 'write'
    : capability.mode === 'control'
      ? 'control'
      : 'read'
}

export function isClassifiedBrowserTool(toolName: string): toolName is BrowserPublicToolName {
  return Object.prototype.hasOwnProperty.call(BROWSER_CAPABILITY_REGISTRY, toolName)
}

const ALWAYS_READ = new Set<BrowserPublicToolName>()
const ALWAYS_CONTROL = new Set<BrowserPublicToolName>()
const ALWAYS_WRITE = new Set<BrowserPublicToolName>()
const CONDITIONAL: Record<string, (args: Record<string, unknown>) => BrowserToolEffect> = {}

for (const toolName of BROWSER_PUBLIC_TOOL_NAMES) {
  const entry = BROWSER_CAPABILITY_REGISTRY[toolName]
  const effects = new Set(entry.operations.map((operationId) => (
    browserOperationCapability(operationId).mode === 'mutate'
      ? 'write'
      : browserOperationCapability(operationId).mode === 'control'
        ? 'control'
        : 'read'
  )))
  if (effects.size === 1) {
    const effect = effects.values().next().value as BrowserToolEffect
    ;(effect === 'read' ? ALWAYS_READ : effect === 'control' ? ALWAYS_CONTROL : ALWAYS_WRITE).add(toolName)
  } else {
    CONDITIONAL[toolName] = (args) => classifyBrowserToolCall(toolName, args)
  }
}

export const BROWSER_TOOL_WRITE_CLASSIFICATION = Object.freeze({
  alwaysRead: ALWAYS_READ,
  alwaysControl: ALWAYS_CONTROL,
  alwaysWrite: ALWAYS_WRITE,
  conditional: Object.freeze(CONDITIONAL),
})
