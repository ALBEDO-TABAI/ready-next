# F Pre-flight Audit Report

Date: 2026-05-01

## Summary

- Branch: `codex/skill-runtime-b-plan`
- HEAD: `822ad056aeed357e802e22fd2b9de839a80bf484`
- D/E status: `npm run verify:e` is present and was previously verified green in this worktree; F must chain `verify:e`.
- Main correction: the F plan's original "8 source-grep files / new no-source-grep rule" assumption is stale. `ready/no-source-grep-test` already exists and the live baseline is `142` entries across `110` files.
- Escalation status: no ESCALATE. The numbers differ from §0.2, but the execution plan has been corrected to freeze baseline growth, maintain the existing rule, and rewrite one example instead of bulk-clearing historical UI debt.

## Commands Run

```bash
git status --short --branch
git rev-parse --abbrev-ref HEAD && git rev-parse HEAD
node -e "const p=require('./package.json'); console.log(JSON.stringify(p.scripts,null,2))"
rg -n "no-source-grep-test|baseline|createNoCoordinatorIdLeakRule|RULE_IDS" eslint-rules/index.mjs eslint.config.mjs scripts/check-eslint-baseline.cjs eslint-rules/baseline.json
grep -rln 'readFileSync.*\.ts\|readFileSync.*\.tsx' src/__tests__/ 2>/dev/null | sort
rg -n "eslint-disable-next-line ready/no-source-grep-test|allow-source-grep:" src eslint-rules scripts -g '*.{ts,tsx,mjs,cjs,js}'
rg -n "export function __(reset|seed|stub|forceFlush|breakOpen)\w*ForTests?|export const __breaksInvariants|function setupRunner|const setupRunner" src -g '*.{ts,tsx}'
node scripts/check-eslint-baseline.cjs --area ui-history --max 9999
command -v ffmpeg; ffmpeg -version | head -n 1
command -v ffprobe; ffprobe -version | head -n 1
command -v yt-dlp; yt-dlp --version
find src/__tests__ -maxdepth 2 -type d -name e2e -print
find src/__tests__ -maxdepth 3 -type f -name '*.e2e.ts' -print
```

## Source-grep Audit

| Item | Result | Execution decision |
|---|---:|---|
| Original §0.2 command hits | 9 files | Plan text corrected; do not use old 8-file scope. |
| Existing `ready/no-source-grep-test` baseline | 142 entries / 110 files | `N0=142`; W5 freezes final count with virtual area `no-source-grep-test`. |
| Existing `eslint-disable-next-line ready/no-source-grep-test` | 46 lines / 34 files | Keep valid existing ESLint disables; docs must recommend reason suffix. |
| Existing `allow-source-grep:` comments | 0 | W2 adds support and missing-reason message; W3 documents it as preferred form. |
| `ready/no-source-grep-test` rule | Already registered as `error` | W2 maintains existing rule, not a duplicate. |

Original command hits:

| File | Decision |
|---|---|
| `src/__tests__/atomic-write.test.ts` | Keep. E fsync-order source inspection is a valid low-level contract; do not rewrite. |
| `src/__tests__/before-quit-cleanup.test.ts` | Historical baseline. No F rewrite target. |
| `src/__tests__/chat-header-menu-style-contract.test.ts` | Historical UI baseline. No F rewrite target. |
| `src/__tests__/database.test.ts` | Historical baseline. No F rewrite target. |
| `src/__tests__/skill-execution-tools-removed.test.ts` | Historical source contract. No F rewrite target. |
| `src/__tests__/skill-python-runtime-contract.test.ts` | Historical source contract. No F rewrite target. |
| `src/__tests__/skill-session-cleanup-contract.test.ts` | Historical source contract. No F rewrite target. |
| `src/__tests__/tool-loop-dedup.test.ts` | W3 recommended rewrite sample; single-point source-grep, not `atomic-write.test.ts`. |
| `src/__tests__/tool-registry-skills-dynamic-resolution.test.ts` | Historical bundle-topology source contract. No F rewrite target. |

W2 implementation basis:

- Add or maintain four fixture cases for `ready/no-source-grep-test`: valid, invalid, `allow-source-grep` with reason, and `allow-source-grep` missing reason.
- Keep existing ESLint disable form accepted; do not require converting existing files.
- Add virtual checker area `no-source-grep-test` that counts current findings by rule id, not by the existing `ui-history` area label.

## Helper Invariant Audit

| Helper | File:line | Decision |
|---|---|---|
| `__resetBrowserRegistryForTests` | `src/main/modules/browser-engine/browser-cleanup.ts:109` | `__breaksInvariants`: resets BrowserView registry singleton. |
| `__resetSkillChildDriversForTests` | `src/main/modules/agent-control/skill-child-drivers.ts:80` | `__breaksInvariants`: resets child driver registry singleton. |
| `__resetSessionContinuityForTests` | `src/main/modules/agent-control/session-continuity.ts:634` | `__breaksInvariants`: resets in-memory session continuity state. |
| `__resetSkillChildRunnerForTests` | `src/main/modules/agent-control/skill-child-runner.ts:1203` | `__breaksInvariants`: resets child-runner singleton lifecycle caches. |
| `setupRunner` | `src/__tests__/skill-child-runner.test.ts:512` | File-level `__breaksInvariants`: wraps singleton reset and custom repository injection. |
| `setupRunner` | `src/__tests__/skill-child-runner-resume-lifecycle.test.ts:307` | File-level `__breaksInvariants`: wraps singleton reset and resume repository injection. |
| `setupRunner` | `src/__tests__/skill-child-run-end-to-end.test.ts:245` | File-level `__breaksInvariants`: wraps singleton reset and fake repository/runtime wiring. |

Plan correction:

- `src/main/modules/agent-control/sub-agent-runner.ts` does not exist.
- `src/main/modules/agent-control/sub-agent/sub-agent-runner.ts` exists, but no `__resetSubAgentRegistryForTests` was found.
- W1 must not invent a sub-agent reset marker.

## E2E Audit

| Item | Result |
|---|---|
| Existing `src/__tests__/e2e` directory | none |
| Existing `*.e2e.ts` tests | none |
| `READY_E2E` usage | none |
| `ffmpeg` | `/opt/homebrew/bin/ffmpeg`, version 8.1 |
| `ffprobe` | `/opt/homebrew/bin/ffprobe`, version 8.1 |
| `yt-dlp` | `/opt/homebrew/bin/yt-dlp`, version 2026.02.04 |

W4 harness target:

1. Create fixture mp4 from `ffmpeg -f lavfi`.
2. Launch real child-run lifecycle through `startSkillChildRun`.
3. Use the real VEA child driver and real runtime lifecycle.
4. Verify `status='running'` from launch.
5. Verify `runtime.calls.length >= 1`.
6. Verify true ffmpeg/scenedetect output exists and `size > 0`.
7. Verify a close event arrives before timeout.
8. Verify the plan reaches ffmpeg/scenedetect before any AI-stage mock short-circuit.

W4 must not add a driver `if (TEST)` branch. The AI stage boundary is handled through fixture/runtime injection and documented as outside F's e2e scope.

## Downstream Work Order

1. W1: add helper invariant rule and markers exactly for the seven audited helper sites.
2. W2: maintain existing source-grep rule; add `allow-source-grep` missing reason behavior and virtual baseline area.
3. W3: write testing conventions, include waiver canonicalization, and rewrite `tool-loop-dedup.test.ts` or another W0-approved non-atomic simple sample.
4. W4: add opt-in e2e harness and fixture.
5. W5: add `verify:f` and manually test the four required break cases.
6. W6: write final docs with real `HEAD`, `verify:f` output, e2e log summary, and `N0 -> N_FINAL`.
