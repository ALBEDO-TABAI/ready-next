---
title: P5e Derivation Live Boundary Implementation
date: 2026-06-20
status: active
enforce: false
scope: P5e / C23
source:
  - outputs/agent-audit/fix-plan/256-CLAUDE-P5E-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/257-SUBAGENT-P5E-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/258-CONSENSUS-P5E-DERIVATION-LIVE-BOUNDARY-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P5e Derivation Live Boundary Implementation

## Goal

Make the specialist derivation/create boundary explicit and machine-checked.

## Completion Standard

This slice is complete only when:

- legacy candidate derivation helpers are explicitly marked dormant/test-era;
- production code cannot call those legacy helpers;
- old candidate confirm is proven to stage a blueprint and not create an agent;
- live blueprint creation is proven to call `registry.create` after writes and retain rollback cleanup;
- the specialist create funnel gate and its self-test run in `verify:evolution-p4`;
- focused tests and phase verifies pass.

## Code Changes

1. Add comment-only markers near `prepareSpecialistAgentDerivation` and `deriveSpecialistAgent`.
2. Extend `scripts/check-specialist-create-funnel.cjs` with:
   - legacy dormant marker checks;
   - old confirm staging-only checks;
   - live blueprint funnel shape checks.
3. Extend `scripts/__tests__/check-specialist-create-funnel.test.cjs` with negative fixtures for missing dormant marker and broken blueprint funnel shape.
4. Add `node scripts/check-specialist-create-funnel.cjs` and `node --test scripts/__tests__/check-specialist-create-funnel.test.cjs` to `verify:evolution-p4`.

## Non-Scope

- Do not rewrite or delete legacy `deriveSpecialistAgent`.
- Do not alter `deriveSpecialistAgentFromBlueprint` behavior.
- Do not change IPC runtime behavior.
- Do not touch unrelated P5 slices, P6, browser identity, or specialist product routes.

## Verification

- `node scripts/check-specialist-create-funnel.cjs`
- `node --test scripts/__tests__/check-specialist-create-funnel.test.cjs`
- `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/specialist-agent-factory-blueprint.test.ts src/__tests__/agent-derivation-flow.test.ts src/__tests__/agent-factory.test.ts src/__tests__/agent-specialist-blueprint-ipc.test.ts`
- `npm run verify:evolution-p4`
- `npm run verify:specialist-blueprint`
- `npm run typecheck`

## No-Overclaim Rule

The live rollback behavior already exists before P5e. This slice only closes the boundary and regression guard. It must not be described as making the legacy helper transaction-safe.
