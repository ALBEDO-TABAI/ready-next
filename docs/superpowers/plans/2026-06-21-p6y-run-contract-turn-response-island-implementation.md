---
title: P6y · Run-Contract Turn Response Type Island Implementation
date: 2026-06-21
phase: P6y
priority: P2
enforce: true
depends:
  - outputs/agent-audit/fix-plan/470-CLAUDE-P6Y-TURN-RESPONSE-PLAN.md
  - outputs/agent-audit/fix-plan/471-CODEX-P6Y-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/473-CLAUDE-P6Y-PLAN-REVISED.md
---

# P6y Run-Contract Turn Response Type Island Implementation

## Goal

Close one narrow C30 follow-up: move the turn-response type cluster out of
`run-contracts.ts` into its own type-only island while preserving the existing
`run-contracts.ts` import surface.

This continues the P6s/P6u/P6v incremental C30 pattern. It is not a full
`run-contracts.ts` split.

## Scope In

1. Add `src/main/modules/agent-control/contracts/turn-response-contracts.ts`.
2. Move exactly these 8 type-only declarations into that island:
   - `TurnProviderContext`
   - `TurnSimpleResponse`
   - `TurnToolCall`
   - `TurnToolExecutionResult`
   - `TurnToolBatchResult`
   - `TurnToolCallParseError`
   - `TurnModelResponse`
   - `TurnShortcutResult`
3. Re-export all 8 from `run-contracts.ts` using `export type { ... }`.
4. Add `scripts/check-run-contract-turn-response-island.cjs`.
5. Add `scripts/__tests__/check-run-contract-turn-response-island.test.cjs`.
6. Add `verify:evolution-p6y`, chained to `verify:evolution-p6x`.

## Scope Out

- Do not move `TurnEngineHost`, `TurnEngineRequest`, `RunMessage`,
  `TurnEngineSession`, `RecoveryRecord`, `ToolSnapshot`, or
  `TaskInteractionState`.
- Do not edit consumer import paths.
- Do not rename, re-type, reorder, or clean up the moved fields.
- Do not perform C32 browser task status work.
- Do not include P2b shell isolation, browser identity/session work, or
  specialist-agent product work.
- Do not update root `CLAUDE.md` / `AGENTS.md`; this type-only island is not a
  new root hard constraint.

## Gate Requirements

`check-run-contract-turn-response-island.cjs` must fail when:

- any of the 8 moved declarations remain locally defined in `run-contracts.ts`;
- any of the 8 declarations are missing from `turn-response-contracts.ts`;
- `run-contracts.ts` re-exports the 8 declarations as value exports instead of
  `export type`;
- the island imports `node:fs`, `fs`, `node:path`, or `path`;
- the island redefines do-not-move leaves instead of importing them as types.

The gate self-test must include one passing temp fixture plus red fixtures for
the failure modes above.

## Verification

Run:

```bash
node scripts/check-run-contract-turn-response-island.cjs
node --test scripts/__tests__/check-run-contract-turn-response-island.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/turn-engine-contract.test.ts src/__tests__/agent-runtime-host-contract.test.ts src/__tests__/agent-sdk-runtime.test.ts
npm run verify:evolution-p6y
npm run typecheck
git diff --check
```

## Anti-Overclaim

P6y only relocates 8 type-only turn-response declarations out of
`run-contracts.ts` into `turn-response-contracts.ts` behind a stable type-only
re-export. It does not complete C30/P6, does not close C29, and does not touch
C32/browser task status semantics.

## Stop Points

- If the type-only cycle fails `typecheck`, stop and reassess.
- If any consumer import path must change, stop and fix the re-export instead.
- If implementation must move anything beyond the 8 listed declarations, stop
  and reopen the plan.
- If `verify:evolution-p6y` does not chain through `verify:evolution-p6x`, stop
  and fix the chain before closeout.
