---
stage: N (Stage 8 — child loop owns long tasks; parent retires force-typed-action)
sequence: after M (frame update single source of truth)
status: draft v9 (2026-05-06)
verify_target: verify:n
inherits: verify:m
enforce: true
revision_history:
  - v1 (2026-05-06): initial draft.
  - v2 (2026-05-06): codex RED on v1 (7 RED + 3 YELLOW). v2 addressed
      R1 (helper signature), R2 (candidate-vs-blocked split), R4 (terminal
      reason vocabulary), R5 (budgetLimitedBeforeCompletion before break),
      R7 (metrics location), Y1 (drop test hook), Y3 (verify:native).
  - v9 (2026-05-06): codex RED on v8 — 4 narrow gaps:
      [compile blocker — ReminderTopic] new topic
      `force-tool-blocked-child-owned` referenced in Phase 1.2 but not in
      `ReminderTopic` union (`system-reminder-registry.ts:17`) or
      `DEFAULT_CONFLICTS` table (`system-reminder-assembly.ts:5-19`). v9
      adds both files to the modify list and specifies the additions:
      append `'force-tool-blocked-child-owned'` to the union and add a
      `DEFAULT_CONFLICTS['force-tool-blocked-child-owned']: []` entry
      (mirrors the existing `force-tool-checkpoint-blocked` shape — no
      conflicts; coexistence is benign because they only fire on disjoint
      branches per Phase 1.2).
      [Scenario F precondition] v8 said "embedded manifest with
      child_loop.actions[] but no driver" wouldn't be caught by the static
      gate, but Phase 0.2 catches it if the static-name entry is missing.
      v9 narrows: Scenario F applies only when the PR adds the matching
      `STATIC_SKILL_TOOL_NAMES_BY_ACTION` entry (so static gate passes)
      AND omits the driver registration; only then does the boot
      assertion fire.
      [Case B wording] v8 said manifest fence "not reached" but the v8
      code computes `childOwnedByManifest` unconditionally. v9 softens
      to "the manifest-block metric is not emitted because the early-break
      guard requires `!childOwnedByContract`" — predicate IS computed,
      just not acted on.
      [Case C test hook] v8 said to add a legacy test tool to "static
      registry" which is risky (the reverse map is computed at module
      load). v9 clarifies: tests patch
      `defaultToolRegistry.getToolDefinitionForExecution(toolName)` to
      return a fixture definition for the legacy fixture's tool name.
      `STATIC_SKILL_TOOL_NAMES_BY_ACTION` is NOT mutated by tests.
  - v8 (2026-05-06): codex YELLOW on v7.1 — 2 last wording cleanups:
      [scope wording] early sections + N1 said "any skill whose manifest
      declares `child_loop.actions[]`", but Phase 0.4 strips `child_loop`
      from custom skills at compile, so the operative rule is "any
      embedded skill whose `ready-skill.json` declares `child_loop.actions[]`",
      equivalently "any skill whose compiled `definition.childLoop` is
      non-empty after Phase 0.4 normalization". v8 narrows the wording.
      [v7.1 stale metadata] document was at `v7` while this pass was
      described as `v7.1`; v8 bumps `status` and `revision_history`.
  - v7 (2026-05-06): codex YELLOW on v6 — 2 last narrow nits:
      [boot-failure rationale wording] :459 still cited a non-existent
      "manifest⇔driver static review" catching this in CI; v3 retired that
      static gate. v7 rewrites to "the Phase 0.3 boot-assertion test
      `skill-child-stage-n-boot-assertion.test.ts` in verify:n catches this
      in CI; the Phase 0.2 static gate is for manifest⇔static-name only".
      [Phase 1.2 import update] v6 said to export
      `isParentForceForbiddenByManifest` from `run-contracts.ts` but didn't
      explicitly say to update `turn-engine.ts:325` (which currently only
      imports `shouldParentForceLongSkillTool` from run-contracts). v7
      explicitly lists the import addition as part of Phase 1.2.
  - v6 (2026-05-06): codex YELLOW on v5 — 3 narrow remaining items:
      [N2b §1 wording] line ~151-153 still named `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`
      where the live `<skillId>:<action>` keys live in
      `STATIC_SKILL_TOOL_NAMES_BY_ACTION`. v6 corrects.
      [CLAUDE.md vs Phase 0.4 contradiction] §6.21 snippet said custom
      `child_loop` is benign because the manifest fence still applies; Phase
      0.4 makes custom `child_loop` → `undefined` at compile, so there is
      nothing for the fence to act on. v6 rewrites §6.21 to match Phase 0.4.
      [test parallelism] new tests `parent-force-blocked-for-child-owned`,
      `agent-runtime-stage-n-boot-assertion`, and
      `turn-engine-budget-warning-no-suppression-for-child-loop` may touch
      child-runner singletons; v6 renames them to `skill-child-*` prefix so
      they fall into `test:serial-skill-child` per package.json:27 +
      scripts/run-parallel-tests.cjs:32 (singleton-safe serial group).
  - v5 (2026-05-06): codex RED on v4 — 3 narrow findings:
      [import bug] boot assertion called `getStaticSkillToolNameForAction` but
      only imported `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`. v5 imports the helper
      and removes the unused reverse-table import.
      [custom-skill claim overclaim] v4 said custom `child_loop` is benign;
      codex correctly noted dynamic skill tool names are NOT in
      `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`, so the manifest fence at the
      synthesis site cannot catch them. v5 closes this by **rejecting custom
      `child_loop` declarations at compile time** (`skill-compiler.ts:463`):
      if `source !== 'embedded'` and the manifest declares `child_loop`,
      `normalizeChildLoop` returns `undefined` with a console.warn. The
      effective rule: only embedded skills can declare child_loop; custom
      attempts are silently dropped to keep them safe (no parent-force fence
      gap). The boot assertion's `customWithChildLoop` path becomes
      unreachable in normal flow — kept as belt for unit tests that bypass
      the compiler.
      [residual wrong-table wording] Scenario F2 + risk register at the
      cited lines updated from `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` →
      `STATIC_SKILL_TOOL_NAMES_BY_ACTION` for `skillId:action` references.
      Also fixes "awaited inside createWindow" → "synchronously called
      inside async function createWindow" (codex (d) wording nit).
  - v4 (2026-05-06): codex RED on v3 — 4 narrow findings:
      [Phase 0.2 table name] v3 named `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`
      (computed via Object.fromEntries at skills-tools-static.ts:42-47).
      v4 corrects: gate parses the forward literal
      `STATIC_SKILL_TOOL_NAMES_BY_ACTION` at lines 27-36 (regex-feasible,
      multi-line `<skillId>:<action>` quoted keys).
      [boot assertion over all skills] v3 looped over ALL `listSkills()`
      including user-installed custom skills. A custom skill declaring
      `child_loop.actions[]` (which `skill-compiler.ts:463` does normalize)
      would abort Ready boot — bad UX. v4 filters to `source === 'embedded'`;
      custom skills with `child_loop` are surfaced as a separate non-fatal
      warning (and the static gate skips them too).
      [stale script name in CLAUDE.md] v3's §6.21 snippet referenced retired
      `scripts/check-child-loop-manifest-vs-driver.cjs`. v4 fixes to
      `scripts/check-manifest-vs-static-tool-name.cjs`.
      [boot-failure UX overclaim] v3 leaned on CLAUDE.md §6.13 native DB
      dialog. That path is DB-specific. v4 documents the actual failure
      shape: throw escapes AgentControlRuntime constructor → bubbles to
      ipc-handler → caught by `unhandledRejection` process handler
      (`process-handlers.ts:141-145`) → process exits. Developer-grade,
      not user-grade. Acceptable for an invariant violation that should
      never ship.
  - v3 (2026-05-06): codex RED on v2 — 4 finding clusters remained:
      [R1 partial / new#4] manifest⇔static-name-registry not gated; v3 adds
      `scripts/check-manifest-vs-static-tool-name.cjs` covering "every
      child_loop.actions[] entry has matching STATIC_SKILL_ACTIONS_BY_TOOL_NAME
      entry" + boot assertion mirror.
      [R3 unfixed] manifest⇔driver regex couldn't parse current source
      (registration is `registerSkillChildDriver(veaDriver)` with the skillId
      on a class field, not a literal in the call). v3 retires the static
      manifest⇔driver gate; the runtime boot assertion (Phase 0.3) is the
      authoritative cross-check via `getSkillsRuntimeManager().listSkills()`
      ↔ `listRegisteredSkillChildDrivers()`. Static gate scope narrows to
      manifest ↔ static-name-registry only.
      [R6 partial] Phase 3 variable was `executedToolName` but live local is
      `toolName` (extracted from `executedTool.name` at turn-engine.ts:3869).
      v3 corrects.
      [new#2/#3] Phase 0.3 boot assertion has no `bootSkillRuntime` insertion
      point and must run OUTSIDE the existing try/catch. v3 places it in the
      AgentControlRuntime constructor AFTER the configureSkillChildRunner
      try/catch (runtime.ts:355-369), so it throws uncaught.
      [Y2 partial] regex-lite gate story tightened — only static-data ↔
      static-data checks; runtime introspection handles the registration
      shape that regex can't.
---

# Stage N (Stage 8) — Parent loop steps back; child loop owns long-skill execution

> Stage M (commit `8546a2d`) closed the per-turn read view. Stage N closes the
> **execution-ownership boundary**: long-skill execution is the child runner's
> job. The parent loop only **launches**, **resumes**, **cancels**, and
> **observes**. The legacy "parent synthesizes a typed `tool_use` for the next
> long-skill action" path is fenced for any **embedded** skill whose
> `ready-skill.json` declares `child_loop.actions[]` (equivalently: any skill
> whose compiled `definition.childLoop` is non-empty after Phase 0.4
> compiler normalization), regardless of whether the active contract carries
> `childRunId`. Custom-source skills cannot opt into child-loop in this
> stage — Phase 0.4 strips their `child_loop` declaration at compile.

## 0. Why this stage now

The child runner already exists (`skill-child-runner.ts`,
`skill-child-drivers.ts`, `video-expert-child-driver.ts`). VEA actions
(`video_expert_pipeline`, `video_expert_ai_analyze`) route via
`dispatchChildLoopSkillAction` and `turn-engine.ts:3251` already early-returns
when `shouldParentForceLongSkillTool(contract) === false` (i.e. when
`contract.childRunId` is set). The machinery still alive:

1. **Force-tool synthesis branch** (`turn-engine.ts:3252-3440`). Active for any
   skill whose contract does not yet carry `childRunId`. A future long-skill
   shipping without `child_loop` manifest declaration would silently fall
   back to typed-tool synthesis. Stage N closes that.
2. **`forceLoopGuard` cross-turn state** (`run-contracts.ts:977-987`).
   "Migration-only" but still written and read every turn for non-child-owned
   contracts. The field's existence is a magnet for new force-paths.
3. **`DEFAULT_RESUME_ACTION_BY_SKILL_ID` table** (`turn-frame-steering.ts:37`).
   Currently empty. Nothing prevents a future PR from re-populating it for a
   long-skill — restoring the exact ownership inversion this stage retires.
4. **`lastLongTypedSkillActionIteration` budget-warning suppression**
   (`turn-engine.ts:35-46, 3858-3871`). v1 wrongly assumed unreachable for
   child-loop; codex confirmed reachable via `dispatchChildLoopSkillAction`
   → `turn-engine.ts:3858-3871`. Real fence required, not doc-only.
5. **Driver-registry vs. manifest mismatch.** `isChildLoopSkillAction` requires
   BOTH `isChildOwnedSkill(skillId)` (driver-registry based:
   `skill-child-drivers.ts:74-80`) AND `isConfiguredChildLoopSkillAction`
   (manifest-based: `child-loop-skill-actions.ts:64-68`). A manifest-only
   declaration with no driver registration silently falls through to inline
   `runSkill` at `skills-tools.ts:1881-1900`. Stage N adds a
   manifest-⇔-driver invariant gate so this can't happen.

User-visible payoff: removing the marker `// Phase 6 — child-loop short-circuit`
at `turn-engine.ts:3243-3268`, replaced with a single hard rule:

> **Any embedded skill whose `ready-skill.json` declares `child_loop.actions[]`
> (equivalently: any skill whose compiled `definition.childLoop` is non-empty)
> is owned by the child runner. The parent NEVER synthesizes a typed
> `tool_use` for those actions. Enforced by runtime + tests + CI gate.
> Custom skills cannot declare child-loop in this stage — Phase 0.4 strips
> the field at compile time.**

## 1. Invariants this stage establishes

**N1. Long-skill ownership is an embedded-manifest property.** A skill is
"child-owned" iff (a) it is embedded-source AND (b) its `ready-skill.json`
declares `child_loop.actions[]` (≥1 entry). After Phase 0.4 compile-time
normalization this is equivalent to: `definition.childLoop?.actions?.length
>= 1`. `isConfiguredChildLoopSkillAction(skillId, action)` already encodes
the post-compile check (`child-loop-skill-actions.ts:64-68`); custom skills
fail this predicate because their compiled `definition.childLoop` is
`undefined`.

**N2. Manifest ⇔ driver invariant.** Every manifest that declares
`child_loop.actions[]` MUST have a matching driver registered via
`registerSkillChildDriver` (so `isChildOwnedSkill(skillId) === true`).
Enforced at runtime via the boot assertion in Phase 0.3 — runtime
introspection of `getSkillsRuntimeManager().listSkills()` ↔
`listRegisteredSkillChildDrivers()`. v3 deliberately does NOT add a static
regex-based gate for this invariant: live VEA registration is
`registerSkillChildDriver(veaDriver)` (`video-expert-child-driver.ts:651`)
with the `skillId` on a class field
(`readonly skillId = VEA_SKILL_ID` at `:400`); a regex that captures
`skillId:` inside the call would fail current source. The boot assertion
introspects the actual registries — authoritative — and throws OUTSIDE the
existing `configureSkillChildRunner` try/catch (`runtime.ts:355-369`) so a
violation aborts boot rather than getting swallowed.

**N2b. Manifest ⇔ static-name-registry invariant.** Every action listed in a
manifest's `child_loop.actions[]` MUST also appear in the **forward** literal
`STATIC_SKILL_TOOL_NAMES_BY_ACTION` (`skills-tools-static.ts:27-36`) as a
`<skillId>:<action>` key mapped to the registered `skill_*` tool name.
Without this, `isParentForceForbiddenByManifest` (which reverse-maps via
`STATIC_SKILL_ACTIONS_BY_TOOL_NAME` at `skills-tools-static.ts:42-47` —
itself derived from the forward literal) cannot resolve the tool name back
to skillId/action and the fence silently returns false. Enforced by:
- static CI gate `scripts/check-manifest-vs-static-tool-name.cjs` (regex on
  the **forward literal** at `skills-tools-static.ts:27-36` — pure
  declarative table, regex-feasible);
- mirror runtime check inside the same boot assertion (Phase 0.3) using
  `getStaticSkillToolNameForAction(skillId, action)` (the helper at
  `skills-tools-static.ts:38-40`), so a test environment that bypasses the
  static gate still fails closed.

**N3. Parent never synthesizes a typed `tool_use` for a manifest-declared
child-loop action.** `turn-engine.ts:3252` introduces a manifest fence:
```ts
const candidateForceToolName = (
  turnFrame
    && turnFrame.steering?.mode === 'force_tool'
    && !forceToolDispatchedThisTurn
    && typeof turnFrame.steering.requiredToolName === 'string'
    && turnFrame.steering.requiredToolName
    && Array.isArray(routedAllowedToolNames)
    && routedAllowedToolNames.includes(turnFrame.steering.requiredToolName)
) ? turnFrame.steering.requiredToolName : null

const childOwnedByContract = !shouldParentForceLongSkillTool(turnFrame?.skill?.runContract || null)
const childOwnedByManifest = isParentForceForbiddenByManifest(candidateForceToolName)
const childOwnedSkill = childOwnedByContract || childOwnedByManifest

const forceToolName = (!childOwnedSkill) ? candidateForceToolName : null
```
- When `childOwnedByContract === true` (existing behavior): zero metrics, fall
  through, model decides; `forceLoopGuard` skipped.
- When `childOwnedByContract === false && childOwnedByManifest === true` (new):
  emit `turn_force_tool_blocked_child_owned`, push system reminder topic
  `force-tool-blocked-child-owned` (priority 92), set
  `budgetLimitedBeforeCompletion = true`, apply
  `framePatch: { terminalReason: 'checkpoint_user_input' }` (existing
  vocabulary — Stage M priority rank 10), `break` to post-loop checkpoint.
- When neither: existing legacy force-tool path; `forceLoopGuard` reads/writes
  unchanged.

**N4. Parent's only long-skill verbs are launch / resume / cancel / observe.**
- launch: `dispatchChildLoopSkillAction` (`skills-tools.ts:1881`)
- resume: `computeChildContinuationDecision` (`turn-engine.ts:487`) →
  `resumeSkillChildRun` (`turn-engine.ts:2021`)
- cancel: `cancelSkillChildRun` (`turn-engine.ts:1878`)
- observe: `getCloseEvent(childRunId)`; close events flow as `framePatch`.

**N5. `forceLoopGuard` writes are unreachable for child-loop.** The write site
at `turn-engine.ts:3413` lives inside the `else if (forceToolName)` branch. With
N3's `forceToolName === null` for child-loop, the branch is statically
unreachable. v2 adds a Phase 1.3 invariant belt (`assert.ok` style metric +
`budgetLimitedBeforeCompletion = true` + `break`) so a future regression
reaching this branch fails-closed.

**N6. `lastLongTypedSkillActionIteration` is fenced for child-loop typed
results.** The write at `turn-engine.ts:3871` runs after `consumeExecutedToolBatch`
when a long-skill typed action completes. Codex confirmed this IS reached for
VEA child-loop launches (the `child_launched` envelope still flows through
typed-action result handling). v2 adds a runtime guard before the write:
```ts
const executedSkillId = …
const executedAction = …
const isChildLoopExecution = !!executedSkillId && !!executedAction
  && isConfiguredChildLoopSkillAction(executedSkillId, executedAction)
if (!isChildLoopExecution) {
  lastLongTypedSkillActionIteration = iterations
}
```

**N7. Negative tests lock the closure.** Behavior tests cover the manifest
fence, the contract fence, the legacy non-child-loop path, the budget-warning
fence, and the manifest-⇔-driver invariant.

## 2. Concrete changes

### Phase 0 — Confirm child-owned alternative completeness + manifest⇔driver gate

**Goal:** prove the child-owned path covers every existing long-skill action,
and add the manifest⇔driver invariant gate before any deletion.

#### 0.1 Inventory (no code change)

- [ ] List child-loop manifests:
  ```bash
  grep -l '"child_loop"' assets/embedded-skills/*/ready-skill.json
  ```
  Expected: only `video-expert-analyzer/ready-skill.json` (actions
  `video_expert_pipeline`, `video_expert_ai_analyze`).

- [ ] List driver registrations:
  ```bash
  grep -n 'registerSkillChildDriver' src/main/modules/agent-control/*.ts
  ```
  Expected: `video-expert-child-driver.ts` registers driver for
  `video-expert-analyzer`. Confirm 1:1 with manifest list.

- [ ] List parent-loop entry points to force-tool synthesis:
  ```bash
  grep -n 'requiredToolName\|forceToolName' \
    src/main/modules/agent-control/turn-engine.ts \
    src/main/modules/agent-control/turn-frame-steering.ts
  ```
  Confirm only `turn-engine.ts:3252` synthesizes; `turn-frame-steering.ts`
  only sets `requiredToolName` on the steering object.

- [ ] List long-skill verbs the parent calls:
  ```bash
  grep -nE 'startSkillChildRun|startSkillChildRunAndWait|resumeSkillChildRun|cancelSkillChildRun|computeChildContinuationDecision|getCloseEvent' \
    src/main/modules/agent-control/turn-engine.ts \
    src/main/modules/skills-runtime/runtime-manager.ts \
    src/main/modules/tools/skills-tools.ts \
    src/main/modules/rss-engine/item-analysis-manager.ts
  ```
  Confirm every verb (launch / resume / cancel / observe) has a non-force-tool
  call site. If a verb has only force-tool entry, it is a Phase 1 prerequisite,
  not a Phase 2 deletion target.

Output: append a Phase 0 markdown subsection to this plan with the recorded
inventory.

#### 0.2 Manifest ⇔ static-name-registry gate (regex-feasible)

**File:** `scripts/check-manifest-vs-static-tool-name.cjs` (new)

For each `assets/embedded-skills/*/ready-skill.json`:
- If manifest has no `child_loop`, skip.
- Else: extract manifest id (top-level `"id"` field or directory name) and
  every action in `manifest.child_loop.actions[]`.
- For each action `A`, assert that `STATIC_SKILL_TOOL_NAMES_BY_ACTION` in
  `src/main/modules/tools/skills-tools-static.ts:27` contains a key
  `<manifest.id>:<A>`. Reverse: every entry in
  `STATIC_SKILL_TOOL_NAMES_BY_ACTION` whose `<skillId>` is the id of a
  manifest with `child_loop` MUST have its `<action>` listed in that
  manifest's `child_loop.actions[]` (catches drift in the other direction).

Both source files are pure declarative tables, so regex is sufficient:
- Manifests: `JSON.parse(readFileSync(...))` — fully structural, no regex.
- Static table: parse the **forward literal**
  `STATIC_SKILL_TOOL_NAMES_BY_ACTION` at `skills-tools-static.ts:27-36`
  (the multi-line `Record<string, string>` with quoted `<skillId>:<action>`
  keys mapping to quoted tool names). v3 wrongly named the reverse table
  `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` which is computed via
  `Object.fromEntries(Object.entries(...).map(...))` at
  `skills-tools-static.ts:42-47` and has no source-readable literal shape.
  Regex: `/['"]([\w-]+):([\w-]+)['"]\s*:\s*['"]([\w_]+)['"]/g` extracts
  `(skillId, action, toolName)` triples. The script header documents the
  forward-table parsing decision.

Custom skill scope: the gate **skips** any embedded-skills directory entry
that doesn't appear in `assets/embedded-skills/` (custom user-installed
skills live elsewhere and are not bundled). A custom skill declaring
`child_loop` is a separate non-fatal class — see Phase 0.3 for the
`source === 'embedded'` filter.

**Note (v3):** v2's "manifest⇔driver" static gate is RETIRED. Driver
registration uses class-field `skillId` (not a literal inside the call), so
regex parsing is brittle. The runtime boot assertion in Phase 0.3 is the
authoritative manifest⇔driver check.

**File:** `scripts/__tests__/check-manifest-vs-static-tool-name.test.cjs` (new)

- Positive: current source passes (VEA's two actions match exactly).
- Negative 1: temp-edit `skills-tools-static.ts` to remove the
  `'video-expert-analyzer:video_expert_pipeline'` entry → gate fails with
  "manifest action missing static tool name".
- Negative 2: temp-add a fixture manifest under a sandbox embedded-skills dir
  with `child_loop.actions: ['phantom_action']` while the static map has no
  matching entry → gate fails with the same reason. (Test uses an env-var
  override of the embedded-skills root path, not the real directory.)
- Negative 3: temp-add a static map entry `'video-expert-analyzer:phantom'`
  → gate fails with "static tool action not declared in manifest".

#### 0.3 Runtime startup assertion (manifest⇔driver + manifest⇔static-name)

**File:** `src/main/modules/agent-control/runtime.ts`

The current insertion point is the `AgentControlRuntime` constructor at
`runtime.ts:355-369`. The existing `try { configureSkillChildRunner(...) }
catch { console.warn(...) }` block is best-effort — failures are swallowed.
The Stage N assertion runs **after** that try/catch and **outside** of it,
so violations throw uncaught and abort boot:

```ts
// File: src/main/modules/agent-control/runtime.ts
// Insertion point: immediately after the existing try/catch at :355-369.

import { listRegisteredSkillChildDrivers } from './skill-child-drivers'
import { getSkillsRuntimeManager } from '../skills-runtime/runtime-manager'
import { getStaticSkillToolNameForAction } from '../tools/skills-tools-static'

// ... existing constructor body ...
try {
  configureSkillChildRunner({ runtimeManager: getSkillsRuntimeManager(), ... })
} catch (error) {
  console.warn('[AgentControlRuntime] configureSkillChildRunner failed:', ...)
}

// Stage N — manifest⇔driver + manifest⇔static-name boot invariants.
// Throws uncaught (NOT inside the configureSkillChildRunner try/catch) so a
// violation aborts boot; fixing it requires either registering a driver or
// removing the manifest's `child_loop` declaration.
this.assertStageNChildLoopInvariants()
```

The method on `AgentControlRuntime`:

```ts
private assertStageNChildLoopInvariants(): void {
  const skills = getSkillsRuntimeManager().listSkills()
  const drivers = new Set(listRegisteredSkillChildDrivers())
  const driverOrphans: string[] = []
  const staticNameOrphans: Array<{ skillId: string; action: string }> = []
  const customWithChildLoop: string[] = []

  for (const skill of skills) {
    const childLoopActions = skill.childLoop?.actions || []
    if (childLoopActions.length === 0) continue

    // v5 — only embedded skills are subject to the boot invariant. v5
    // ALSO rejects custom `child_loop` at compile time (see Phase 0.4 in
    // this plan), so this branch should be unreachable in normal flow.
    // We keep it as belt for unit tests that bypass the compiler (e.g.
    // by injecting a synthetic SkillState into the listSkills() return).
    // No abort — only a console.warn — because the manifest fence cannot
    // reverse-look-up dynamic custom tool names in
    // `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`, so a runtime abort here would
    // be both pointless (no fence regression possible since custom
    // child_loop is dropped at compile) AND user-hostile.
    if (skill.source !== 'embedded') {
      customWithChildLoop.push(skill.id)
      continue
    }

    if (!drivers.has(skill.id)) {
      driverOrphans.push(skill.id)
    }
    for (const action of childLoopActions) {
      // Use the forward mapping helper (skills-tools-static.ts:38-40):
      // getStaticSkillToolNameForAction(skillId, action) returns the
      // registered tool name or null. Null === orphan.
      const toolName = getStaticSkillToolNameForAction(skill.id, action)
      if (!toolName) {
        staticNameOrphans.push({ skillId: skill.id, action })
      }
    }
  }

  if (customWithChildLoop.length > 0) {
    console.warn(
      `[AgentControlRuntime] custom skills declare child_loop (Phase 0.4 should have dropped these at compile; reaching this branch indicates a test that bypassed skill-compiler): ${customWithChildLoop.join(', ')}`,
    )
  }

  const violations: string[] = []
  if (driverOrphans.length > 0) {
    violations.push(
      `embedded manifests declare child_loop but no driver registered: ${driverOrphans.join(', ')}`,
    )
  }
  if (staticNameOrphans.length > 0) {
    violations.push(
      `embedded manifest child_loop actions missing in STATIC_SKILL_TOOL_NAMES_BY_ACTION: ${
        staticNameOrphans.map(({ skillId, action }) => `${skillId}:${action}`).join(', ')
      }`,
    )
  }
  if (violations.length > 0) {
    throw new Error(`[Stage N invariant] ${violations.join('; ')}`)
  }
}
```

Why outside the existing try/catch: the `configureSkillChildRunner` catch is
intentional best-effort behavior (test harness without DB still boots). The
Stage N invariants are correctness, not best-effort — a misregistered driver
silently dropping a long skill back to the parent-force path is the exact
failure Stage N closes. v4 documents the actual failure path (codex v3 RED
correction):

The `throw` escapes the `AgentControlRuntime` constructor. Calling site is
`setupAgentIPC` (`src/main/modules/claude-bridge/ipc-handler.ts:173-176`,
returns `void`, **synchronous** call — not `await`), invoked inside the
async `createWindow()` (`src/main/index.ts:330`) without a local catch.
The synchronous throw promotes into the async function's rejection chain;
`createWindow()` itself is floated at app startup as
`void createWindow().then(...)` (`src/main/index.ts:707`) without a
`.catch`. The unhandled rejection is caught by the global process handler
at `src/main/process-handlers.ts:141-145`, which logs and exits the process.

This is **developer-grade** failure (process exits with stack in stderr),
NOT user-grade (no `dialog.showErrorBox` like the primary-DB hardgate at
`src/main/index.ts:241-249`). That is acceptable here because: (a) Stage N
invariants must hold at build time (the **Phase 0.2 static gate
`scripts/check-manifest-vs-static-tool-name.cjs` covers manifest⇔static-name
only**, and the **Phase 0.3 boot-assertion test
`skill-child-stage-n-boot-assertion.test.ts` in `verify:n` covers
manifest⇔driver and the static-name mirror at runtime construction**, so
verify:n catches both invariant violations in CI before merge); (b)
violation should never reach a shipped build; (c) the developer running
`npm run dev` will see the stack immediately and the message names the
offending skillId.

Future: if a Stage N+1 finds this UX inadequate (e.g. CI wasn't run
locally and the developer is surprised), wrap the assertion in
`dialog.showErrorBox(...)` + `app.exit(1)` mirroring the DB hardgate.

(v7: above paragraph already states the synchronous call shape; the v4
"awaited" wording has been removed. Same source citations.)

#### 0.4 Compile-time rejection of custom `child_loop`

**File:** `src/main/modules/skills-runtime/skill-compiler.ts`

The current compile path normalizes `child_loop` for any source:
```ts
// skill-compiler.ts:463
const childLoop = normalizeChildLoop(manifest?.child_loop ?? manifest?.childLoop, actions, id)
```

Stage N rejects custom-source `child_loop` at compile time. Modify
`compileSkillDefinition` (or whichever function holds the `source` resolution
relative to the `normalizeChildLoop` call) to drop `child_loop` before it
reaches `normalizeChildLoop` if `source !== 'embedded'`:

```ts
// Inside compileSkillDefinition (skill-compiler.ts), around line 463.
// `source` is one of 'embedded' | 'custom'; both are resolved earlier.
const rawChildLoop = manifest?.child_loop ?? manifest?.childLoop
const childLoop =
  rawChildLoop !== undefined && source !== 'embedded'
    ? (() => {
        console.warn(
          `[skill-compiler] custom skill ${id} declares child_loop; dropping (Stage N: only embedded skills may opt into child-loop runtime).`,
        )
        return undefined
      })()
    : normalizeChildLoop(rawChildLoop, actions, id)
```

The behavior:
- Custom skill with `child_loop` declaration: definition's `childLoop` is
  `undefined`. Static fence cannot fire (action's tool name is dynamic, not
  in `STATIC_SKILL_TOOL_NAMES_BY_ACTION`); driver is impossible to register.
  The custom skill simply behaves as a non-child-loop skill — its typed
  action goes through the legacy `runSkill` path (long-blocking) like any
  other custom skill today.
- Embedded skill with `child_loop`: unchanged path through
  `normalizeChildLoop`.

**Test:** `src/__tests__/skill-child-compiler-custom-child-loop-drop.test.ts` (new)
- Compile a custom-source manifest with `child_loop.actions: ['x']` →
  resulting `definition.childLoop` is `undefined`, console.warn emitted.
- Compile an embedded-source manifest with the same `child_loop` → result
  preserves `childLoop` as before.

### Phase 1 — Negative tests + manifest-aware runtime fence

#### 1.1 Add manifest-aware runtime predicate

**File:** `src/main/modules/agent-control/run-contracts.ts`

```ts
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../tools/child-loop-skill-actions'

/**
 * Stage N — manifest-aware fence. True when the supplied tool name maps to a
 * `child_loop.actions[]` entry of the owning skill (manifest-based, NOT
 * driver-registry based — N2 invariant ensures the two agree, but this fence
 * is intentionally manifest-only so a misregistered driver cannot accidentally
 * re-open the parent-force path).
 *
 * Tool-name → (skillId, action) lookup uses `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`
 * (skills-tools-static.ts:42-47). For dynamic skill tool names that are not
 * in the static map, the lookup is `null` and this fence returns false — the
 * runtime startup assertion (Phase 0.3) prevents shipping a child-loop skill
 * whose tool names are not statically registered.
 */
export function isParentForceForbiddenByManifest(
  toolName: string | null | undefined,
): boolean {
  if (typeof toolName !== 'string' || !toolName) return false
  const entry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName]
  if (!entry) return false
  return isConfiguredChildLoopSkillAction(entry.skillId, entry.actionName)
}
```

Two key differences from v1:
- Takes `toolName` directly, not `(skillId, toolName)` pair. Uses the existing
  `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` reverse-lookup table
  (`skills-tools-static.ts:42-47`). No string slicing.
- Returns false (not error) for unknown tool names. The Phase 0.2 static gate
  + Phase 0.3 boot assertion (N2b manifest⇔static-name invariant) ensure
  every manifest-declared `child_loop` action has a static-table entry, so
  this branch only returns false for non-skill tool names — never for a
  child-loop action that should be fenced. Codex v2 review (RED 1 partial)
  flagged that v2 over-claimed safety here; v3 closes the gap with N2b's
  explicit invariant.

#### 1.2 Runtime fence at the synthesis site

**File:** `src/main/modules/agent-control/turn-engine.ts`

**Imports:** the existing import at `:325` only brings in
`shouldParentForceLongSkillTool` from `run-contracts`. Phase 1.2 must
extend this import to also pull in `isParentForceForbiddenByManifest`:

```ts
// turn-engine.ts (top imports — extend the existing run-contracts import)
import {
  shouldParentForceLongSkillTool,
  isParentForceForbiddenByManifest,   // ← add this line
} from './run-contracts'
```

Replace lines 3251-3261 with the candidate-vs-blocked split:

```ts
// Stage N — split candidate from "child-owned guard" so the manifest fence
// has a non-null tool name to emit metrics against (codex v1→v2 R2).
const candidateForceToolName = (
  turnFrame
    && turnFrame.steering?.mode === 'force_tool'
    && !forceToolDispatchedThisTurn
    && typeof turnFrame.steering.requiredToolName === 'string'
    && turnFrame.steering.requiredToolName
    && Array.isArray(routedAllowedToolNames)
    && routedAllowedToolNames.includes(turnFrame.steering.requiredToolName)
) ? turnFrame.steering.requiredToolName : null

const childOwnedByContract = !shouldParentForceLongSkillTool(turnFrame?.skill?.runContract || null)
const childOwnedByManifest = isParentForceForbiddenByManifest(candidateForceToolName)
const childOwnedSkill = childOwnedByContract || childOwnedByManifest
const forceToolName = (!childOwnedSkill) ? candidateForceToolName : null

// Stage N — when the contract fence does not fire but the manifest fence does,
// surface a checkpoint instead of falling through to the model. This catches
// the adoption-state case (manifest says child-owned, contract not yet
// stamped with childRunId).
if (
  candidateForceToolName
  && !childOwnedByContract
  && childOwnedByManifest
) {
  logAgentMetric('turn_force_tool_blocked_child_owned', {
    sessionId: request.sessionId,
    skillId: turnFrame?.skill?.skillId || null,
    toolName: candidateForceToolName,
    reason: 'manifest_child_loop',
    iteration: iterations,
  })
  pushSystemReminderMessage(session, {
    topic: 'force-tool-blocked-child-owned',
    priority: 92,
    text: [
      `系统补充：本轮 force_tool 已被 child-loop 边界挡板（tool=${candidateForceToolName}）。`,
      '该 skill 的长任务由 child runner 拥有，父循环不再合成 typed tool_use。',
      '请等待 child 运行的 close event 或在下一轮明确指示 cancel/resume。',
    ].join('\n'),
  })
  host.log(
    `[turn_force_tool_blocked_child_owned] tool=${candidateForceToolName} skillId=${turnFrame?.skill?.skillId || 'null'} iteration=${iterations}`,
  )
  budgetLimitedBeforeCompletion = true
  if (turnFrame) {
    turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: 'checkpoint_user_input' })
  }
  break
}
```

Place this block immediately after the `forceToolName` derivation, BEFORE the
existing `priorGuard` / `wouldRepeat` logic. The early `break` exits the
iteration loop (same shape as the existing checkpoint at `:3370-3378`).

The metric `turn_force_tool_blocked_child_owned` is a local string metric
(matching existing `turn_force_tool_dispatched` / `turn_force_tool_checkpoint`
shape at `:3353-3362`). NOT in `TOOL_ERROR_METRICS` (codex R7 confirmed
CLAUDE.md §6.11 separates the two).

#### 1.3 Symmetrical write-fence belt for `forceLoopGuard`

**File:** `src/main/modules/agent-control/turn-engine.ts`

After Phase 1.2 lands, the `else if (forceToolName)` branch at `:3379` is
unreachable for child-loop because `forceToolName === null` for them. But
defense-in-depth: insert a belt at `:3405` (top of the `if (turnFrame &&
turnFrame.skill)` block):

```ts
if (turnFrame && turnFrame.skill) {
  // Stage N belt — child-loop should never reach this branch after Phase 1.2.
  // If a future refactor regresses, fail closed instead of writing the guard.
  if (isParentForceForbiddenByManifest(forceToolName)) {
    logAgentMetric('turn_force_tool_invariant_violation', {
      sessionId: request.sessionId,
      skillId: turnFrame.skill.skillId,
      toolName: forceToolName,
      reason: 'guard_write_for_child_owned',
      iteration: iterations,
    })
    host.log(
      `[turn_force_tool_invariant_violation] tool=${forceToolName} skillId=${turnFrame.skill.skillId} iteration=${iterations}`,
    )
    // Mid-iteration checkpoint, mirror the synthesis fence at :3370.
    budgetLimitedBeforeCompletion = true
    turnFrame = applyTurnFramePatch(turnFrame, { terminalReason: 'checkpoint_user_input' })
    break
  }
  // ... existing dispatchedAt / newDigest / sameAsPrior / guardPatch
}
```

Codex R5: setting `budgetLimitedBeforeCompletion = true` before `break` is
mandatory; otherwise the post-loop path returns `done` (per
`turn-engine.ts:4311-4312` checkpoint gate vs `:4483` default-done path).

#### 1.4 Negative tests

**File:** `src/__tests__/skill-child-parent-force-blocked.test.ts` (new)

Behavior tests using real `defaultToolRegistry`, real
`STATIC_SKILL_ACTIONS_BY_TOOL_NAME`, real `isConfiguredChildLoopSkillAction`,
real VEA manifest from `assets/embedded-skills/video-expert-analyzer/ready-skill.json`:

1. **Case A — manifest-only fence.** Contract `{ skillId:
   'video-expert-analyzer', childRunId: null }`. Steering forces
   `skill_video_expert_pipeline`. Expect: 0× `turn_force_tool_dispatched`, 1×
   `turn_force_tool_blocked_child_owned`, terminal turn closes via checkpoint
   path with `terminalReason: 'checkpoint_user_input'`, no `forceLoopGuard`
   write.

2. **Case B — contract fence wins.** Contract `{ skillId:
   'video-expert-analyzer', childRunId: 'vabcd1234' }`. Steering would force.
   Expect: 0× `turn_force_tool_dispatched`, 0× `turn_force_tool_blocked_child_owned`,
   no `force-tool-blocked-child-owned` reminder injected. Note: Phase 1.2
   computes `childOwnedByManifest` unconditionally as part of the OR with
   `childOwnedByContract`; the predicate IS computed in Case B, just not
   acted on (the early-break guard requires `!childOwnedByContract`).
   Test asserts the metric/reminder absence, not the predicate path.

3. **Case C — non-child-loop legacy path lives.** Contract for fixture
   `legacy-non-child-loop-skill`, no `child_loop` declared. Steering forces
   `skill_legacy_typed_action_a`. Expect: 1×
   `turn_force_tool_dispatched`, 0× `turn_force_tool_blocked_child_owned`,
   `forceLoopGuard` written.

   > Test hook (v9): the test patches
   > `defaultToolRegistry.getToolDefinitionForExecution(toolName)` to
   > return a synthesized definition for the fixture tool name. It does
   > NOT mutate `STATIC_SKILL_TOOL_NAMES_BY_ACTION` (which is module-load-
   > computed and would risk cross-test pollution). The patch is restored
   > in `afterEach`. The fixture's `legacy-non-child-loop-skill` is
   > defined in `src/__tests__/fixtures/skills/legacy-non-child-loop-skill.ts`
   > as a pure data export — no manifest file is created.

(Codex Y1: Case D from v1 dropped — exposed test hook over-engineered.)

#### 1.5 Re-target existing legacy force-tool tests

**File:** `src/__tests__/turn-engine-force-tool-dispatch.test.ts`

The three tests at `:605`, `:681`, `:774` assert force-tool semantics for VEA
without `childRunId`. With Phase 1.2 in place, these will FAIL because the
manifest fence catches VEA tool names regardless of contract state.

Re-target to use `legacy-non-child-loop-skill` fixture (same fixture as Case C):
- Replace `skill_video_expert_pipeline` with `skill_legacy_typed_action_a`.
- Replace `skill_video_expert_ai_analyze` with `skill_legacy_typed_action_b`.
- Keep all assertion shapes (`forceDispatched.length`, `dispatchedToolNames`,
  one-per-turn cap).
- Rename test titles from "VEA score-batch resume" to "non-child-loop typed
  action".

The test at `:1166` (`Phase 6: turn-engine never dispatches force_tool for VEA
when contract.childRunId is set`) stays as-is — it locks the contract fence
(N4) for VEA specifically. v2 adds an additional assertion: 0×
`turn_force_tool_blocked_child_owned` (proves contract fence reaches first,
N3 manifest fence not consulted).

### Phase 2 — Static CI gate

#### 2.1 Gate behavior — `scripts/check-no-parent-force-for-child-loop.cjs`

Three assertions, all regex-lite (per Stage M pattern;
`scripts/check-frame-write-single-source.cjs:7-11` for documentation
precedent):

1. **No child-loop action in `DEFAULT_RESUME_ACTION_BY_SKILL_ID`.**
   Read `turn-frame-steering.ts`, find the literal `DEFAULT_RESUME_ACTION_BY_SKILL_ID`
   declaration, parse the object literal entries with `/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g`.
   For each `(skillId, action)`, look up
   `assets/embedded-skills/<skillId>/ready-skill.json` and reject if action
   is in `child_loop.actions[]`. Today the literal is empty → trivial pass.

2. **`turn-engine.ts` synthesis site has both fences.**
   Read `turn-engine.ts`, find the line containing `const childOwnedByContract`,
   assert the surrounding 30 lines reference both `shouldParentForceLongSkillTool`
   AND `isParentForceForbiddenByManifest`. Fails if either is missing.

3. **`forceLoopGuard` write site has the invariant belt.**
   Find the literal `guardPatch:` (must be unique in the file), assert the
   preceding 100 lines reference `isParentForceForbiddenByManifest`.

Limitations (documented in script header, per Stage M precedent):
- Regex doesn't follow renamed identifiers, indirect import aliases, or
  multi-line Object literal in DEFAULT_RESUME_ACTION_BY_SKILL_ID.
- Future Stage N.1 may upgrade to `@typescript-eslint/parser` AST.

#### 2.2 Gate self-tests

**File:** `scripts/__tests__/check-no-parent-force-for-child-loop.test.cjs` (new)

- Positive: current source passes.
- Negative 1: temp-edit `turn-frame-steering.ts` to add VEA entry → fails with
  "child-loop action in default-resume table".
- Negative 2: temp-edit `turn-engine.ts` to remove
  `isParentForceForbiddenByManifest` reference → fails with "synthesis fence
  missing manifest predicate".
- Negative 3: temp-edit `turn-engine.ts` to remove the invariant belt
  reference → fails with "guardPatch write missing invariant belt".

### Phase 3 — Fence `lastLongTypedSkillActionIteration` for child-loop

(Codex R6: confirmed reachable; runtime fence required. v3 corrects the
variable name from v2's `executedToolName` to live source's `toolName`.)

**File:** `src/main/modules/agent-control/turn-engine.ts`

The exact write site is `:3870-3872`:

```ts
// turn-engine.ts:3868-3872 (live source as of v3 audit)
const toolName = executedTool.name
if (isLongTypedSkillActionName(toolName)) {
  lastLongTypedSkillActionIteration = iterations
}
```

Replace with the child-loop fence (no new local variable; reuses `toolName`):

```ts
const toolName = executedTool.name
if (isLongTypedSkillActionName(toolName)) {
  // Stage N — child-loop typed actions launch a child run via
  // dispatchChildLoopSkillAction; the typed-action result is a
  // `child_launched` placeholder, not a real long-action completion. Treating
  // them as "long-skill-completed" silences the next iteration's budget
  // warning (`shouldInjectBudgetWarning` consults
  // `lastLongTypedSkillActionIteration`), which is wrong for child-loop.
  const childLoopEntry = STATIC_SKILL_ACTIONS_BY_TOOL_NAME[toolName] || null
  const isChildLoopExecution = !!childLoopEntry
    && isConfiguredChildLoopSkillAction(childLoopEntry.skillId, childLoopEntry.actionName)
  if (!isChildLoopExecution) {
    lastLongTypedSkillActionIteration = iterations
  }
}
```

Imports to add at the top of `turn-engine.ts`:

```ts
import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../tools/skills-tools-static'
import { isConfiguredChildLoopSkillAction } from '../tools/child-loop-skill-actions'
```

(`isConfiguredChildLoopSkillAction` is already exported from
`src/main/modules/tools/child-loop-skill-actions.ts:64`.)

**File:** `src/__tests__/skill-child-budget-warning-no-suppression.test.ts` (new)

Behavior test:
- Run `turn-engine` with a session that completes a `dispatchChildLoopSkillAction`
  call (returns `child_launched` envelope).
- Assert `lastLongTypedSkillActionIteration` is NOT set (introspect via the
  next iteration's budget-warning behavior — if it suppresses, fence broken;
  if it warns normally, fence holds).
- Negative-of-negative: run a non-child-loop typed action (test fixture from
  Case C), assert `lastLongTypedSkillActionIteration` IS set.

### Phase 4 — Documentation + verify wiring

#### 4.1 `docs/architecture/skill-child-loop-boundary.md`

- §5.4 closure table: add row "Parent never synthesizes force `tool_use` for
  manifest-declared child-loop action" → enforced by N3 runtime fence + N2
  manifest⇔driver invariant + Phase 2 CI gate.
- §6 "Migration sketch": rewrite as "Migration closed in Stage N (commit
  TBD)".
- New §7 (Stage N): document the two fences (contract + manifest), the
  decision tree, the manifest⇔driver invariant, and the deferred
  `forceLoopGuard` field retirement (Stage N+1).

#### 4.2 CLAUDE.md §6.21

```
- Stage N (Stage 8) 起 parent loop 不再为 manifest-declared `child_loop.actions[]`
  合成 typed `tool_use`。判定包含两条独立 fence：契约级
  `shouldParentForceLongSkillTool(contract)`（看 `childRunId`）+ manifest 级
  `isParentForceForbiddenByManifest(toolName)`（用 `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`
  反查 + `isConfiguredChildLoopSkillAction`）。两条均独立生效，缺一不可。
- N2 invariant：每个声明 `child_loop.actions[]` 的**embedded** manifest 必须
  有匹配的 `registerSkillChildDriver` 注册。`AgentControlRuntime` 构造函数
  里的 boot assertion (`assertStageNChildLoopInvariants`) 会在
  manifest⇔driver 不一致或 manifest⇔静态名映射缺失时直接 throw，进程通过
  全局 unhandledRejection handler 退出。
- N2b invariant：每个 embedded manifest 的 `child_loop.actions[]` 都必须在
  `STATIC_SKILL_TOOL_NAMES_BY_ACTION`（forward literal，
  `skills-tools-static.ts:27-36`）里有对应的 `<skillId>:<action>` 条目。
  `scripts/check-manifest-vs-static-tool-name.cjs` 是硬门；boot assertion 是
  runtime 镜像。
- Custom（非 embedded）skill 在 `skill-compiler.ts` 编译期被剥除 `child_loop`
  字段（console.warn 提示），所以编译产物的 `definition.childLoop` 永远是
  undefined。这意味着自定义 skill 的动态 typed-action **不会** 被 N3 manifest
  fence 接管（动态 tool 名也不在 `STATIC_SKILL_TOOL_NAMES_BY_ACTION` 里），但
  也不会进入 child-loop 路径——它们走 legacy `runSkill`，与今日普通 custom
  skill 一致。如果未来需要 custom skill 走 child-loop，必须先升级到 embedded
  source 并补齐 driver 注册 + 静态名映射。
- 运行时违反 invariant 抛 `turn_force_tool_invariant_violation`（local string metric，
  不在 `TOOL_ERROR_METRICS`），并由 `scripts/check-no-parent-force-for-child-loop.cjs`
  阻止源头回归。
```

#### 4.3 `package.json`

```json
"verify:n": "npm run verify:m && node scripts/check-manifest-vs-static-tool-name.cjs && node scripts/check-no-parent-force-for-child-loop.cjs && npm run test:n:gates && npm run test:n:focus",
"test:n:gates": "node --test scripts/__tests__/check-manifest-vs-static-tool-name.test.cjs scripts/__tests__/check-no-parent-force-for-child-loop.test.cjs",
"test:n:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-child-parent-force-blocked.test.ts src/__tests__/skill-child-budget-warning-no-suppression.test.ts src/__tests__/turn-engine-force-tool-dispatch.test.ts src/__tests__/skill-child-stage-n-boot-assertion.test.ts src/__tests__/skill-child-compiler-custom-child-loop-drop.test.ts"
```

`verify` (top-level): `npm run verify:native && npm run verify:n && npm run test`.

### Phase 5 — Final regression sweep

- [ ] `npm run typecheck` passes.
- [ ] `npm run verify:n` passes.
- [ ] `npm run verify:native` passes (CLAUDE.md §6.13). Stage N does not
      change SQLite shape, but the gate must still hold.
- [ ] Manual smoke against a live VEA session in dev:
  1. Start a new VEA analysis with a URL.
  2. Confirm `dispatchChildLoopSkillAction` envelope `child_launched` returns,
     parent emits no `turn_force_tool_dispatched` metric.
  3. Force-stop the run, restart Ready, confirm resume goes through
     `resumeSkillChildRun` (no force-tool synthesis in
     `ready-directchat.log`).
  4. Cancel mid-run, confirm `cancelSkillChildRun` emits one `child_terminal`
     with `terminalReason: 'cancelled_user'`, no `failed` mapping.

## 3. Files map

### Create

- `src/__tests__/skill-child-parent-force-blocked.test.ts`
- `src/__tests__/skill-child-budget-warning-no-suppression.test.ts`
- `src/__tests__/fixtures/skills/legacy-non-child-loop-skill.ts`
- `src/__tests__/skill-child-stage-n-boot-assertion.test.ts`
  (covers Phase 0.3 — manifests with `child_loop` but no driver / no
   static-name entry must throw at construction)
- `src/__tests__/skill-child-compiler-custom-child-loop-drop.test.ts`
  (covers Phase 0.4 — custom-source `child_loop` dropped at compile)
- `scripts/check-manifest-vs-static-tool-name.cjs`
- `scripts/check-no-parent-force-for-child-loop.cjs`
- `scripts/__tests__/check-manifest-vs-static-tool-name.test.cjs`
- `scripts/__tests__/check-no-parent-force-for-child-loop.test.cjs`
- `scripts/__tests__/fixtures/embedded-skills/fake-child-loop/ready-skill.json`
  (sandbox fixture for gate self-test, used via env-var override of the
   embedded-skills root path)

### Modify

- `src/main/modules/agent-control/run-contracts.ts`
  (export `isParentForceForbiddenByManifest`)
- `src/main/modules/agent-control/turn-engine.ts`
  (Phase 1.2 candidate-vs-blocked split + manifest fence;
  Phase 1.3 invariant belt;
  Phase 3 `lastLongTypedSkillActionIteration` fence)
- `src/main/modules/agent-control/runtime.ts`
  (Phase 0.3 manifest⇔driver boot assertion)
- `src/main/modules/skills-runtime/skill-compiler.ts`
  (Phase 0.4 — drop `child_loop` for `source !== 'embedded'`)
- `src/main/modules/agent-control/system-reminder-registry.ts`
  (append `'force-tool-blocked-child-owned'` to the `ReminderTopic` union
   at `:17`; required by Phase 1.2's reminder push)
- `src/main/modules/agent-control/system-reminder-assembly.ts`
  (add `'force-tool-blocked-child-owned': []` entry to `DEFAULT_CONFLICTS`
   at `:5-19`; no conflicts — coexists with
   `force-tool-checkpoint-blocked` because Phase 1.2 fires the two on
   disjoint branches)
- `src/__tests__/turn-engine-force-tool-dispatch.test.ts`
  (re-target VEA fixtures to non-child-loop legacy fixture)
- `package.json`
  (`verify:n` / `test:n:focus` / `test:n:gates`; update top-level `verify`)
- `docs/architecture/skill-child-loop-boundary.md` (§5.4, §6, new §7)
- `CLAUDE.md` (§6.21)

### Read-only consult (no modify expected)

- `src/main/modules/tools/child-loop-skill-actions.ts`
- `src/main/modules/tools/skills-tools-static.ts`
- `src/main/modules/agent-control/skill-child-drivers.ts`
- `src/main/modules/agent-control/skill-child-runner.ts`
- `assets/embedded-skills/video-expert-analyzer/ready-skill.json`

## 4. Acceptance scenarios

(Same as v1; v2 fixes the metric vocabulary per codex R4.)

### Scenario A — VEA without childRunId on contract (manifest fence)

Input: contract `{ skillId: 'video-expert-analyzer', childRunId: null,
action: 'video_expert_pipeline' }`. Steering forces
`skill_video_expert_pipeline`.

Expected:
- 0× `turn_force_tool_dispatched`
- 1× `turn_force_tool_blocked_child_owned` with `reason='manifest_child_loop'`
- Turn closes via checkpoint with `terminalReason='checkpoint_user_input'`
- No `forceLoopGuard` write
- System reminder topic `force-tool-blocked-child-owned` (priority 92) injected

### Scenario B — VEA with childRunId (contract fence)

Input: contract has `childRunId: 'vabcd1234'`. Steering would force.

Expected:
- 0× `turn_force_tool_dispatched`
- 0× `turn_force_tool_blocked_child_owned` (contract fence reached first)
- Existing Stage 6 close-event flow proceeds

### Scenario C — non-child-loop legacy path lives

Input: contract for fixture skill `legacy-non-child-loop-skill`. Steering
forces `skill_legacy_typed_action_a`.

Expected:
- 1× `turn_force_tool_dispatched`
- 0× `turn_force_tool_blocked_child_owned`
- `forceLoopGuard` written for next turn

### Scenario D — gate self-test: PR adding VEA to default-resume table

PR adds `'video-expert-analyzer': 'video_expert_pipeline'` to
`DEFAULT_RESUME_ACTION_BY_SKILL_ID`. Expected: `verify:n` fails at
`check-no-parent-force-for-child-loop.cjs` with reason
"child-loop action in default-resume table".

### Scenario E — gate self-test: PR removes manifest fence

PR removes `isParentForceForbiddenByManifest` reference from `turn-engine.ts`.
Expected: `verify:n` fails with reason "synthesis fence missing manifest
predicate".

### Scenario F — manifest⇔driver invariant fires (runtime-only path)

PR adds a new embedded skill manifest with `child_loop.actions[]` AND
adds the matching `STATIC_SKILL_TOOL_NAMES_BY_ACTION` entry (so Phase 0.2
static gate passes), but **omits** the `registerSkillChildDriver` call.
Expected:
- Static gate `check-manifest-vs-static-tool-name.cjs` PASSES (the
  static-name entry is present; the gate only verifies that, not driver
  registration).
- Runtime: when `AgentControlRuntime` is constructed (boot path), the
  Phase 0.3 assertion throws with "embedded manifests declare child_loop
  but no driver registered: <skillId>". Ready aborts boot.

Note: if the PR adds the manifest declaration WITHOUT the static-name
entry, Phase 0.2 catches it earlier in CI (Scenario F2 below).

### Scenario F2 — manifest ⇔ static-name invariant fires (static gate path)

PR adds a new embedded manifest with `child_loop.actions: ['phantom_action']`
but omits the corresponding entry in `STATIC_SKILL_TOOL_NAMES_BY_ACTION`
(`skills-tools-static.ts:27`). Expected:
- `verify:n` fails at `check-manifest-vs-static-tool-name.cjs` with
  "manifest action missing static tool name".
- If the static gate is bypassed, the boot assertion catches it with
  "embedded manifest child_loop actions missing in STATIC_SKILL_TOOL_NAMES_BY_ACTION".

### Scenario F3 — custom skill `child_loop` is silently dropped (compile-time)

A custom user-installed skill ships `ready-skill.json` with
`child_loop.actions: ['x']`. Expected:
- `skill-compiler.ts` emits console.warn and returns `definition.childLoop
  = undefined`.
- The custom skill behaves as a non-child-loop skill — its typed action
  (if exposed) flows through legacy `runSkill`, identical to any custom
  skill today.
- No boot abort; no parent-force fence regression (because the action's
  dynamic tool name was never in the static table to begin with).

### Scenario G — child-loop budget-warning suppression fence

A `dispatchChildLoopSkillAction` returns `child_launched`. Expected:
- `lastLongTypedSkillActionIteration` is NOT set
- Next iteration's budget-warning behavior runs normally (no silent
  suppression)

## 5. Risk register

| Risk | Detection | Fallback |
| --- | --- | --- |
| Embedded skill action declared in manifest `child_loop.actions[]` but missing in `STATIC_SKILL_TOOL_NAMES_BY_ACTION` (`skills-tools-static.ts:27`) | Phase 0.2 static gate + Phase 0.3 boot assertion catch at build/boot | Add the entry to the static table (or remove the manifest declaration) |
| Custom skill ships `child_loop` declaration | Phase 0.4 compile-time drop with console.warn (`skill-compiler.ts`) | None — the manifest fence cannot reverse-look-up dynamic custom tool names; v5 dropped these to close the gap. Custom skills wanting child-loop must move to embedded source. |
| `:3871` write site has different local variable for executed tool | Phase 3 audit step | Adjust the fence code to match actual variable; test still asserts behavior |
| Static gate v1 regex misses multi-line Object literal | Negative self-test for the multi-line shape | Upgrade to AST in Stage N.1 |
| Re-targeted legacy tests lose coverage of legacy-path metric shape | v1.5 retains all assertion shapes | Diff the test before/after; if any assert drops, restore |
| `forceLoopGuard` field still on contract type after Stage N | Documented as deferred | Stage N+1 entry in tracker |
| `legacy-non-child-loop-skill` fixture leaks invariant breakage between tests | `__breaksInvariants` declaration + `try/finally` restore | Test reviewer checklist |

## 6. Out of scope

- Deleting `forceLoopGuard` field from `SkillRunContract`. Stage N+1.
- Migrating non-VEA long skills to child-loop. None exist today.
- Removing `lastLongTypedSkillActionIteration` entirely. Phase 3 fences for
  child-loop only.
- Replacing `force_tool` mode for non-skill tools (no such tools exist).
- Generic skill-DSL beyond `child_loop.actions[]`.

## 7. Stage N implementation notes (filled during execution)

(Phase 0 inventory + execution-time deviations recorded here as Phase 0.4
through Phase 5 land. Empty in v2 draft.)

## 8. Verification command sequence

```bash
# Phase 0 inventory
grep -l '"child_loop"' assets/embedded-skills/*/ready-skill.json
grep -n 'registerSkillChildDriver' src/main/modules/agent-control/*.ts

# Phase 0.2 manifest ⇔ static-name gate (regex on static data)
node scripts/check-manifest-vs-static-tool-name.cjs
node --test scripts/__tests__/check-manifest-vs-static-tool-name.test.cjs

# Phase 0.3 boot assertion (runtime introspection)
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-stage-n-boot-assertion.test.ts

# Phase 1 negative tests
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-parent-force-blocked.test.ts \
  src/__tests__/turn-engine-force-tool-dispatch.test.ts

# Phase 2 gate self-tests
node scripts/check-no-parent-force-for-child-loop.cjs
node --test scripts/__tests__/check-no-parent-force-for-child-loop.test.cjs

# Phase 3 budget-warning suppression
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-budget-warning-no-suppression.test.ts

# Full stage gate
npm run verify:n

# Native gate (CLAUDE.md §6.13)
npm run verify:native
```

## 9. Commit boundaries

1. `chore(verify): add Stage N manifest⇔static-name gate` (Phase 0.2)
2. `feat(skills): drop child_loop for non-embedded skills at compile` (Phase 0.4)
3. `feat(agent): Stage N boot assertion for child-loop manifest invariants` (Phase 0.3)
3. `test: add Stage N negative coverage for parent force on child-loop skills` (Phase 1.4 — expected RED before runtime fence)
4. `feat(agent): manifest-aware parent-force fence for child-loop skills` (Phase 1.1 + 1.2)
5. `chore(agent): invariant belt for forceLoopGuard write site` (Phase 1.3)
6. `test: re-target legacy force-tool tests off VEA fixture` (Phase 1.5)
7. `chore(verify): add Stage N source-gate for parent-force-on-child-loop` (Phase 2)
8. `fix(agent): fence budget-warning suppression marker for child-loop` (Phase 3)
9. `docs(agent): mark Stage N parent ownership boundary` (Phase 4.1, 4.2)
10. `chore(verify): wire verify:n into top-level verify` (Phase 4.3)

Each commit must pass `verify:m` at minimum; commits 6+ must pass `verify:n`.
