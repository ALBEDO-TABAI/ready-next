---
name: Z0-1-release-candidate-gate-bundle-implementation
stage: Z0.1
date: 2026-05-24
status: implementation-draft
enforce: false
parent_seed: docs/superpowers/plans/archive/2026-05-24-Z-release-candidate-seed.md
predecessor_closeout: docs/superpowers/audits/2026-05-23-stage-y-closeout/CLOSE-NOTE.md
scope_lock: release-candidate gate bundle only
---

# Z0.1 — Release-candidate gate bundle implementation plan

## 0. Decision summary

Stage Y can be green while the product is still not release-ready,
because the 20 dogfood surfaces may honestly remain
`deferred-with-owner`. Z0.1 adds a separate release-candidate gate:

```bash
npm run verify:release-candidate
```

The gate is fail-fast and intentionally starts with
`verify:release-live-evidence`. If live evidence is still deferred, the
release run stops before expensive `test` and `build` work. Once the live
surfaces pass, the same command continues through the Stage Z readiness
proofs and then the automated Stage Z bundle.

## 1. Scope

In scope:

- Add a package script `verify:release-candidate`.
- Add `scripts/run-release-candidate-verify.cjs` as the single local
  release-candidate command runner.
- Add `scripts/check-release-stage-z-readiness.cjs` to keep Stage Z's
  non-code release blockers (CI URL, deep-gates disposition, manual
  checklist, Codex-operated simulated-human agent acceptance, branch
  protection, platform smokes) in the same fail-fast release-candidate
  path.
- Include these checks in the runner:
  - `verify:release-live-evidence`
  - `verify:release-stage-z-readiness`
  - `verify:native`
  - `typecheck`
  - `lint:check`
  - `verify:lint-budget`
  - `check-eslint-baseline`
  - `verify:ipc-contract`
  - `verify:meta-paths`
  - `verify:stage-x-known-regressions`
  - `verify:stage-y-known-regressions`
  - `verify:stage-y-p0-ledger`
  - `verify:stage-y-dogfood-evidence`
  - `verify:agent-acceptance-checklist`
  - `test`
  - `build`
- Add focused script tests proving the release-candidate runner cannot
  omit the live evidence gate, the Stage Z readiness gate, or the Stage Z
  required bundle.
- Expose the agent acceptance checklist as its own package script so the
  final release standard is explicit rather than only implicit inside
  the broad `test` command.
- Require Stage Z to record Codex-operated simulated-human agent
  acceptance evidence for every A1-L6 checklist row. Automated pass
  output alone is not enough for final release readiness; each pass row
  must point to an existing per-item operation record under the Stage Z
  evidence directory.

Out of scope:

- Creating or editing GitHub Actions release jobs.
- Marking any of the 20 dogfood surfaces as pass.
- Running live dogfood on behalf of 白.
- Creating fake Stage Z closeout evidence for manual/CI/platform items.
- Changing business logic, UI, provider behavior, or BrowserView runtime
  behavior.

## 2. Acceptance

- `node --test scripts/__tests__/run-release-candidate-verify.test.cjs`
  passes.
- `npm run verify:agent-acceptance-checklist` passes.
- `node --test scripts/__tests__/check-release-stage-z-readiness.test.cjs`
  passes.
- `npm run verify:release-candidate` fails today at
  `verify:release-live-evidence` with 0/20 live pass surfaces. That is the
  correct current release-blocking result.
- `npm run verify:release-stage-z-readiness` fails today with the explicit
  missing Stage Z proofs (first remote CI URL, deep-gates disposition,
  executed manual checklist, Codex-operated simulated-human agent
  acceptance, branch protection, and macOS/Windows packaged smokes). That
  is also the correct current release-blocking result.
- Once all 20 surfaces have pass evidence and Stage Z non-code proofs exist,
  the same command continues into native, typecheck, lint, IPC, Stage X/Y,
  agent acceptance, test, and build checks.

## 3. Risk and rollback

Risk is limited to release verification. The new commands do not run in
the normal development `verify` chain, so they cannot slow everyday work.

Rollback is removing the package script, the runner, this plan, and the
runner test.
