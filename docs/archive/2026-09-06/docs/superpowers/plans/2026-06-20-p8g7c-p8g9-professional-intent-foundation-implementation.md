---
title: P8g-7c/P8g-9 Professional Intent Foundation Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: false
scope:
  - outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md
  - outputs/agent-audit/fix-plan/171-CLAUDE-P8G7C-P8G9-PLAN-FAILURE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P8g-7c/P8g-9 Professional Intent Foundation

## Boundary

This document covers the first anti-hollow slice only.

It makes bare type-label specialist requests ask professional intake questions before blueprint proposal, and it strengthens deterministic quality checks against generic foundations. It does not complete the full specialist-agent designer product. The follow-up route is `outputs/agent-audit/fix-plan/175-CONSENSUS-P8G9B-PROFESSIONAL-AGENT-DESIGNER-ROUTE.md`.

## Goal

Make "我要一个 xxx 类型的专项 agent" less likely to become a hollow but structurally valid blueprint. The model-visible creation path must first interview for professional scope when the user only gives a type label, and the deterministic quality gate must reject long generic foundation text.

## P8g-7c Decision

Do not wire a real semantic judge provider in this batch.

Reason:

- The current resolver has no product-configured provider selector.
- A direct provider connection here would bypass Ready's existing AI settings and secret surfaces.
- The already implemented `production_judge_not_configured` state is the honest product behavior until a provider decision is made.

Required behavior:

- No claim that production semantic review is active.
- Unavailable semantic review remains visible before confirmation.
- Deterministic gates remain the hard safety floor.

## P8g-9 Changes

1. Add a model-visible professional-intake rule for `propose_specialist_blueprint`:
   - if the user only names a specialist type and does not give enough scope evidence, call `ask_user_questions` first;
   - ask at most three high-impact questions;
   - cover scope/success, non-goals/main-agent split, and inputs/outputs/tool/memory boundaries;
   - preserve the original `user_request_verbatim`.
2. Keep `propose_specialist_blueprint` for cases where enough evidence already exists or after the user answers.
3. Strengthen deterministic quality checks so long but generic field-complete blueprints are sent to clarification instead of being treated as excellent.
4. Keep all assets staged until explicit confirmation.

## Non-Goals

- No new provider key, model selector, or external LLM call.
- No automatic specialist creation.
- No active routing before confirmation.
- No Studio active-agent asset editor; that remains P8g-8b.
- No task-output evolution loop; that remains P8g-8c.

## Acceptance

- Tool instructions require professional interview before proposing a blueprint from a bare type-label request.
- The interview stays within three questions.
- A generic but wordy foundation fails deterministic quality.
- Semantic judge unavailable remains explicit and does not count as pass.
- Existing staged blueprint, confirmation, and Studio flows stay green.

## Verification

- `npx tsx@^4.19.2 --test src/__tests__/propose-specialist-blueprint-tool.test.ts src/__tests__/specialist-blueprint-quality.test.ts src/__tests__/agent-specialist-blueprint-clarification.test.ts`
- `npm run verify:specialist-blueprint`
- `npm run verify:agent-system-studio`
- `npm run typecheck`
- `git diff --check`
