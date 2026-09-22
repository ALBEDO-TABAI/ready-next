---
title: P6m · specialist-blueprint errorKind drift implementation
date: 2026-06-21
phase: P6m
priority: P2
depends:
  - outputs/agent-audit/fix-plan/356-CLAUDE-P6M-SPECIALIST-BLUEPRINT-ERRORKIND-PLAN.md
  - outputs/agent-audit/fix-plan/357-CODEX-P6M-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/358-CONSENSUS-P6M-SPECIALIST-BLUEPRINT-ERRORKIND-ROUTE.md
covers:
  - C32
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6m · Specialist-Blueprint ErrorKind Drift

## Goal

Close one narrow C32 drift family: the `propose_specialist_blueprint` tool must consume its three structured `errorKind` codes from `contracts/error-kinds.ts`, and the shared-enum drift gate must prevent local copies or fake family ownership.

This does not close full P6, full C32, C29, C30, C31, P2b isolation, browser identity isolation, P8 product work, or any UI route.

## In Scope

- Add `SPECIALIST_BLUEPRINT_ERROR_KINDS` for:
  - `verbatim_source_unavailable`
  - `verbatim_mismatch`
  - `confirmed_blueprint_immutable`
- Replace the in-scope literals in `src/main/modules/tools/builtins/propose-specialist-blueprint.ts`.
- Extend `scripts/check-shared-enum-drift.cjs` and its fixture tests.
- Add `src/__tests__/specialist-blueprint-error-kinds.test.ts`.
- Add focused behavior proof for confirmed blueprint immutability in `src/__tests__/propose-specialist-blueprint-tool.test.ts`.
- Add `verify:evolution-p6m`.

## Out Of Scope

- Other errorKind families such as `web_search_failed` or `command_high_risk_blocked`.
- TurnEngine/DirectChat retirement, dormant shell deletion, or compaction policy changes.
- C30 move-only splitting.
- Specialist blueprint pipeline refactors.

## Red Proof

Before production wiring, these must fail:

- `node scripts/check-shared-enum-drift.cjs` on the real codebase.
- `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/specialist-blueprint-error-kinds.test.ts`.
- New gate fixtures proving:
  - the three codes registered in the wrong family are rejected;
  - target usage without importing `SPECIALIST_BLUEPRINT_ERROR_KINDS` is rejected;
  - missing shared-family usage is rejected;
  - local literal copies in `propose-specialist-blueprint.ts` are rejected for object properties, positional strings, type unions, and object-map keys.

## Green Proof

- `rg -n "verbatim_source_unavailable|verbatim_mismatch|confirmed_blueprint_immutable" src/main/modules/tools/builtins/propose-specialist-blueprint.ts` must show no copied string literals.
- `node scripts/check-shared-enum-drift.cjs`
- `node --test scripts/__tests__/check-shared-enum-drift.test.cjs`
- `npm run verify:evolution-p6m`
- `npm run verify:evolution-p6k`
- `npm run verify:evolution-p6l`
- `npm run typecheck`
- `npm run verify:native`
- `git diff --check --` for P6m relevant paths.

The behavior proof must preserve the existing strings, messages, output shape, and `blueprintId` for all three errors. The confirmed-immutable path is explicitly in scope because it was not already covered by the existing specialist blueprint behavior tests.

## Closeout

P6m can close only after:

- implementation proof is recorded;
- Claude implementation review succeeds, or a no-output is recorded and named subagent replacement review is recorded;
- no-output ledger is refreshed if needed;
- `00-ROADMAP.md` is calibrated and keeps P6 remaining open.
