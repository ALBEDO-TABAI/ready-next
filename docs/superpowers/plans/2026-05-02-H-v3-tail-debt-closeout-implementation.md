# H — v3 Tail Debt Closeout Implementation Plan

> **For agentic workers:** REQUIRED: use subagent-driven development. W0 is already completed by this document + pre-flight audit. Do not start H1/H2 implementation until the implementation plan is reviewed.

**Goal:** Close the v3 tail debts identified in H without starting v4, adding new architecture layers, or changing A0-G contracts.

**Architecture:** H is split into H1/H2 because W0 found the silent-catch baseline is far above 50. H1 lands low-risk doc/metric/timer/test fixes. H2 lands the two broader CI checkers with baselines.

**Tech Stack:** Electron main process, TypeScript, Node `node:test`, cjs gate scripts, existing `TOOL_ERROR_METRICS`.

---

## Summary

- W0 found the `silent catch N0 > 50` ESCALATE condition. H must split:
  - **H1:** A1/A2 docs, B1-B4 metrics, D timer idempotency, E active-child-run test cleanup.
  - **H2:** A3 `check-claude-md-claims.cjs` and B5 `check-silent-catch.cjs`.
- W0 also found A1 evidence drift: `CLAUDE.md / AGENTS.md` do not literally name `ChildExecutionPermission`; W1 should clarify ambiguous `permission context` wording instead.
- H1/H2 are delivery packages inside H, not a new roadmap phase and not v4.

## ESCALATE Handling

| Trigger | Action |
| --- | --- |
| §1 evidence differs by >30% | Fix the H counter-proposal/audit docs first; do not implement code against stale facts. W0 already applied this to A1. |
| silent catch N0 >50 | Split H into H1 and H2. H1 excludes A3/B5 cjs checkers; H2 handles the checker/baseline work after H1. |
| doc-claim checker false positives >30% | Land checker as soft warning, record follow-up PR for hardening allowlist, and do not block H1/H2 completion on the hard gate. |

## H1 Land Order

### W1 — A1/A2 Documentation Truth

Owner: Avicenna  
Land after: W0 review approval  
Files: `CLAUDE.md`, `AGENTS.md`, H counter-proposal if implementation discovers more factual drift.

Implementation:

- Replace §6.16 wording that implies a formal `ChildExecutionPermission` type with actual behavior: child runner passes `childInternal: true` and `childInternalSkillAction` through the gateway/tool-executor path.
- Change §6.12 base `skill_run_shell` allowlist to the real 18 commands:
  `python / python3 / node / bash / sh / curl / cat / ls / head / tail / grep / find / which / mkdir / pwd / echo / awk / sed`.
- State that `yt-dlp / ffmpeg / ffprobe / scenedetect` are reachable to scripts through runtime PATH or per-skill `shell_allowlist_extensions`, not through the base LLM-facing allowlist.
- Document that allowlist extensions are scoped by active/reference skill context (`referenceSkillId || activeSkillId`) and are not global user config.

Verify:

- `rg "ChildExecutionPermission" CLAUDE.md AGENTS.md` returns 0.
- `npm run verify:g`.

### W3 — B1-B4 Silent Failure Metrics

Owner: Erdos  
Land after: W1  
Files: `tool-error-metrics.ts`, B1-B4 modules, focused tests.

Metric names:

- `secretDecryptFailed: 'secret_decrypt_failed'`
- `skillReferenceInlineFailed: 'skill_reference_inline_failed'`
- `skillProjectionPartial: 'skill_projection_partial'`
- `runStateSelectionDirSkipped: 'run_state_selection_dir_skipped'`

`skill_projection_partial` payload:

```ts
type SkillProjectionPartialMetric = {
  phase: 'stat' | 'parse' | 'readdir'
  path: string
  errorKind: string
}
```

Implementation details:

- B1 decrypt failure keeps current return behavior (`raw`) and emits `secret_decrypt_failed`.
- B2 emits `skill_reference_inline_failed` only when at least one candidate doc existed/read failed and the inline path ultimately falls back.
- B3 emits `skill_projection_partial` only for projection read/traversal failures:
  - stat fallback: `phase: 'stat'`, real path
  - run_state read/parse fallback: `phase: 'parse'`, real path
  - readdir fallback: `phase: 'readdir'`, directory path
- `JSON.stringify` fallback is not counted as `skill_projection_partial`; it keeps current coercion behavior and carries `// silent-catch: stringify of arbitrary value, fallback to String() coercion is acceptable`.
- B4 emits `run_state_selection_dir_skipped` for `run-state-selection.ts` directory traversal failure. Other run-state-selection silent probes are left to H2 baseline unless the owner can add equivalent metric coverage without scope creep.

Testing:

- Use `node:module registerHooks` to mock `electron.safeStorage` for secret-storage tests, matching existing Electron test pattern.
- Add focused tests that trigger each metric and assert metric name plus payload fields.
- B3 tests must assert `phase`, `path`, and `errorKind`, not just metric presence.

Verify:

- Focus tests for B1-B4.
- `npm run verify:g`.

### W5 — Timer Idempotency + Active Child Run Test Cleanup

Owner: Hume  
Land after: W3 or in parallel with W3, but land after W3 if shared tests conflict  
Files: `runtime-manager.ts`, existing timer tests, `active-child-run-ipc.test.ts`, `ipc-handler.ts` only if needed for injectable helpers.

Timer implementation:

- `startReferenceHintSweep()` returns early if either reference-hint timer is already set.
- `startOutputDirSweep()` returns early if either output-dir timer is already set.
- Re-entry logs `console.warn(...)`; it does not emit a metric.
- Stop methods remain unchanged and clear the one active timer pair.

Active child IPC test priority:

1. Preferred: true behavior test. Extract tiny exported helpers from `ipc-handler.ts`:
   - `listActiveChildRunsForIpc(runtimeLike)`
   - `cancelChildRunForIpc(runtimeLike, payload)`
   The real `ipcMain.handle` callbacks call these helpers. The test imports helpers, passes a fake runtime, and asserts response shape + `source: 'ui_button'`.
2. Fallback only if helper extraction proves impossible: document the reason and use a cjs wrapper. This fallback is not expected from W0 findings.
3. Do not use a test that only re-runs `check-child-control-ipc.cjs`.

`check-child-control-ipc.cjs`:

- Keep it as a structure gate.
- Ensure it remains at least as strong as the removed source-grep assertions: main IPC, preload, renderer types, Settings, preview mocks, runner summary/cancel source/metric.

Verify:

- Timer idempotency tests.
- Rewritten `active-child-run-ipc.test.ts`.
- `node scripts/check-child-control-ipc.cjs`.
- `npm run verify:g`.

### W6a — H1 Docs and Gate Record

Owner: Hubble  
Land after: W1/W3/W5  

Implementation:

- Add H1 completion note to H implementation doc.
- Do not mark H overall complete yet.
- No `verify:h` yet; H2 owns final H gate.

Verify:

- `npm run verify:g`.
- `git diff --check`.

## H1 Completion Note

Date: 2026-05-02

- H1 W1/W3/W5/W6a implementation is present for review.
- HEAD during H1 verification: `4dcf09fa6c8b5311c8a4a1838c165ef67166e8a8`.
- `npm run verify:g` exited 0 after H1 code changes. The final `test:g:focus` segment reported 54 tests, 54 passed, 0 failed.
- `CLAUDE.md / AGENTS.md` no longer contain `ChildExecutionPermission`.
- No H2 work was started: no doc-claim checker, no silent-catch checker, no `verify:h`.
- H overall is not complete. H2 remains pending the review trigger below.
- H2 launch remains `W2 -> W4 -> W6b` after user/Claude review confirms no H1 regression, no new silent-catch debt from H1, and no timer regression.

## H2 Land Order

H1 -> H2 trigger:

- H1 W1/W3/W5/W6a must be landed first, then `npm run verify:g` must be green.
- User/Claude review must confirm H1 did not introduce regressions, new silent catch debt, or timer behavior regressions.
- Only after that review passes may H2 start (`W2 -> W4 -> W6b`).
- If review finds a regression, fix H1 first; do not start H2 while H1 is unstable.

### W2 — A3 Doc Claim Checker

Owner: Avicenna  
Land after: H1  
Files: `scripts/check-claude-md-claims.cjs`, `scripts/__tests__/check-claude-md-claims.test.cjs`, `package.json`.

Implementation:

- Scan `CLAUDE.md / AGENTS.md` §6.12-§6.18.
- Extract backtick claims that look like code identifiers, env names, metric names, or exported type/function names.
- Search in `src/main/modules`, `src/shared`, `src/preload`, and `scripts`.
- Report `<doc>:<line>: undefined identifier '<id>' — does not exist in code`.
- Add explicit allowlist for shell commands, prose labels, and path-like snippets only when they are proven false positives.
- If dry-run false positive rate is >30%, default the script to soft warning and write a follow-up note; otherwise make it a hard gate.

Verify:

- Script unit tests include Fake claim failure.
- `node scripts/check-claude-md-claims.cjs`.
- `npm run verify:g`.

### W4 — B5 Silent Catch Checker

Owner: Darwin  
Land after: H1 and W2  
Files: `scripts/check-silent-catch.cjs`, test file, baseline snapshot, `package.json`.

Implementation:

- Build an AST-based checker for `catch` blocks in:
  - `src/main/modules/agent-control`
  - `src/main/modules/skills-runtime`
  - `src/main/modules/tools`
- Catch blocks pass if they log, emit `logAgentMetric`, throw, or have a non-empty `// silent-catch: <reason>`.
- Existing silent catches are frozen in a baseline snapshot using stable identity `{ file, line, snippetHash }`.
- B1-B4 sites fixed in H1 should not be present in the baseline unless intentionally left as H2 baseline.
- New silent catch not in baseline must fail.

Verify:

- Script unit tests cover pass/fail/baseline/comment cases.
- Formal script run.
- `npm run verify:g`.

### W6b — Final H Gate and Docs

Owner: Hubble  
Land after: W2/W4  
Files: `package.json`, H docs, roadmap/residual docs as needed.

Implementation:

- Add scripts:
  - `test:h:gates`
  - `test:h:focus`
  - `verify:h = npm run verify:g && H gates && H focus`
- Update H counter-proposal status to completed and add Final Record.
- Update route document with H as "v3 tail closeout", not v4.
- Update residual debt doc with no-owner ADR trigger note for root cause 4 / O2 / O3.
- Add §6.15 docs for Hook handler and L2 compactor trigger standards.

Verify:

- `npm run verify:h`.
- `git diff --check`.
- Record HEAD, pass counts, H1/H2 split decision, and final N0/N_FINAL notes.

## Assumptions

- H1/H2 split is required because W0 found silent catch N0 far above 50.
- H2 may be reviewed separately after H1, but both are part of H, not a new roadmap phase.
- No A0-G gate is weakened or rewritten.
- No new registry/coordinator/context-builder abstraction is introduced.
- UI key-damage notification for B1 is out of scope; H only adds observability.

## H2 Final Record

- H2 landed after H1 review using the fixed order `W2 -> W4 -> W6b`.
- Verification HEAD: `e0916f3bd3658c79d35b3b9365ef191cfcdd380f`.
- `npm run verify:h` exited 0.
- The final `verify:h` run chained `verify:g`, `test:h:gates`, and `test:h:focus`.
- Final focused counts observed in `verify:h`: G focus 54 tests passed / 0 failed; H gates 9 tests passed / 0 failed.
- `test:h:focus` output: `CLAUDE.md claims: ok`; `silent catch: ok (198 baseline entries)`.
- Baseline: W0 broad silent-catch candidate range was 204-248; W4 AST gate froze `N0 = 198`, `N_FINAL = 198`.
- Break coverage: fake doc claim is covered by `check-claude-md-claims.test.cjs`; a new bare catch without log/metric/throw/comment/baseline is covered by `check-silent-catch.test.cjs`; `verify:h` invokes both gates.
- H final docs: the H counter-proposal status is `completed`; §6.15 now includes the Hook handler and L2 compactor trigger standards; the roadmap marks H as the v3 tail closeout, not v4.
- Post-H follow-up: the duplicated local `errorKind(error: unknown): string` helper should be extracted later if desired. H intentionally leaves it duplicated to avoid adding a shared abstraction inside the closeout scope.
