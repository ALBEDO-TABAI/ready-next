---
title: Stage Y1.3 — warning/source-grep burn (first batch) implementation plan
date: 2026-05-23
stage: Y1.3
status: implementation-in-progress
predecessors:
  - docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
plan: docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
scope_lock: §11.3
enforce: false
---

# Stage Y1.3 — Warning/source-grep burn (first batch)

This sub-plan covers the FIRST PR of the Stage Y1.3 warning-burn slot.
Stage Y1.3 itself is intentionally serialized into multiple small PRs
(Y1.3.N) so each burn is reviewable and verifiable in isolation. This PR
attempts the trivial wins; subsequent PRs will handle the larger volume
items.

## 1. Scope (this PR only)

Per §11.3 priority order:

1. **Rule 4 — `(eslint-core)/unused-disable-directive` (3 warnings)** — trivial deletion of stale `// eslint-disable-…` comments whose underlying rule no longer fires.
2. **Rule 1 — `react-hooks/exhaustive-deps` (3 of 18 warnings)** — three carefully-chosen instances where the fix is either (a) add a stable dependency, or (b) explicitly document the deliberate omission per the ledger guidance ("Convert to documented `// eslint-disable-next-line ... -- reason` rather than silent suppression when paying down.").

The remaining warning volume (15 of 18 exhaustive-deps, 17 react-refresh, 182 no-unused-vars, 551 no-explicit-any) is **explicitly deferred** to subsequent Y1.3.N PRs. Per §11.3 scope lock, no rule budget may be raised by Stage Y work; this PR only lowers budgets.

## 2. Rule 4 — unused-disable-directive (3/3 to retire)

For each of the three rows, ESLint reports "Unused eslint-disable directive (no problems were reported from '<rule>')". This is ESLint's own self-diagnostic; removing the directive cannot cause new lint findings because by definition the underlying rule is not active for that line.

| File | Line | Disabled rule | Why the disable is currently unused | Action |
| --- | --- | --- | --- | --- |
| `scripts/__tests__/check-turn-engine-no-domain-branch.test.cjs` | 15 | `no-new-func` | `no-new-func` is not enabled in `eslint.config.mjs`. The directive was likely defensive copy-paste from a project where the rule fires. | Remove line 15. |
| `src/__tests__/legacy-agent-ipc-removed.test.ts` | 25 | `ready/no-source-grep-test` | The ready/no-source-grep-test rule scans via its own `Program`-level handler with `honorReviewedDisables: false` (see `eslint-rules/index.mjs:49`), so the disable comment cannot be honored. In practice the rule doesn't fire on this site because the gate's heuristic (`scanNoSourceGrepTest` in `eslint-rules/a0-rule-utils.mjs:71`) does not match this call shape. The eslint-disable directive is therefore both unhonorable AND unneeded. | Remove line 25. |
| `src/main/modules/calendar-engine/reminder-notifier.ts` | 82 | `@typescript-eslint/no-require-imports` | `@typescript-eslint/no-require-imports: 'off'` in `eslint.config.mjs:56`. | Remove line 82. |

### Verification per row

Each removal is verified by running ESLint on the file alone (`npx eslint <path>`) and confirming the file emits exactly one fewer warning. No source behavior changes; no test changes required.

## 3. Rule 1 — react-hooks/exhaustive-deps (3/18 to burn)

The 18 occurrences are catalogued in §3.1. This PR fixes 3 of them. The remaining 15 stay in the budget and are owned by the next Y1.3.N PR.

### 3.1 Decision tree per occurrence (this PR's three picks)

| File | Line | Missing dep | Fix branch | Why this fix is safe |
| --- | --- | --- | --- | --- |
| `src/renderer/components/document/DraggableModeSwitch.tsx` | 33 | `startSpringAnimation` | (b) documented disable | `startSpringAnimation` is a `useCallback(() => …, [])` at lines 36-64 with empty deps — its identity is stable for the component lifetime, so omitting it from the `mode`-watching effect's deps is intentional. (NB: the callback is declared AFTER the effect in source order, so the simpler "just add it to the dep array" fix would trigger a temporal-dead-zone reference; documented disable is the lowest-risk reduction.) |
| `src/renderer/components/personality/PersonalityEditor.tsx` | 59 | `loadPersonalities` | (b) documented disable | `loadPersonalities` is a freshly-allocated async function on every render (no `useCallback`). Adding it to deps would re-run the load on every render — wrong. The effect is deliberately mount-only ("load once when the component mounts"). Convert silent suppression to `// eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only loader; see Y1.3 sub-plan §3.1`. |
| `src/renderer/components/profile/UserProfileEditor.tsx` | 70 | `loadProfiles` | (b) documented disable | Same shape as PersonalityEditor: `loadProfiles` is recreated each render and the effect is intentionally mount-only. Convert to documented disable comment. |

### 3.2 Picks deferred to next Y1.3.N PR (15 remaining)

These are NOT touched in this PR because either (a) the fix requires verifying a non-trivial set of ref/closure invariants, (b) the file is on the Y0.5 dogfood evidence path and risks bundling with surface work, or (c) the file is in the §11.3 priority-3 ChatPanel.tsx territory and is reserved for the Y1.3 ChatPanel batch:

- `AskUserQuestionsCard.tsx:95` — `card` (deliberate identity-only reseed; needs the documented-disable treatment but combined with a re-read of the card-mutation lifecycle)
- `ChatPanel.tsx:604, 755, 766` — bundled with the §11.3 priority-3 ChatPanel batch
- `ModelSelector.tsx:64` — `activeProfile`
- `SXMonthGridEvent.tsx:47` (×2) — the fix wants `platforms` wrapped in `useMemo`, which is a small refactor
- `MarkdownEditor.tsx:351` — `tab.isDirty`
- `MarkdownSelectionToolbar.tsx:387` — `anchor`
- `WidgetRenderer.tsx:158` — `widgetCode`
- `GraphView.tsx:75` — `layoutNodes` (also wants `useMemo`)
- `FileTree.tsx:1368` — ref-cleanup closure (Y0.5 surface-01 territory)
- `SkillAskUserPrompt.tsx:83` — `current` (ref-like)
- `DocumentMode.tsx:419` — `activeTab` + `splitTab` (Y0.5 surface-04 territory)
- `RSSMode.tsx:301` — `warmRefreshRSSData` (Y0.5 surface-03 territory)

## 4. Budget update

Lower budgets in `docs/superpowers/operations/lint-warning-debt-ledger.md` to match the post-PR state:

| Rule | Budget before | Burn in this PR | Budget after |
| --- | ---: | ---: | ---: |
| `(eslint-core)/unused-disable-directive` | 3 | -3 | 0 |
| `react-hooks/exhaustive-deps` | 18 | -3 | 15 |
| **Total** | **771** | **-6** | **765** |

Other rule budgets (no-unused-vars 182, react-refresh/only-export-components 17, @typescript-eslint/no-explicit-any 551) are unchanged.

## 5. Verification chain

- `npm run lint:check` — exits 0; total warnings drops from 771 → 765.
- `npm run verify:lint-budget` — exits 0 with the new budgets.
- `npm run test` — exits 0; no behavior tests affected (the three fix sites are not test-coverage-bearing).
- `npm run typecheck` — exits 0.

## 6. Out of scope

- Any rule-2 / rule-3 / rule-5 burn.
- The other 15 exhaustive-deps occurrences.
- Renaming, restructuring, or test additions beyond the three fix sites.
- Touching ChatPanel.tsx (reserved for a dedicated Y1.3 ChatPanel batch).

## 7. Deferred-work ledger row

The Stage Y deferred-work ledger gets a `Y1.3 first batch` row recording: 6 warnings burned, 15 exhaustive-deps + 182 no-unused-vars + 17 react-refresh + 551 no-explicit-any remain owned by subsequent Y1.3.N PRs.
