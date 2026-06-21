---
title: P6u · C30 run-contract parent-force fence island implementation
date: 2026-06-21
phase: P6u
enforce: true
depends:
  - outputs/agent-audit/fix-plan/437-SUBAGENT-P6U-ROUTE-SELECTION-REVIEW.md
  - outputs/agent-audit/fix-plan/438-CLAUDE-P6U-OPUS-DYNAMIC-WORKFLOW-PROMPT.md
---

# P6u · C30 Run-Contract Parent-Force Fence Island Implementation

## Goal

Close one narrow C30 preflight: extract the parent-force fence helpers
(`shouldParentForceLongSkillTool`, `isParentForceForbiddenByManifest`) out of
`run-contracts.ts` into a small dedicated island, re-export them from
`run-contracts.ts` to keep every call site stable, and lock the split with a
structural gate.

This mirrors the already-proven P6s loader-island split. It is a second,
independent island carved from the same giant file — proving the pattern
generalizes — not the end of the giant-file split.

## Non-Goals

- Not deleting, broadly splitting, or relayouting the rest of `run-contracts.ts`.
- Not moving `SkillRunContract`, `loadSkillRunContract`, or
  `buildContractFramePatch` (those are the P6s island; this slice leaves them
  untouched).
- Not touching `turn-engine.ts` execution logic. The legacy force_tool
  boundary checks keep consuming both helpers through the stable
  `run-contracts.ts` import path.
- Not changing parent-force, child-loop, frame-patch, or projection behavior.
  This is a no-behavior-change move.
- Not closing C30 or P6, and not retiring TurnEngine/DirectChat.
- Out of scope entirely: C29, C32, map/amap errorKind, clipping/content-study,
  browser identity/profile/session isolation, P2b shell isolation, and any
  product/UI work.

## Exact Touch Set

Create:

- `src/main/modules/agent-control/contracts/skill-parent-force-fence.ts`
- `scripts/check-run-contract-parent-force-island.cjs`
- `scripts/__tests__/check-run-contract-parent-force-island.test.cjs`

Edit:

- `src/main/modules/agent-control/contracts/run-contracts.ts` (delete the two
  helper definitions + their now-unused `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` /
  `isConfiguredChildLoopSkillAction` imports; add a value re-export from
  `./skill-parent-force-fence`)
- `package.json` (add the `verify:evolution-p6u` alias)

Closeout docs under `outputs/agent-audit/fix-plan/` as needed.

No other file changes. `git diff --check` must be clean.

## Contract

### Island Ownership

`skill-parent-force-fence.ts` owns:

- `shouldParentForceLongSkillTool(contract: unknown): boolean`
- `isParentForceForbiddenByManifest(toolName: string | null | undefined): boolean`
- the two imports those helpers require, verbatim from their current home:
  - `import { STATIC_SKILL_ACTIONS_BY_TOOL_NAME } from '../../tools/skills-tools-static'`
  - `import { isConfiguredChildLoopSkillAction } from '../../tools/child-loop-skill-actions'`

The helper bodies move byte-for-byte; no logic edits. Their doc comments move
with them.

### Public Compatibility

`run-contracts.ts` keeps the public import path stable by re-exporting both
helpers:

```ts
export { shouldParentForceLongSkillTool, isParentForceForbiddenByManifest } from './skill-parent-force-fence'
```

`turn-engine.ts` (synthesis fence + `guardPatch` write belt) and every other
call site must continue importing both helpers from `run-contracts.ts` with no
change. After the move, `run-contracts.ts` no longer imports
`skills-tools-static` or `child-loop-skill-actions` for these helpers.

### Gate

`check-run-contract-parent-force-island.cjs` mirrors the P6s gate shape
(regex-lite, `stripComments`, exported `check({ root })`, exit 1 with explicit
reason strings). It enforces:

- `run-contracts.ts` does **not** directly define
  `shouldParentForceLongSkillTool` or `isParentForceForbiddenByManifest`
  (`export function …`).
- `run-contracts.ts` does **not** import `skills-tools-static`,
  `skills-tools`, or `child-loop-skill-actions`.
- `run-contracts.ts` re-exports both helpers from `./skill-parent-force-fence`.
- `skill-parent-force-fence.ts` exports both helpers.
- `skill-parent-force-fence.ts` owns the imports of
  `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` and `isConfiguredChildLoopSkillAction`.

Gate self-tests cover the passing split shape plus each failing shape
(old-shape helper definitions in `run-contracts.ts`, residual
`skills-tools-static` import, missing re-export, island missing a helper
export, island missing an owned import).

## Work Packages

Each package is sized for one Codex pass.

1. **Add `skill-parent-force-fence.ts`.** New file in the `contracts/`
   directory. Add the two imports and paste the two helper functions
   (`shouldParentForceLongSkillTool`, `isParentForceForbiddenByManifest`)
   verbatim, including their doc comments. Export both.

2. **Move, don't copy.** Delete the two helper definitions from
   `run-contracts.ts`, and delete the now-unused `STATIC_SKILL_ACTIONS_BY_TOOL_NAME`
   and `isConfiguredChildLoopSkillAction` imports there. Confirm no other code
   in `run-contracts.ts` still references those two imports before deleting
   them (they are used only by the two moved helpers).

3. **Re-export from `run-contracts.ts`.** Add the value re-export line for both
   helpers from `./skill-parent-force-fence`, alongside the existing
   `./skill-run-contract-loader` re-export block.

4. **Add `check-run-contract-parent-force-island.cjs`.** Implement the gate per
   the Gate contract above, copying the structure of
   `check-run-contract-loader-island.cjs`.

5. **Add gate self-tests.** `scripts/__tests__/check-run-contract-parent-force-island.test.cjs`
   with a temp-dir harness (passing harness + each failing shape), copying the
   structure of `check-run-contract-loader-island.test.cjs`.

6. **Add `verify:evolution-p6u`.** New `package.json` script that runs the gate,
   the gate self-test, the existing parent-force behavior assets, and the P6s
   loader-island gate (to prove the two islands coexist):

   ```
   node scripts/check-run-contract-parent-force-island.cjs
   node --test scripts/__tests__/check-run-contract-parent-force-island.test.cjs
   node scripts/check-no-parent-force-for-child-loop.cjs
   node --test scripts/__tests__/check-no-parent-force-for-child-loop.test.cjs
   npx tsx@^4.19.2 --test --test-concurrency=1 \
     src/__tests__/skill-child-parent-force-blocked.test.ts \
     src/__tests__/skill-child-run-end-to-end.test.ts \
     src/__tests__/turn-engine-force-tool-dispatch.test.ts
   npm run verify:evolution-p6s
   ```

## Structural Gate Acceptance

`check-run-contract-parent-force-island.cjs` MUST fail when:

- `run-contracts.ts` defines either helper directly
  (`export function shouldParentForceLongSkillTool` /
  `export function isParentForceForbiddenByManifest`).
- `run-contracts.ts` imports `skills-tools-static`, `skills-tools`, or
  `child-loop-skill-actions`.
- the new island does not export both helpers.
- the new island does not own the imports of
  `STATIC_SKILL_ACTIONS_BY_TOOL_NAME` and `isConfiguredChildLoopSkillAction`.

It MUST pass on the intended split: helpers defined and imports owned in
`skill-parent-force-fence.ts`, both helpers re-exported from
`run-contracts.ts`, and `run-contracts.ts` free of the two tools imports.

## Behavior Verification

The move changes no behavior; these EXISTING assets must stay green:

- `scripts/check-no-parent-force-for-child-loop.cjs` and its self-test — the
  Stage N synthesis fence + `guardPatch` write belt still resolve both helper
  names in `turn-engine.ts` through the stable re-export.
- `src/__tests__/skill-child-parent-force-blocked.test.ts` — child-owned
  contracts still block the parent force path.
- `src/__tests__/skill-child-run-end-to-end.test.ts`.
- `src/__tests__/turn-engine-force-tool-dispatch.test.ts`.
- `npm run verify:evolution-p6s` — the P6s loader island gate still passes,
  proving the loader island and the parent-force island coexist without
  regressing the public surface of `run-contracts.ts`.

## Exit Commands

```bash
npm run verify:evolution-p6u
npm run typecheck
git diff --check
```

## Review Checklist (Codex, after Claude)

- Confirm no business code beyond the planned slice is in the plan: only the
  two helper definitions move + their two imports + the re-export; no
  `turn-engine.ts` logic change, no `SkillRunContract`/loader change, no
  unrelated `run-contracts.ts` edits.
- Confirm no overclaim: the plan must not assert C30 or P6 is complete; this is
  one island extraction + guard, with the broader split still open.
- Confirm tests are behavior-backed plus gate-backed: the new structural gate
  has self-tests, and the no-behavior-change claim is anchored to existing
  parent-force behavior tests plus the P6s gate, not to source grep alone.

## Explicit Exclusions

This slice does not cover:

- moving `SkillRunContract`, the loader, or any further `run-contracts.ts`
  split beyond the two parent-force helpers;
- any `turn-engine.ts` execution-path change;
- C29 dormant runtime retirement; C32 / map-amap / clipping-content-study
  errorKind families; browser identity/profile/session isolation; P2b shell
  isolation; specialist-agent product/UI work;
- full C30 or full P6 closure.
