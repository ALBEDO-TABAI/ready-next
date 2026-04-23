/**
 * Pure module (no electron imports) for building the two pre-dispatch error
 * messages the tool executor layer returns:
 *
 *   1. "Unknown tool" — the tool name isn't in the gateway's registry. Either
 *      the model fabricated it, or the manifest that declared it isn't loaded.
 *      The model must either switch tools or admit it doesn't exist.
 *
 *   2. "Tool not allowed in current context" — the tool IS registered, but the
 *      current run's allowedToolNames doesn't include it. The model should use
 *      one of the available same-prefix tools, not retry the same call.
 *
 * Before: both cases returned the same "Tool not allowed" message, which gave
 * the model no signal to distinguish "doesn't exist" from "exists but gated."
 * The model's common failure mode was to explain the gate away with a fabricated
 * "skill tools are restricted in current context" excuse.
 */

export type AllowedToolsInput = Set<string> | string[] | null | undefined

export function normalizeAllowedToolSet(value: AllowedToolsInput): Set<string> | null {
  if (value instanceof Set) return value
  if (Array.isArray(value)) return new Set(value)
  return null
}

export function buildUnknownToolMessage(toolName: string): string {
  return `Unknown tool: ${toolName}. This tool is not registered in the current runtime.`
}

export function buildToolNotAllowedMessage(
  toolName: string,
  allowedToolNames: Set<string>,
): string {
  const prefix = deriveToolPrefix(toolName)
  const samePrefix = [...allowedToolNames]
    .filter((name) => deriveToolPrefix(name) === prefix)
    .slice(0, 12)
  const hintPart = samePrefix.length > 0
    ? `\nAvailable ${prefix || 'tools'} this turn: ${samePrefix.join(', ')}`
    : ''
  return `Tool not allowed in current context: ${toolName}.${hintPart}`
}

function deriveToolPrefix(toolName: string): string {
  const idx = toolName.indexOf('_')
  return idx > 0 ? toolName.slice(0, idx) : ''
}
