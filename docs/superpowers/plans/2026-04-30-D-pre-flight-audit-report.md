---
name: D W0 — Pre-flight Audit Report
status: completed
owner: Hubble
date: 2026-05-01
branch: codex/skill-runtime-b-plan
head: 10d261651192791098ea8e8a304caef7639898df
---

# D W0 — Pre-flight Audit Report

## Completion Standard

W0 is complete when this report gives W1-W7 a current, command-backed map of reminder authors/consumers, compaction/truncation/token surfaces, hook-like surfaces, C land state, expected D removals, branch/HEAD, and any plan contradictions that affect execution order. W0 intentionally did not edit runtime/source/test/package files.

## Workspace State

- Worktree: `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`
- Branch: `codex/skill-runtime-b-plan`
- HEAD: `10d261651192791098ea8e8a304caef7639898df`
- Working tree note: `docs/superpowers/plans/2026-04-30-D-reminder-registry-compaction-hooks-implementation.md` and unrelated `docs/superpowers/plans/2026-04-30-E-defense-and-fragility-reduction-implementation.md` were already untracked at audit start. This W0 adds only this report and a small D-plan amendment.
- Out-of-bounds files not touched: `src/main/modules/agent-control/skill-child-runner.ts`, `src/main/modules/agent-control/skill-child-sub-agent*.ts`.

## Commands Run

```bash
git status --short --branch
git rev-parse --abbrev-ref HEAD && git rev-parse HEAD
sed -n '1,260p' docs/superpowers/plans/2026-04-30-D-reminder-registry-compaction-hooks-implementation.md
sed -n '260,760p' docs/superpowers/plans/2026-04-30-D-reminder-registry-compaction-hooks-implementation.md
rg -n "systemReminder|buildBudgetWarningMessage|reminderTokens|session\\.messages\\.push|appendSessionMessages|sessionMessages" src/main/modules/agent-control/turn-engine.ts src/main/modules/agent-control/turn-frame-steering.ts src/main/modules/agent-control/turn-frame.ts src/main/modules/agent-control/turn-frame-resolver.ts src/main/modules/agent-control/skill-domain-adapter.ts src/main/modules/agent-control/*domain-adapter.ts
sed -n '80,125p' src/main/modules/agent-control/turn-engine.ts
sed -n '390,505p' src/main/modules/agent-control/turn-frame-steering.ts
sed -n '2348,2500p' src/main/modules/agent-control/turn-engine.ts
sed -n '2600,2650p' src/main/modules/agent-control/turn-engine.ts
sed -n '1,210p' src/main/modules/agent-control/skill-domain-adapter.ts
sed -n '1,220p' src/main/modules/agent-control/domain-adapter.ts
rg -n "compact|compaction|truncate|truncat|token|MAX_.*CHARS|REFERENCE_SKILL_INLINE_CAP_CHARS|MAX_TOTAL|estimate" src/main/modules/agent-control src/shared src/__tests__ package.json
sed -n '1,260p' src/main/modules/agent-control/context-compression.ts
sed -n '1,280p' src/main/modules/agent-control/prompt-assembly.ts
sed -n '500,635p' src/main/modules/agent-control/prompt-assembly.ts
sed -n '40,285p' src/main/modules/agent-control/browser-domain-orchestrator.ts
sed -n '80,105p' src/main/modules/agent-control/document-domain-adapter.ts
sed -n '340,365p' src/main/modules/agent-control/skill-context-orchestrator.ts
sed -n '345,365p' src/shared/document-sectioning.ts
rg -n "Hook|hook|pre_tool_use|post_tool_use|user_prompt_submit|stop|onToolStart|onToolResult|RunCompletionHooks|ReflectionResultHook|ToolExecutionHooks" src/main/modules/agent-control src/main/modules/tools src/__tests__
sed -n '1,120p' src/main/modules/agent-control/tool-execution-hooks.ts
sed -n '870,905p' src/main/modules/agent-control/run-contracts.ts
sed -n '50,90p' src/main/modules/agent-control/run-coordinator.ts
sed -n '270,310p' src/main/modules/agent-control/run-coordinator.ts
rg -n "verify:c|verify:b|check-eslint-baseline|eslint-rules/index|no-inline|coordinator" package.json scripts eslint-rules src/__tests__ docs/superpowers/plans/2026-04-30-C-coordinator-role-abstraction-implementation.md
ls eslint-rules
sed -n '1,270p' eslint-rules/index.mjs
ls scripts | sort | sed -n '1,220p'
sed -n '120,150p' scripts/check-eslint-baseline.cjs
sed -n '1,80p' package.json
pwd
```

## Reminder Authors And Consumers

D scope reminder authors are exactly these 9 current sites. I distinguish helper-only text construction from actual push/write sites:

| # | File:line | Type | Current behavior | D topic candidate |
|---|---|---|---|---|
| 1 | `src/main/modules/agent-control/turn-engine.ts:101` | author helper | `buildBudgetWarningMessage(...)` constructs budget reminder text. It is not a push by itself. | `budget` |
| 2 | `src/main/modules/agent-control/turn-engine.ts:2369` | push/write | pushes converge budget warning into `session.messages` as `role: 'user'`. | `budget` |
| 3 | `src/main/modules/agent-control/turn-engine.ts:2489` | push/write | pushes 70% budget warning into `session.messages` as `role: 'user'`. | `budget` |
| 4 | `src/main/modules/agent-control/turn-engine.ts:2626-2639` | push/write | builds force-tool checkpoint `reminderTokens` and pushes `role: 'user'`. | `missing-input` or `force-tool-checkpoint` |
| 5 | `src/main/modules/agent-control/turn-frame-steering.ts:401` | write | writes checkpoint `systemReminder: reason`. | `checkpoint` |
| 6 | `src/main/modules/agent-control/turn-frame-steering.ts:423` | write | writes child-owned `systemReminder: reminderTokens.join('\n')`. | `child-owned` |
| 7 | `src/main/modules/agent-control/turn-frame-steering.ts:472` | write | writes force-tool missing-input checkpoint `systemReminder`. | `force-tool-missing` plus `checkpoint` |
| 8 | `src/main/modules/agent-control/turn-frame-steering.ts:485` | write | writes force-tool locked `systemReminder`. | `force-tool-locked` |
| 9 | `src/main/modules/agent-control/turn-frame-steering.ts:500` | write | writes ask-model typed-action-preferred `systemReminder`. | `typed-action-preferred` |

Current non-author reset/type/consumer sites:

| File:line | Classification | Note |
|---|---|---|
| `src/main/modules/agent-control/turn-frame.ts:111` | type declaration | `TurnFrame.steering.systemReminder: string | null`. |
| `src/main/modules/agent-control/turn-frame-resolver.ts:220` | default reset | default `systemReminder: null`; should stay allowed. |
| `src/main/modules/agent-control/turn-frame-steering.ts:438` | reset | no typed tool; resets `systemReminder: null`; not an author. |
| `src/main/modules/agent-control/skill-domain-adapter.ts:57-59` | consumer plus fallback author | consumes `frameSteering.systemReminder`, but also has fallback typed-action text if no reminder exists and a preferred skill tool exists. W1-W3 should decide whether this fallback becomes a registry entry or remains a skill-domain instruction; otherwise it remains an extra model-facing author. |
| `src/main/modules/agent-control/skill-domain-adapter.ts:175` | consumer write | emits the built skill-domain instruction as `sessionMessages`; it is not a direct reminder author, but it is how the consumed reminder reaches the model. |

Extra model-message pushes that are not D reminder scope and should not be over-banned by W3/W4:

| File:line | Why not D reminder scope |
|---|---|
| `turn-engine.ts:2014` | planner step list; task-plan control message, not a system reminder registry concern. |
| `turn-engine.ts:2804` | text-tool bridge correction after disallowed tool text; retry/correction loop message. |
| `turn-engine.ts:2833` | browser task retry nudge requiring browser tool use; browser loop enforcement. |
| `turn-engine.ts:2847` | text-tool bridge correction for missing native tools; transport recovery. |
| `turn-engine.ts:2887`, `3422` | `domainApplyResult.nextUserMessage`; domain loop continuation. |
| `turn-engine.ts:2909`, `3369` | planner step advancement messages. |
| `turn-engine.ts:2941`, `2965` | design loop / repetition guard messages. They are tool-loop safeguards, not D's known reminder root cause. |
| `turn-engine.ts:3296`, `3304`, `3323`, `3342`, `3351` | assistant/tool/tool-result history serialization. Must remain allowed. |
| `turn-engine.ts:1907`, `2061`, `3416`, `3495` | `appendSessionMessages(...)` for domain prepare/dispatch/apply/limit results. W4 should not ban this generic helper. |
| `browser-domain-adapter.ts:356`, `405` and `browser-domain-orchestrator.ts` checkpoint/limit builders | browser workflow checkpoint/limit messages. They are domain adapter outputs, not D's SystemReminderRegistry target unless a later stage deliberately expands registry ownership. |
| `calendar-domain-adapter.ts:108`, `feishu-domain-adapter.ts:132`, `rss-domain-adapter.ts:113`, `skill-domain-adapter.ts:175` | domain instructions. They are C DomainAdapter-owned messages. |

## Compaction / Truncation / Token Sites

L1 existing behavior already in code:

| File:line | Behavior | Classification |
|---|---|---|
| `prompt-assembly.ts:95-98` | static char caps `MAX_L0_CHARS`, `MAX_L1_CHARS`, `MAX_L2_CHARS`, `MAX_TOTAL_CHARS`. | L1 existing prompt-budget cap. |
| `prompt-assembly.ts:159` | `clip(text, maxChars)` appends `[truncated]`. | L1 existing truncation helper. |
| `prompt-assembly.ts:235-260` | `applyBudget(...)` clips L1/L2 sections and drops overflowing refs. | L1 existing deterministic prompt budget. |
| `prompt-assembly.ts:512`, `622` | clips loaded L0/L1 memory sections. | L1 existing memory prompt cap. |
| `context-compression.ts:25-57` | `compressHistoryForPrompt` keeps recent messages and summarizes earlier by clipped lines. | L1 existing cheap history summary for prompt assembly. |
| `context-compression.ts:59-80` | `compressToolTraceForPrompt` keeps recent tool trace entries. | L1 existing cheap trace summary. |
| `context-compression.ts:82-103` | `compressArtifactsForPrompt` keeps recent artifact entries. | L1 existing cheap artifact summary. |
| `browser-domain-orchestrator.ts:56-64` | `compactRecentEvidence` dedupes and clips recent evidence to 4 entries. | L1 existing domain projection compaction. |
| `document-domain-adapter.ts:94-99` | `truncateDetail(text, max=240)` for document inspection detail. | L1 existing display/projection truncation. |
| `skill-context-orchestrator.ts:24`, `358-360` | `REFERENCE_SKILL_INLINE_CAP_CHARS = 12_000`; inline reference skill doc truncation. | L1 existing context-doc cap, out of D reminder scope. |
| `src/shared/document-sectioning.ts:34-36`, `355+` | document context chunk/prompt char limits. | L1 existing document-specific context selection. |

Future L2 candidates:

| Surface | Reason |
|---|---|
| `turn-engine.ts` model-call path before each model invocation | This is the true future L2 location for session history compaction/token-threshold behavior because it sees `session.messages`. |
| `context-compression.ts` | Existing cheap summarizers can become reusable L1 utilities under `LayeredCompactor`, but they are not token-aware. |
| `prompt-assembly.ts` | Current prompt budgets are char-count only; can be formalized as L1 under `LayeredCompactor`, but should not be mistaken for true model-history L2. |
| No current token estimator found | `rg` found tokenization helpers for search/intent/secret names, but no model token estimator or circuit breaker. D must introduce this skeleton. |

## Hook-like Surfaces

Current hook-like surfaces do not conflict with D HookRegistry:

| File:line | Current surface | Why no conflict |
|---|---|---|
| `tool-execution-hooks.ts:5-10` | `ToolExecutionHooks` with `onToolStart`, `onToolResult`, `onToolRecovered`, `onBatchInterrupted`. | Per-tool runtime callbacks passed into `ToolRuntime` / `ExecutionLoopOrchestrator`; not a named lifecycle registry, no register/unregister, no user prompt or stop lifecycle. |
| `run-contracts.ts:886-893` plus `run-coordinator.ts:61-75`, `280-305` | `RunCompletionHooks` and `ReflectionResultHook` with `onSuccess`, `onFailure`, `onMemoryCapture`. | Per-run completion/reflection callbacks; not tool lifecycle hooks and not global/per-engine registry. |
| `DomainAdapter` methods in `domain-adapter.ts` | coordinator role methods (`prepare`, `dispatch`, `applyResult`, etc.). | Product-surface coordinator contract, not lifecycle hook registry. D HookRegistry should sit beside it. |
| Renderer React hooks and Node `registerHooks` tests | UI/framework hooks. | Naming overlap only. Not related to agent lifecycle. |

The D lifecycle names `pre_tool_use`, `post_tool_use`, `user_prompt_submit`, and `stop` do not currently exist in agent-control.

## C Land State And D Conflicts

C is landed in the audited branch:

- `package.json` has `test:c:gates`, `test:c:focus`, and `verify:c`.
- `verify:c` includes `node scripts/check-coordinator-isolation.cjs`, `node scripts/check-eslint-baseline.cjs`, C focused tests, and `npm run verify:b`.
- `scripts/check-coordinator-isolation.cjs` exists.
- `eslint-rules/index.mjs` registers `ready/no-coordinator-id-leak`.
- `DomainAdapter` includes C coordinator hooks (`contributePromptFragment`, `arbitrateRunCapabilities`, `decorateUserText`, `prepare`, `dispatch`, `applyResult`, `buildProjectionPatch`).
- `SkillDomainAdapter` is already a C-style adapter and currently consumes `turnFrameSteering.systemReminder`.

D conflicts/constraints:

- `verify:d` should explicitly include `npm run verify:c`, not only `verify:b`, because C is present.
- W4 should add the reminder ESLint rule to `eslint-rules/index.mjs`. The current repo uses a central ESM plugin file; adding a standalone `.cjs` rule file without registering it there will not affect `lint:check`.
- `scripts/check-eslint-baseline.cjs --area d-gate --max 0` is not valid today. Current usage only allows `a1-gate|ui-history|other-a0`. Either extend the checker and baseline schema in W4, or omit `--area d-gate` from `verify:d`.
- W5/W6 should not directly edit `turn-engine.ts` before W4/reminder migration lands if this branch uses the revised execution order. Their skeleton/tests/metrics can land early, but their `turn-engine` fire/wire points should wait until W4 to reduce conflict with W1-W3.

## Expected D Completion Changes

Code paths expected to disappear or change by D completion:

- Direct `systemReminder: <expr>` writes in `turn-frame-steering.ts:401`, `423`, `472`, `485`, `500` disappear or become registry assembly output only.
- `turn-frame-steering.ts:438` remains allowed as `systemReminder: null` reset/default.
- Direct reminder pushes at `turn-engine.ts:2369`, `2489`, `2639` disappear and become registry registrations.
- `buildBudgetWarningMessage(...)` can remain as a text helper, but its callers should no longer push its return directly into `session.messages`.
- `SkillDomainAdapter` should stop inventing fallback typed-action reminder text if D's contract is interpreted as "all model-facing system-level reminder text goes through registry." At minimum W1-W3 must make an explicit choice and test it.
- `session.messages.push` generic history/tool-result/planner/domain messages should remain. W4 lint must target only known reminder-shaped inline writes, not all user-role messages.
- `LayeredCompactor` and `HookRegistry` files/tests should appear, but L2 algorithm and real hook handlers remain out of scope.

## Plan Contradictions Affecting W1-W4

1. Current plan says W4 creates `eslint-rules/no-inline-system-reminder-write.cjs`; current repo pattern is `eslint-rules/index.mjs` with in-file custom rules. Use `index.mjs` as the enforcement point.
2. Current plan's `verify:d` sample uses `--area d-gate --max 0`, but baseline checker does not support `d-gate`. Do not add that command unless W4 also extends the checker and tests.
3. C has landed. `verify:d` should include `npm run verify:c`.
4. Revised execution says `W0 -> W1 -> (W2 || W3) || (W5 || W6) -> W4 -> W7`; to avoid conflicts, W5/W6 should create skeletons/tests/metric constants first and defer direct `turn-engine.ts` wiring to W4 or a post-W4 integration step.

## W0 Result

Status: DONE. No runtime/source/test/package files were changed. The audit found no conflict with C that blocks D, but it does require the concise W4 corrections above.
