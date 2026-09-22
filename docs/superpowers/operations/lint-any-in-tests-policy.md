---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Policy: `@typescript-eslint/no-explicit-any` inside `src/__tests__/**`

> Owning plan: `docs/superpowers/plans/2026-05-22-W2-lint-warning-debt-ledger-implementation.md` § W2.2
> Capture date: 2026-05-22 (branch `codex/readyguy`)
> Status: **default in effect** — see "Decision" below.

## Why tests historically used `any`

Test files in `src/__tests__/` represent **396 of the 551** `no-explicit-any` warnings observed in the W2 capture — the largest single concentration in the codebase. The drivers:

1. **Mock and stub shapes** — Many module-level singletons in `src/main/` and `src/renderer/` expose deep, internally-shaped types that the production code itself only narrows at the call site. Test fixtures historically used `as any` rather than re-asserting the full shape, especially when only one or two fields were exercised.
2. **Cross-process IPC fixtures** — Tests that fake `webContents`, `ipcMain.handle`, or `BrowserView` shells reach for `any` because the upstream Electron types are intentionally wide and the test only needs a few callbacks.
3. **Snapshot-style state inspection** — `useAgent`-adjacent tests and projection contract tests often grab the whole store state and assert on derived fields, where `any` avoids re-exporting internal slice types purely for tests.
4. **Negative tests and contract violations** — Some tests deliberately construct malformed inputs to assert that runtime guards reject them; the well-typed signatures forbid the malformed input by design, so `any` is used to bypass the compile-time guard precisely to exercise the runtime guard.

None of these justify *new* `any` usage in production code, but they explain the historical concentration in tests.

## Options considered

| # | Policy | Test-slice budget | CI behavior | Migration cost |
| --- | --- | --- | --- | --- |
| 1 | **Allowed** | unbounded | never fails for test-area `any` | none, hides regressions |
| 2 | **Tolerated with cap** | budget = current count | fails when new test-area `any` is added | low; aligns with whole-file budget script |
| 3 | **To-be-removed** | budget = current count, plus a dated reduction schedule | fails on growth; reductions tracked explicitly | high; requires per-test typed fixtures |

## Decision

**Default: Option 2 — Tolerated with cap.**

- The W2 ledger row for `@typescript-eslint/no-explicit-any` records `Budget = 551` covering all areas. The test-slice contribution (396) is included in that single rule budget rather than being split into a separate `_in_tests` budget, because the budget script keys on rule id only.
- Growth past the current count fails `npm run verify:lint-budget` whether the new `any` lands in tests or production. Until the test slice is paid down, **any production-side reduction must be paired with the same-commit budget-lowering** described in `lint-warning-debt-ledger.md` "Reconciliation rules"; otherwise the test slice will silently absorb the freed budget.
- No reduction schedule is attached. A reduction plan can be written in a future W phase once `useAgent` (W4) and Workbench shell (W3) settle; both are likely to rewrite many test fixtures and the per-test typing cost is better paid alongside those rewrites.

## Decision pending 白 review; default tolerated-with-cap stands unless overridden
