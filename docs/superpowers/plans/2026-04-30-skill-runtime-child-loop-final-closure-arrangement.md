---
enforce: false
---

# Skill Runtime Child-Loop Final Closure Arrangement

> **For agentic workers:** This is a planning-arrangement brief, not the final implementation plan. Claude should first rewrite/supplement this into a concrete execution plan with failing tests and exact edits. Do not begin code changes until the rewritten plan explicitly closes every acceptance gate below.

**Goal:** Close the remaining child-run architecture gaps after the first two remediation rounds, specifically the missing resume/cancel command surface, await-timeout semantics, true tool admission, terminal reason model, terminal identity lookup, and parent prompt cleanup.

**Architecture:** Treat `SkillChildRun` as a lifecycle service, not just a launcher plus close-event cache. Parent code may start, resume, wait, cancel, and inspect child runs through explicit child commands; it must not choose VEA's internal typed action. Product awaiters may stop waiting without killing the child. Read models must attach both active and terminal child identities exactly.

**Tech Stack:** Electron main process, TypeScript, SQLite/better-sqlite3, Ready skill runtime, child-run repository over `skill_task_runs`, VEA child driver, RSS visual analyzer, Zod/tool gateway, `npx tsx --test`, `npm run typecheck`.

---

## 0. Current State Snapshot

Branch/worktree:

```text
cwd: /Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan
branch: codex/skill-runtime-b-plan
HEAD: 9fb93c9 chore: record child runtime verification gate
working tree: clean at the time this arrangement was written
```

Known good:

- `npm run typecheck` passed.
- Targeted 16-file child-runtime suite passed: 144 tests, 0 failures.
- Direct `sceneScoresPath` VEA cold-start and RSS visual real-driver path were added and are green.
- Parent force-tool dispatch is suppressed when `childRunId` exists.

Known not good enough:

- `npm run verify` still fails at lint in unrelated baseline files. This is not the primary child-loop blocker, but the branch cannot honestly claim full-repo clean verification.
- More importantly, the child-run lifecycle remains incomplete: it can launch and observe, but resume / wait-timeout / terminal identity / true gateway admission are still not closed.

## 1. The Real Remaining Root Cause

The first remediation round fixed the visible P0/P1 issues. The deeper problem is still this:

```text
SkillChildRun is implemented as a start-and-watch wrapper, not yet as a complete lifecycle service.
```

That creates the current leaks:

- `TurnEngine` can see `childRunId`, but cannot issue a real `resume` command when the child is paused.
- Product callers can wait for a child, but timeout still kills the child instead of timing out only the observer.
- Child internal gateway shares schema validation, but not the same registered-tool admission semantics as public dispatch.
- Close events carry cleaner statuses, but terminal reasons still collapse important causes.
- Contract identity lookup can find active child rows, but terminal child rows can be invisible to exact path lookup.
- Some parent prompts still tell the model to use typed skill actions even in child-owned context.

Claude's rewrite must address this root cause first. Do not submit another plan that only patches the six line-level findings.

## 2. Non-Negotiable Acceptance Gates

Claude's rewritten plan must include tests and implementation steps proving all of these:

- [ ] A paused child (`recoverable_paused`, `budget_paused`, or `blocked` when resumable) can be resumed through `resumeSkillChildRun(childRunId)` from the parent continuation path.
- [ ] A terminal child (`completed`, `failed`, `killed`) never resumes accidentally.
- [ ] `startSkillChildRunAndWait` timeout does not call `cancelSkillChildRun` and does not convert the child into `cancelled_user`.
- [ ] Explicit user cancel is the only product/parent path that maps to `killed/cancelled_user`.
- [ ] Unknown or unregistered child internal actions fail like public dispatch: `tool_not_registered` / `host_unavailable`, not direct `runtimeManager.runSkill`.
- [ ] Child gateway requires a real tool definition or a deliberately registered internal-only definition. Missing definition cannot be telemetry-only.
- [ ] `terminalReason` can represent `await_timeout` and `child_process_crashed` distinctly, not only as `infra_error` or `cancelled_user`.
- [ ] Exact `childRunId`, `runStatePath`, `outputDir`, and `singleFlightKey` lookup can return terminal child rows when building a read model.
- [ ] Active single-flight duplicate prevention still uses active-only lookup; terminal exact lookup must not cause duplicate prevention to reuse old finished work.
- [ ] Budget warnings / skill-domain prompts do not mention typed skill actions when the active frame is child-owned.
- [ ] Verification includes focused red/green tests for every above item, plus `npm run typecheck`.

## 3. Required Rewrite Output From Claude

Claude should produce a rewritten implementation plan, not a patch yet.

The rewritten plan must contain:

1. **A command model.**
   - Define the child command API:
     - `startSkillChildRun`
     - `resumeSkillChildRun`
     - `cancelSkillChildRun`
     - `waitForSkillChildRunClose` or equivalent observer-only wait helper
     - `getSkillChildRunCloseEvent`
   - Clarify which caller owns each command:
     - agent typed tool launch;
     - TurnEngine continuation;
     - RSS/product awaiter;
     - explicit user cancel;
     - app shutdown/session detach.

2. **A state transition table.**
   - For each child close status and terminal reason, specify:
     - can parent resume?
     - should parent checkpoint?
     - should parent mark terminal?
     - should product retry?
     - should product keep waiting or return observer timeout?

3. **A file-by-file plan.**
   - Include exact files, expected functions, tests, and commands.
   - Do not say "add validation" or "fix timeout"; name the function and expected behavior.

4. **Red tests first.**
   - Every remaining finding must have a failing test named for the behavior.
   - A test that only inspects comments or only repeats the existing green path is not enough.

5. **Verification plan.**
   - Include focused test command(s).
   - Include `npm run typecheck`.
   - Explain whether `npm run verify` is expected to fail on unrelated lint and how to prove no new files caused it.

## 4. Remaining Workstreams

### Workstream A — Parent Child-Command Surface

Problem:

- `computeChildContinuationDecision(...)` currently returns `checkpoint_paused` for any non-terminal close event.
- The TurnEngine path that sees `checkpoint_paused` only checkpoints; it does not call `resumeSkillChildRun`.
- `resumeSkillChildRun` exists, but production parent continuation does not use it.

Claude must design:

- A way to distinguish:
  - user asked to continue/resume this child;
  - user asked to cancel;
  - user asked for status;
  - model should simply report current state.
- A parent route that calls `resumeSkillChildRun(childRunId)` only on explicit continuation/resume, not automatically on every turn.
- A terminal guard so completed/failed/killed children are not resumed.

Likely files:

- `src/main/modules/agent-control/turn-engine.ts`
- `src/main/modules/agent-control/run-contracts.ts`
- `src/main/modules/agent-control/turn-frame-steering.ts`
- `src/__tests__/skill-child-run-end-to-end.test.ts`
- `src/__tests__/turn-frame-steering.test.ts`

Required test cases:

- Given `childRunId` + `recoverable_paused` close + user intent "继续", TurnEngine calls `resumeSkillChildRun`.
- Given `childRunId` + `budget_paused` close + user intent "继续", TurnEngine calls `resumeSkillChildRun`.
- Given `childRunId` + `completed` close + user intent "继续", TurnEngine does not resume and surfaces terminal result.
- Given live child with no close event, TurnEngine does not call typed VEA action.

Design warning:

- Do not solve this by putting typed skill actions back into `preferredToolNames`.
- Do not let the model decide whether to call `skill_video_expert_ai_analyze`; the child driver owns that.

### Workstream B — Observer Timeout Is Not Cancellation

Problem:

- `startSkillChildRunAndWait` currently calls `cancelSkillChildRun(childRunId, 'await_timeout')`.
- `cancelSkillChildRun` maps non-`launch_stuck` aborts to `cancelled_user`.
- Product wait timeout therefore kills the child and mislabels the cause.

Claude must design:

- A separate observer-only wait helper, for example:

```ts
waitForSkillChildRunClose(childRunId, { timeoutMs }): Promise<
  | { kind: 'closed'; closeEvent: SkillChildCloseEvent }
  | { kind: 'timeout'; childRunId: string; elapsedMs: number }
>
```

- `startSkillChildRunAndWait` should return an observer timeout result without aborting the child.
- RSS visual flow must decide what to do with observer timeout:
  - for product UX, likely throw/return "still running / timeout waiting" while preserving the child handle;
  - do not mark success;
  - do not kill the child unless an explicit user cancel path asks for it.

Likely files:

- `src/main/modules/skills-runtime/runtime-manager.ts`
- `src/main/modules/agent-control/skill-child-runner.ts`
- `src/main/modules/rss-engine/item-analysis-manager.ts`
- `src/__tests__/rss-visual-skill-child-run.test.ts`
- `src/__tests__/skill-child-runner.test.ts`

Required test cases:

- `startSkillChildRunAndWait({ timeoutMs: small })` returns timeout / non-success and child remains active or recoverable.
- Timeout result is not `killed` and not `cancelled_user`.
- Explicit cancel still returns `killed/cancelled_user`.
- RSS translate function does not say user cancelled when the awaiter timed out.

Design warning:

- Do not fake this by changing only error text. The child must not be aborted on observer timeout.

### Workstream C — Real ToolDefinition Admission For Child Internal Actions

Problem:

- `executeSkillActionViaToolGateway` logs missing `ToolDefinition` but continues.
- It then calls `runtimeManager.runSkillFromChildRunner` / `runSkill` directly.
- Public `executeToolCall` rejects missing definitions before validation. Child internal path should not be weaker.

Claude must design:

- Whether child internal actions use the public `ToolDefinition` handler or a registered internal-only `ToolDefinition`.
- Missing definition must return a structured error matching public dispatch (`host_unavailable`, reason `tool_not_registered`) and must not enter runtime.
- If an action is allowed to be child-internal but not model-visible, register it explicitly as internal, not as an undefined bypass.

Likely files:

- `src/main/modules/agent-control/tool-registry.ts`
- `src/main/modules/tools/tool-executor.ts` only if sharing executor logic is cleaner.
- `src/__tests__/tool-gateway-registry.test.ts`
- `src/__tests__/tool-input-schemas-registry.test.ts`
- `src/__tests__/skill-child-runner.test.ts`

Required test cases:

- Unknown child action has no definition and never calls runtime manager.
- Known VEA child action has a definition and schema, then reaches runtime.
- Schema failure still matches public `input_validation`.
- Missing definition and missing schema are not silently treated as passthrough for child-owned skill actions.

Design warning:

- "Same Zod resolver" is not enough. Tool admission means definition lookup + allowability + schema + dispatch/error shape.

### Workstream D — Terminal Reason Vocabulary

Problem:

- Current union lacks `await_timeout` and `child_process_crashed`.
- Process crash is stored as `status='failed'`, `terminalReason='infra_error'`, `error.kind='child_process_crashed'`.
- Launch-stuck is currently `failed/launch_stuck`; this may be acceptable, but the plan must say why.

Claude must design:

- Final terminal reason union.
- Mapping table:
  - user cancel;
  - observer timeout;
  - launch stuck;
  - child process crashed;
  - runtime host unavailable;
  - input validation;
  - skill-declared failure;
  - blocked config/external;
  - budget pause;
  - process restarted.

Likely files:

- `src/main/modules/agent-control/skill-child-run-types.ts`
- `src/main/modules/agent-control/skill-child-runner.ts`
- `src/main/modules/agent-control/turn-engine.ts`
- `src/main/modules/rss-engine/item-analysis-manager.ts`
- `src/__tests__/skill-child-runtime-decisions.test.ts`
- `src/__tests__/skill-child-runner.test.ts`

Required test cases:

- Crash-shaped throw returns distinct `terminalReason='child_process_crashed'` or an explicitly justified equivalent.
- Observer timeout returns `terminalReason='await_timeout'` only if represented as a close event; otherwise it must be a non-close observer result.
- Input validation has a stable reason and does not look like infra crash.
- User cancel remains `cancelled_user`.

Design warning:

- Do not bury the only meaningful distinction inside `error.kind` if parent/product code branches on `terminalReason`.

### Workstream E — Exact Identity Lookup For Terminal Rows

Problem:

- `findChildRunByRunStatePath`, `findChildRunByOutputDir`, and `findChildRunBySingleFlightKey` all apply active-status filters.
- That is correct for duplicate prevention, but wrong for read-model reconstruction from exact handles.

Claude must design:

- Separate repository methods:
  - active-only lookup for single-flight and duplicate launch;
  - any-status exact lookup for contract/read-model reconstruction.
- `loadSkillRunContract` should use any-status exact lookup for `childRunId`, `runStatePath`, `outputDir`, `singleFlightKey`.
- Latest-by-skill fallback should likely remain active-only to avoid attaching stale unrelated terminal rows.

Likely files:

- `src/main/modules/repositories/skill-task-run-repository.ts`
- `src/main/modules/agent-control/run-contracts.ts`
- `src/__tests__/skill-child-run-end-to-end.test.ts`
- `src/__tests__/task-projection-sync.test.ts`

Required test cases:

- Completed child row can be loaded by exact `outputDir`.
- Failed child row can be loaded by exact `runStatePath`.
- Killed child row can be loaded by exact `childRunId`.
- New launch with the same target does not reuse completed terminal row via single-flight.
- Latest-by-skill fallback does not attach a stale terminal child when no exact handle is provided.

Design warning:

- Do not remove active filtering from `findLatestChildRunByKey` if it is used for duplicate prevention. Split methods instead.

### Workstream F — Prompt And Budget Warning Cleanup

Problem:

- `buildBudgetWarningMessage` still tells long-skill context to use typed skill actions.
- Child-owned steering correctly avoids typed actions, but budget warning can be injected earlier and contradict it.

Claude must design:

- Child-owned long-skill prompt branch:
  - "child runner owns internal action selection";
  - "wait/resume/cancel/status via child command";
  - no `typed skill action` language.
- Legacy non-child long-skill prompt can keep typed-action wording only when no `childRunId` exists.

Likely files:

- `src/main/modules/agent-control/turn-engine.ts`
- `src/__tests__/turn-frame-steering.test.ts`
- A focused budget warning test if one exists or should be added.

Required test cases:

- Budget warning for child-owned frame does not contain `typed skill action`.
- Budget warning for legacy non-child skill can still contain typed action wording if that path remains.
- Child-aware reminder and budget warning do not contradict each other.

## 5. Suggested Ordering

Claude should rewrite the plan in this order:

1. Workstream E first if needed to make read models reliable for terminal child rows.
2. Workstream A next, because resume command behavior depends on correct contract identity.
3. Workstream B, because product await timeout semantics depend on command/observer separation.
4. Workstream C, because it changes child action dispatch and may affect runner tests.
5. Workstream D, to normalize all close/observer outcomes after A/B/C define real paths.
6. Workstream F last, because prompt wording should follow the final command model.
7. Documentation and verification last.

If Claude chooses a different order, the rewritten plan must explain why that order avoids circular dependencies.

## 6. Verification Bar

Minimum focused verification after implementation:

```bash
npm run typecheck
```

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/skill-child-runner.test.ts \
  src/__tests__/skill-child-single-flight.test.ts \
  src/__tests__/skill-child-runtime-decisions.test.ts \
  src/__tests__/skill-child-run-end-to-end.test.ts \
  src/__tests__/tool-gateway-registry.test.ts \
  src/__tests__/tool-input-schemas-registry.test.ts \
  src/__tests__/rss-visual-skill-child-run.test.ts \
  src/__tests__/task-projection-sync.test.ts \
  src/__tests__/turn-frame-steering.test.ts
```

Then run:

```bash
npm run verify
```

If `npm run verify` still fails on unrelated lint baseline:

- list exact error files;
- prove they are not in `git diff --name-only <pre-remediation-base>..HEAD` for this closure work;
- do not claim "verify passed";
- do claim only the focused child-loop suite passed.

## 7. What Claude Must Not Do

- Do not reintroduce typed VEA actions into parent preferred tools as a "resume" shortcut.
- Do not convert observer timeout into `cancelled_user`.
- Do not make missing tool definitions telemetry-only.
- Do not widen types to `string` to avoid modeling terminal reasons.
- Do not use active-only lookup for exact terminal child reconstruction.
- Do not add new UI controls.
- Do not refactor unrelated supervisor/projection code unless a failing test proves it is needed.
- Do not call the plan complete without red/green tests for all six review findings.

## 8. Handoff Instruction

Claude should now rewrite this arrangement into a concrete implementation plan. The rewritten plan should be saved under:

```text
docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-final-closure-implementation.md
```

The rewritten plan is expected to be more detailed than this arrangement, with exact test names and exact edit points. After Claude rewrites it, Codex should review the rewritten plan before any implementation proceeds.
