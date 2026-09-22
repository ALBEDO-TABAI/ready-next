---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Skill Runtime Child Loop Final Closure Implementation

Date: 2026-04-30

Target worktree:

```text
/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan
```

## Final Contract

`SkillChildRun` is now treated as a durable child lifecycle, not as a parent-loop long-task retry wrapper.

Canonical child statuses:

```text
queued
running
recoverable_paused
budget_paused
blocked
completed
failed
killed
```

Canonical terminal reasons:

```text
completed
checkpoint_budget
checkpoint_background
queued_global_concurrency
launch_stuck
blocked_config
blocked_external
nested_child_run_not_supported
cancelled_user
failed_skill
infra_error
child_process_crashed
host_unavailable
tool_not_registered
input_validation
process_restarted
```

Observer timeout is deliberately separate:

```text
ChildWaitResult = closed | observer_timeout
```

`observer_timeout` is not a child status, not a terminal reason, and must not write a close event or cancel the child.

Resume identity is in-place:

```text
same childRunId
same skill_task_runs row
same outputDir
same runStatePath
same singleFlightKey
```

Only `recoverable_paused` and `budget_paused` are directly resumable. `blocked` remains blocked until an external repair path changes the state. `completed`, `failed`, and `killed` are terminal and are never resumed.

Child-internal skill actions are admitted through registered tool definitions and the same `executeToolCall` dispatch contract. Internal definitions are invisible to the model by default and allowed only when the invoker is the child runner.

## Closed Gaps

- Status contract is centralized in `skill-child-run-types.ts` and `skill-child-state-machine.ts`.
- Legacy `infra_error` payloads with specific error kinds are decoded to canonical reasons such as `child_process_crashed`, `host_unavailable`, `tool_not_registered`, and `input_validation`.
- `resumeSkillChildRun` reuses the same row and refuses blocked or terminal children without dispatching another action.
- `waitForSkillChildRunClose` supports multiple awaiters, independent timeout, and independent abort without killing the child.
- `startSkillChildRunAndWait` now returns observer timeout without calling cancel.
- RSS visual analysis can pass only `sceneScoresPath`; the real VEA child driver can consume that direct input.
- Exact child identity lookup by `runStatePath`, `outputDir`, or `singleFlightKey` can find terminal rows for contract reconstruction, while active single-flight reuse remains active-only.
- Child internal actions without a tool definition return `tool_not_registered`; invalid arguments return `input_validation`; valid internal actions dispatch through `executeToolCall`.
- Child-owned TurnFrames expose only status/resume/cancel observation behavior to the parent loop; typed skill action prompting is suppressed for child-owned frames.
- User "continue" resumes only `recoverable_paused` or `budget_paused`; user "cancel" writes `cancelled_user` only for explicit cancel.
- Skill primitives remain visible when the session has an active child task run.

## Verification

Commands run:

```bash
npm run typecheck
npx tsx@^4.19.2 --test src/__tests__/skill-child-state-machine.test.ts src/__tests__/skill-task-run-repository.test.ts src/__tests__/tool-internal-admission.test.ts src/__tests__/skill-child-runner.test.ts src/__tests__/rss-visual-skill-child-run.test.ts src/__tests__/phase-3-output-safety-net.test.ts src/__tests__/skill-tool-gating-by-session.test.ts src/__tests__/skill-primitive-tool-gating.test.ts src/__tests__/turn-engine-force-tool-dispatch.test.ts src/__tests__/turn-engine-route.test.ts src/__tests__/turn-frame-steering.test.ts
npx tsx@^4.19.2 --test src/__tests__/skill-child-run-end-to-end.test.ts
./node_modules/.bin/eslint . --ext .js,.jsx,.cjs,.mjs,.ts,.tsx,.cts,.mts --format json
npm run verify
```

Results:

```text
npm run typecheck: passed
targeted child-runtime / RSS / tool-admission / parent-loop tests: 137 passed, 0 failed
skill-child-run-end-to-end: 19 passed, 0 failed
lint baseline at HEAD 9fb93c9: 30 errors, 528 warnings
current lint: 23 errors, 526 warnings
lint delta: -7 errors, -2 warnings
changed files with lint errors: 0
npm run verify: rebuild:native passed, typecheck passed, then stopped at pre-existing lint baseline errors
```

The full `verify` command is still not clean because the repository already has lint errors outside this closure scope. The machine diff proves this implementation did not add lint errors and reduced the total error count.
