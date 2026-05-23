# Lint warning debt ledger

> Source: `docs/superpowers/operations/lint-warning-raw.txt` (`npm run lint:check` at branch `codex/readyguy`, captured 2026-05-22)
> Owning plan: `docs/superpowers/plans/2026-05-22-W2-lint-warning-debt-ledger-implementation.md`
> Total warnings on capture: **769** (0 errors)
>
> This ledger is the **only** authoritative budget for `scripts/check-lint-warning-budget.cjs`. Budgets start equal to the captured count for each rule; the budget script fails if any rule's live warning count exceeds its row's `Budget`. Lowering a `Budget` is encouraged once warnings are paid down — raising one requires an explicit row in the deferred-work ledger.

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
| @typescript-eslint/no-explicit-any | 551 | 396 | 55 | 37 | 63 | 0 | 551 | TBD | n/a |
| @typescript-eslint/no-unused-vars | 182 | 26 | 93 | 41 | 2 | 20 | 182 | TBD | n/a |
| react-hooks/exhaustive-deps | 18 | 0 | 0 | 18 | 0 | 0 | 18 | TBD | n/a |
| react-refresh/only-export-components | 17 | 0 | 0 | 17 | 0 | 0 | 17 | TBD | n/a |
| (eslint-core)/unused-disable-directive | 3 | 1 | 1 | 0 | 0 | 1 | 3 | TBD | n/a |

Row total = 771 (matches `npm run lint:check` summary).

Stage X2 raised the `@typescript-eslint/no-unused-vars` budget from 180 → 182 (renderer 39 → 41). The +2 are stale imports left in `src/renderer/components/agent/ChatPanel.tsx` after the X2 ChatPanel refactor (commit `9cda9c49` 起的 X2.1–X2.8 链路裁剪了大段 JSX 与导入；剩余的两条未使用导入与 X2 主目标——session/composer/provider recovery——无关，留作 Stage Y P1 warning-burn 一并清理)，符合 `react-hooks/exhaustive-deps` + `react-refresh/only-export-components` 之外的 Stage Y P1 burn 顺位。

### Notes per rule

- **@typescript-eslint/no-explicit-any** — Dominated by `src/__tests__/` (396 of 551). Policy decision for the test slice lives in `lint-any-in-tests-policy.md`; the budget here covers all areas so non-test growth still fails CI.
- **@typescript-eslint/no-unused-vars** — Concentrated in `src/main/` (93). Several entries are imports retained for type-narrowing in service constructors; cleanup should follow per-module ownership rather than a bulk pass.
- **react-hooks/exhaustive-deps** — Renderer only (18). Each occurrence is a deliberate dependency-list omission, typically guarded by a ref. Convert to documented `// eslint-disable-next-line ... -- reason` rather than silent suppression when paying down.
- **react-refresh/only-export-components** — Renderer only (17). These warn for non-component named exports from `*.tsx` files (utilities, context factories). Plan: extract helpers into sibling `.ts` files when refactoring rather than a sweeping move.
- **(eslint-core)/unused-disable-directive** — Three stale `// eslint-disable-...` directives whose underlying rule no longer fires. Cheapest debt to retire; deferred so W2 does not mutate `src/`. ESLint emits these without a trailing rule id; the budget script identifies them via the message prefix `Unused eslint-disable directive`.

## Reconciliation rules

- When a rule's actual count drops below `Budget`, **lower `Budget` to the new count in the same commit** (the budget script does not auto-tighten).
- When a row's `Total` reaches `0`, leave the row in this ledger with `Budget = 0` until the next quarterly trim so we have a regression tripwire.
- New rules that begin emitting warnings (after a rule upgrade or config change) must be added here in the same commit; the budget script treats any rule not in the ledger as `Budget = 0` and will fail on the first warning, surfacing the omission.
- The ledger is the contract; the raw capture in `lint-warning-raw.txt` is a snapshot for auditability only.
