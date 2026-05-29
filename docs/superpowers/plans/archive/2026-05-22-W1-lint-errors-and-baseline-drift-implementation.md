---
name: W1-lint-errors-and-baseline-drift-implementation
stage: W1
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_review: docs/superpowers/audits/2026-05-22-ready-recent-change-review-and-next-roadmap.md
---

# W1 - Lint errors and baseline drift implementation plan

## 0. Scope

This plan only clears current lint errors and A0 baseline drift.

In scope:

- `npm run lint:check` errors.
- `node scripts/check-eslint-baseline.cjs` new/stale entries.
- Focused behavior tests or reviewed exemptions needed to replace failing source-grep tests.

Out of scope:

- The 769 warning backlog.
- Large `any` cleanup.
- Workbench shell rework.
- `useAgent` refactor.
- Random formatting or neighboring cleanup.

## 1. Current measured state

Measured on `codex/readyguy` on 2026-05-22:

- `npm run typecheck`: pass.
- `npm run verify:native`: pass.
- `node scripts/check-silent-catch.cjs`: pass.
- `npm run verify:ipc-contract`: pass.
- `npm run test`: pass.
- `npm run lint:check`: fail with 25 errors / 769 warnings.
- `node scripts/check-eslint-baseline.cjs`: fail with 19 new entries and 16 stale entries.

## 2. Success criteria

W1 is complete when:

1. `npm run lint:check` exits with zero **rule-level errors** (warnings out of scope for W1; this is the gate semantic published in W0).
2. `node scripts/check-eslint-baseline.cjs` is green (no new entries, no stale entries).
3. `npm run typecheck` still passes.
4. `npm run test` (full parallel suite) passes — required because any source-grep → behavior-test replacement, helper extraction, or test deletion touches the global test surface.
5. `npm run test:serial-skill-child` passes — required because W1.3 touches skill-child sub-agent imports.
6. A focused test path proves any behavior-test replacements (i.e., the new behavior test exists, runs, and asserts the same contract the old source-grep test asserted).
7. No warning-only cleanup is included.
8. Every reviewed exemption added under W1 is recorded in `docs/superpowers/operations/lint-exemption-ledger.md` (created if absent) with rule, file:line, reason, owner, expiry date or removal condition. The ledger is the single source of truth for "why this rule was silenced".
9. The W1 disposition matrix (§ 3.0, 5 dispositions: replace / exempt / delete / boundary-update / baseline-stale-remove) is filled in for every entry in the error inventory and baseline drift inventory.

## 3.0 Disposition matrix (required for every entry below)

The five dispositions apply differently per rule family. Use the **applicability column** to choose the right disposition for each error:

| Disposition | Applies to | When to choose | Required evidence |
| --- | --- | --- | --- |
| **replace** | E1 (source-grep), E3 (legacy field), E4 (control-regex) | The target code can be invoked from `node:test` (or already has a runnable seam) and the source-grep assertion can become a runtime assertion. For E3/E4 this means a behavior test that exercises the actual code path that the rule was protecting. | New behavior test exists, runs, and asserts the same contract. Linked PR removes the source-grep test (E1) or rewrites the offending code (E3/E4). |
| **exempt** | E1 (source-grep) primarily; E3 only if recovery-path proof exists; **forbidden** for E2 and E4 | The target code couples to `electron` / `ipcMain` at import or has no runnable seam, and extracting an electron-free helper is out of scope for W1. | One-line `// eslint-disable-next-line <rule-name> -- <reason>` immediately above the offending line, where `<rule-name>` is the exact rule that fired (`ready/no-source-grep-test` for E1, `ready/no-legacy-backdoor` for E3) + ledger entry in `lint-exemption-ledger.md` with rule, reason, owner, expiry/removal-condition. |
| **delete** | E1 (source-grep), E3 (legacy field if dead) | The assertion no longer maps to live code (assertion target moved or was removed in Stage U/V and the test is now redundant or wrong; or for E3, the field has no readers anywhere in the repo). | Commit message names which Stage U/V move invalidated it and which behavior test now covers the contract (or "no replacement: contract is obsolete because X"). For E3 deletion: commit message names the grep command that proved zero readers. |
| **boundary-update** | E2 (sub-agent leak) primarily; any custom Ready rule whose definition itself is outdated | The rule that flagged the violation has an outdated definition; the legitimate code organization changed (e.g., E2 sub-agent imports that are now a sanctioned child-run boundary, not a leak). | Patch to the ESLint rule (or its allowlist data) + a rule test under `eslint-rules/__tests__/` that pins both the new accepted shape and a rejected counterexample. The W1 ledger records the rule + old/new boundary. **Never use this to silence one-off violations** — only when the rule itself is wrong. |
| **baseline-stale-remove** | § 4 stale baseline entries only | A stale baseline entry whose source-grep test has been moved, replaced, or deleted by the prior 4 dispositions; the entry no longer matches any live source line. | Remove the specific entry from `eslint-rules/baseline.json` (do not regenerate the whole file) + commit message naming the disposition that invalidated it. `node scripts/check-eslint-baseline.cjs --update` is allowed only as the last step of W1.4, after all individual stale entries have been removed by hand or accounted for. |

The W1 executor must publish the filled matrix in the PR description for each W1.x PR. Codex review of each W1 PR begins by checking the matrix against the diff.

## 3.1 Special note on Electron-coupled source-grep tests

Many of the 18 source-grep errors fire against tests whose existing comments already document the electron coupling, e.g.:

- `document-attachment-async-io.test.ts` — "We use a static source check because the handler registers against the Electron `ipcMain` singleton on import"
- `executor-routes-list-and-remove-intents.test.ts` — "the executor pulls `electron` via document-engine/ipc-handler so we assert routing by static-source inspection. A future extraction of electron-free helpers can upgrade these to runtime assertions."

Implication: **most of these should default to `exempt`**, not `replace`. Extracting electron-free helpers is real refactor work and is out of W1 scope unless a single small helper makes a clean cut. Choose `replace` only when a same-PR helper extraction is < ~50 LOC and does not change runtime behavior; otherwise choose `exempt` and let the ledger track the future runtime upgrade.

## 3. Error inventory

### E1. `ready/no-source-grep-test` - 18 errors

Current errors:

1. `src/__tests__/chat-model-switcher-contract.test.ts:7`
2. `src/__tests__/document-attachment-async-io.test.ts:18`
3. `src/__tests__/document-attachment-async-io.test.ts:19`
4. `src/__tests__/document-attachment-async-io.test.ts:23`
5. `src/__tests__/document-engine-async-handlers.test.ts:8`
6. `src/__tests__/document-engine-async-handlers.test.ts:12`
7. `src/__tests__/document-insight-widget-window.test.ts:111`
8. `src/__tests__/document-list-widgets-metric.test.ts:12`
9. `src/__tests__/document-list-widgets-metric.test.ts:17`
10. `src/__tests__/document-widget-target-controlled-selection.test.ts:58`
11. `src/__tests__/executor-routes-list-and-remove-intents.test.ts:17`
12. `src/__tests__/executor.routes-list-and-remove-intents.test.ts:14`
13. `src/__tests__/patch-target-resolution-metric.test.ts:16`
14. `src/__tests__/patch-target-resolution-metric.test.ts:21`
15. `src/__tests__/pipeline.update.includes-existing-widget-in-prompt.test.ts:12`
16. `src/__tests__/pipeline.widget-draft.cache-invalidation-on-failure.test.ts:12`
17. `src/__tests__/pipeline.widget-draft.reprompts-on-schema-error.test.ts:12`
18. `src/__tests__/rss-preview-browser-handoff-contract.test.ts:7`

Implementation rule (revised per § 3.1):

- Use the § 3.0 disposition matrix; **default to `exempt`** for Electron-coupled tests (the existing test comments already justify this), and only choose `replace` when a clean ≤50-LOC helper extraction is possible inside the same PR.
- `delete` is a legitimate disposition when the Stage U/V move-only series moved the underlying assertion target out from under the test, and the new location is already covered by another behavior test.
- All `exempt` choices register in `docs/superpowers/operations/lint-exemption-ledger.md` per § 2 item 8.

Disambiguation: items 11 and 12 reference two near-identical filenames:

- `executor-routes-list-and-remove-intents.test.ts` (hyphen)
- `executor.routes-list-and-remove-intents.test.ts` (dot)

W1 must first determine whether these are duplicates (then `delete` one) or whether they intentionally split coverage (then dispose each independently and document the split rationale in the PR).

Suggested batches:

1. Document pipeline tests: items 2-10 and 13-17.
2. Executor route tests: items 11-12 (with duplicate disambiguation first).
3. Chat/RSS UI contract tests: items 1 and 18.

### E2. `ready/no-subagent-leak` - 5 errors

Current errors:

1. `src/main/modules/agent-control/skills/skill-child-runner.ts:100`
2. `src/main/modules/agent-control/skills/skill-child-runner.ts:101`
3. `src/main/modules/agent-control/skills/skill-child-sub-agent-close-mapping.ts:10`
4. `src/main/modules/agent-control/skills/skill-child-sub-agent-factory.ts:11`
5. `src/main/modules/agent-control/skills/skill-child-sub-agent.ts:31`

Implementation rule (use § 3.0 matrix):

- Do not silence the rule first.
- Decide whether these imports are now a legitimate child-run ownership boundary or a real leak from the old sub-agent package.
- If legitimate → `boundary-update`: patch the rule (or its allowlist) so the sub-agent boundary is sanctioned, and add a rule test under `eslint-rules/__tests__/no-subagent-leak*.test.cjs` that pins both the new accepted shape and a rejected counterexample.
- If not legitimate → `replace`: move the shared types/helpers behind a child-run-owned facade, update imports, and keep the rule unchanged.
- `exempt` is **not** a default here — the rule exists precisely to catch this category, so silencing one site without rule consensus is forbidden.

Verification:

- `npx eslint src/main/modules/agent-control/skills --ext .ts`
- relevant skill-child tests from `npm run test:serial-skill-child`
- if `boundary-update` chosen, the new rule test must run via `node --test eslint-rules/__tests__/`

### E3. `ready/no-legacy-backdoor` - 1 error

Current error:

- `src/main/modules/agent-control/skills/skill-child-run-types.ts:177`

Context evidence (from current code, lines 172-181):

```ts
/**
 * Bridge handles to legacy parent-visible state. New child runs may be
 * created from a recovered legacy row; in that case these fields point
 * at the legacy projection / task-run / detached-task ids.
 */
legacy: {
  taskRunId: string | null
  detachedTaskId: string | null
  projectionTaskId: string | null
}
```

**The comment claims a recovery-path bridge, but a `grep -rn '\.legacy\b' src/main/modules/agent-control/` from this repo on 2026-05-22 finds zero reads of `.legacy.taskRunId`, `.legacy.detachedTaskId`, or `.legacy.projectionTaskId` outside this file**. The field may be dead code, or it may be read indirectly via dynamic destructuring / db row deserialization that grep misses.

Implementation rule (mandatory order, no preset conclusion):

1. **Run the reader-grep**: `grep -rn '\.legacy\.' src/ ; grep -rn 'legacy:\s*{' src/` and record findings (zero, indirect, or direct) in the PR description.
2. **Choose disposition per findings** (use § 3.0 matrix):
   - **Zero reads found, no indirect access** → `delete` the field type + remove the offending source line. Confirm `npm run test:serial-skill-child` still passes (no recovery breaks).
   - **Indirect reads found** (db deserialization, dynamic spread) → `replace`: rename to `adoption: { ... }` (typed alias) with a full search-and-replace, and add a behavior test that exercises the indirect path. Run `npm run test:serial-skill-child`.
   - **Direct reads found in a hot recovery path that cannot be safely renamed in W1 scope** → `exempt` with ledger entry naming each reader and a "rename when [condition]" trigger.
   - **`boundary-update` is also valid** if `no-legacy-backdoor` rule should distinguish "adoption metadata" from "backdoor"; in that case patch the rule + add `eslint-rules/__tests__/no-legacy-backdoor*.test.cjs`.
3. **Never silence without the grep evidence** from step 1.

Verification:

- `node scripts/check-eslint-baseline.cjs`
- `npm run test:serial-skill-child`
- If `replace` chosen: behavior test asserting child-run recovery still hydrates from the renamed field on a fixture row.
- If `delete` chosen: PR description includes the grep output proving zero readers.

### E4. `no-control-regex` - 1 error

Current error:

- `src/main/modules/browser-engine/download-service.ts:38`

Implementation rule:

- Replace the regex literal containing control characters with a safe named constant or escaped range that ESLint accepts.
- Add or run the existing download-service/path sanitization test if present.

Verification:

- `npx eslint src/main/modules/browser-engine/download-service.ts --ext .ts`
- focused browser-engine test if available

## 4. Baseline drift inventory

### New entries reported by `check-eslint-baseline`

1. `src/__tests__/chat-model-switcher-contract.test.ts:7 ready/no-source-grep-test`
2. `src/__tests__/document-attachment-async-io.test.ts:18 ready/no-source-grep-test`
3. `src/__tests__/document-attachment-async-io.test.ts:19 ready/no-source-grep-test`
4. `src/__tests__/document-attachment-async-io.test.ts:23 ready/no-source-grep-test`
5. `src/__tests__/document-engine-async-handlers.test.ts:8 ready/no-source-grep-test`
6. `src/__tests__/document-engine-async-handlers.test.ts:12 ready/no-source-grep-test`
7. `src/__tests__/document-insight-widget-window.test.ts:111 ready/no-source-grep-test`
8. `src/__tests__/document-list-widgets-metric.test.ts:12 ready/no-source-grep-test`
9. `src/__tests__/document-list-widgets-metric.test.ts:17 ready/no-source-grep-test`
10. `src/__tests__/document-widget-target-controlled-selection.test.ts:58 ready/no-source-grep-test`
11. `src/__tests__/executor-routes-list-and-remove-intents.test.ts:17 ready/no-source-grep-test`
12. `src/__tests__/executor.routes-list-and-remove-intents.test.ts:14 ready/no-source-grep-test`
13. `src/__tests__/patch-target-resolution-metric.test.ts:16 ready/no-source-grep-test`
14. `src/__tests__/patch-target-resolution-metric.test.ts:21 ready/no-source-grep-test`
15. `src/__tests__/pipeline.update.includes-existing-widget-in-prompt.test.ts:12 ready/no-source-grep-test`
16. `src/__tests__/pipeline.widget-draft.cache-invalidation-on-failure.test.ts:12 ready/no-source-grep-test`
17. `src/__tests__/pipeline.widget-draft.reprompts-on-schema-error.test.ts:12 ready/no-source-grep-test`
18. `src/__tests__/rss-preview-browser-handoff-contract.test.ts:7 ready/no-source-grep-test`
19. `src/main/modules/agent-control/skills/skill-child-run-types.ts:177 ready/no-legacy-backdoor`

### Stale entries reported by `check-eslint-baseline`

1. `src/__tests__/browser-runtime-hydration-contract.test.ts:7 ready/no-source-grep-test`
2. `src/__tests__/chat-model-switcher-contract.test.ts:7 ready/no-source-grep-test`
3. `src/__tests__/document-attachment-async-io.test.ts:18 ready/no-source-grep-test`
4. `src/__tests__/document-engine-async-handlers.test.ts:8 ready/no-source-grep-test`
5. `src/__tests__/document-insight-widget-window.test.ts:111 ready/no-source-grep-test`
6. `src/__tests__/document-list-widgets-metric.test.ts:12 ready/no-source-grep-test`
7. `src/__tests__/document-list-widgets-metric.test.ts:17 ready/no-source-grep-test`
8. `src/__tests__/document-widget-target-controlled-selection.test.ts:58 ready/no-source-grep-test`
9. `src/__tests__/executor-routes-list-and-remove-intents.test.ts:17 ready/no-source-grep-test`
10. `src/__tests__/executor.routes-list-and-remove-intents.test.ts:14 ready/no-source-grep-test`
11. `src/__tests__/patch-target-resolution-metric.test.ts:16 ready/no-source-grep-test`
12. `src/__tests__/patch-target-resolution-metric.test.ts:21 ready/no-source-grep-test`
13. `src/__tests__/pipeline.update.includes-existing-widget-in-prompt.test.ts:12 ready/no-source-grep-test`
14. `src/__tests__/pipeline.widget-draft.cache-invalidation-on-failure.test.ts:12 ready/no-source-grep-test`
15. `src/__tests__/pipeline.widget-draft.reprompts-on-schema-error.test.ts:12 ready/no-source-grep-test`
16. `src/main/modules/agent-control/skill-child-run-types.ts:179 ready/no-legacy-backdoor`

Implementation rule:

- Do not run `check-eslint-baseline --update` as the first move.
- First eliminate, explicitly exempt, or delete the new errors (per § 3.0 matrix).
- Then remove stale entries or update the baseline only for remaining reviewed exemptions.
- `delete` is also valid for stale baseline entries when the test they pointed at has been moved/deleted by Stage U/V and the new location is already covered.

## 5. Recommended PR sequence

### W1.1 Document-pipeline source-grep disposition pass

(Title reflects § 3.1 default: most are `exempt`, not `replace`. Each entry chooses its own disposition via § 3.0 matrix.)

Files likely touched:

- `document-attachment-async-io.test.ts`
- `document-engine-async-handlers.test.ts`
- `document-insight-widget-window.test.ts`
- `document-list-widgets-metric.test.ts`
- `document-widget-target-controlled-selection.test.ts`
- `patch-target-resolution-metric.test.ts`
- `pipeline.update.includes-existing-widget-in-prompt.test.ts`
- `pipeline.widget-draft.cache-invalidation-on-failure.test.ts`
- `pipeline.widget-draft.reprompts-on-schema-error.test.ts`

Verify:

- focused test files touched
- `npm run lint:check`
- `node scripts/check-eslint-baseline.cjs`

### W1.2 Executor / chat / RSS source-grep disposition pass

(Title reflects § 3.1 default. Items 11/12 file-name disambiguation must be resolved first.)

Files likely touched:

- `chat-model-switcher-contract.test.ts`
- `executor-routes-list-and-remove-intents.test.ts`
- `executor.routes-list-and-remove-intents.test.ts`
- `rss-preview-browser-handoff-contract.test.ts`

Verify:

- focused test files touched
- `npm run lint:check`
- `node scripts/check-eslint-baseline.cjs`

### W1.3 Sub-agent boundary decision

(Disposition is `boundary-update` or `replace` per E2 rule; `exempt` is forbidden here.)

Files likely touched:

- `skill-child-runner.ts`
- `skill-child-sub-agent-close-mapping.ts`
- `skill-child-sub-agent-factory.ts`
- `skill-child-sub-agent.ts`
- ESLint rule patch + `eslint-rules/__tests__/no-subagent-leak*.test.cjs` if `boundary-update` is chosen

Verify:

- `npm run test:serial-skill-child`
- `npm run lint:check`

### W1.4 Single-file hard errors and baseline closeout

Files likely touched:

- `skill-child-run-types.ts` (legacy field — must satisfy § 3 E3 recovery-path proof before disposition)
- `download-service.ts`
- `eslint-rules/baseline.json` — stale entries removed individually per `baseline-stale-remove`; `--update` is the last step only after all hand removals are committed

Verify:

- `npm run lint:check`
- `node scripts/check-eslint-baseline.cjs`
- `npm run typecheck`
- relevant focused tests

## 6. Final verification for W1

Mandatory final commands (all must pass before W1 close):

```bash
npm run typecheck
npm run lint:check                 # zero rule errors; warnings ignored for W1
node scripts/check-eslint-baseline.cjs
npm run test                        # full parallel suite — required because W1 touches the test surface
npm run test:serial-skill-child     # required because W1.3 touches skill-child sub-agent imports
```

Plus, for W1 close-out evidence (saved under `docs/superpowers/audits/2026-05-22-stage-w-closeout/w1/`):

- Raw stdout of every command above.
- The filled § 3.0 disposition matrix covering all 25 errors and 35 baseline entries (19 new + 16 stale).
- The current state of `docs/superpowers/operations/lint-exemption-ledger.md` (created during W1 if absent).

Do not require full warning cleanup in W1. W2 owns warning debt.

## 7. Codex review checkpoints inside W1

Per the Stage W roadmap § 2.2 cadence:

1. **W1 plan review**: before W1.1 PR dispatch (i.e., the second-round review this plan goes through).
2. **Per-PR review**: each W1.x PR is reviewed against the § 3.0 disposition matrix it publishes.
3. **W1 exit review**: full closeout bundle reviewed before W2 starts.

A W1.x PR is "0-异议" when Codex returns no must-fix comments two rounds in a row, or all open comments are explicitly accepted as out-of-scope by 白.
