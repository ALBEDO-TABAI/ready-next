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
 * Stage 10 (P) — every model-visible call site supplies an explicit
 * `SkillToolAuthorization`. The reason union encodes either a selected
 * skill or one of three explicit no-skill reasons; there is no
 * implicit-skip default. Child-runner / host invokers
 * (`invoker !== 'model'`) continue to bypass authorization regardless of
 * mode — admission only enforces authorization for model-issued tool
 * calls. Child-internal tools have their own admission gate at
 * `tool-executor.ts:131-151`.
 */

export type SkillToolAuthorizationSource = 'explicit' | 'trusted_resume' | 'active_task'

export type SkillToolAuthorization =
  | {
      readonly mode: 'none'
      /**
       * Caller intentionally denied skill access for this turn (e.g.
       * weather question with no skill mention, or a non-resume turn
       * after identity concluded no recoverable task exists).
       */
      readonly reason: 'no_skill_signal' | 'turn_not_skill_resume' | 'config_repair_no_recoverable_task'
      /**
       * Optional additive candidate primitives. These are available methods,
       * not a selected exclusive skill. Dispatch still binds them to the
       * named skill's allowlist and existing confirmation rules.
       */
      readonly candidateSkillPrimitives?: Readonly<{
        skillId: string
        primitives: readonly string[]
      }>
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
 * Stage 10 final-review tightening — the type already declares
 * `ReadonlySet<string>` for `allowedTypedActions` / `allowedPrimitives`,
 * but `Object.freeze` on the authorization does NOT prevent mutation of
 * the underlying Set. A contributor could `as unknown as Set<string>`
 * past the type and silently expand the allow-set at runtime, broadening
 * authorization without it appearing in any policy decision.
 *
 * Returning a real `Set` with overridden mutators is insufficient because
 * `Set.prototype.add.call(set, 'x')` would still mutate it (the prototype
 * method bypasses own-property overrides). To truly prevent mutation we
 * return a closure-backed facade that satisfies `ReadonlySet<T>` but is
 * NOT a Set instance — calling `Set.prototype.add` on it throws because
 * the receiver lacks Set internal slots.
 */
function freezeSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const internal = new Set(values)
  // Closure-backed facade. Object.freeze + `as ReadonlySet<T>` gives a
  // type-correct immutable view; `Set.prototype.<mutator>.call(facade, ...)`
  // throws TypeError "Method Set.prototype.<mutator> called on incompatible
  // receiver" because the facade is a plain object, not a Set instance.
  const facade = Object.freeze({
    get size(): number { return internal.size },
    has: (value: T): boolean => internal.has(value),
    forEach: (
      callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
      thisArg?: unknown,
    ): void => {
      internal.forEach((value, key) => {
        callbackfn.call(thisArg, value, key, facade as ReadonlySet<T>)
      })
    },
    entries: (): IterableIterator<[T, T]> => internal.entries(),
    keys: (): IterableIterator<T> => internal.keys(),
    values: (): IterableIterator<T> => internal.values(),
    [Symbol.iterator]: (): IterableIterator<T> => internal[Symbol.iterator](),
  })
  return facade as ReadonlySet<T>
}

/**
 * Build a `mode: 'selected'` authorization. The caller is responsible
 * for passing pre-validated typed-action / primitive name sets — this
 * factory does NOT consult any registry; it only freezes the inputs.
 *
 * The returned authorization is `Object.freeze`'d, AND the underlying
 * `allowedTypedActions` / `allowedPrimitives` Sets are wrapped in
 * `freezeSet` so their mutator methods throw — see `freezeSet` doc-comment.
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
    allowedTypedActions: freezeSet(params.allowedTypedActions),
    allowedPrimitives: freezeSet(params.allowedPrimitives),
    source: params.source,
    reason: params.reason,
  }) as SkillToolAuthorization
}

/**
 * Build a `mode: 'none'` authorization with an explicit reason. Use
 * this when the caller has computed identity and concluded the turn
 * does not select a skill.
 */
export function buildExplicitNoSkillAuthorization(
  reason: Extract<SkillToolAuthorization, { mode: 'none' }>['reason'],
  extras?: {
    candidateSkillPrimitives?: {
      skillId: string
      primitives: readonly string[]
    }
  },
): SkillToolAuthorization {
  return Object.freeze({
    mode: 'none',
    reason,
    ...(extras?.candidateSkillPrimitives
      ? {
          candidateSkillPrimitives: Object.freeze({
            skillId: extras.candidateSkillPrimitives.skillId,
            primitives: Object.freeze([...extras.candidateSkillPrimitives.primitives]),
          }),
        }
      : {}),
  }) as SkillToolAuthorization
}

/**
 * Stage 4 W3b — derive authorization from a `SkillTurnIdentity` (the
 * pure-read decision computed by `resolveSkillTurnIdentity`).
 *
 * Mapping:
 *   - `identity.mode === 'skill'` → `mode:'selected'` with skillId,
 *     allowedTypedActions (from `preferredSkillToolNames`), and
 *     allowedPrimitives (the full primitive set when a skill is
 *     selected — primitive admission is bounded by skill selection,
 *     not by individual primitive allowlisting).
 *   - `identity.mode === 'none'` → `mode:'none'` with the corresponding
 *     reason.
 *
 * `identity.source` maps to `authorization.source`:
 *   - 'explicit_user_mention' → 'explicit'
 *   - 'run_state_resource' → 'trusted_resume'
 *   - other (lookback / hint / history) → 'active_task'
 */
export function buildAuthorizationFromIdentity(
  identity:
    | { mode: 'skill'; skillId: string; source: string }
    | { mode: 'none'; reason: string },
  options: {
    preferredSkillToolNames: ReadonlyArray<string>
    allPrimitiveToolNames: ReadonlyArray<string>
  },
): SkillToolAuthorization {
  if (identity.mode === 'none') {
    const reason = identity.reason
    if (
      reason === 'no_skill_signal'
      || reason === 'turn_not_skill_resume'
      || reason === 'config_repair_no_recoverable_task'
    ) {
      return buildExplicitNoSkillAuthorization(reason)
    }
    // Unknown identity reason — fall back to a neutral explicit no-skill
    // (still denies, but with a generic reason).
    return buildExplicitNoSkillAuthorization('no_skill_signal')
  }
  const source: SkillToolAuthorizationSource =
    identity.source === 'explicit_user_mention'
      ? 'explicit'
      : identity.source === 'run_state_resource'
        ? 'trusted_resume'
        : 'active_task'
  return buildSelectedSkillToolAuthorization({
    skillId: identity.skillId,
    allowedTypedActions: options.preferredSkillToolNames,
    allowedPrimitives: options.allPrimitiveToolNames,
    source,
    reason: identity.source,
  })
}

/**
 * Stage 4 W3b.2 — filter a tool list (defs / schemas) by authorization.
 * Applied at the registry's 4 model-visible list resolvers as
 * defense-in-depth: ToolPolicy already filters typed actions via
 * `preferredSkillToolNames`, and this filter also strips primitives in
 * `mode:'none'` turns so the legacy session prefilter cannot open primitives
 * by itself.
 *
 * Semantics:
 *   - `mode:'none'` (any reason) → strip ALL skill_* tools
 *   - `mode:'selected'` → keep skill_* tools whose name is in
 *     `allowedTypedActions ∪ allowedPrimitives`; non-skill tools pass
 *     through unchanged (authorization is skill-scoped)
 *
 * The `getName` callback adapts to both ToolDefinition shape (`tool.name`)
 * and OpenAI tool schema shape (`tool.function.name`).
 */
export function filterToolsByAuthorization<T>(
  tools: ReadonlyArray<T>,
  authorization: SkillToolAuthorization,
  getName: (tool: T) => string | null,
): T[] {
  if (authorization.mode === 'none') {
    const candidate = authorization.candidateSkillPrimitives
    return tools.filter((tool) => {
      const name = getName(tool)
      if (!name || !name.startsWith('skill_')) return true
      return Boolean(candidate && candidate.primitives.includes(name))
    })
  }
  // mode === 'selected'
  return tools.filter((tool) => {
    const name = getName(tool)
    if (!name) return true
    if (!name.startsWith('skill_')) return true
    return authorization.allowedTypedActions.has(name) || authorization.allowedPrimitives.has(name)
  })
}

/**
 * Authorization-driven admission decision for a single tool name. Only
 * called by `tool-executor` for `invoker === 'model'` skill_* tools.
 * Returns `null` when admission passes; returns a denial reason when
 * the model is not authorized for this tool this turn.
 */
export function checkSkillToolAuthorization(
  toolName: string,
  authorization: SkillToolAuthorization,
  isPrimitive: boolean,
): { allowed: true } | { allowed: false; reason: string } {
  if (authorization.mode === 'none') {
    if (
      isPrimitive
      && authorization.candidateSkillPrimitives
      && authorization.candidateSkillPrimitives.primitives.includes(toolName)
    ) {
      return { allowed: true }
    }
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
