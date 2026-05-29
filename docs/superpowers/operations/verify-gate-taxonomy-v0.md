---
title: Verify gate taxonomy v0
date: 2026-05-22
stage: W0
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
formalized_in: W6 (release gate reconciliation)
---

# Verify gate taxonomy v0

This is the W0 seed classification of every `verify:*`, `typecheck`,
`lint:check`, and `test*` script in `package.json` on branch `codex/readyguy`
@ 2026-05-22. W6 will reconcile and promote it to v1.

Buckets:

- **merge** — runs on every PR before merge. Either part of top-level
  `npm run verify` (slim chain) or a declared W1 expansion target. Must exit 0
  for merge.
- **manual-deep** — historical staged verify chain (`verify:a0`..`verify:t`);
  used for deep diagnostic runs, not per-PR.
- **release-only** — only run when cutting a release artifact (rebuilds
  native, runs cloud-side checks).
- **debt-dashboard** — tracks debt without blocking merge (e.g., baseline
  growth gates that are currently red and tracked in W1/W2).
- **archive** — superseded or not currently invoked; candidates for removal
  in W6.

## Table

| script | bucket | rationale |
| --- | --- | --- |
| `verify` | merge | top-level slim merge gate (`verify:native && typecheck && check-silent-catch && check-move-only-pr && verify:ipc-contract && test`) |
| `typecheck` | merge | part of slim `verify`; gates type errors |
| `lint:check` | merge | W1 expansion target — once W1 clears the 25 errors this becomes part of the merge gate; currently red (25 errors / 769 warnings) |
| `verify:native` | merge | part of slim `verify`; required for SQLite/Electron ABI paths |
| `verify:ipc-contract` | merge | part of slim `verify`; Stage V V5 contract gate |
| `test` | merge | part of slim `verify`; runs `test:parallel && test:serial-skill-child` |
| `test:parallel` | merge | invoked by `test` |
| `test:serial-skill-child` | merge | invoked by `test` |
| `verify:ipc-contract` | merge | duplicate row removed — single source above |
| `verify:calendar` | manual-deep | calendar-specific deep suite; run before calendar-impacting PRs |
| `verify:cloud` | release-only | runs `rebuild:native && verify:t && test` plus `check-verify-native-trigger`; release / cloud sign-off only |
| `verify:f:e2e` | manual-deep | end-to-end suite; not gated per-PR |
| `verify:a0` | manual-deep | stage A0 deep chain (includes `lint:check` + baseline + plan pairing + commit-msg check); deep diagnostic |
| `verify:a05` | debt-dashboard | `check-eslint-baseline --area a1-gate --max 0`; tracks a1-gate area baseline |
| `verify:a1` | manual-deep | stage A1 deep chain; subagent isolation + skill-child API |
| `verify:b` | manual-deep | stage B deep chain (composes a0 + a1 + tool-error / projection / settings checks) |
| `verify:c` | manual-deep | stage C deep chain (coordinator isolation + identity + skill rearm + turn-engine no-domain-branch) |
| `verify:d` | manual-deep | stage D deep chain (reminder / compactor / hook / turn-frame steering) |
| `verify:e` | manual-deep | stage E deep chain (atomic write + silent-catch + ipc-contract + output-dir lifecycle) |
| `verify:f` | manual-deep | stage F deep chain (testing-conventions + tool-loop dedup) |
| `verify:g` | manual-deep | stage G deep chain (child-status vocab + child-control IPC + turn-feature-flags) |
| `verify:h` | manual-deep | stage H deep chain (CLAUDE.md claims) |
| `verify:i1` | manual-deep | stage I1 deep chain (renderer metric / friendliness) |
| `verify:i` | manual-deep | alias to `verify:i1` |
| `verify:j` | manual-deep | stage J deep chain (process handlers + log rotation + terminal reason + child output dir) |
| `verify:k` | manual-deep | stage K deep chain (test coverage by verify + sqlite skip pattern) |
| `verify:l` | manual-deep | stage L deep chain (verify:k + verify:l:gates) |
| `verify:l:gates` | manual-deep | stage L gates (ledger funnel + close-event + projection-view-only + status vocabulary + child-run transition validator) |
| `verify:m` | manual-deep | stage M deep chain (frame-write single source + budget single source + read-artifact no-active + context-modifier shape) |
| `verify:n` | manual-deep | stage N deep chain (manifest vs static tool name + no parent force for child loop) |
| `verify:o` | manual-deep | stage O deep chain (task-card projection-only + renderer no-status-text-guess + projection-push wired) |
| `verify:p` | manual-deep | stage P deep chain (skill authorization read-skill / authorization rearm order) |
| `verify:q` | manual-deep | stage Q deep chain (canResume single source + skill resumability triple-fence) |
| `verify:r` | manual-deep | stage R deep chain (research domain + web-search/web-fetch tools + skill assets + tool-call args) |
| `verify:s` | manual-deep | stage S deep chain (provider parity + capability class + reasoning / token / clarification / migration) |
| `verify:t` | manual-deep | stage T deep chain (sandbox bash high-risk + symlink reject + shell-output redact + parallel branch + MCP + deferred tool) |
| `test:watch` | archive | dev convenience watcher; not a gate |
| `test:skill` | manual-deep | skill + agent-context + embedded-skill + db-worker + spawn + before-quit + boot-reaper deep run |
| `test:perf` | manual-deep | db / file-filter / file-watcher / indexer / use-force-layout perf suite |
| `test:ui-contracts` | manual-deep | UI contract test set |
| `test:a0:gates` | manual-deep | invoked by `verify:a0` and `verify:a1` |
| `test:a0:focus` | manual-deep | invoked by `verify:a0`; skill-child + turn-engine focus |
| `test:c:gates` | manual-deep | invoked by `verify:c` |
| `test:c:focus` | manual-deep | invoked by `verify:c`; coordinator + turn-engine + planner focus |
| `test:f:gates` | manual-deep | invoked by `verify:f` |
| `test:f:focus` | manual-deep | invoked by `verify:f` |
| `test:g:gates` | manual-deep | invoked by `verify:g` |
| `test:g:focus` | manual-deep | invoked by `verify:g` |
| `test:h:gates` | manual-deep | invoked by `verify:h` |
| `test:h:focus` | manual-deep | invoked by `verify:h` |
| `test:i:gates` | manual-deep | composed of `test:i1:gates` + silent-catch test |
| `test:i:focus` | manual-deep | runs `check-silent-catch.cjs` |
| `test:i1:gates` | manual-deep | invoked by `verify:i1` |
| `test:i1:focus` | manual-deep | invoked by `verify:i1` |
| `test:j:gates` | manual-deep | invoked by `verify:j` |
| `test:j:focus` | manual-deep | invoked by `verify:j` |
| `test:k:gates` | manual-deep | invoked by `verify:k` |
| `test:l:gates` | manual-deep | invoked by `verify:l:gates` |
| `test:l:focus` | manual-deep | invoked by `verify:l:gates` |
| `test:m:gates` | manual-deep | invoked by `verify:m` |
| `test:m:focus` | manual-deep | invoked by `verify:m` |
| `test:n:gates` | manual-deep | invoked by `verify:n` |
| `test:n:focus` | manual-deep | invoked by `verify:n` |
| `test:o:gates` | manual-deep | invoked by `verify:o` |
| `test:o:focus` | manual-deep | invoked by `verify:o` |
| `test:p:gates` | manual-deep | invoked by `verify:p` |
| `test:p:focus` | manual-deep | invoked by `verify:p` |
| `test:q:gates` | manual-deep | invoked by `verify:q` |
| `test:q:focus` | manual-deep | invoked by `verify:q` |
| `test:r:gates` | manual-deep | invoked by `verify:r` |
| `test:r:focus` | manual-deep | invoked by `verify:r` |
| `test:s:gates` | manual-deep | invoked by `verify:s` |
| `test:s:focus` | manual-deep | invoked by `verify:s` |
| `test:t:gates` | manual-deep | invoked by `verify:t` |
| `test:t:focus` | manual-deep | invoked by `verify:t` |

## Notes

- `check-silent-catch.cjs` and `check-eslint-baseline.cjs` are invoked via
  `verify` / `verify:a0` rather than as standalone `verify:*` scripts; they
  are merge-gate components but do not have dedicated `verify:*` entries.
- `check-move-only-pr.cjs` is part of `verify` and no-ops without the
  move-only label/env; merge bucket.
- W6 will reconcile this table with any historical scripts that should be
  renamed/removed and align it with CI labels if CI exists for this branch.
