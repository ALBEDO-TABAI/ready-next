---
title: P6j · Dormant compaction cleanup implementation
date: 2026-06-21
phase: P6j
branch: agent-evolution/phase1
enforce: false
source:
  - outputs/agent-audit/fix-plan/330-CLAUDE-P6-REMAINING-AFTER-P6I-PROMPT.md
  - outputs/agent-audit/fix-plan/331-CLAUDE-P6-REMAINING-AFTER-P6I-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/332-CONSENSUS-P6J-C29A-DORMANT-COMPACTION-CLEANUP-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6j · Dormant Compaction Cleanup

## Goal

Close one narrow C29 follow-up: old DirectChat/TurnEngine dormant execution shells must no longer own retry compaction.

Production live compaction remains:

- SDK input compaction in `compact-agent-input.ts`.
- L1 prompt summary in `prompt-assembly.ts` via `compressHistoryForPrompt`.

## Scope

1. Tighten `check-dormant-compaction-not-in-live-path.cjs`.
   - `agent-sdk-runtime.ts` still must use only `compact-agent-input`.
   - `prompt-assembly.ts` still may import `context-compression`.
   - `turn-engine.ts` and `direct-chat.ts` must not import `context-compression`, `layered-compactor`, or the L2 stub.
   - `compaction/index.ts` may keep exports for now; this batch is not file deletion.

2. Update gate self-tests.
   - Passing harness has no DirectChat/TurnEngine compaction imports.
   - Fixture with TurnEngine `context-compression` import fails.
   - Fixture with TurnEngine dynamic `context-compression` import fails.
   - Fixture with DirectChat `context-compression` import fails.
   - Fixture with TurnEngine `layered-compactor` import fails.
   - Fixture with TurnEngine dynamic `layered-compactor` import fails.
   - Fixture with TurnEngine / DirectChat `compaction` barrel import fails.

3. Remove dormant compaction code from `turn-engine.ts`.
   - Remove `compressHistoryForPrompt` import and helper.
   - Remove `createLayeredCompactor` import, metric map, and instance.
   - Keep TurnEngine class and dormant execution shell intact.

4. Remove dormant compaction code from `direct-chat.ts`.
   - Remove `compressHistoryForPrompt` import and helper.
   - Keep DirectChat provider/domain-adapter role and `sendMessage` shell intact.

5. Update old behavior tests.
   - Replace "TurnEngine compacts string-only model session" expectation with "TurnEngine no longer compacts session; persisted/session messages remain unmutated".
   - Keep rich-content block preservation test meaningful.

6. Add `verify:evolution-p6j`.

## Exclusions

- No TurnEngine deletion.
- No DirectChat deletion.
- No orchestrator send-path changes.
- No SDK live compaction changes.
- No prompt-assembly context-budget changes.
- No C30 move-only split.
- No C32 errorKind work.
- No claim that full `verify:d` is green if a broader baseline still blocks it.

## Red Proof

Before removing production code, tighten the gate and self-test, then run:

```bash
node scripts/check-dormant-compaction-not-in-live-path.cjs
```

Expected red result on the current code:

- `turn-engine.ts` still imports dormant compaction.
- `direct-chat.ts` still imports dormant compaction.

## Verification

Required commands:

```bash
node scripts/check-dormant-compaction-not-in-live-path.cjs
node --test scripts/__tests__/check-dormant-compaction-not-in-live-path.test.cjs
node scripts/check-directchat-turnengine-dormant-boundary.cjs
node --test scripts/__tests__/check-directchat-turnengine-dormant-boundary.test.cjs
npx tsx@^4.19.2 --test src/__tests__/turn-engine-route.test.ts
npm run verify:evolution-p6j
npm run verify:evolution-p6f
npm run typecheck
git diff --check -- scripts/check-dormant-compaction-not-in-live-path.cjs scripts/__tests__/check-dormant-compaction-not-in-live-path.test.cjs src/main/modules/agent-control/turn-engine.ts src/main/modules/claude-bridge/direct-chat.ts src/__tests__/turn-engine-route.test.ts package.json docs/archive/2026-09-06/docs/superpowers/plans/2026-06-21-p6j-dormant-compaction-cleanup-implementation.md
```

## Stop Conditions

Stop and re-plan if:

- implementation requires changing `orchestrator.ts` or SDK send path;
- deleting TurnEngine or DirectChat becomes necessary;
- behavior tests require large TurnEngine contract rewrites;
- C32 or C30 work starts creeping into the diff.
