---
name: G W0 pre-flight audit
description: G phase W0 read-only audit for N1-N4 and O7 control surface.
status: completed
date: 2026-05-01
owner: Hubble
---

# G W0 Pre-flight Audit Report

## 0. Completion Standard

W0 is complete when:

1. Branch, HEAD, worktree state, and audit time are recorded.
2. `package.json` verify-chain is inspected and the G chaining assumption is stated.
3. Every G §0.2 item is quantified with exact read-only commands and counts.
4. N2 SubAgent/resume shape is inspected and a placement decision is made without implementing it.
5. W1-W5 implementers get per-file disposition tables.
6. The three hard-stop judgments are explicit.
7. Only this audit report and, if needed, factual §0.2 corrections in the G plan are changed.

## 1. Baseline

| Item | Value |
|---|---|
| Worktree | `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan` |
| Branch | `codex/skill-runtime-b-plan` |
| HEAD | `806e9b1141abb6a20f95b1e072a1315add3aff61` |
| Audit time | `2026-05-01 20:38:49 CST` |
| Git status summary at start | `?? docs/superpowers/plans/2026-04-30-G-quality-polish-and-control-surface-implementation.md` |

Command:

```bash
git branch --show-current && git rev-parse HEAD && git status --short
date '+%Y-%m-%d %H:%M:%S %Z'
```

## 2. Verify-chain Status

`package.json` already contains `verify:f`, and `verify:f` chains `verify:e`.

Therefore G should add `verify:g` that chains `verify:f`, not `verify:e` or `verify:d` directly.

Command:

```bash
sed -n '1,220p' package.json
```

Observed script tail:

```json
"verify:f": "npm run verify:e && node scripts/check-eslint-baseline.cjs --area no-source-grep-test --max 142 && node scripts/check-testing-conventions-doc.cjs && npm run test:f:gates && npm run test:f:focus"
```

## 3. Exact Audit Counts

Summary command:

```bash
printf 'set_defs='; rg "^const TERMINAL_CHILD_CLOSE_STATUSES" src/main/modules/agent-control | wc -l | tr -d ' '; printf '\nset_refs='; rg "TERMINAL_CHILD_CLOSE_STATUSES" src/main/modules/agent-control | wc -l | tr -d ' '; printf '\nstatus_literal_decisions='; rg "(close|closeEvent|live)\.status\s*(===|!==)\s*['\"]|childStatus\s*(===|!==)\s*['\"]|['\"](completed|failed|killed|blocked|recoverable_paused|budget_paused)['\"]\s*(===|!==)\s*(close|closeEvent|live)\.status" src/main/modules/agent-control src/main/modules/tools src/main/modules/rss-engine src/main/modules/skills-runtime | wc -l | tr -d ' '; printf '\nchildCloseEvent_writes='; rg "(\.|\b)childCloseEvent\s*=" src/main/modules src/shared src/preload src/renderer | wc -l | tr -d ' '; printf '\nflag_refs='; rg "isChildResumeEnabled|isChildInternalStrictAdmissionEnabled|isChildRunCircuitBreakerEnabled" src/main/modules src/shared src/preload src/renderer | wc -l | tr -d ' '; printf '\nfailed_skill_refs_main='; rg "failed_skill" src/main/modules src/shared src/preload src/renderer | wc -l | tr -d ' '; printf '\nfailed_skill_refs_tests='; rg "failed_skill" src/__tests__ | wc -l | tr -d ' '; printf '\nrenderer_childRunId_refs='; rg "childRunId" src/renderer | wc -l | tr -d ' '; printf '\npreload_control_refs='; rg "cancelDetachedSkillTask|suspendRun|resumeRun|listActiveChildRuns|cancelChildRun" src/preload src/renderer/types/electron.d.ts | wc -l | tr -d ' '; printf '\n'
```

Counts:

| Area | Count |
|---|---:|
| `TERMINAL_CHILD_CLOSE_STATUSES` definitions | 2 |
| `TERMINAL_CHILD_CLOSE_STATUSES` references | 4 |
| close-status literal decision candidates | 16 |
| `childCloseEvent =` candidates | 8 |
| flag helper references | 10 |
| `failed_skill` refs in main/shared/preload/renderer | 20 |
| `failed_skill` refs in tests | 21 |
| renderer `childRunId` refs | 0 |
| preload/type control refs for existing task-level controls | 9 |

## 4. N1 Status Vocabulary

Command:

```bash
rg -n "TERMINAL_CHILD_CLOSE_STATUSES" src/main/modules src/shared src/preload src/renderer package.json
```

| File | Lines | Disposition |
|---|---:|---|
| `src/main/modules/agent-control/turn-engine.ts` | 316, 337 | Replace: duplicate terminal set and `.has(live.status)` should move to shared helper. |
| `src/main/modules/agent-control/turn-frame-steering.ts` | 296, 307 | Replace: duplicate terminal set and `.has(close.status)` should move to shared helper. |

Command:

```bash
rg -n "(close|closeEvent|live)\.status\s*(===|!==)\s*['\"]|childStatus\s*(===|!==)\s*['\"]|['\"](completed|failed|killed|blocked|recoverable_paused|budget_paused)['\"]\s*(===|!==)\s*(close|closeEvent|live)\.status" src/main/modules/agent-control src/main/modules/tools src/main/modules/rss-engine src/main/modules/skills-runtime
```

| File | Lines | Count | Disposition |
|---|---:|---:|---|
| `src/main/modules/agent-control/child-run-circuit-breaker.ts` | 92 | 1 | Replace with helper/predicate dedicated to failure counting. |
| `src/main/modules/agent-control/skill-child-sub-agent.ts` | 220 | 1 | Allow-literal: semantic mapping from child close to SubAgent close reason. |
| `src/main/modules/agent-control/skill-child-runner.ts` | 1158-1161 | 4 | Replace: retained-lifecycle terminal/blocked classifier should use shared status helper(s). |
| `src/main/modules/agent-control/turn-engine.ts` | 2517-2522 | 3 | Allow-literal: parent terminal-reason mapping, but whitelist explicitly. |
| `src/main/modules/rss-engine/item-analysis-manager.ts` | 608, 611, 614 | 4 | Allow-literal outside agent-control: product error classification for VEA result. |
| `src/main/modules/skills-runtime/runtime-manager.ts` | 2087, 2123, 2137 | 3 | Allow-literal outside agent-control: compatibility `success` derivation for await helper; comment line included in grep count. |

Additional status switches:

```bash
rg -n "switch \((close|closeEvent|live)\.status\)|switch \(childStatus\)|case ['\"](completed|failed|killed|blocked|recoverable_paused|budget_paused)['\"]" src/main/modules/agent-control src/main/modules/tools src/main/modules/rss-engine src/main/modules/skills-runtime
```

Important G-relevant switch:

| File | Lines | Disposition |
|---|---:|---|
| `src/main/modules/agent-control/turn-engine.ts` | 418-433 | Allow-literal: `renderChildCommandOutcome` user-facing command outcome switch. |

Other switch matches are broader status-mapping code and should not be blindly converted by W1.

## 5. W2 childCloseEvent Writes

Command:

```bash
rg -n "childCloseEvent\s*=|\.childCloseEvent\s*=" src/main/modules src/shared src/preload src/renderer
```

| File | Line | Kind | Disposition |
|---|---:|---|---|
| `src/main/modules/tools/skills-tools.ts` | 2122 | `contract.childCloseEvent = result.closeEvent` | Baseline/allowed: initial tool-result contract stamping, not resume clearing. |
| `src/main/modules/agent-control/run-contracts.ts` | 1455 | local variable decode | Baseline/allowed: local reconstruction, not contract mutation. |
| `src/main/modules/agent-control/run-contracts.ts` | 1457 | local variable reset | Baseline/allowed: local reconstruction, not contract mutation. |
| `src/main/modules/agent-control/turn-engine.ts` | 1486 | direct contract write | Allow for H1 gate only if W2 checker scopes to resume branch; otherwise replace via a narrow helper to avoid opening a broad direct-assignment hole. |
| `src/main/modules/agent-control/turn-engine.ts` | 1505 | direct contract write after cancel | Allow-literal/direct write: cancellation close is newly produced in this turn. |
| `src/main/modules/agent-control/turn-engine.ts` | 1580 | direct resume write | Forbidden after W2: replace with `Object.assign(contract, resumed.freshContractFields)`. |
| `src/main/modules/agent-control/turn-engine.ts` | 2504 | direct contract write | Allow-literal/direct write: terminal continuation close routing. |
| `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts` | 30 | local metadata read variable | Baseline/allowed: not a mutation despite grep match. |

H1 direct assignment gate: if W2 adds a script rule, make it precise. The hard forbidden pattern is the resume branch direct write at `turn-engine.ts:1580`; the other `turn-engine.ts` direct writes are current close propagation points and need either explicit whitelist or a small setter/helper.

## 6. W3 Close-event Construction and Freeze Status

Command:

```bash
rg -n "makeCloseEvent\(|makeMappedClose\(|mapSubAgentCloseToChildClose\(|decodeStoredSkillChildCloseEvent\(" src/main/modules/agent-control/skill-child-runner.ts src/main/modules/agent-control/skill-child-sub-agent.ts src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts src/main/modules/agent-control/skill-child-state-machine.ts
```

| File | Lines | Construction role | Frozen today |
|---|---:|---|---|
| `src/main/modules/agent-control/skill-child-runner.ts` | 495, 727, 782, 833, 870, 900, 1437, 1500, 1572 | Runner synth/refusal/final close construction through local `makeCloseEvent`. | No |
| `src/main/modules/agent-control/skill-child-sub-agent.ts` | 68, 82, 127, 139, 227, 240 | SubAgent driver failure/budget/abort close construction through local `makeCloseEvent`. | No |
| `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts` | 34, 48, 57, 66, 74, 82, 90, 98, 106, 115, 122, 151 | SubAgent close-to-child close mapper through `makeMappedClose`; preserved metadata branch returns a shallow copy. | No |
| `src/main/modules/agent-control/skill-child-state-machine.ts` | 71-78 | Stored close decode/reconstruction. | No |

Freeze command:

```bash
rg -n "Object\.freeze|DeepReadonly|Readonly<.*CloseEvent|freeze.*Close|Object\.isFrozen" src/main/modules/agent-control/skill-child-*.ts src/__tests__/skill-child-*.test.ts
```

Result: no matches. N3 mutability risk is real; no current freeze contract exists.

## 7. W4 Flag Readers

Command:

```bash
rg -n "isChildResumeEnabled|isChildInternalStrictAdmissionEnabled|isChildRunCircuitBreakerEnabled" src/main/modules src/shared src/preload src/renderer
```

| File | Line | Reader | Disposition |
|---|---:|---|---|
| `src/main/modules/agent-control/skill-child-feature-flags.ts` | 34 | `isChildResumeEnabled` definition | Allowed as snapshot source only. |
| `src/main/modules/agent-control/tool-definition.ts` | 63 | `isChildInternalStrictAdmissionEnabled` definition | Allowed as snapshot/source helper, or moved into snapshot module. |
| `src/main/modules/agent-control/child-run-circuit-breaker.ts` | 95 | `isChildRunCircuitBreakerEnabled` definition | Allowed as snapshot/source helper. |
| `src/main/modules/agent-control/turn-engine.ts` | 124, 1535 | `isChildResumeEnabled` import/call | Forbidden after W4 except at snapshot creation boundary. |
| `src/main/modules/agent-control/skill-child-runner.ts` | 51, 200 | circuit breaker import/call in constructor | Allowed if G snapshots only per runner construction; if W4 scope means per turn only, keep out of `TurnFeatureFlags`. |
| `src/main/modules/tools/tool-executor.ts` | 14, 116 | strict admission import/call | Forbidden direct call after W4 if strict admission must be turn-stable; pass snapshot or execution policy through `ToolContext`. |

Important correction to draft: `tool-executor.ts` is a real flag caller outside `agent-control` and must be included in W4.

## 8. `failed_skill` Remaining Sites

Command:

```bash
rg -n "terminalReason:\s*['\"]failed_skill['\"]|failed_skill" src/main/modules src/shared src/preload src/renderer src/__tests__
```

Main/shared/preload/renderer count: 20. Tests count: 21.

G-relevant main classifications:

| File | Lines | Classification |
|---|---:|---|
| `src/main/modules/agent-control/skill-child-run-types.ts` | 49 | Vocabulary baseline; keep. |
| `src/main/modules/agent-control/skill-child-state-machine.ts` | 17 | Decode compatibility baseline; keep. |
| `src/main/modules/agent-control/run-coordinator.ts` | 28 | Error mapping; keep. |
| `src/main/modules/agent-control/child-run-retry-policy.ts` | 54 | Retry policy; keep. |
| `src/main/modules/agent-control/turn-frame.ts` | 14 | Parent terminal reason vocabulary; keep unless a later phase removes it. |
| `src/main/modules/agent-control/video-expert-child-driver.ts` | 263-264 | Real skill-declared failure; keep. |
| `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts` | 135, 147 | Mapping from subagent error kind; keep. |
| `src/main/modules/agent-control/skill-child-runner.ts` | 1360, 1551 | Legacy/default mapping; keep. |
| `src/main/modules/agent-control/skill-child-sub-agent.ts` | 71, 130-142 | Driver/action failure construction; keep. |
| `src/main/modules/agent-control/turn-engine.ts` | 2519-2520 | Parent terminal mapping; keep but whitelist under W1. |
| `src/main/modules/rss-engine/item-analysis-manager.ts` | 159 | Comment only. |
| `src/renderer/modules/agent/types.ts` | 291 | Renderer type vocabulary; keep. |
| `src/renderer/modules/agent/scopeRunState.ts` | 79 | Renderer normalization; keep. |

Conclusion: N5 is not a G implementation target. No hard stop.

## 9. O7 IPC / Preload / Renderer Entry Points

Commands:

```bash
rg -n "childRunId|child[Rr]un|resumeRun|cancelDetachedSkillTask|suspendRun|listActiveChildRuns|cancelChildRun" src/main src/preload src/renderer
rg -n "agent:(cancelDetachedSkillTask|suspendRun|resumeRun)|cancelDetachedSkillTask|suspendRun|resumeRun|Settings|Debug|Devtools|developer|debug" src/main/modules/claude-bridge/ipc-handler.ts src/preload/index.ts src/renderer/types/electron.d.ts src/renderer/components src/renderer/modules src/renderer/App.tsx
```

| Layer | Current entry | Candidate for W5 |
|---|---|---|
| Main IPC | `agent:cancelDetachedSkillTask`, `agent:suspendRun`, `agent:resumeRun` in `src/main/modules/claude-bridge/ipc-handler.ts` | Add `agent:listActiveChildRuns` and `agent:cancelChildRun` near existing task/run controls. |
| Runtime | task-level `cancelDetachedSkillTask`, `suspendRun`, `resumeRun` in `src/main/modules/agent-control/runtime.ts` | Add thin runtime methods only if IPC should not import runner directly. |
| Runner | `cancelSkillChildRun`, `getSkillChildRunner`, active map private in `src/main/modules/agent-control/skill-child-runner.ts` | Add list-active summary API at runner boundary. |
| Preload | `cancelDetachedSkillTask`, `suspendRun`, `resumeRun` in `src/preload/index.ts` | Add `listActiveChildRuns` / `cancelChildRun`. |
| Renderer types | matching task-level API in `src/renderer/types/electron.d.ts` | Add `ActiveChildRunSummaryData` and agent API methods. |
| Renderer UI | `TaskPanel.tsx` and `ChatPanel.tsx` task-level continue/cancel | Recommended: Settings/debug subsection, not TaskCard, because renderer has 0 `childRunId` refs today and G explicitly avoids productizing child-run rows. |

Renderer `childRunId` count is 0, so W5 should not assume an existing child-run UI model.

## 10. N2 SubAgent Resume Shape Check

Commands:

```bash
rg -n "resumeSkillChildRun|prepareResumeLifecycle|freshContractFields|parentNextHint|closeEvent:\s*null|status:\s*'running'" src/main/modules/agent-control/skill-child-sub-agent.ts src/main/modules/agent-control/skill-child-runner.ts src/main/modules/agent-control/turn-engine.ts
sed -n '340,470p' src/main/modules/agent-control/skill-child-runner.ts
sed -n '690,735p' src/main/modules/agent-control/skill-child-runner.ts
sed -n '1560,1605p' src/main/modules/agent-control/turn-engine.ts
sed -n '1,285p' src/main/modules/agent-control/skill-child-sub-agent.ts
```

Findings:

| File | Finding |
|---|---|
| `src/main/modules/agent-control/skill-child-runner.ts` | `resumeSkillChildRun` returns `StartSkillChildRunResult`; no `freshContractFields` exists. `prepareResumeLifecycle` clears repository state with `{ status: 'running', closeEvent: null }`. |
| `src/main/modules/agent-control/turn-engine.ts` | Resume branch manually writes `childStatus`, `childCloseEvent`, and `parentNextHint` from `resumed`. |
| `src/main/modules/agent-control/skill-child-sub-agent.ts` | SubAgent result metadata carries close events, but there is no resume-specific result shape and no equivalent `freshContractFields`. |

Decision: attach `freshContractFields` to `StartSkillChildRunResult` returned by `resumeSkillChildRun` in `skill-child-runner.ts`, not inside `skill-child-sub-agent.ts`. SubAgent is the worker lifecycle result boundary; the parent contract refresh is runner/turn-engine boundary state.

N2 conflict judgment: no conflict found. No existing equivalent field exists.

## 11. W1-W5 Disposition Tables

### W1: status decisions

| File | Disposition |
|---|---|
| `src/main/modules/agent-control/skill-child-run-types.ts` | Add single-source terminal status set/helper(s). |
| `src/main/modules/agent-control/turn-engine.ts` | Replace local `TERMINAL_CHILD_CLOSE_STATUSES`; keep/whitelist `renderChildCommandOutcome` switch and parent terminal mapping. |
| `src/main/modules/agent-control/turn-frame-steering.ts` | Replace local `TERMINAL_CHILD_CLOSE_STATUSES`. |
| `src/main/modules/agent-control/child-run-circuit-breaker.ts` | Replace `close.status === 'failed'` with helper/predicate. |
| `src/main/modules/agent-control/skill-child-runner.ts` | Replace retained lifecycle chained status comparisons. Keep status normalization helpers if explicitly whitelisted. |
| `src/main/modules/agent-control/skill-child-sub-agent.ts` | Allow semantic status switch/mapping. |
| `src/main/modules/rss-engine/item-analysis-manager.ts` | Baseline outside agent-control; allow product-facing VEA cause mapping. |
| `src/main/modules/skills-runtime/runtime-manager.ts` | Baseline outside agent-control; allow compatibility success derivation. |
| `src/main/modules/tools/skills-tools.ts` | Baseline result-envelope mapping; do not convert blindly. |

### W2: childCloseEvent writes

| File | Disposition |
|---|---|
| `src/main/modules/agent-control/turn-engine.ts:1580` | Forbidden after W2; must use `freshContractFields`. |
| `src/main/modules/agent-control/turn-engine.ts:1486` | H1 gate: allow only with explicit whitelist/helper; do not let checker allow all direct writes. |
| `src/main/modules/agent-control/turn-engine.ts:1505` | Allowed current-turn cancel propagation. |
| `src/main/modules/agent-control/turn-engine.ts:2504` | Allowed terminal continuation propagation. |
| `src/main/modules/tools/skills-tools.ts:2122` | Allowed baseline initial contract stamping. |
| `src/main/modules/agent-control/run-contracts.ts:1455,1457` | Allowed local reconstruction. |
| `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts:30` | Allowed local metadata read. |

### W3: close-event factories

| File | Factory |
|---|---|
| `src/main/modules/agent-control/skill-child-runner.ts` | local `makeCloseEvent`; also decode/persist returns should normalize through freeze. |
| `src/main/modules/agent-control/skill-child-sub-agent.ts` | local `makeCloseEvent`; preserve driver-returned close should be frozen before metadata handoff. |
| `src/main/modules/agent-control/skill-child-sub-agent-close-mapping.ts` | `makeMappedClose`; preserved metadata branch should also freeze returned copy. |
| `src/main/modules/agent-control/skill-child-state-machine.ts` | `decodeStoredSkillChildCloseEvent`; reconstructed stored close should be frozen or callers must immediately freeze. |

### W4: flag reader whitelist

| File | Disposition |
|---|---|
| `src/main/modules/agent-control/turn-feature-flags.ts` | New allowed snapshot boundary. |
| `src/main/modules/agent-control/skill-child-feature-flags.ts` | Allowed source helper only. |
| `src/main/modules/agent-control/tool-definition.ts` | Allowed source helper only, or moved under snapshot module. |
| `src/main/modules/agent-control/child-run-circuit-breaker.ts` | Allowed parser/helper; constructor read may remain if scoped as runner-lifetime, not turn-lifetime. |
| `src/main/modules/agent-control/turn-engine.ts` | Direct helper call forbidden after W4. |
| `src/main/modules/tools/tool-executor.ts` | Direct strict-admission call forbidden after W4 if strict admission is part of turn snapshot; pass policy through `ToolContext`. |

### W5: UI entry

| Candidate | Judgment |
|---|---|
| Settings/debug subsection | Recommended. Existing `/settings` route and settings rail entry exist; G wants minimal control surface and renderer has no child-run model. |
| TaskPanel child rows | Not recommended for G. It would productize child-run internals and conflicts with G non-goal. |
| ChatPanel inline controls | Not recommended for G. Same child-run model gap as TaskPanel. |
| Separate devtools route | Possible but heavier than needed; no existing devtools route was found. |

## 12. ESCALATE Judgments

| Hard stop | Judgment |
|---|---|
| W0 unclassifiable drift | No ESCALATE. Drift exists versus draft numbers, but all drift is classifiable and the plan can be corrected factually. |
| N2 resume shape conflict | No ESCALATE. `freshContractFields` belongs on `StartSkillChildRunResult` from `resumeSkillChildRun`; no competing equivalent field exists. |
| N3 known runtime close mutation | No evidence found from grep. This is not proof impossible; it only means no obvious mutation of close event fields was discoverable by static grep. |

## 13. W0 Verification

Required after writing:

```bash
git diff --check
npm run verify:f
```

`verify:f` is expected to be heavier because it chains `verify:e`, `verify:d`, `verify:c`, and earlier phases. If it is not reasonably feasible, run `npm run typecheck` and `npm run lint:check` and record that substitution.
