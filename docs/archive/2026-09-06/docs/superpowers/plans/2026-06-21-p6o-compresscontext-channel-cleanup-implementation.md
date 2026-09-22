---
title: P6o CompressContext Channel Cleanup Implementation
date: 2026-06-21
slice: P6o / C29b
status: planned
enforce: false
source:
  - outputs/agent-audit/fix-plan/375-CLAUDE-P6O-COMPRESSCONTEXT-PLAN.md
  - outputs/agent-audit/fix-plan/376-CODEX-P6O-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/378-CLAUDE-P6O-PLAN-REVISED.md
  - outputs/agent-audit/fix-plan/379-SUBAGENT-P6O-PLAN-LEDGER-REVIEW.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6o CompressContext Channel Cleanup Implementation

## Completion Standard

P6o is complete only when the dormant `compressContext` callback channel is gone from the legacy `ExecutionLoopOrchestrator` path, and a context-overflow error in that dormant path no longer retries through either compression or generic retry.

Success requires all of the following:

1. Red tests/gates fail on the current callback/retry behavior.
2. Source removes the dormant callback channel without touching live SDK compaction.
3. Green verification passes for P6o and adjacent dormant-boundary checks.
4. Closeout, no-output ledger statement, and roadmap calibration are updated.

## Scope

Allowed source files:

- `src/main/modules/agent-control/contracts/run-contracts.ts`
- `src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`

Allowed tests/gates:

- `src/__tests__/execution-loop-parallel-tools.test.ts`
- `src/__tests__/agent-runtime-host-contract.test.ts`
- `scripts/check-dormant-compaction-not-in-live-path.cjs`
- `scripts/__tests__/check-dormant-compaction-not-in-live-path.test.cjs`
- `package.json`

Allowed docs:

- this implementation plan;
- `outputs/agent-audit/fix-plan/*P6O*`;
- `outputs/agent-audit/fix-plan/00-ROADMAP.md`.

## Non-Scope

Do not change:

- `buildRecoveryPlan()`;
- `classifyExecutionError()`;
- live SDK compaction;
- `prompt-assembly.ts`;
- `compact-agent-input.ts`;
- `context-compression.ts`;
- shared `shouldCompressContext` classifier/router fields;
- video fallback, provider fallback, tool-batch retry, browser identity, P2b, P7/P8, C30, full C29, full C32, or full P6.

## Required Behavior

In legacy `ExecutionLoopOrchestrator`, when the model request throws a context-overflow error:

- the model request is attempted exactly once;
- no compression callback is accepted or called;
- no generic retry is attempted for a `shouldCompressContext` recovery plan;
- the original error is surfaced.

## Required Tests And Gates

Red-before:

- rewrite the old compression retry test so current code fails because it attempts twice;
- extend the runtime-host contract test to reject dormant callback plumbing;
- extend the dormant compaction gate to reject `compressContext` in the callback-channel files and prove each forbidden file is caught.

Green-after:

```bash
npm run verify:evolution-p6o
npm run verify:evolution-p6f
npm run verify:evolution-p6j
npm run typecheck
git diff --check -- \
  docs/archive/2026-09-06/docs/superpowers/plans/2026-06-21-p6o-compresscontext-channel-cleanup-implementation.md \
  outputs/agent-audit/fix-plan \
  package.json \
  scripts/check-dormant-compaction-not-in-live-path.cjs \
  scripts/__tests__/check-dormant-compaction-not-in-live-path.test.cjs \
  src/__tests__/agent-runtime-host-contract.test.ts \
  src/__tests__/execution-loop-parallel-tools.test.ts \
  src/main/modules/agent-control/contracts/run-contracts.ts \
  src/main/modules/agent-control/runtime-core/execution-loop-orchestrator.ts \
  src/main/modules/claude-bridge/direct-chat.ts
```

`verify:native` is not required for P6o because this slice does not touch native-backed persistence or SQLite behavior.

## Closeout Requirements

The closeout must state:

- P6o retires only the dead dormant callback channel and its latent one-retry gap;
- P6o does not close full C29/C30/C31-b/C32/P6;
- no-output remains **52 / 39** unless a later Claude P6o call returns no output;
- `374` remains excluded as CLI invocation/frontmatter transport failure, not Claude no-output;
- `378` is valid Claude output.
