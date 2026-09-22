---
title: P6i · browser_tool_failed errorKind drift gate
date: 2026-06-21
phase: P6i
priority: P2
depends: [P6d, P6h]
covers: [C32]
enforce: false
source:
  - outputs/agent-audit/fix-plan/323-CLAUDE-P6-REMAINING-AFTER-P6H-PROMPT.md
  - outputs/agent-audit/fix-plan/324-CLAUDE-P6-REMAINING-AFTER-P6H-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/325-CONSENSUS-P6I-BROWSER-TOOL-ERRORKIND-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6i · `browser_tool_failed` ErrorKind Drift Gate

## Goal

Close one narrow C32 follow-up: the browser fallback `errorKind` value `browser_tool_failed` must have a shared registry entry and must be consumed from that registry in production fallback paths.

This is a drift-prevention slice only. It must not change browser tool behavior or error presentation.

## Completion Criteria

- `BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code` is registered in `src/main/modules/agent-control/contracts/error-kinds.ts`.
- `src/main/modules/tools/browser-failure-output.ts` and `src/main/modules/tools/tool-executor.ts` consume the shared constant instead of local `browser_tool_failed` literals.
- `scripts/check-shared-enum-drift.cjs` fails if the browser errorKind is unregistered or copied locally in those target files.
- Existing browser failure envelope behavior remains unchanged.
- `324` is recorded as closed by the P6i replacement review chain in closeout/no-output docs.

## Non-Goals

- Do not register all remaining `errorKind` values.
- Do not close full C32.
- Do not change `tool-result-envelope.ts` mapping.
- Do not modify browser control flow, lease behavior, or failure copy.
- Do not delete DirectChat/TurnEngine dormant compaction.
- Do not start C30 move-only file splitting.

## Implementation Steps

1. Extend shared-enum drift gate and self-tests.
   - Add browser errorKind target files.
   - Add required `browser_tool_failed` registration.
   - Add self-tests for unregistered and local literal copies.
   - Verify this is red against current production code before implementation.

2. Add shared registry group.
   - Add `BROWSER_TOOL_ERROR_KINDS`.
   - Include it in all registered-code lookup helpers.

3. Replace production literals.
   - `browser-failure-output.ts` fallback paths.
   - `tool-executor.ts` legacy browser `Error:` fallback.

4. Verify behavior and drift protection.

## Required Verification

Red proof:

```bash
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
```

Expected before implementation: failure against the real codebase because browser tool errorKind registration/consumption is not yet wired.

Green proof:

```bash
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
npx tsx --test src/__tests__/browser-tool-failure-envelope.test.ts
node scripts/check-browser-tool-no-json-failure.cjs
npm run verify:evolution-p6h
npm run verify:evolution-p6i
npm run typecheck
git diff --check -- src/main/modules/agent-control/contracts/error-kinds.ts src/main/modules/tools/browser-failure-output.ts src/main/modules/tools/tool-executor.ts scripts/check-shared-enum-drift.cjs scripts/__tests__/check-shared-enum-drift.test.cjs package.json docs/archive/2026-09-06/docs/superpowers/plans/2026-06-21-p6i-browser-tool-errorkind-drift-gate-implementation.md outputs/agent-audit/fix-plan/325-CONSENSUS-P6I-BROWSER-TOOL-ERRORKIND-ROUTE.md
```

Source check:

```bash
rg "errorKind:\\s*['\"]browser_tool_failed|\\|\\|\\s*['\"]browser_tool_failed|browser_tool_failed['\"]" src/main/modules/tools/browser-failure-output.ts src/main/modules/tools/tool-executor.ts
```

After implementation, matches in production code must be absent except where the shared constant name is imported/used without the literal.
