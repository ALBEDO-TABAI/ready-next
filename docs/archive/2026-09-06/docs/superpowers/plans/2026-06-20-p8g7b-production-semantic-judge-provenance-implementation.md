---
title: P8g-7b Production Semantic Judge + Provenance Closeout
date: 2026-06-20
status: implemented; production judge provider remains not configured by default
owner: 白
author: Codex
executor: Codex
reviewer: Claude
enforce: false
pairs_with:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-20-p8g7-semantic-foundation-judge-implementation.md
  - outputs/agent-audit/fix-plan/161-CONSENSUS-P7C4-P8G7B-P8G8-ROUTE-REFRESH.md
  - outputs/agent-audit/fix-plan/162-CLAUDE-P8G7B-PRODUCTION-JUDGE-PROVENANCE-PLAN.md
depends_on:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-19-specialist-agent-creation-blueprint-implementation.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-06-20-p8g7-semantic-foundation-judge-implementation.md
scope:
  - production semantic judge resolver wiring
  - source message provenance closeout
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P8g-7b Production Semantic Judge + Provenance Closeout

> Closeout note (2026-06-20): the resolver, wiring, source-message provenance, empty-output fail-closed behavior, and drift gates have landed. The real LLM-backed semantic judge provider is still intentionally not configured; production records `production_judge_not_configured` until a future provider is supplied.

## 0. Completion Standard

This slice is complete when the existing specialist-agent creation funnel no longer has a hidden semantic-review hole:

- `propose_specialist_blueprint` and specialist blueprint IPC both receive the same narrow semantic judge resolver.
- If a real judge is unavailable, the review records an observable unavailable reason.
- Missing, failed, timed-out, or disabled judge output never counts as semantic pass.
- Ordinary chat turns do not run the judge unless the model/tool path is actually proposing or reviewing a specialist blueprint.
- Blueprint provenance records `sourceMessageId` when the current context provides one.
- If no stable source message id exists, the blueprint records a concrete `sourceMessageUnavailableReason`.
- Existing explicit unverified confirmation remains the only fallback for deterministic-pass + semantic-unavailable blueprints.

## 1. Non-Goals

- No generic model-provider or capability-layer refactor.
- No automatic specialist creation.
- No automatic routing activation.
- No blank Studio manual-create flow; that is P8g-8.
- No browser profile, partition, or BrowserView isolation work; that is P7c4.
- No fake or synthesized message id.
- No `FOUNDATION.md` prompt injection.

## 2. Implementation Plan

### Slice A · Narrow semantic judge resolver

Add a small specialist-only resolver under `agent-control/agents`.

Contract:

- Accept an optional injected judge for tests or future provider wiring.
- Return `{ judge, unavailableReason }`.
- Default production state is `judge: undefined` with a specific reason such as `production_judge_not_configured`.
- The resolver must not call an LLM by itself in this slice.

### Slice B · Production wiring

Wire the resolver into:

- `src/main/modules/tools/tool-executor.ts` for `propose_specialist_blueprint`.
- `src/main/modules/claude-bridge/ipc-handler.ts` for `agentSpecialistBlueprintGroup`.

Also allow the existing lower-level modules to carry `semanticFoundationJudgeUnavailableReason` into `runSpecialistFoundationSemanticReview()`.

### Slice C · Provenance reason

Extend the specialist blueprint provenance shape:

- Keep `sourceMessageId` for real ids.
- Add `sourceMessageUnavailableReason` for the current gap.

Thread both fields through the tool runtime context. New writes should not leave `sourceMessageId: null` without also recording why no source id was available.

Only the execution host may provide a trusted `sourceMessageId`. `requestEnvelope` fields that merely look like message ids are not trusted as provenance.

### Slice D · Tests and gates

Focused checks:

- Direct tool execution persists true `sourceMessageId` when provided.
- Direct tool execution persists unavailable reason when no source id is available.
- No judge stores `semanticReview.status === 'unavailable'` with a production unavailable reason when that reason is passed.
- A fake injected judge still blocks or passes by closed issue ids.
- IPC admission carries the same unavailable reason.
- `tool-executor` no longer hardcodes `sourceMessageId: null`.
- Specialist create funnel gate fails if production registration forgets the semantic judge resolver.

## 3. Verification

Run at minimum:

- `npx tsx --test src/__tests__/propose-specialist-blueprint-tool.test.ts src/__tests__/agent-specialist-blueprint-ipc.test.ts src/__tests__/agent-specialist-blueprint-schema.test.ts src/__tests__/specialist-blueprint-semantic-judge.test.ts`
- `node scripts/check-specialist-create-funnel.cjs`
- `npm run verify:specialist-blueprint`
- `npm run verify:agent-system-studio`
- `npm run typecheck`
- `git diff --check`

If the broader verification chain is too slow or blocked by unrelated dirty work, record the exact blocker and keep the P8g-7b focused tests green.
