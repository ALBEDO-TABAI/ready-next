---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# W6 — package.json scripts diff (main..HEAD)

Branch: `codex/readyguy`
Captured: 2026-05-22
Command (per W6.6):

```bash
git diff main..HEAD -- package.json | grep -A1 '"scripts"' > docs/superpowers/operations/w6-scripts-diff.md
```

The literal command above produces an **empty** capture because the diff window
between `main` and HEAD does not include the `"scripts":` key line itself — all
changes are line edits *inside* the existing scripts block, so the line
containing `"scripts":` is unchanged and never appears in `git diff` context.
The file is intentionally non-empty so the diff record stays informative; the
section below contains the substantive changes that fall inside the scripts
block.

## Narrative — scripts changes since `main`

Only the `scripts` block in `package.json` is touched between `main` and HEAD.
The semantic deltas (verified by `git diff main..HEAD -- package.json`):

1. **`verify` (top-level merge gate) — rewritten to slim form.**
   Old: `verify:native && verify:t && verify:calendar && test`.
   New: `verify:native && typecheck && check-silent-catch && check-move-only-pr && verify:ipc-contract && test`.
   This is the W0-documented slim merge gate; the historical `verify:t` /
   `verify:calendar` chains are now manual-deep, not merge-blocking.

2. **`verify:ipc-contract` (new top-level entry).**
   Extracted as a standalone script wired into the slim `verify` chain. Stage V
   V5 contract gate.

3. **`verify:a0` — added three structural gates.**
   `check-no-ipcmain-emit-truthy.cjs`, `check-no-legacy-agent-ipc.cjs`,
   `check-no-skill-executions-resurrection.cjs` joined before
   `check-plan-pairing.cjs`. Stage U1/U2 retirement gates.

4. **`verify:b` — Stage U feature gates added.**
   `check-tool-error-shape.cjs`, `check-task-projection-wire-canonical.cjs`,
   `check-rss-platform-rule-single-source.cjs`,
   `check-settings-no-legacy-key-read.cjs`. Composition trimmed: no longer
   re-invokes `verify:a05` (separation between merge gates and `a1-gate`
   debt-dashboard area).

5. **`verify:c` — turn-engine isolation gate added.**
   `check-turn-engine-no-domain-branch.cjs` (Stage C cross-domain rule).

6. **`verify:e` — composition narrowed + new gates inlined.**
   Now depends on `verify:c` instead of `verify:d`; adds
   `check-silent-catch.cjs` and `verify:ipc-contract` inside the chain. Stage U
   silent-catch + IPC contract wiring.

7. **`verify:f` — separated debt-dashboard from merge gate.**
   The `check-eslint-baseline.cjs --area no-source-grep-test --max 142`
   invocation moved out into a dedicated script `debt:no-source-grep-test`
   (debt-dashboard bucket). `verify:f` now only runs the testing-conventions
   gate and the `f:*` test pair.

8. **`debt:no-source-grep-test` (new).**
   Standalone debt-dashboard entry; **not** part of any merge or manual-deep
   chain. Tracks `no-source-grep-test` warning ceiling at 142. *(Note: this
   script does not match the `^(verify|lint|typecheck|test)` inventory regex,
   so it does not appear in the v1 taxonomy table by W6's definition of
   `verify`-family scripts. It is documented here as the new ledger entry for
   visibility.)*

9. **`verify:h` — composition shrunk.**
   Removed inline `check-silent-catch.cjs` calls (now covered by `verify:e`
   via `check-silent-catch.cjs`). `test:h:gates` / `test:h:focus` reduced to
   `check-claude-md-claims` only.

10. **`verify:i` — composition shrunk.**
    Now an alias for `verify:i1` (was previously `verify:i1 && test:i:gates &&
    test:i:focus`). The `test:i:*` pair still exists for explicit silent-catch
    runs but is no longer chained into `verify:i`.

11. **`verify:j` — base changed.**
    Now depends on `verify:i1` directly (skipping the `verify:i` indirection).
    Behavior identical because `verify:i` is now an `i1` alias.

12. **`verify:cloud` — release-only gate hardened.**
    Added trailing `check-verify-native-trigger.cjs` to ensure native rebuilds
    are correctly cron'd on release branches.

13. **`verify:l:gates` and `test:l:gates` / `test:l:focus` — Stage L expansion.**
    Three new gate scripts (`check-child-run-transition-validator`,
    `check-run-state-schema-single-source`,
    `check-task-projection-status-shared`) plus `check-no-fire-and-forget`
    inline. `test:l:focus` adds 6 new test files (state-machine, repository,
    schema, selection, resource-resolver, migration-043).

14. **`verify:p` — Stage P expansion.**
    Adds `check-read-skill-visibility-single-source.cjs` as the first gate.

15. **`verify:s` — Stage S simplification.**
    Removed leading `npm run verify:native` re-invocation (already covered by
    the chain).

## W2 addendum — `verify:lint-budget` landed

Commit `200e8c47` ("W2 — lint warning debt ledger") added
`verify:lint-budget` to `package.json` between W0 capture and W6 reconciliation.
The script runs `node scripts/check-lint-warning-budget.cjs` and exits 1 only
when ESLint warning counts exceed the budget recorded in
`docs/superpowers/operations/lint-warning-debt-ledger.md`. It is **not** part
of any merge or manual-deep chain; v1 places it in the `debt-dashboard`
bucket. The W2 commit message itself names W6 as the responsible classifier.

## Net effect on W6 taxonomy

- The slim merge gate (`verify`) is materially smaller than `main` and now
  matches the v1 `merge` bucket definition exactly.
- Two W-era debt-dashboard scripts exist: `debt:no-source-grep-test`
  (out-of-regex, narrative-only) and `verify:lint-budget` (first-class taxonomy
  row). Together they form the current ledger surface.
- No script was removed; renames did not occur. All v0-classified scripts are
  still present in `package.json`.

## Follow-up

- Consider widening the W6.1 inventory regex to include `^debt:` so
  `debt:no-source-grep-test` and future debt scripts are first-class taxonomy
  rows rather than narrative-only.
