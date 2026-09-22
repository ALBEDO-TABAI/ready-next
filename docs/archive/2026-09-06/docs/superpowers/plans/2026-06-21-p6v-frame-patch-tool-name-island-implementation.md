---
title: P6v · Frame-Patch Tool-Name Island Implementation
date: 2026-06-21
branch: agent-evolution/phase1
enforce: false
author: Claude Code CLI (--model opus)
source:
  - outputs/agent-audit/final/02-CODEX-INDEPENDENT-CANONICAL-FINDINGS.md   # C29/C30/C31/C32 canonical
  - outputs/agent-audit/fix-plan/00-ROADMAP.md                            # roadmap truth surface
  - outputs/agent-audit/fix-plan/441-P6U-C30-PARENT-FORCE-ISLAND-CLOSEOUT.md # last C30 island (precedent)
  - outputs/agent-audit/fix-plan/443-ROADMAP-P6U-CALIBRATION-SUBAGENT-AUDIT.md # P6u calibration
  - outputs/agent-audit/fix-plan/444-CLAUDE-P6V-REMAINING-PLAN-PROMPT.md  # this planning prompt
  - outputs/agent-audit/fix-plan/445-CLAUDE-P6V-REMAINING-PLAN.md         # Claude plan
  - outputs/agent-audit/fix-plan/446-CODEX-P6V-PLAN-REVIEW.md             # Codex plan corrections
  - outputs/agent-audit/fix-plan/448-CLAUDE-P6V-IMPLEMENTATION-REVIEW.md  # implementation review hardening note
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6v Remaining Plan — Frame-Patch Tool-Name Island

## Verdict

**PICK — C30 follow-up.** One narrow slice: extract the frame-patch tool-name
logic island (`FRAME_PATCH_EMITTING_TOOL_NAMES` + `isFramePatchEmittingToolName`)
out of `run-contracts.ts` into its own module, preserve all public imports via
re-export, and add a structural anti-reflow gate.

This is the third C30 god-object extraction in the same proven shape as **P6s**
(SkillRunContract loader island) and **P6u** (parent-force fence island). It is
the smallest remaining island in `run-contracts.ts` that is *pure logic* (a
constant + a predicate function with embedded logic), has a single production
importer, and can be moved with zero behavior change.

This slice **does not** close full C30, full P6, the giant-file split, C29,
C31, or C32.

## Why this slice is next (vs. at least two alternatives)

### The C30 island method is the live, de-risked path

`run-contracts.ts` is the canonical god-object cited by C30
(`02-CODEX-INDEPENDENT-CANONICAL-FINDINGS.md:398-407`, alongside
`agent-sdk-runtime.ts`, `browser-tools.ts`, `skill-child-runner.ts`). C30 is
"confirmed but downgraded — structural debt, split it gradually alongside other
fixes, do not do a single big refactor" (lines 401-407). The roadmap's chosen
method is exactly this: P6s extracted the loader, P6u extracted the parent-force
fence, each with a re-export shim + a non-reflow gate. After P6u, the file is
**1196 lines / 41,655 bytes** and is now almost entirely type/interface
definitions; the only remaining standalone *logic* island is the frame-patch
tool-name pair at `run-contracts.ts:1145-1192`. Picking it continues the exact
de-risked pattern the user has already approved twice.

Evidence it is a clean island:
- `src/main/modules/agent-control/contracts/run-contracts.ts:1155` —
  `FRAME_PATCH_EMITTING_TOOL_NAMES` (5-element `readonly` literal).
- `src/main/modules/agent-control/contracts/run-contracts.ts:1172` —
  `isFramePatchEmittingToolName(toolName)` (self-contained predicate; only
  dependency is the constant on the line above and a local `PRIMITIVE_NAMES`
  set).
- Importers are exactly **one production callsite + two tests**, all importing
  from the `run-contracts` barrel, so a re-export keeps every callsite byte-for-byte:
  - `src/main/modules/agent-control/tools-runtime/tool-parallelism-policy.ts:2-3`
  - `src/__tests__/turn-frame-patch.test.ts:27-28`
  - `src/__tests__/skill-run-contract-shape.test.ts:26-28`

### Alternative A — C29 remaining (TurnEngine/DirectChat retirement): DEFER

C29 is "multiple compaction codepaths coexist; pick the live one, demote/delete
the dormant" (`02-...FINDINGS.md:387-394`). P6t already removed the DirectChat
legacy callable send entry, and P6f/P6j/P6o already fenced the dormant execution
boundary and dormant compaction ownership. What remains for C29 is the actual
**deletion of the TurnEngine/DirectChat shells** — the route-selection reviewer
for P6u explicitly said "defer C29; P6t already closed the clearest small C29
slice" (`441-P6U-...CLOSEOUT.md:79-80`). The next real C29 step is a deletion
proof that spans `direct-chat.ts`, `turn-engine.ts`, and their dormant
references — broader than a single island, and not yet de-risked. Defer.

### Alternative B — C32 remaining (map/amap, projection status, run_state status): DEFER vs. this slice

C32 is "same rule hand-written in many places → extract shared enum/type guard +
drift gate" (`02-...FINDINGS.md:419-426`). P6d/P6h/P6i/P6k/P6l/P6m/P6n/P6q/P6r
have already drained the errorKind-drift families. The route reviewer for P6u
noted "map/amap is valid later work, but broader than the C30 island"
(`441-...CLOSEOUT.md:81-83`). A C32 map/amap or projection-status unification
touches multiple call sites across the runtime and needs its own discovery of
every hand-written copy before a shared source can be authored — strictly larger
than moving one already-isolated constant+predicate. The frame-patch island is
smaller, lower-risk, and keeps C30 progressing without stalling on a C32
discovery pass. Defer C32 to a later slice.

### Why C30-island beats both right now

- It is the **smallest** safe unit (one constant + one function, one production
  importer).
- It is **fully de-risked** by P6s and P6u — same shim, same gate shape, same
  verify chaining.
- It moves the roadmap materially: after this slice, `run-contracts.ts` has
  **no remaining standalone logic islands**, leaving only the type/interface
  body — which clarifies that any *further* C30 work on this file is the larger
  wire/internal type split (the dormant Stage U U4.1 plan referenced at
  `run-contracts.ts:1-20`), a deliberately separate decision.

## Scope — in

1. New module
   `src/main/modules/agent-control/contracts/skill-frame-patch-tool-names.ts`
   containing `FRAME_PATCH_EMITTING_TOOL_NAMES` and
   `isFramePatchEmittingToolName`, moved verbatim (no behavior change, same
   doc-comments).
2. `run-contracts.ts`: delete the two definitions; add a re-export
   `export { FRAME_PATCH_EMITTING_TOOL_NAMES, isFramePatchEmittingToolName } from './skill-frame-patch-tool-names'`
   so all three existing importers compile unchanged.
   - **Header constraint (`run-contracts.ts:15-19`):** the file header says
     *"Do NOT add new exports to this file"* (Stage U U4.1a). The P6v re-export
     does **not** add a new conceptual/public export: both
     `FRAME_PATCH_EMITTING_TOOL_NAMES` and `isFramePatchEmittingToolName` are
     *already* public exports from this barrel today; P6v only moves their
     definition site into the island and preserves the same two names via the
     shim — identical to the P6s/P6u precedent, which the same header already
     accommodated. Net public export names from `run-contracts.ts` are unchanged.
3. New structural gate
   `scripts/check-run-contract-frame-patch-island.cjs`, modeled on
   `check-run-contract-parent-force-island.cjs`. It must:
   - **Strip comments before matching** (reuse the P6u gate's `stripComments`
     helper) so the old doc comments left around the former definition site
     cannot cause false positives.
   - Fail if the comment-stripped `run-contracts.ts` defines **either**
     `const FRAME_PATCH_EMITTING_TOOL_NAMES` **or**
     `function isFramePatchEmittingToolName` or a local
     `const/let/var isFramePatchEmittingToolName`. The predicate check must
     catch both bare functions and arrow-form local variables (no leading
     `export` requirement) so a non-exported local copy is also caught —
     exactly the non-exported-definition gap the P6u reviewer caught
     (`441-...CLOSEOUT.md:86-90`), plus the P6v implementation-review
     hardening from `448`.
   - Fail if the re-export shim from `./skill-frame-patch-tool-names` is missing.
4. Gate self-test
   `scripts/__tests__/check-run-contract-frame-patch-island.test.cjs`
   (passing-harness + each failure mode, mirroring the P6u self-test).
5. New `verify:evolution-p6v` script in `package.json`, chaining the new gate +
   self-test + the two behavior tests that exercise the symbols + chaining
   `verify:evolution-p6u`.
6. Roadmap sync per the §0 anti-expansion rule (`00-ROADMAP.md:549`): source
   list, refresh paragraph, §0 re-verify table row, §1.1 phase table row, §2
   queue item, §3 P4/P5/P6 summary, §4 gate index, §5 doc index — each must say
   "frame-patch tool-name island only; not full C30/P6".

## Scope — out

- **No** dedup of the local `PRIMITIVE_NAMES` set inside
  `isFramePatchEmittingToolName` against `FRAME_PATCH_EMITTING_TOOL_NAMES`. They
  are deliberately different sets (the predicate's primitive set lists 9 names
  incl. `skill_ask_user`/`skill_run_shell`/artifact tools; the constant lists 5
  frame-emitting names). Merging them would change behavior — explicitly a
  non-goal of a surgical move. Note it as an observed smell only.
- **No** edits to `tool-parallelism-policy.ts` or either test file (the
  re-export keeps their imports valid). Touching them would broaden the diff.
- **No** Stage U U4.1 wire/internal type split, and **no** deletion of
  `run-contracts.ts` (U4.1e). That is a separate, larger refactor.
- **No** C29 TurnEngine/DirectChat deletion, **no** C31 redaction, **no** C32
  map/amap or projection-status unification.
- **No** P2b shell isolation, **no** browser identity/session/profile isolation,
  **no** specialist-agent product work.

## Exact files likely to change

| File | Change |
|---|---|
| `src/main/modules/agent-control/contracts/skill-frame-patch-tool-names.ts` | **new** — moved constant + predicate (verbatim) |
| `src/main/modules/agent-control/contracts/run-contracts.ts` | remove the two defs at lines ~1145-1192; add re-export near the existing loader re-exports (lines 1194-1195) |
| `scripts/check-run-contract-frame-patch-island.cjs` | **new** — anti-reflow gate |
| `scripts/__tests__/check-run-contract-frame-patch-island.test.cjs` | **new** — gate self-test |
| `package.json` | **new** `verify:evolution-p6v` script |
| `outputs/agent-audit/fix-plan/00-ROADMAP.md` | sync per anti-expansion rule |

No existing production source other than `run-contracts.ts` changes; one new
island module (`skill-frame-patch-tool-names.ts`) is added.

## Tests / gates to add or extend

Add:
- `check-run-contract-frame-patch-island.cjs` — strips comments first (P6u
  `stripComments`), then asserts:
  - the comment-stripped `run-contracts.ts` does **not** contain
    `const FRAME_PATCH_EMITTING_TOOL_NAMES` nor a bare
    `function isFramePatchEmittingToolName` nor local
    `const/let/var isFramePatchEmittingToolName` (no `export` prefix required,
    so a non-exported local copy is also caught — match the P6u non-exported
    guard and the P6v arrow-form hardening);
  - `run-contracts.ts` **does** contain a re-export of both symbols from
    `./skill-frame-patch-tool-names`;
  - the island module **does** export both symbols.
- `check-run-contract-frame-patch-island.test.cjs` — passing harness + one
  failing harness per error code.

Extend:
- `package.json` →
  `"verify:evolution-p6v": "node scripts/check-run-contract-frame-patch-island.cjs && node --test scripts/__tests__/check-run-contract-frame-patch-island.test.cjs && npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/turn-frame-patch.test.ts src/__tests__/skill-run-contract-shape.test.ts && npm run verify:evolution-p6u"`

The two chained behavior tests already exercise both symbols
(`turn-frame-patch.test.ts:284-325`, `skill-run-contract-shape.test.ts:300-333`),
so they prove the move preserved behavior; chaining P6u keeps the prior islands
green.

## Acceptance criteria

1. `npm run verify:evolution-p6v` passes:
   - frame-patch island gate OK;
   - gate self-tests pass (passing harness + every failure mode);
   - `turn-frame-patch.test.ts` and `skill-run-contract-shape.test.ts` pass
     unchanged;
   - chained `verify:evolution-p6u` (incl. its chained `verify:evolution-p6s`)
     stays green.
2. `npm run typecheck` passes with the three importers untouched.
3. `git diff --check` clean.
4. The frame-patch constant + predicate exist in exactly one definition site
   (the new island); `run-contracts.ts` only re-exports them.
5. **Importers stay unchanged (shim proof):** `tool-parallelism-policy.ts`,
   `turn-frame-patch.test.ts`, and `skill-run-contract-shape.test.ts` keep
   importing both symbols from the `run-contracts` barrel (no import-path edits)
   and still pass — proving the re-export shim preserves every callsite. Net
   public export names from `run-contracts.ts` are unchanged (no new export
   added, honoring the `run-contracts.ts:15-19` header).
6. Roadmap synced in all eight required sections with anti-overclaim wording.

## Risks and anti-overclaim language for the roadmap

- **Risk: re-export drift.** If a later change re-adds a local definition in
  `run-contracts.ts`, behavior could silently fork. Mitigation: the gate's
  non-exported-definition check (the exact gap P6u's reviewer caught) blocks it.
- **Risk: over-claiming C30 progress.** This closes one island, not the file.
  Roadmap must read: *"P6v closed the frame-patch tool-name helper island
  extraction from `run-contracts.ts` and its anti-reflow gate. It does NOT close
  full C30, the giant-file/wire-internal split, P6, C29, C31, or C32."*
- **Risk: confusion with Stage U U4.1.** The dormant U4.1 plan
  (`run-contracts.ts:1-20`) is a *type* split; P6v is a *logic* island move and
  does not advance or block U4.1. State this explicitly so no one reads P6v as
  starting U4.1.
- **No-output ledger:** if any Claude review step returns no output, fall back
  to a named subagent adversarial review per CLAUDE.md §0 and record the trace;
  do not mark closeout on a no-output review.

## What this slice does NOT close

- Full C30 giant-file split of `run-contracts.ts` (and of `agent-sdk-runtime.ts`,
  `browser-tools.ts`, `skill-child-runner.ts`); the Stage U U4.1 wire/internal
  type split and U4.1e file deletion.
- Full P6 (C29 remaining + C30 remaining + C32 remaining).
- C29 TurnEngine/DirectChat shell deletion or stronger retirement proof.
- C31 broader redaction work.
- C32 remaining families (map/amap, projection status, run_state status mapping,
  any further hand-written-rule unification).
- P2b OS/container shell isolation.
- Browser identity/session/profile isolation.
- Specialist-agent product/UI work.

P6v only proves the third safe C30 extraction boundary in `run-contracts.ts`.
