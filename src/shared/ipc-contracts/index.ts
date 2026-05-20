/**
 * Stage U PR U4.1 — IPC wire-contract barrel (skeleton).
 *
 * Audit §1.4 / plan §5 — `src/main/modules/agent-control/run-contracts.ts`
 * grew into a 1814-line god-file holding 65+ exports mixing wire-shape
 * types (renderer consumes via preload) with main-internal types
 * (TurnEngineSession, SkillRunContract, etc.). U4.1 bisects them:
 *
 *   - WIRE  →  `src/shared/ipc-contracts/`  (this directory)
 *   - INTERNAL  →  `src/main/modules/agent-control/run-contracts-internal.ts`
 *
 * U4.1a (this PR) establishes the skeleton:
 *   - Creates the `src/shared/ipc-contracts/` directory + this barrel
 *   - Creates an empty `run-contracts-internal.ts` slot for the
 *     subsequent migration PRs
 *   - Annotates every export in `run-contracts.ts` with `// WIRE` or
 *     `// INTERNAL` at the declaration site
 *   - Publishes the full classification table at
 *     `docs/superpowers/plans/U4.1-run-contracts-export-classification.md`
 *
 * NO actual migration happens in U4.1a (zero behavior risk). The
 * `check-wire-contract-isolation.cjs` gate is registered but starts in
 * U4.1d, after the wire types are physically located here.
 *
 * Audit shows the actual cross-process surface is narrower than the
 * plan originally feared: only 2 types in run-contracts.ts are truly
 * renderer-facing (TaskProjectionRecord + TaskProjectionChangeEvent).
 * `ScopeRunSummary` lives in `types.ts` and is wire-facing too but is
 * out of scope for U4.1 (a separate PR can fold it in later).
 *
 * Re-exports below land in U4.1b–c as the types physically move here.
 */

export {}
