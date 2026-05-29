---
name: W2-lint-warning-debt-ledger-implementation
stage: W2
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_phase: docs/superpowers/plans/archive/2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md
---

# W2 — Lint warning debt ledger implementation plan

## 0. Scope

W2 turns the 769-warning backlog into a tracked debt ledger that cannot silently grow. It does **not** clean warnings.

In scope: classify warnings by rule family + area, decide a policy for `any` in tests, install a per-rule threshold script.

Out of scope: actually fixing `no-explicit-any`, `no-unused-vars`, `exhaustive-deps`, or any other warning. Those are W2+ continuation work.

## 1. Preconditions

- W1 closed: `npm run lint:check` zero rule errors, `check-eslint-baseline` green.
- W0 verification snapshot present (uses as warning baseline reference).

## 2. Success criteria

1. `docs/superpowers/operations/lint-warning-debt-ledger.md` exists, listing every rule with warning count > 0, area breakdown (tests / main / renderer / shared / scripts), owner, target.
2. `docs/superpowers/operations/lint-any-in-tests-policy.md` exists, stating whether `@typescript-eslint/no-explicit-any` in `src/__tests__/**` is allowed, tolerated with cap, or to-be-removed.
3. `scripts/check-lint-warning-budget.cjs` exists and runs in CI / merge gate. It fails if any rule's warning count exceeds its budget (initially = current count).
4. `package.json` adds `verify:lint-budget` script wrapping the budget check.
5. W6 reconciliation will later place `verify:lint-budget` into the `debt-dashboard` bucket.

## 3. Step-by-step

### W2.1 — Classify current warnings

Generate raw data:

```bash
mkdir -p docs/superpowers/operations
npm run lint:check 2>&1 | tee docs/superpowers/operations/lint-warning-raw.txt
```

From `lint-warning-raw.txt`, build a per-rule + per-area summary into `lint-warning-debt-ledger.md`. Initial structure:

```
| Rule | Total | tests | main | renderer | shared | scripts | Budget | Owner | Target date |
| ---  | ---   | ---   | ---  | ---      | ---    | ---     | ---    | ---   | ---         |
| @typescript-eslint/no-explicit-any | 551 | ? | ? | ? | ? | ? | 551 | TBD | n/a |
| @typescript-eslint/no-unused-vars  | 180 | ? | ? | ? | ? | ? | 180 | TBD | n/a |
| react-hooks/exhaustive-deps        | 18  | ? | ? | ? | ? | ? | 18  | TBD | n/a |
| react-refresh/only-export-components | 17 | ? | ? | ? | ? | ? | 17 | TBD | n/a |
```

Use a small node script (write inline or one-off) to count by `(rule, area)` from `lint-warning-raw.txt`.

### W2.2 — `any` in tests policy decision

Write `lint-any-in-tests-policy.md` covering:

- Why tests historically used `any` (mock shapes, edge-case fixtures).
- One of three policies:
  1. **Allowed**: keep current behavior; ledger budget for `any-in-tests` = current count.
  2. **Tolerated with cap**: budget = 110% of current; growth past cap fails CI.
  3. **To-be-removed**: budget = current; explicit reduction plan elsewhere.
- Decision (white-input): default to "Tolerated with cap" unless 白 says otherwise.

### W2.3 — Budget check script

`scripts/check-lint-warning-budget.cjs`:

- Reads `docs/superpowers/operations/lint-warning-debt-ledger.md` budget column.
- Runs `npm run lint:check --silent` (capture stderr/stdout), parses warning count by rule.
- Exits 1 if any rule's actual count > budget; exits 0 otherwise.
- Prints a clear table showing rule, budget, actual, delta.

Add to `package.json`:

```json
"verify:lint-budget": "node scripts/check-lint-warning-budget.cjs"
```

### W2.4 — CI / docs wiring

- Update W6 plan (when it lands) to slot `verify:lint-budget` into `debt-dashboard` bucket.
- W2 itself does **not** add `verify:lint-budget` to the merge gate. Adding to merge requires explicit roadmap decision.

## 4. Final verification

```bash
npm run lint:check
node scripts/check-lint-warning-budget.cjs   # should exit 0 initially (budget = current)
```

Then manually verify the ledger:

- Total warning count in ledger sums to `lint:check` warning total.
- Every non-zero rule has a row.
- Owner column has at least "TBD" not blank (so reviewer sees it needs assignment).

## 5. Codex review

Per roadmap § 2.2:

- Plan review before W2.1.
- W2 exit review after the 4 deliverables are committed.

W2 closes when both reviews return 0-异议.
