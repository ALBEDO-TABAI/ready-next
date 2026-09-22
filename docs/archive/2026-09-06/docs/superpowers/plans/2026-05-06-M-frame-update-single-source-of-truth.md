---
stage: M
sequence: after L (fact-ledger)
status: implemented + post-review-yellow (codex 2026-05-06)
post_implementation_notes:
  - Codex's final post-implementation review returned YELLOW with 5 findings.
    Two are addressed in-place (helper exemption tightened from file-level to
    call-site-specific; missing frame-write-single-source.test.ts added). Three
    are documented as known-lite gate limitations to be upgraded in Stage M.1
    (full @typescript-eslint/parser AST machinery + alias tracking + multi-line
    Object.assign + nested field-write detection in check-frame-write-single-
    source.cjs and check-budget-single-source.cjs). The lite gates catch the
    documented direct-mutation regression patterns; the AST upgrade closes the
    long-tail (alias names other than `contract`, multi-line writes, deeper
    nested fields).
  - Plan §3.5 listed `context-modifier-symmetry.test.ts` and the implementation
    landed it as `attach-contract-framepatch-symmetry.test.ts`. Same surface,
    clearer name. The planned M6 fallback metric was removed after post-review:
    `skill_patch_config` now reads frame context only, so Stage M does not add
    a new legacy active-context branch while retiring the read-artifact branch.
verify_target: verify:m
inherits: verify:l
enforce: false
revision_history:
  - v1 (2026-05-06): initial draft
  - v2 (2026-05-06): codex red. Fixed: missed contextModifier surface, I2 banning legitimate
    direct writes, non-existent SkillBudgetLeaseState.exhausted, cold-session breakage from
    `activeArtifactRoots: []` resolver default, I1 contradiction with kept legacy callers,
    M4-before-M5 ordering, top-level verify dropping verify:native.
  - v3 (2026-05-06): codex red on v2. Fixed: incomplete mutation inventory (added :1849
    cancel branch, :1981 Object.assign bulk write, :3983 child-resume terminal), gate
    regexes blind to Object.assign / replacement / aliased mutations and false-positive on
    local SkillRunContract assembly, terminalReason "first-write-wins" silently dropping
    real terminals after provisional checkpoint, contextModifier annotation escape hatch
    that would whitelist the existing inspect-run-state bug, applyTurnFramePatch wording
    that implied mutation, deriveSeedArtifactRoots missing dirname import, ≤25-line budget
    proximity rule (replaced with named-helper requirement).
  - v4 (2026-05-06): codex red on v3. Fixed: contextModifier inventory still incomplete
    (skill_inspect_detached / skill_start_detached / typed-action-non-VEA also emit
    framePatch.activeArtifactRoots without contextModifier — fix at the helper boundary
    `attachContractFramePatch` so all callers inherit symmetry); §3.3 budget gate would
    fail on legitimate score/fingerprint mutations (narrowed to lease creation/replacement
    and `currentLeaseEndIteration`/`hardCapIteration` only); cancel-branch `cancelled_user >
    done` audit-loss explicitly deferred to Stage M+1 with rationale; §2.5 sample now
    uses `createToolExecutionOutput` options correctly; AST alias-tracking acknowledged
    as new machinery (not reused precedent); JSON allowlist schema specified.
  - v5 (2026-05-06): codex narrow red on v4. Fixed: §2.5 attachContractFramePatch snippet
    used `merged.runContract` (Partial<SkillRunContract>) where `contextModifier.activeFrame.
    runContract` requires `SkillRunContract | null` — corrected to use the full `contract`
    local; §5 rollout had only 1 of 3 §2.5 changes assigned to a pre-fallback-removal
    PR — split M5a into M5a-helper / M5a-inspect / M5a-typed-gate (all before M4+M5);
    §3.4 incorrectly listed `buildInspectFramePatch` as a "trusted helper" — only
    `attachContractFramePatch` qualifies (it wraps the full output); for inspect-run-state
    the gate inspects the consuming `createToolExecutionOutput` call. Allowlist staleness
    rule augmented with function-name match as a recommended secondary key (line-fragility
    nuance).
  - v6 (2026-05-06): codex yellow on v5 — single finding. v5's typed-action contextModifier
    emitted only `activeArtifactRoots` while I2 promised both channels mirror `runContract`.
    v6 emits `runContract: contract ?? null` in the typed-action snippet so all 3 sites
    (helper / inspect / typed) mirror BOTH `activeArtifactRoots` AND `runContract`; gate
    §3.4 description tightened to enforce both. Wording nit: `contract` is a local const
    from `loadSkillRunContract`, not a function parameter.
  - v7 (2026-05-06): codex yellow on v6 — 2 narrow consistency nits. v6's I2 said both
    channels carry `activeArtifactRoots` + `runContract` + `discoveredHandles`, but the
    snippets / gate only mirror roots + contract; `buildContractFramePatch` emits
    `discoveredHandles` from contract handles while the new helper / inspect / typed
    snippets set `[]` or omit it. v7 explicitly narrows I2 to "roots + runContract
    symmetry only" (discoveredHandles deferred to Stage M+1, with rationale). v6's §3.4
    "when framePatch.runContract is set" was too broad and would false-flag
    `skill_patch_config`'s partial blocker update (which doesn't carry roots). v7 ties
    runContract-symmetry enforcement to sites that ALSO emit `activeArtifactRoots`.
  - v8 (2026-05-06): codex yellow on v7 — single repeating narrow finding. v7's
    `inspect-run-state` snippet still set `contextModifier.activeFrame.runContract:
    framePatch?.runContract ?? null`, but `framePatch.runContract` is
    `Partial<SkillRunContract>` (turn-frame.ts:230) and `contextModifier.activeFrame.
    runContract` requires `SkillRunContract | null` (tool-result-types.ts:19) — same
    type bug v5 fixed for `attachContractFramePatch` but not propagated to inspect.
    v8 widens `buildInspectFramePatch` return to `{ framePatch, contract: SkillRunContract |
    null }` so the wrapper receives the full contract; the contextModifier then uses
    `contract` directly. Also softens §3.4's "same reference" to "same source contract"
    per codex's wording nit (framePatch.runContract is a partial clone of the source).
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Stage M — Frame Update Only Writes Back To One Truth Source (v8)

> Stage L (commit `355421e`) settled the durable cross-process **fact ledger** (`skill_task_run_repository`). Stage M settles the **per-turn read view**: every read inside the model loop comes from the frame, every write to the frame goes through one of exactly two declared channels, with all priority and merge semantics named explicitly.

## 0. Why this stage now

After L the cross-process ledger is single-source. Within a turn there are still parallel surfaces — and v3's expanded inventory shows there are more than v1/v2 admitted:

| Surface | Current truth | Should be |
|---|---|---|
| `activeArtifactRoots` (read sandbox) | `frame.activeArtifactRoots` first; **fallback** to `resolveActiveSkillContext` (legacy advisor); **resolver seeds `[]`** even when `outputDir` is known (`turn-frame-resolver.ts:228`) | seeded resolver → frame only |
| Budget exhaustion | mid-loop `skillBudgetLeaseState` mutation **and** direct `turnFrame.budget = { …, exhausted: true }` at `turn-engine.ts:4248` | `frame.budget` updated via `framePatch.budget`; lease is producer only |
| Terminal reason | direct assignments at `turn-engine.ts:{1258, 1853, 3010, 3029, 3062, 3283, 3983, 4252}` (8 sites — v2 missed 3983) | via `framePatch.terminalReason` with **explicit priority ranking** |
| Run-contract child fields | direct mutation `contract.* = …` at `turn-engine.ts:{1834-1840, 1849-1851, 2995-2999, 3049-3053, 3966-3970}` PLUS bulk `Object.assign(turnFrame.skill.runContract, resumed.freshContractFields)` at `:1981` | via `framePatch.runContract` |
| Tool-result emitted state | `framePatch` (post-batch) **and** `contextModifier.activeFrame` (intra-batch via `applyContextModifier` in `tool-runtime.ts:121`) — but `inspect-run-state.ts:407, 660` emits framePatch only (existing bug) | both, with gate enforcement |

User-visible payoff: removing the marker `TODO(skill-child-loop): drop fallback after child-run path is stable` at `read-artifact.ts:38-42` and `skills-tools.ts:1687-1696`.

## 1. Invariants this stage establishes

I1. **The frame is the only read surface for *frame-state* data inside the model loop.**
"Frame-state data" = artifact roots, run-state derived progress, liveness, budget, terminal reason, run-contract handles. **Identity-resolution reads are explicitly NOT frame-state**: `resolvePrimitiveSkillId`, `getSkillToolDefs`, `isStaticSkillToolVisible`, `skill_run_shell` shell-allowlist resolution, `skill_start_detached` admission, `buildSkillProjectionPatch` projection patch synthesis still read `resolveActiveSkillContext`/`getLatestActiveSkillTaskRun`/`readSkillTaskProjection` because they answer "which skill / which projection" — orthogonal to "what is the skill's runtime state". Stage M does not touch those reads.

I2. **Two declared write channels into the frame, no third.**

   * **I2a (post-batch frame):** every mutation of `TurnFrame` happens by reassignment after `applyTurnFramePatch(frame, patch)` returns a *new* frame. `applyTurnFramePatch` is pure (`turn-frame.ts:468`) — it does NOT mutate. Every existing direct mutation in `turn-engine.ts` (the 8 terminalReason sites + 5 contract.* clusters + 1 Object.assign + 1 budget direct write — 15 mutation points across 11 line numbers) migrates to `framePatch.*` fields consumed by `applyTurnFramePatch`, and the call site reassigns `turnFrame = applyTurnFramePatch(turnFrame, patch)`.

   * **I2b (intra-batch context):** `ToolRuntimeContext.activeFrame` is mutated only by `applyContextModifier(context, output)`. This is the same-batch fast-path; the in-place mutation is by design (`tool-runtime.ts:138-167`).

   The two channels carry overlapping shapes. **Stage M enforces symmetry on `activeArtifactRoots` and `runContract` only.** When a tool emits `framePatch.activeArtifactRoots`, it MUST also emit `contextModifier.activeFrame.activeArtifactRoots` with matching roots. When the same tool also emits `framePatch.runContract` (i.e. the site is contract-bearing, not a partial blocker update), it MUST also emit `contextModifier.activeFrame.runContract` with the same contract reference. **`discoveredHandles` symmetry is deferred to Stage M+1** — `buildContractFramePatch` derives `framePatch.discoveredHandles` from contract handles (`run-contracts.ts:1700-1706`), but no current intra-batch reader of `context.activeFrame.discoveredHandles` would benefit from same-batch propagation; the post-batch frame merge already covers the consumers. If a future read site emerges, M+1 widens the symmetry contract.

I3. **`frame.budget` is the steering/dispatch read.**
   Steering and dispatch read `turnFrame.budget` only; `skillBudgetLeaseState.*` is consulted only by the lease controller and inside the named producer helper `produceBudgetPatch`. Exhaustion is derived from `state.budgetWarningLevel === 'exhausted'` or `state.stepBudgetState?.remainingIterations <= 0` — `SkillBudgetLeaseState` has no `exhausted` field (`run-contracts.ts:181`).

I4. **`skill_read_artifact` has no legacy active-context fallback** *after* the resolver seeds `frame.activeArtifactRoots` from every cold-session source the legacy fallback consulted. `turn-frame-resolver.ts:228` changes from `activeArtifactRoots: []` to a seeded list (see §2.1). Cold-session reads that succeed today via the legacy fallback continue to succeed; they route through the frame.

I5. **No new mode means no new truth source.** Future product modes contribute via `framePatch` / `contextModifier` only. New channels require this plan amended.

## 2. Concrete changes

### 2.1 Resolver seeding (must land first; unblocks I4)

**File: `src/main/modules/agent-control/turn-frame-resolver.ts`**

Add `import { dirname } from 'node:path'` if not present.

Add helper:

```ts
function deriveSeedArtifactRoots(args: {
  context: ActiveSkillContext | null
  runContract: SkillRunContract | null
}): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  const push = (path?: string | null) => {
    if (typeof path !== 'string') return
    const trimmed = path.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    roots.push(trimmed)
  }
  // Primary source: ActiveSkillContext (load-bearing — mirrors the legacy
  // fallback the gate at §3.2 will remove).
  if (args.context) {
    push(args.context.outputDir)
    if (args.context.runStatePath) push(dirname(args.context.runStatePath))
    if (args.context.sceneScoresPath) push(dirname(args.context.sceneScoresPath))
    if (args.context.deliveryReportPath) push(dirname(args.context.deliveryReportPath))
  }
  // Secondary source: runContract.artifactRoots is currently `[outputDir]`
  // (run-contracts.ts:1407) — additive, harmless if redundant.
  if (args.runContract) {
    push(args.runContract.outputDir)
    if (args.runContract.runStatePath) push(dirname(args.runContract.runStatePath))
    for (const r of args.runContract.artifactRoots || []) push(r)
    if (args.runContract.artifactPaths?.sceneScoresPath) push(dirname(args.runContract.artifactPaths.sceneScoresPath))
    if (args.runContract.artifactPaths?.deliveryReportPath) push(dirname(args.runContract.artifactPaths.deliveryReportPath))
  }
  return roots
}
```

Replace `activeArtifactRoots: []` at `:228` with `activeArtifactRoots: deriveSeedArtifactRoots({ context: activeContext, runContract })`. The function is pure and unit-testable.

### 2.2 Terminal-reason precedence (mandatory; supports I2a)

`TurnTerminalReason` priority table — patches with higher priority override patches with lower or equal priority. Earlier writes do not silently win.

```ts
const TURN_TERMINAL_REASON_RANK: Record<TurnTerminalReason, number> = {
  cancelled_user:         100,
  cancelled_runtime:       90,
  failed_skill:            80,
  persistence_failed:      75,
  blocked_config:          70,
  blocked_external:        65,
  blocked_tool_error:      60,
  resume_launch_failed:    55,
  done:                    50,
  checkpoint_background:   30,
  checkpoint_budget:       20,
  checkpoint_user_input:   10,
}
```

Rationale (each pair was a concrete v2 worry):
- **`done` > `checkpoint_*`**: a child resume that completes (`done`) must not be overwritten by a later iteration's budget/background checkpoint marker.
- **`checkpoint_budget` > `checkpoint_user_input`**: the v2 silent-drop case — `:3283` writes provisional `checkpoint_user_input`, then `:4252`'s budget close must override.
- **`cancelled_user` > everything**: user cancel always wins.
- **`failed_skill` > `done`**: a tool failure observed after a provisional `done` must surface as failure.

`mergeTurnFramePatches` and `applyTurnFramePatch` consult this rank when handling `terminalReason`. If a patch's `terminalReason` rank is `< current`, the field is ignored — *not* an error. If equal, last-write-wins (idempotent re-emits stay benign).

### 2.3 Migrate all direct frame mutations in turn-engine.ts to patches (mandatory; unblocks I2a)

**Add fields to `TurnFramePatch`:**

```ts
  budget?: {
    leaseEndIteration?: number | null
    hardCapIteration?: number | null
    exhausted?: boolean
  }
  terminalReason?: TurnTerminalReason
```

**Migrate 15 mutation points** (every example reassigns `turnFrame = applyTurnFramePatch(...)`):

| Site | Today | After M2a |
|---|---|---|
| `turn-engine.ts:1258` `turnFrame.terminalReason = terminalReason` | direct write | `turnFrame = applyTurnFramePatch(turnFrame, { terminalReason })` |
| `:1834-1840` first contract.* cluster (3 fields) | direct mutation through `const contract = turnFrame.skill.runContract` alias | rewrite alias use: `turnFrame = applyTurnFramePatch(turnFrame, { runContract: { skillId: contract.skillId, childCloseEvent: …, childStatus: …, parentNextHint: … } })` |
| `:1849-1851` cancel-branch contract.* cluster (3 fields) | direct mutation | same pattern as above |
| `:1853` `turnFrame.terminalReason = 'cancelled_user'` | direct write | reassignment via patch |
| `:1981` `Object.assign(turnFrame.skill.runContract, resumed.freshContractFields)` | bulk mutation | `turnFrame = applyTurnFramePatch(turnFrame, { runContract: { skillId: turnFrame.skill.runContract.skillId, ...resumed.freshContractFields } })` |
| `:2995-2999` second contract.* cluster | direct mutation | reassignment via patch |
| `:3010, :3029` terminal writes | direct writes | reassignments via patch |
| `:3049-3053` third contract.* cluster | direct mutation | reassignment via patch |
| `:3062` outcome terminal | direct write | reassignment via patch |
| `:3283` `turnFrame.terminalReason = 'checkpoint_user_input'` (provisional) | direct write | reassignment via patch — priority ranking in §2.2 makes the later budget close override correctly |
| `:3966-3970` fourth contract.* cluster | direct mutation | reassignment via patch |
| `:3983` `turnFrame.terminalReason = outcome.terminalReason` | direct write | reassignment via patch |
| `:4248-4252` `turnFrame.budget = { …, exhausted: true }` + `turnFrame.terminalReason = budgetTerminalReason` | direct writes | `turnFrame = applyTurnFramePatch(turnFrame, { budget: { exhausted: true }, terminalReason: budgetTerminalReason })` |

**After every patch application** in turn-engine.ts call `turnFrame = applySteeringToTurnFrame(turnFrame, { recentForceToolDispatched })` (existing helper at `:3870`) to recompute steering, then `refreshToolPolicyFromTurnFrame('budget_patch' | 'terminal_patch' | 'child_close_patch')`. **`refreshToolPolicyFromTurnFrame` does NOT recompute steering** (`:2401`); the steering recomputation is the explicit `applySteeringToTurnFrame` call.

The 4 cluster sites (`:1834-1840`, `:1849-1851`, `:2995-2999`, `:3049-3053`, `:3966-3970`) currently mutate through a `const contract = turnFrame.skill.runContract` alias. M2a rewrites the alias use: callers either re-fetch `turnFrame.skill.runContract` after the patch, or build the partial inline. Tests cover both shapes.

### 2.4 Lease producer emits budget patches (unblocks I3)

```ts
function produceBudgetPatch(args: {
  lease: SkillBudgetLeaseState | null
  state: ChatTurnState
}): TurnFramePatch {
  const exhausted =
    args.state.budgetWarningLevel === 'exhausted'
    || (args.state.stepBudgetState?.remainingIterations || 0) <= 0
  return {
    budget: {
      leaseEndIteration: args.lease?.currentLeaseEndIteration ?? null,
      hardCapIteration: args.lease?.hardCapIteration ?? null,
      exhausted,
    },
  }
}
```

Use it after every `skillBudgetLeaseState` mutation (at `:2820`, `:2895`, `:3917`) and in the budget-exhausted branch (now `:4248`):

```ts
turnFrame = applyTurnFramePatch(turnFrame, produceBudgetPatch({ lease: skillBudgetLeaseState, state }))
turnFrame = applySteeringToTurnFrame(turnFrame, { recentForceToolDispatched })
refreshToolPolicyFromTurnFrame('budget_patch')
```

The gate at §3.3 enforces every lease mutation site is followed by a `produceBudgetPatch(...)` call (named-helper requirement, not a line-count heuristic).

### 2.5 Fix every site that emits `framePatch.activeArtifactRoots` to also emit `contextModifier` (mandatory; unblocks gate 3.4)

v3 only fixed `inspect-run-state.ts`. v4 covers all 5 emitters codex enumerated.

The cleanest architectural answer is **at the helper boundary**: `attachContractFramePatch` (`src/main/modules/tools/skills-tools.ts:740-769`) is the shared wrapper that already attaches a `framePatch` (built via `buildContractFramePatch` in `run-contracts.ts:1709-1714`). v4 modifies this helper to **also derive a matching `contextModifier`** whenever the framePatch's `activeArtifactRoots` is non-empty:

```ts
// inside attachContractFramePatch, after `merged` is computed (around :760):
// `contract` is the full SkillRunContract parameter passed in at :739; use that
// for contextModifier.activeFrame.runContract (which requires SkillRunContract |
// null — see tool-result-types.ts:23). DO NOT use merged.runContract: that is
// Partial<SkillRunContract> and would fail typecheck.
const mergedRoots = merged.activeArtifactRoots ?? []
const existingModifier = output.contextModifier
const existingRoots = existingModifier?.activeFrame?.activeArtifactRoots ?? []
const unionRoots = (() => {
  if (mergedRoots.length === 0) return existingRoots
  const seen = new Set(existingRoots)
  const out = [...existingRoots]
  for (const r of mergedRoots) if (!seen.has(r)) { seen.add(r); out.push(r) }
  return out
})()
const nextContextModifier = unionRoots.length > 0
  ? {
    activeFrame: {
      activeArtifactRoots: unionRoots,
      // Prefer caller-supplied contextModifier runContract; otherwise use the
      // FULL `contract` parameter (typed SkillRunContract | null). Never use
      // `merged.runContract` here — it is `Partial<SkillRunContract>`.
      runContract: existingModifier?.activeFrame?.runContract ?? contract ?? null,
      discoveredHandles: existingModifier?.activeFrame?.discoveredHandles ?? [],
    },
  }
  : (existingModifier ?? null)
return createToolExecutionOutput(output.text, {
  shape: output.shape,
  data: output.data,
  projectionPatch: output.projectionPatch,
  interactionHint: output.interactionHint,
  framePatch: merged,
  contextModifier: nextContextModifier,
})
```

This automatically fixes 4 of the 5 callers codex flagged — they all go through `attachContractFramePatch`:

| Site | Today | After v4 |
|---|---|---|
| `skills-tools.ts:1220-1231` `skill_inspect_detached` | framePatch via helper, no contextModifier | helper emits both |
| `skills-tools.ts:1503-1516` `skill_start_detached` | framePatch via helper, no contextModifier | helper emits both |
| `skills-tools.ts:740-769` `attachContractFramePatch` self | preserves caller's contextModifier as-is | unions caller's contextModifier with framePatch.activeArtifactRoots |
| `inspect-run-state.ts:640-660` (does NOT use the helper — direct `createToolExecutionOutput` call) | framePatch only | see below |

**For `inspect-run-state.ts:640-660`** — the wrapper passes `framePatch` directly through `createToolExecutionOutput`'s options object. v4 added a `contextModifier` option in the same call. **v8 fix (type-shape):** `framePatch.runContract` is `Partial<SkillRunContract>` (turn-frame.ts:230), but `contextModifier.activeFrame.runContract` requires `SkillRunContract | null` (tool-result-types.ts:19). Reading the partial would not typecheck. **`buildInspectFramePatch` is widened to also return the full `contract`**, and the wrapper threads it through.

**Step 1 — widen `buildInspectFramePatch` return** (inspect-run-state.ts:407-426):

```ts
// inside buildInspectFramePatch, replace `return patch` with:
return { framePatch: patch, contract }
```

Update the function's return type from `TurnFramePatch` to `{ framePatch: TurnFramePatch; contract: SkillRunContract | null }`. `contract` is already in scope at the `buildInspectFramePatch` body (it's the local built starting at the function's loadSkillRunContract call earlier in the function).

**Step 2 — wrapper at `:626-660`** consumes the new shape:

```ts
const { framePatch, contract } = buildInspectFramePatch({ /* unchanged inputs */ })

const activeArtifactRoots = framePatch.activeArtifactRoots ?? []
return createToolExecutionOutput(
  `Inspected run_state at ${runStatePath}. Found keys: ${summary.knownKeysFound.join(', ') || '(none of the known keys)'}.`,
  {
    shape: 'json',
    data: { /* unchanged */ },
    framePatch,
    contextModifier: activeArtifactRoots.length > 0
      ? {
        activeFrame: {
          activeArtifactRoots,
          // Use the FULL `contract` from the helper, not `framePatch.runContract`.
          // The latter is `Partial<SkillRunContract>` and would fail typecheck.
          runContract: contract ?? null,
          discoveredHandles: [],
        },
      }
      : null,
  },
)
```

`createToolExecutionOutput` already accepts a `contextModifier` field in its options (`tool-result-types.ts:65-66`).

**For typed actions at `skills-tools.ts:2011-2034`** — today these emit a contextModifier ONLY when the tool is in `VEA_CONTEXT_MUTATING_TOOL_NAMES`. v4 removes that gate: any typed action whose framePatch carries `activeArtifactRoots` should also emit a matching contextModifier. This is the bug codex flagged: same-batch `skill_inspect_detached → skill_read_artifact` breaks today and would continue to break after M4+M5 unless this gate is widened. Replace the `VEA_CONTEXT_MUTATING_TOOL_NAMES` block with (v6 — also mirrors `runContract`, matching I2's promise of full-channel symmetry):

```ts
// `contract` here is the local SkillRunContract returned by loadSkillRunContract
// earlier in this function (skills-tools.ts:1984). It is the same reference the
// framePatch is built from, so contextModifier carries the matching contract.
const contextModifier = outputDir
  ? {
    activeFrame: {
      activeArtifactRoots: [outputDir],
      runContract: contract ?? null,
    },
  }
  : null
```

These three together (helper widening + inspect-run-state explicit + typed-action gate removal) make every framePatch emitter symmetric on **both** `activeArtifactRoots` AND `runContract`. Gate 3.4 then enforces no regression on either field.

### 2.6 Drop the active-context fallback in `skill_read_artifact` (M4+M5 combined)

After §2.1 (resolver seeding) and §2.5 (inspect-run-state contextModifier) have landed:

**File: `src/main/modules/tools/skills-tools.ts:1687-1696`** — replace the if/else with:

```ts
        if (Array.isArray(liveFrameRoots)) {
          for (const root of liveFrameRoots) pushRoot(root)
        }
```

**File: `src/main/modules/tools/skill-primitives/read-artifact.ts:24-44`** — drop the `TODO(skill-child-loop)` block. Keep `additionalAllowedReadRoots` parameter and its doc, just without the fallback language.

### 2.7 Migrate `skill_patch_config` activeContext read to frame

**File: `src/main/modules/tools/skills-tools.ts:1335`** — read frame only:

```ts
const frameContract = runtimeContext?.activeFrame?.runContract as SkillRunContract | null
const activeContextForPatch = frameContract
  ? { runStatePath: frameContract.runStatePath ?? null, outputDir: frameContract.outputDir ?? null }
  : null
```

If the runtime frame is missing, stale-blocker clearing is unavailable for that
call; the tool still patches and validates config, but it must not reopen the
retired active-context fallback.

### 2.8 Documentation sync

- `CLAUDE.md` §6.13 — append: budget producer/consumer split via `produceBudgetPatch` + `frame.budget`; terminalReason precedence ranks.
- `CLAUDE.md` §6.20 (new) — Frame is the single read surface inside the model loop + I1-I5.
- `AGENTS.md` mirror.
- `docs/superpowers/testing-conventions.md` — note the two-tier write model.

## 3. CI gates

All wired into `verify:m`.

### 3.0 Note on AST + alias tracking (v4 correction)

v3 cited `scripts/check-coordinator-isolation.cjs` as a precedent for AST alias tracking. Codex correctly pointed out that script uses TypeScript AST but only visits imports and adapter-id comparisons — it does NOT track variable aliases. So `check-frame-write-single-source.cjs` and `check-budget-single-source.cjs` are **new machinery**, not reuse. They will use `@typescript-eslint/parser` (already a dev-dep) plus a small visitor that tracks:

- `const X = turnFrame.skill.runContract` style aliases (and the same for `frame`/`turn-frame-typed parameters`)
- `Object.assign(X, ...)` calls where X is an aliased reference
- `X.field = ...` writes through the aliased reference

The visitor pattern is straightforward (~150 LoC for both gates) and unit-testable in isolation. The "synthetic-source regression test" file (`frame-write-single-source.test.ts`) covers the visitor with hand-crafted source samples for each forbidden pattern.

### 3.1 `scripts/check-frame-write-single-source.cjs`

**Scope B (turn-engine.ts):** parse `src/main/modules/agent-control/turn-engine.ts` and flag any of:

```
\bturnFrame\.(budget|terminalReason|liveness|configValidation|activeArtifactRoots)\s*=
\bturnFrame\.skill\.(runContract|action|status|staleBlockerReason)\s*=
\bturnFrame\.skill\.runContract\.\w+\s*=
\bturnFrame\.skill\.runContract\.artifactPaths\.\w+\s*=
Object\.assign\s*\(\s*turnFrame\.skill\.runContract\b
Object\.assign\s*\(\s*turnFrame\.\w+\b
\bdelete\s+turnFrame\.
```

Plus a follow-the-alias check: any `const \w+ = turnFrame.skill.runContract` declaration creates an alias whose subsequent `\w+\.\w+\s*=` writes are flagged as well. Implementation: AST-level alias tracking (the script uses `@typescript-eslint/parser` + a small visitor; same machinery already used by `scripts/check-coordinator-isolation.cjs`).

**Scope A (`src/main/modules/tools/**/*.ts`):** same forbidden patterns, BUT scoped to functions whose parameter types reference `TurnFrame`. Tools that build a *local* `SkillRunContract` value (e.g. `skills-tools.ts:2208, 2210`, `buildContractFramePatch` outputs) are **not** flagged — they construct contracts to *emit* via framePatch, not to mutate a live frame. Detection: a forbidden pattern only fires if the receiver expression resolves through a parameter or local typed `TurnFrame` (the alias tracker above also handles this).

### 3.2 `scripts/check-read-artifact-no-active-context.cjs`

Reads `src/main/modules/tools/skills-tools.ts`. In the source region between `tool.name === 'skill_read_artifact'` and the next `tool.name === '...'` boundary, the substrings `resolveActiveSkillContext` and `activeContextForRoots` MUST NOT appear.

### 3.3 `scripts/check-budget-single-source.cjs`

1. **Steering reads only frame.budget**: in `src/main/modules/agent-control/turn-frame-steering.ts` (and any file that reads steering), references to `\.currentLeaseEndIteration|\.hardCapIteration` are forbidden. Producers (anywhere in the codebase) are detected by being inside a function whose name starts with `produceBudgetPatch` or by being inside `src/main/modules/agent-control/skill-budget-lease-controller.ts`.

2. **Every *frame-affecting* lease mutation in turn-engine.ts is followed by `produceBudgetPatch`** (v4 narrowing). The gate fires only for mutations that change `frame.budget` — concretely:

   * lease creation: `skillBudgetLeaseState = createSkillBudgetLeaseState(...)`
   * lease replacement: `skillBudgetLeaseState = evaluation.state` (or any reassignment)
   * field writes that affect the frame: `skillBudgetLeaseState\.(currentLeaseEndIteration|hardCapIteration)\s*=`

   Internal-score / fingerprint mutations are explicitly exempt and the gate must NOT flag them:

   * `skillBudgetLeaseState.progressScore = ...` (`turn-engine.ts:3909`)
   * `skillBudgetLeaseState.wasteScore = ...` (`:3910`)
   * `skillBudgetLeaseState.lastFingerprint = ...` (`:3912`)

   These are scoring-internal state, not frame-state. The codex v3 review explicitly flagged that v3's overbroad rule would have failed on these.

   For mutations that DO require a follow-up: AST-level — the next *non-trivial* statement (skipping logs, metrics, comments) in the same enclosing block must be a call to `produceBudgetPatch` whose result feeds `applyTurnFramePatch`. The gate's allowlist is keyed on the AST node names, not regex.

3. **No direct `turnFrame.budget` writes**: covered by §3.1 too — belt-and-suspenders.

### 3.4 `scripts/check-context-modifier-shape.cjs`

**No annotation escape hatch.** The gate enforces a hard rule: any tool source location that emits `framePatch.activeArtifactRoots` MUST also emit `contextModifier.activeFrame.activeArtifactRoots`.

**v5 helper-aware detection (corrected).** v3 only inspected return literals; codex pointed out helper-produced patches (`attachContractFramePatch`, `buildContractFramePatch`) would be missed. v4 widened to "trusted helpers". Codex v4 corrected: only helpers that wrap the *full* `ToolExecutionOutput` can guarantee symmetry — `buildInspectFramePatch` only builds a `TurnFramePatch` and cannot itself emit `contextModifier`. v5 narrows the trusted list:

1. **Trusted helpers (single entry):** `attachContractFramePatch` in `skills-tools.ts:740-769`. After §2.5 lands, this helper auto-emits `contextModifier` whenever its returned framePatch has `activeArtifactRoots`. Callers that use this helper as their final return statement are trusted by inheritance.
2. **NOT trusted (despite producing framePatches):** `buildInspectFramePatch`, `buildContractFramePatch`. These only return a `TurnFramePatch` value; the caller must then bind it to a `ToolExecutionOutput` via `createToolExecutionOutput(...)`, and that *call* is what the gate inspects. The gate visits every call to `createToolExecutionOutput` whose options object contains `framePatch:`; if the bound framePatch carries `activeArtifactRoots`, the same options object MUST also carry a `contextModifier:` field with matching roots.
3. **Direct return literals (no helper):** any `return { framePatch: { activeArtifactRoots: [...] }, ... }` MUST also include a `contextModifier:` field with matching roots.
4. **v7 — gate enforces both fields when activeArtifactRoots is present, narrowed to avoid false-flags on partial-contract emitters:** the gate fires only on sites where `framePatch.activeArtifactRoots` is non-empty. At those sites:
   * `contextModifier.activeFrame.activeArtifactRoots` MUST mirror `framePatch.activeArtifactRoots` (same set).
   * If the same site also emits `framePatch.runContract`, `contextModifier.activeFrame.runContract` MUST be the same source contract — not the partial clone in `framePatch.runContract` (which is `Partial<SkillRunContract>`), but the full `SkillRunContract | null` value the framePatch was constructed from. The helper (`attachContractFramePatch`) passes the full `contract` directly; direct emitters (inspect-run-state via the widened `buildInspectFramePatch`, typed actions via the local `contract`) must do the same.

   Sites that emit `framePatch.runContract` *without* `activeArtifactRoots` (e.g. `skill_patch_config`'s partial blocker update with `runContract: { skillId, blocker: { reason: ..., stale: ... } }`) are explicitly NOT subject to the symmetry rule. They emit a contract update but no read-sandbox change, and no intra-batch reader needs same-batch contextModifier propagation.

   `discoveredHandles` symmetry is NOT enforced at this stage (per the I2 v7 narrowing); a future Stage M+1 may widen the rule if a same-batch reader of `context.activeFrame.discoveredHandles` emerges.
5. **Violators without an explicit allowlist entry fail.**

This makes the gate's contract clear: "trust comes from full-output wrapping, not from framePatch-construction." `attachContractFramePatch` qualifies because it returns a `ToolExecutionOutput`; `buildInspectFramePatch` does not.

**Allowlist schema** (file: `scripts/check-context-modifier-shape.allowlist.json`):

```json
{
  "$schema": "./check-context-modifier-shape.allowlist.schema.json",
  "entries": [
    {
      "file": "src/main/modules/tools/path/to/file.ts",
      "lineStart": 123,
      "lineEnd": 145,
      "reason": "Non-empty plain-English justification (must be ≥ 20 chars)",
      "addedBy": "alice@example.com",
      "addedAt": "2026-05-06"
    }
  ]
}
```

Schema rules (enforced by the gate):
- `entries` is an array.
- Every entry has all 5 fields **plus** an optional 6th `enclosingFunction` field (recommended).
- `reason` length ≥ 20 characters and not whitespace-only.
- `addedAt` ISO date.

**Stale-detection rule (v5 line-fragility mitigation):** the gate matches an allowlist entry to a current violation by either:
1. exact `file` + `lineStart..lineEnd` range match, OR
2. `file` + `enclosingFunction` match (if the entry includes the function name).

Entries with both keys passing match the violation cleanly even if line numbers shift during refactor. Entries with only the line range still match exactly when no refactor has moved the violation. An allowlist entry that matches NO current violation is stale and the gate fails — entries must be removed when their violation is fixed.

After §2.5 lands (M5a-helper + M5a-inspect + M5a-typed-gate, all before M4+M5), no allowlist entries should be needed.

### 3.5 Test files

| Test | Purpose |
|---|---|
| `frame-budget-roundtrip.test.ts` | producer emits patch → frame.budget updated → steering reads it → exhausted flips to `'checkpoint'` |
| `frame-terminal-priority.test.ts` | priority table from §2.2: `done` survives later `checkpoint_budget`; `cancelled_user` overrides everything; `checkpoint_user_input` is overridden by `checkpoint_budget` (v2 silent-drop case) |
| `read-artifact-no-fallback.test.ts` | cold session, **resolver** seeds roots from `ActiveSkillContext.outputDir` → `skill_read_artifact run_state.json` works without prior `inspect_run_state` |
| `read-artifact-no-fallback-empty.test.ts` | truly empty session (no resolver seed available) → `no_root_match` |
| `inspect-run-state-context-modifier.test.ts` | inspect emits both framePatch.activeArtifactRoots and contextModifier.activeFrame.activeArtifactRoots; same-batch read sees discovered root |
| `attach-contract-framepatch-symmetry.test.ts` | helper auto-emits matching contextModifier when framePatch has activeArtifactRoots; covers skill_inspect_detached, skill_start_detached, typed-action-non-VEA paths |
| `typed-action-context-modifier-no-vea-gate.test.ts` | typed action for non-VEA skill (e.g. lets-go-rss) emits contextModifier when outputDir is set; previously gated to VEA-only |
| `frame-write-single-source.test.ts` | gate's regex + alias tracker catches all 11 patterns + accepts `applyTurnFramePatch` reassignment + does NOT flag local SkillRunContract assembly |
| `frame-resolver-seed.test.ts` | `deriveSeedArtifactRoots` covers all 5+ inputs |
| `dispatch-active-context-budget-still-resolved.test.ts` | deferred after post-review; `skill_patch_config` now reads frame context only, so there is no fallback metric surface to exercise |
| `context-modifier-symmetry.test.ts` | typed-action wrapper emits matching framePatch + contextModifier; unrelated tool that emits framePatch only is allowlisted via JSON file (gate accepts) |

## 4. Test coverage plan (Stage K compliance)

```json
"test:m:gates": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/frame-budget-roundtrip.test.ts src/__tests__/frame-terminal-priority.test.ts src/__tests__/read-artifact-no-fallback.test.ts src/__tests__/read-artifact-no-fallback-empty.test.ts src/__tests__/inspect-run-state-context-modifier.test.ts src/__tests__/attach-contract-framepatch-symmetry.test.ts src/__tests__/typed-action-context-modifier-no-vea-gate.test.ts src/__tests__/frame-write-single-source.test.ts src/__tests__/frame-resolver-seed.test.ts src/__tests__/dispatch-active-context-budget-still-resolved.test.ts src/__tests__/context-modifier-symmetry.test.ts",
"test:m:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/turn-frame.test.ts src/__tests__/turn-frame-steering.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/skill-read-artifact-frame-roots.test.ts src/__tests__/turn-frame-patch.test.ts",
"verify:m": "npm run verify:l && node scripts/check-frame-write-single-source.cjs && node scripts/check-read-artifact-no-active-context.cjs && node scripts/check-budget-single-source.cjs && node scripts/check-context-modifier-shape.cjs && npm run test:m:gates && npm run test:m:focus"
```

Top-level `verify` keeps `verify:native` and chains M after — it does NOT replace `verify:native`:

```json
"verify": "npm run verify:native && npm run verify:m"
```

`verify:cloud` chains to `verify:m` without `verify:native` (per CLAUDE.md §6.17).

## 5. Rollout sequence (v3)

| PR | Scope | Lines (est.) | Risk |
|---|---|---|---|
| **M1** | `framePatch.budget` + `framePatch.terminalReason` field declarations + merge/apply with priority ranks (§2.2) + unit tests | ~220 | low |
| **M0a** | Resolver seeding (`deriveSeedArtifactRoots` + unit test); `dirname` import | ~120 | low — pure function |
| **M2a** | Migrate the 15 mutation points in turn-engine.ts to applyTurnFramePatch reassignment (terminalReason × 8, budget × 1, contract.* × 5 clusters, Object.assign × 1); rewrite alias usage; verify priority ranks suffice for sequential branches | ~380 | medium — touches every terminal branch |
| **M2b** | `produceBudgetPatch` helper; lease producer wires it at 3 sites; steering migrates to `frame.budget` reads | ~200 | medium |
| **M3** | `check-budget-single-source.cjs` + Scope B of `check-frame-write-single-source.cjs` + tests | ~280 | low (defensive) |
| **M5a-helper** | Widen `attachContractFramePatch` (§2.5 first snippet) to auto-emit `contextModifier` when framePatch.activeArtifactRoots is non-empty + `attach-contract-framepatch-symmetry.test.ts` | ~80 | low — additive; covers `skill_inspect_detached` / `skill_cancel_detached` / `skill_start_detached` callers by inheritance |
| **M5a-inspect** | Fix inspect-run-state.ts: emit `contextModifier` via `createToolExecutionOutput` options (§2.5 second snippet) + `inspect-run-state-context-modifier.test.ts` | ~60 | low |
| **M5a-typed-gate** | Drop `VEA_CONTEXT_MUTATING_TOOL_NAMES` gate at `skills-tools.ts:2023-2029` so non-VEA typed actions also emit `contextModifier` (§2.5 third snippet) + `typed-action-context-modifier-no-vea-gate.test.ts` | ~40 | low — single-line gate removal |
| **M4+M5** | (combined) Drop `skill_read_artifact` fallback in `skills-tools.ts` and `read-artifact.ts` doc; add `check-read-artifact-no-active-context.cjs` + cold-session regression test + empty-session regression test. **Hard ordering: M5a-helper / M5a-inspect / M5a-typed-gate must all be merged before M4+M5; CI in M4+M5 must verify each by name.** | ~180 | low — gates prove no regression |
| **M6** | Migrate `skill_patch_config` to read `activeFrame` only; no active-context fallback | ~80 | low |
| **M7** | Scope A of `check-frame-write-single-source.cjs` (tool dispatchers) + alias tracker + synthetic-source regression test | ~250 | medium — most aggressive lint, lands last |
| **M8** | `check-context-modifier-shape.cjs` (no annotation escape — JSON allowlist only) + tests | ~200 | low |
| **M9** | Wire all gates into `verify:m`; update top-level `verify` + `verify:cloud`; doc sync | ~50 | low |

**Ordering:**
- M1 first because everything else needs the new patch fields.
- M0a before M4+M5 so cold-session reads don't break when fallback is removed.
- M5a before M4+M5 so same-batch inspect→read sees the contextModifier.
- M2a + M2b before M3 because gate 3.3 fails until producer/consumer split is in place.
- M7 (Scope A gate) lands last among gates — most aggressive, shouldn't gate any earlier PR's merge.

## 6. Out of scope (verified non-load-bearing for I1-I5)

These remain because they are *identity-resolution* reads, not frame-state reads:

| Site | Why it stays |
|---|---|
| `skills-tools.ts:307` `getSkillToolDefs` | session-build time, upstream of authorization |
| `skills-tools.ts:343` `buildSkillProjectionPatch` | projection patch is per-stage UI hint |
| `skills-tools.ts:424` `resolvePrimitiveSkillId` legacy chain | W3a back-compat fallthrough |
| `skills-tools.ts:1399` `skill_start_detached` admission labelling | identity, not artifact / state |
| `skills-tools.ts:1547` `skill_run_shell` shell allowlist | identity-keyed allowlist |
| `tool-registry.ts:342` `isStaticSkillToolVisible` | runtime-boot path, before activeFrame is threaded |

Codex v1 confirmed this list does not contradict I1 once I1 is narrowed to frame-state reads. Codex v2 confirmed nothing in this list is load-bearing for the new I2.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `cancelled_user > done` codifies an existing audit-loss edge | **Out of scope for M (v4 explicit defense).** Codex v3 review flagged that `cancelSkillChildRun` returns a cached terminal close (including completed) when the child is no longer active (`skill-child-runner.ts:741-760`), and the cancel-rendering path always emits `cancelled_user` (`turn-engine.ts:1843-1872`) regardless of cached status. **M's job is structural — plumbing the rank table for future patches; the existing semantic is inherited from current direct writes.** Fixing the cancel branch to preserve already-terminal `done` is a separate behavioral change with its own tests and operational implications. Tracked as Stage M+1 question (see §9.Q5). M does not regress this behavior; it preserves it exactly. |
| Priority table at §2.2 inverts a real-world close order we haven't anticipated | `frame-terminal-priority.test.ts` covers all `(earlier, later) → expected_winner` pairs across the 12 reasons (66 cases). Reviewers can flag specific inversions. |
| M2a's alias rewrites break implicit-mutation semantics (existing code mutated `contract.x` and read it back via `contract.x` in the same block) | Each cluster's tests cover read-after-mutation. When the block re-reads contract fields, the rewrite re-fetches `turnFrame.skill.runContract` after the patch. |
| `applyTurnFramePatch` returns a new frame; existing code that captured an early reference to `turnFrame.skill` becomes stale | M2a sweeps for `const \w+ = turnFrame\.skill` and either rewrites to indirect access or invalidates after each patch. The frame-write-single-source gate's alias tracker also catches stale-alias mutations. |
| `produceBudgetPatch` emitted with stale `state.budgetWarningLevel` | Producer is called *after* every state mutation, never before. Gate 3.3.2 enforces named-helper proximity. |
| `check-context-modifier-shape.cjs` allowlist becomes a dumping ground | Allowlist file is in its own JSON, requires explicit reason, must be in code review. Gate fails if a new entry has no reason field. |
| Stage M lands but a future PR forgets `applySteeringToTurnFrame` after a new patch site | Add a CI gate `check-apply-steering-after-patch.cjs` (out of scope for M but tracked for follow-up). For now, M9 documents the requirement and code review enforces. |

## 8. Verification (manual smoke after M9)

1. Open `conv-local-1777219721244-7cx39t` VEA session.
2. Send `继续上次的视频分析`.
3. Observe in `ready-directchat.log`:
   - One `turn_frame_summary` per turn.
   - `turn_frame_patch_applied` entries include `patchKeys: [..., 'budget']` after lease evaluation and `patchKeys: [..., 'terminalReason']` at terminal closure.
4. Force budget exhaustion. Steering picks `'checkpoint'` from `frame.budget.exhausted`.
5. Cold session where resolver seeds roots from `outputDir` → `skill_read_artifact run_state.json` succeeds.
6. Truly empty session → `skill_read_artifact run_state.json` returns `no_root_match`.
7. Same-batch sequence in one turn: `skill_inspect_run_state` then `skill_read_artifact run_state.json` → both succeed (the §2.5 contextModifier emit is what makes this work intra-batch).

## 9. Open questions for codex (v4)

- **Q1.** Priority table — `failed_skill` (80) > `done` (50) is defensive. Codex v3 noted no current path writes `done` then later observes a real failure (clean `done` is written in `finish()` at turn end). Keep defensive, or lower `failed_skill` below `done` and wait for a real case? v4 default: keep defensive — gives future code a sane default.
- **Q2.** §2.5 widens contextModifier emission via the `attachContractFramePatch` helper. Does this risk emitting contextModifier where it was *intentionally* gated (e.g. read-only inspect tools that shouldn't mutate live context)? Codex v3 confirmed `applyContextModifier` only adds to `activeArtifactRoots` set and replaces `runContract` — both safe operations. v4 default: emit unconditionally when activeArtifactRoots is non-empty.
- **Q3.** `Object.assign(turnFrame.skill.runContract, ...)` at `:1981` → migrate to `applyTurnFramePatch` with `runContract: { ...resumed.freshContractFields, skillId }`, or new dedicated `runContractFresh` field? v4 default: reuse `runContract: Partial<SkillRunContract>` — the merger already field-merges, no need for a new field.
- **Q4.** Allowlist schema at §3.4 — JSON with explicit fields, or YAML, or TS file with typed schema? v4 default: JSON + JSON Schema sibling file for IDE validation.
- **Q5 (deferred edge).** Cancel-after-`done` audit loss (codex v3): when `cancelSkillChildRun` returns a cached completed close but the engine emits `cancelled_user`, the audit trail loses the completion. M preserves current behavior. **Stage M+1 question:** should the cancel branch detect already-terminal cached closes and emit the cached terminal reason instead? This is a behavioral change requiring its own test + design discussion. Out of scope for M.

---

## Appendix A — file inventory of the change

```
src/main/modules/agent-control/turn-frame.ts
  + budget?, terminalReason? on TurnFramePatch
  + TURN_TERMINAL_REASON_RANK + shouldApplyTerminalReason helper
  + merge / apply for both new fields
  + reassignment-style apply (already pure — no change to mutation semantics)

src/main/modules/agent-control/turn-frame-resolver.ts
  + import { dirname } from 'node:path'
  + deriveSeedArtifactRoots(...)
  ~ replace `activeArtifactRoots: []` at :228

src/main/modules/agent-control/turn-engine.ts
  ~ migrate 15 mutation points (terminalReason × 8 sites, budget × 1, contract.* × 5 clusters, Object.assign × 1)
  + produceBudgetPatch helper
  ~ swap consumer reads from skillBudgetLeaseState to turnFrame.budget (steering only)
  ~ rewrite contract aliases to either re-fetch or build inline partial

src/main/modules/agent-control/turn-frame-steering.ts
  ~ reads turnFrame.budget at :223/:296/:408 — already correct, no change

src/main/modules/tools/skills-tools.ts
  - delete the 1687-1696 fallback else-branch
  ~ at :1335 (skill_patch_config) use runtimeContext.activeFrame only

src/main/modules/tools/skill-primitives/inspect-run-state.ts
  ~ wrapper at :625-660 emits contextModifier alongside framePatch when activeArtifactRoots non-empty

src/main/modules/tools/skill-primitives/read-artifact.ts
  ~ doc cleanup; drop "TODO(skill-child-loop)" block; keep additionalAllowedReadRoots param

scripts/
  + check-frame-write-single-source.cjs (Scope A + Scope B with alias tracking)
  + check-read-artifact-no-active-context.cjs
  + check-budget-single-source.cjs
  + check-context-modifier-shape.cjs
  + check-context-modifier-shape.allowlist.json (initially empty)

src/__tests__/
  + frame-budget-roundtrip.test.ts
  + frame-terminal-priority.test.ts
  + read-artifact-no-fallback.test.ts
  + read-artifact-no-fallback-empty.test.ts
  + inspect-run-state-context-modifier.test.ts
  + frame-write-single-source.test.ts
  + frame-resolver-seed.test.ts
  + dispatch-active-context-budget-still-resolved.test.ts
  + context-modifier-symmetry.test.ts

package.json
  + test:m:gates / test:m:focus / verify:m
  ~ verify -> verify:native + verify:m (DO NOT drop verify:native)
  ~ verify:cloud -> verify:m (no verify:native, per §6.17)

CLAUDE.md / AGENTS.md
  + §6.20 Frame is the single read surface
  ~ §6.13 budget producer/consumer split + terminal priority

docs/superpowers/testing-conventions.md
  + two-tier write model note
```

## Appendix B — two-tier write model reference

```
                    ┌──────────────────────────────────────┐
                    │   ToolExecutionOutput (single tool)  │
                    │   .framePatch?         post-batch    │
                    │   .contextModifier?    intra-batch   │
                    └──────────────────────────────────────┘
                          │                          │
        intra-batch       │                          │ post-batch
        ─────────────     │                          │ ─────────────
                          ▼                          ▼
        applyContextModifier(ctx)   mergeTurnFramePatches(...) +
        mutates ctx.activeFrame     turnFrame = applyTurnFramePatch(turnFrame, merged)
        in-place — same batch       — pure: returns new frame
                          │                          │
                          ▼                          ▼
         ToolRuntimeContext.activeFrame    TurnFrame.{skill, budget,
         (read by next tool in batch)       activeArtifactRoots, …}
                                            (read by next iteration)
```

`applyTurnFramePatch` is **pure** — the call site reassigns `turnFrame = applyTurnFramePatch(turnFrame, patch)`. v3 examples consistently show the reassignment.

## Appendix C — terminal-reason priority cheatsheet

| Reason | Rank | Beats | Beaten by |
|---|---|---|---|
| `cancelled_user` | 100 | everything | nothing |
| `cancelled_runtime` | 90 | most | cancelled_user |
| `failed_skill` | 80 | done, all checkpoints, lower failures | cancelled_* |
| `persistence_failed` | 75 | done, checkpoints | cancelled_*, failed_skill |
| `blocked_config` | 70 | done, checkpoints, lower blockers | failures, cancelled |
| `blocked_external` | 65 | done, checkpoints | blocked_config, failures, cancelled |
| `blocked_tool_error` | 60 | done, checkpoints | blocked_*, failures, cancelled |
| `resume_launch_failed` | 55 | done, checkpoints | other failures, blocked_*, cancelled |
| `done` | 50 | all checkpoints | failures, blocked_*, cancelled |
| `checkpoint_background` | 30 | budget, user_input | done and above |
| `checkpoint_budget` | 20 | user_input | background, done and above |
| `checkpoint_user_input` | 10 | nothing | everything else |
