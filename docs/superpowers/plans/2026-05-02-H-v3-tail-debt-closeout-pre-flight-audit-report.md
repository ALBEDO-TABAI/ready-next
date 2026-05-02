# H W0 Pre-flight Audit Report

> Date: 2026-05-02
> Worktree: `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`
> Branch: `codex/skill-runtime-b-plan`
> HEAD: `4dcf09fa6c8b5311c8a4a1838c165ef67166e8a8`

## Summary

- W0 found one required factual correction in the H counter-proposal: `CLAUDE.md / AGENTS.md` do **not** literally name `ChildExecutionPermission`; the real issue is ambiguous "permission context" wording plus one old F plan mention.
- Actual shell primitive baseline is 18 commands. `CLAUDE.md / AGENTS.md` currently overstate it as 22 by including `yt-dlp / ffmpeg / ffprobe / scenedetect`.
- Silent catch audit exceeds the hard threshold: approximate real catch blocks `312`, broad silent candidates about `204-248`, so H must split into H1/H2 per M3.
- `active-child-run-ipc.test.ts` is a source-grep-style test; W5 should prefer an extracted injectable IPC behavior helper over a cjs wrapper.

## Commands Run

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
rg -n "ChildExecutionPermission" src docs CLAUDE.md AGENTS.md
node --input-type=module - <<'NODE' # extract SHELL_ALLOWLIST commands/count
rg -n "命令白名单|yt-dlp|ffmpeg|ffprobe|scenedetect|shell_allowlist_extensions" CLAUDE.md AGENTS.md src/main/modules/tools/skill-primitives/run-shell.ts
node --input-type=module - <<'NODE' # broad catch/silent-catch approximation
node --input-type=module - <<'NODE' # §6.12-§6.18 backtick claim count
rg -n "startReferenceHintSweep|startOutputDirSweep|referenceHintBootTimer|outputDirSweepBootTimer" src/main/modules/skills-runtime/runtime-manager.ts src/__tests__
nl -ba src/__tests__/active-child-run-ipc.test.ts | sed -n '1,90p'
rg -n "@testing-library|jsdom|happy-dom|react-test" package.json
```

Subagent read-only audits:

- Hubble-W0-Audit: A-series documentation truth.
- Erdos-W0-SilentCatch: broad silent catch and B1-B4 sites.
- Hume-W0-TimerTest: timer idempotency and active-child-run test feasibility.

## A-series Documentation Truth

### `ChildExecutionPermission`

| Area | Count | Notes |
| --- | ---: | --- |
| `src/` | 0 | No production type/interface exists. |
| `CLAUDE.md / AGENTS.md` | 0 | They do not literally name `ChildExecutionPermission`. |
| `docs/` | 6 | 5 are inside H counter-proposal itself; 1 is in the F plan. |

Decision:

- A1 remains doc-only.
- W0 corrected the H counter-proposal wording: the production-doc issue is ambiguous "explicit child-internal permission context" wording, not a literal `ChildExecutionPermission` mention.
- W1 should change `CLAUDE.md / AGENTS.md §6.16` to describe the actual mechanism: `childInternal: true`, `childInternalSkillAction`, gateway path, and tool-executor admission.

### `SHELL_ALLOWLIST`

Actual `SHELL_ALLOWLIST` count: `18`

```text
python / python3 / node / bash / sh / curl / cat / ls / head / tail / grep / find / which / mkdir / pwd / echo / awk / sed
```

Document mismatch:

- `CLAUDE.md:141` and `AGENTS.md:141` list 22 commands and incorrectly include `yt-dlp / ffmpeg / ffprobe / scenedetect`.
- `CLAUDE.md:142` and `AGENTS.md:142` also imply `yt-dlp/scenedetect` participate in the shell-compat parse path; actual single-quote compat bins are only `python / python3 / node / grep / find / awk / sed`.
- `primitive-schemas.ts` has the correct 18-command baseline.

`shell_allowlist_extensions`:

- `CLAUDE.md / AGENTS.md`: 0 mentions.
- production/shared code: 5 references.
- tests/fixtures: 17 references.
- docs: 2 references, both inside H.

Decision:

- W1 must document that media tools are available to scripts through runtime PATH or per-skill `shell_allowlist_extensions`, not through the base LLM-facing allowlist.
- W1 must mention `referenceSkillId || activeSkillId` scoped extension behavior, not just reference-skill hints.

### §6.12-§6.18 Backtick Claims

Raw extraction:

- `CLAUDE.md`: 63 claim occurrences, 57 unique.
- `AGENTS.md`: 63 claim occurrences, 57 unique.
- Raw corpus grep across `src/main/modules`, `src/shared`, `src/preload`, and `scripts`: 0 missing.

Decision:

- The claim checker false-positive threshold is not triggered at W0.
- Because silent catch N0 exceeded 50, A3 checker moves to H2 with B5. It can remain hard-error by default unless W2/H2 dry-run finds >30% false positives.

## B-series Silent Catch Audit

Broad scan:

| Measure | Count |
| --- | ---: |
| Raw `catch` text hits in target dirs | 361 |
| Approximate real catch blocks | 312 |
| Local regex catch blocks | 324 |
| Bare `catch { ... }` blocks | 168 |
| Broad silent candidates | about 204-248 |

Target dirs:

- `src/main/modules/agent-control`
- `src/main/modules/skills-runtime`
- `src/main/modules/tools`

Decision:

- ESCALATE condition `silent catch N0 > 50` is triggered.
- H must split:
  - H1: A1/A2 docs + B1-B4 metrics + D timer + E active-child-run test.
  - H2: A3 doc-claim checker + B5 silent-catch checker/baseline.

### B1-B4 Exact Catch Sites

| Item | File/site | Current behavior | H1 handling |
| --- | --- | --- | --- |
| B1 encrypt fallback | `secret-storage.ts:34-36` | silent fallback to XOR encryption | allow or metric if touched; not the primary B1 risk |
| B1 decrypt fallback | `secret-storage.ts:55-57` | returns raw encrypted-looking value | emit `secret_decrypt_failed`, keep return raw |
| B2 reference doc read | `skill-context-orchestrator.ts:361-366` | continue/fall back to tool path | emit `skill_reference_inline_failed` after candidates fail |
| B3 stringify fallback | `skill-running-projection.ts:50-52` | returns `String(value)` | include in `skill_projection_partial` using `phase: 'parse'`, `path: '<projection-value>'` |
| B3 stat fallback | `skill-running-projection.ts:94-96` | returns null | emit `skill_projection_partial` with `phase: 'stat'` |
| B3 run_state read/parse | `skill-running-projection.ts:103-105` | returns null | emit `skill_projection_partial` with `phase: 'parse'` |
| B3 readdir fallback | `skill-running-projection.ts:169-171` | returns from directory walk | emit `skill_projection_partial` with `phase: 'readdir'` |
| B4 stat fallback | `run-state-selection.ts:42-44` | returns null | leave for H2 baseline unless H1 owner finds same metric is trivial |
| B4 run_state parse | `run-state-selection.ts:54-56` | uses empty record | leave for H2 baseline unless H1 owner finds same metric is trivial |
| B4 readdir fallback | `run-state-selection.ts:135-137` | returns from traversal | emit `run_state_selection_dir_skipped` |

W3 payload requirement:

```ts
type SkillProjectionPartialMetric = {
  phase: 'stat' | 'parse' | 'readdir'
  path: string
  errorKind: string
}
```

## D/E Audit

### Timer Idempotency

Current state:

- `startReferenceHintSweep`: registers 1 timeout + 1 interval every call.
- `startOutputDirSweep`: registers 1 timeout + 1 interval every call.
- No idempotency guard; repeated starts overwrite stored timer handles.
- Existing test only covers one `startReferenceHintSweep()` call.
- No output-dir sweep idempotency test exists.

Decision:

- W5 adds idempotency guards and behavior tests using `node:test` mock timers.
- Re-entry should no-op and `console.warn`; no metric.

### `active-child-run-ipc.test.ts`

Current state:

- `active-child-run-ipc.test.ts`: 2 tests, 14 `assert.match` checks, hidden source-grep via local `read()`.
- `check-child-control-ipc.cjs`: 6 files, 22 regex checks, includes preview mocks that the TS test does not cover.
- `package.json` has no `jsdom`, Testing Library, Vitest, Playwright, Cypress, or React test renderer dependency.

Decision:

- W5 should not mount React unless it also adds test tooling, which is outside H.
- Preferred behavior route: extract tiny injectable helpers from the IPC handler so the test can import and call list/cancel behavior with a fake runtime.
- CJS wrapper is not allowed as the primary test unless helper extraction proves impossible.

## W0 Outcomes

- H counter-proposal A1 evidence corrected.
- H implementation must split into H1/H2 because silent catch N0 exceeds 50.
- No W1-W6 code implementation has started.
- Next review artifact: `2026-05-02-H-v3-tail-debt-closeout-implementation.md`.
