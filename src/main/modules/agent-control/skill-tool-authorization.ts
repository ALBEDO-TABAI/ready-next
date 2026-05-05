/**
 * Stage 4 W3 — explicit per-turn skill tool authorization.
 *
 * Three-layer separation (per v6 plan §1):
 *
 *   - `SkillTurnIdentity` decides what skill (if any) the turn intends.
 *   - `SkillToolAuthorization` (this module) controls (a) the model's
 *     visible tool list, (b) `tool-executor` admission for skill_* tools,
 *     and (c) primitive `skillId` resolution.
 *   - The registry / schema layer continues to represent the real tool
 *     world. `resolveSkillToolDefinitionForExecution` and
 *     `resolveToolInputSchemaForExecution` are NEVER affected by
 *     authorization — that would break the `tool-executor.ts:114-118`
 *     contract that distinguishes `tool_not_registered` (fabricated
 *     name) from `authorization_denied` (real tool, not allowed this
 *     turn).
 *
 * Default value: `{ mode: 'none', reason: 'not_set' }`. Callers that
 * have not been migrated to compute authorization (W3b cutover) leave
 * the field at this default; admission treats `'not_set'` as a
 * back-compat short-circuit and skips the authorization check entirely.
 * Once W3b switches `turn-engine` and `ToolPolicy` to populate real
 * authorization, the default is no longer reached for model-driven
 * turns and `authorization_denied` becomes the live cutover.
 *
 * Child-runner / host invokers (`invoker !== 'model'`) bypass
 * authorization regardless of mode — admission only enforces
 * authorization for model-issued tool calls. Child-internal tools have
 * their own admission gate at `tool-executor.ts:131-151`.
 */

export type SkillToolAuthorizationSource = 'explicit' | 'trusted_resume' | 'active_task'

export type SkillToolAuthorization =
  | {
      readonly mode: 'none'
      /**
       * `'not_set'` — caller has not been migrated yet. Admission skips.
       * Any other reason — caller intentionally denied skill access for
       * this turn (e.g. weather question with no skill mention).
       */
      readonly reason: 'not_set' | 'no_skill_signal' | 'turn_not_skill_resume' | 'config_repair_no_recoverable_task'
    }
  | {
      readonly mode: 'selected'
      readonly skillId: string
      readonly allowedTypedActions: ReadonlySet<string>
      readonly allowedPrimitives: ReadonlySet<string>
      readonly source: SkillToolAuthorizationSource
      readonly reason: string
    }

/**
 * Pre-built default value used by every layer that hasn't been migrated
 * to populate authorization yet. Keep this as a single shared frozen
 * value so admission can detect it via reference identity OR by checking
 * `mode === 'none' && reason === 'not_set'` (both are equivalent).
 */
export const SKILL_TOOL_AUTHORIZATION_NOT_SET: SkillToolAuthorization = Object.freeze({
  mode: 'none',
  reason: 'not_set',
})

/**
 * Build a `mode: 'selected'` authorization. The caller is responsible
 * for passing pre-validated typed-action / primitive name sets — this
 * factory does NOT consult any registry; it only freezes the inputs.
 */
export function buildSelectedSkillToolAuthorization(params: {
  skillId: string
  allowedTypedActions: Iterable<string>
  allowedPrimitives: Iterable<string>
  source: SkillToolAuthorizationSource
  reason: string
}): SkillToolAuthorization {
  return Object.freeze({
    mode: 'selected',
    skillId: params.skillId,
    allowedTypedActions: new Set(params.allowedTypedActions),
    allowedPrimitives: new Set(params.allowedPrimitives),
    source: params.source,
    reason: params.reason,
  }) as SkillToolAuthorization
}

/**
 * Build a `mode: 'none'` authorization with an explicit reason. Use
 * this when the caller has computed identity and concluded the turn
 * does not select a skill — distinct from the `'not_set'` default.
 */
export function buildExplicitNoSkillAuthorization(
  reason: Exclude<
    Extract<SkillToolAuthorization, { mode: 'none' }>['reason'],
    'not_set'
  >,
): SkillToolAuthorization {
  return Object.freeze({
    mode: 'none',
    reason,
  }) as SkillToolAuthorization
}

/**
 * Authorization-driven admission decision for a single tool name. Only
 * called by `tool-executor` for `invoker === 'model'` skill_* tools.
 * Returns `null` when admission passes; returns a denial reason when
 * the model is not authorized for this tool this turn.
 *
 * Default `'not_set'` short-circuits to pass — back-compat until W3b
 * cutover wires authorization through `ToolPolicy`.
 */
export function checkSkillToolAuthorization(
  toolName: string,
  authorization: SkillToolAuthorization,
  isPrimitive: boolean,
): { allowed: true } | { allowed: false; reason: string } {
  if (authorization.mode === 'none') {
    if (authorization.reason === 'not_set') return { allowed: true }
    return { allowed: false, reason: authorization.reason }
  }
  // mode === 'selected'
  const allowed = isPrimitive
    ? authorization.allowedPrimitives.has(toolName)
    : authorization.allowedTypedActions.has(toolName)
  if (allowed) return { allowed: true }
  return {
    allowed: false,
    reason: isPrimitive ? 'tool_not_in_allowed_primitives' : 'tool_not_in_allowed_typed_actions',
  }
}
