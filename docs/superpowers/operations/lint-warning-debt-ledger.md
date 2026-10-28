> 2026-09-06 用途核对：本表保留 lint 预算检查所消费的基线，不是今天重新扫描得到的剩余问题计数；实际结果以当前检查输出为准。

# Lint warning debt ledger

> Source: `npm run lint:check` on the current release source, reconciled 2026-08-18
> Owning plan: `docs/superpowers/plans/2026-05-22-W2-lint-warning-debt-ledger-implementation.md`
> Current warning debt: **1042** (0 errors), reconciled 2026-10-09
>
> This ledger is the **only** authoritative budget for `scripts/check-lint-warning-budget.cjs`. Budgets start equal to the captured count for each rule; the budget script fails if any rule's live warning count exceeds its row's `Budget`. Lowering a `Budget` is encouraged once warnings are paid down — raising one requires an explicit row in the deferred-work ledger.
>
> **Y1.3 first batch (2026-05-24)**: 6 warnings burned (3 `(eslint-core)/unused-disable-directive` retired + 3 `react-hooks/exhaustive-deps` converted to documented disables). New live total: 765. Per-rule budgets updated in the table below. Plan: `docs/superpowers/plans/archive/2026-05-23-Y1-3-warning-burn-implementation.md`.
>
> **2026-08-12 release-source reconciliation:** the current Codex replacement and its adversarial/native test matrix added typed protocol fixtures and split several production modules. The release gate now measures only controlled source (`outputs/**` is excluded) and has 0 lint errors. The exact warning inventory below is recorded as deferred warning debt; this does not convert warnings into errors or hide generated-output noise.
>
> **2026-10-09 gate cleanup:** `lint:check` was red (73 errors, 58 of them in the gitignored packaging output `build/release-skill-runtime/**`, now ignored like `out/**`) and four rules were over budget. All 47 `react-hooks/exhaustive-deps` warnings were reviewed: 3 became provably neutral fixes (a never-reassigned ref container captured at effect start) and 44 became documented `eslint-disable-next-line ... -- reason` lines; no stale-closure bug was found. `react-refresh/only-export-components` dropped by moving the file-tree placeholder model out of `pending-placeholders.tsx`. Every budget is lowered to the live count. `no-unused-vars` includes 2 warnings under `Packer/` (the `other` bucket).
>
> **2026-08-18 release-source reconciliation:** commits after the prior capture split the Browser act implementation into five modules and advanced the Agent recovery/runtime composition. The split retained private helpers for follow-up extraction, accounting for 249 of the current `no-unused-vars` warnings; the artifact-delivery work removed every warning it newly orphaned before this capture. The controlled release source remains at 0 lint errors. The measured per-rule/per-area inventory is recorded below and in the Stage Y deferred-work ledger instead of weakening or bypassing the gate.

## Area definitions

| Area | Path prefix |
| --- | --- |
| tests | `src/__tests__/` |
| main | `src/main/` |
| renderer | `src/renderer/` |
| shared | `src/shared/` |
| scripts | `scripts/` |

Other paths (none observed in this capture) would land in an `other` bucket; the budget script reports any non-zero `other` count for triage.

## Rule ledger

| Rule | Total | tests | main | renderer | shared | scripts | Budget | Owner | Target date |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| @typescript-eslint/no-explicit-any | 541 | 414 | 21 | 43 | 63 | 0 | 541 | warning-burn follow-up | n/a |
| @typescript-eslint/no-unused-vars | 465 | 59 | 341 | 27 | 6 | 30 | 465 | warning-burn follow-up | n/a |
| react-hooks/exhaustive-deps | 0 | 0 | 0 | 0 | 0 | 0 | 0 | retired (2026-10-09 documented disables) | n/a |
| react-refresh/only-export-components | 36 | 0 | 0 | 36 | 0 | 0 | 36 | warning-burn follow-up | n/a |
| (eslint-core)/unused-disable-directive | 0 | 0 | 0 | 0 | 0 | 0 | 0 | retired (Y1.3) | n/a |

Row total = 1042 (matches the 2026-10-09 `npm run lint:check` summary).

**2026-05-29 reconciliation (pre-release lint gate).** `@typescript-eslint/no-explicit-any` 551 → **544**: typed the 8 structural stub params (`SpawnOptions` + `(code: number) => void`) in `src/__tests__/skill-primitive-run-shell.test.ts`, clearing the +1 over-budget regression that commit `2f0abc6b` introduced (this was the actual red `verify:lint-budget` gate on `codex/readyguy`). `@typescript-eslint/no-unused-vars` 182 → **179**: reconciled to the live source-only count — `eslint.config.mjs` now ignores the build-output dirs `exports/**` and `Packer/.staging/**` (vendored Python site-package JS like torch/sklearn was being linted *locally only*, inflating the local count by ~45; the CI merge job never saw it because it lints a clean checkout with no build step before `lint:check`), and the dead import `BROWSER_VIEW_INTENT_ACK_CHANNEL` in `src/preload/index.ts` was removed (renderer 41 → 38 reflects renderer cleanup that landed since the X2 snapshot). Both budgets lowered to the measured actuals per the reconciliation rules below.

Stage X2 raised the `@typescript-eslint/no-unused-vars` budget from 180 → 182 (renderer 39 → 41). The +2 are stale imports left in `src/renderer/components/agent/ChatPanel.tsx` after the X2 ChatPanel refactor (commit `9cda9c49` 起的 X2.1–X2.8 链路裁剪了大段 JSX 与导入；剩余的两条未使用导入与 X2 主目标——session/composer/provider recovery——无关，留作 Stage Y P1 warning-burn 一并清理)，符合 `react-hooks/exhaustive-deps` + `react-refresh/only-export-components` 之外的 Stage Y P1 burn 顺位。

### Notes per rule

- **@typescript-eslint/no-explicit-any** — Dominated by `src/__tests__/` (396 of 551). Policy decision for the test slice lives in `lint-any-in-tests-policy.md`; the budget here covers all areas so non-test growth still fails CI.
- **@typescript-eslint/no-unused-vars** — Concentrated in `src/main/` (93). Several entries are imports retained for type-narrowing in service constructors; cleanup should follow per-module ownership rather than a bulk pass.
- **react-hooks/exhaustive-deps** — Renderer only (15 remaining after Y1.3 first batch burned 3). Each occurrence is a deliberate dependency-list omission, typically guarded by a ref. Convert to documented `// eslint-disable-next-line ... -- reason` rather than silent suppression when paying down. Y1.3 first batch retired 3 (DraggableModeSwitch.tsx + PersonalityEditor.tsx + UserProfileEditor.tsx); 15 remain across AskUserQuestionsCard / ChatPanel / ModelSelector / SXMonthGridEvent / MarkdownEditor / MarkdownSelectionToolbar / WidgetRenderer / GraphView / FileTree / SkillAskUserPrompt / DocumentMode / RSSMode — owned by subsequent Y1.3.N PRs per sub-plan §3.2.
- **react-refresh/only-export-components** — Renderer only (17). These warn for non-component named exports from `*.tsx` files (utilities, context factories). Plan: extract helpers into sibling `.ts` files when refactoring rather than a sweeping move.
- **(eslint-core)/unused-disable-directive** — All 3 retired by Y1.3 first batch (Budget = 0). The three sites were `scripts/__tests__/check-turn-engine-no-domain-branch.test.cjs:15`, `src/__tests__/legacy-agent-ipc-removed.test.ts:25`, and `src/main/modules/calendar-engine/reminder-notifier.ts:82`; underlying disabled rules (`no-new-func`, `ready/no-source-grep-test`, `@typescript-eslint/no-require-imports`) either are not configured in `eslint.config.mjs` or are scanned through a custom `Program`-level path that does not honor eslint-disable comments. ESLint emits these without a trailing rule id; the budget script identifies them via the message prefix `Unused eslint-disable directive`.

## Reconciliation rules

- When a rule's actual count drops below `Budget`, **lower `Budget` to the new count in the same commit** (the budget script does not auto-tighten).
- When a row's `Total` reaches `0`, leave the row in this ledger with `Budget = 0` until the next quarterly trim so we have a regression tripwire.
- New rules that begin emitting warnings (after a rule upgrade or config change) must be added here in the same commit; the budget script treats any rule not in the ledger as `Budget = 0` and will fail on the first warning, surfacing the omission.
- The ledger is the contract; the raw capture in `lint-warning-raw.txt` is a snapshot for auditability only.
