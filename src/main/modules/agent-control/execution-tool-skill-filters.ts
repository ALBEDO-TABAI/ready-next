/**
 * Stage 4 W3b.3 — 4 skill filter helpers used by `ToolPolicy.getPolicy*`.
 *
 * `preferredSkillToolNames` remains the primary filter source — it's
 * what turn-engine computes per-turn from `buildPreferredSkillToolNames`.
 * The `authorization` parameter is the W3b.3 cutover: the filter also
 * enforces it (defense-in-depth alongside the W3b.2 registry-layer
 * filter — if a name slips past one layer it gets caught at the other).
 * Stage 10 makes this authorization required; callers that do not have a
 * selected skill must pass `buildExplicitNoSkillAuthorization(...)`.
 *
 * Behavior summary for the filter helpers (`filterPreferredSkill*Tools`):
 *   - `authorization.mode==='none'` (any reason) → strip ALL skill_*
 *     (overrides preferredSkillToolNames; identity says no skill applies)
 *   - `authorization.mode==='selected'` → keep skill_* only if name is in
 *     `allowedTypedActions ∪ allowedPrimitives` AND in
 *     `preferredSkillToolNames` (intersection — the more restrictive one)
 *
 * For `mergeForceDocumentAllowedNames`: when authorization is mode:none,
 * skill names from `preferredSkillToolNames` are NOT merged into the
 * forced-document allowlist (they shouldn't be reachable that turn). When
 * mode:selected, only authorized skill names merge.
 *
 * `isSkillToolName` is a pure name-shape check; authorization is not
 * relevant.
 */
import type { SkillToolAuthorization } from './skill-tool-authorization'

export function isSkillToolName(name: string): boolean {
  return name.startsWith('skill_') || name === 'system_run_embedded_python'
}

function isSkillNameAuthorizedInAuthorization(
  name: string,
  authorization: SkillToolAuthorization,
): boolean {
  if (authorization.mode === 'none') {
    return false
  }
  return authorization.allowedTypedActions.has(name)
    || authorization.allowedPrimitives.has(name)
}

export function filterPreferredSkillAnthropicTools(
  tools: Array<Record<string, unknown>>,
  preferredSkillToolNames: string[],
  authorization: SkillToolAuthorization,
): Array<Record<string, unknown>> {
  const allowed = new Set(preferredSkillToolNames)
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name : ''
    if (!isSkillToolName(name)) return true
    if (!allowed.has(name)) return false
    return isSkillNameAuthorizedInAuthorization(name, authorization)
  })
}

export function filterPreferredSkillOpenAITools(
  tools: Array<Record<string, unknown>>,
  preferredSkillToolNames: string[],
  authorization: SkillToolAuthorization,
): Array<Record<string, unknown>> {
  const allowed = new Set(preferredSkillToolNames)
  return tools.filter((tool) => {
    const fn = (tool.function as { name?: unknown } | undefined)?.name
    if (typeof fn !== 'string') return false
    if (!isSkillToolName(fn)) return true
    if (!allowed.has(fn)) return false
    return isSkillNameAuthorizedInAuthorization(fn, authorization)
  })
}

export function mergeForceDocumentAllowedNames(
  baseAllowed: Set<string>,
  preferredSkillToolNames: string[] | null | undefined,
  authorization: SkillToolAuthorization,
): Set<string> {
  if (!preferredSkillToolNames || preferredSkillToolNames.length === 0) return baseAllowed
  const filteredSkillNames = preferredSkillToolNames.filter(
    (name) => isSkillNameAuthorizedInAuthorization(name, authorization),
  )
  if (filteredSkillNames.length === 0) return baseAllowed
  return new Set<string>([...baseAllowed, ...filteredSkillNames])
}
