---
title: P8g-8a Specialist Create Entry Reliability Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: true
scope:
  - outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md
---

# P8g-8a Specialist Create Entry Reliability

## Goal

Make natural-language requests such as "我要一个 xxx 类型的专项 agent" reach a valid staged blueprint path instead of breaking because the model-visible tool schema is narrower than the backend execution schema.

## Assumptions

- The current confirmed blueprint pipeline remains the creation path.
- This slice does not activate routing automatically.
- This slice does not implement blank manual creation, active-agent editing, lifecycle evolution, browser isolation, or a real semantic judge provider.

## Changes

1. Align the model-visible `propose_specialist_blueprint` schema with the backend execution schema.
2. Add a drift test that derives backend required top-level fields from the execution schema and verifies both Anthropic and OpenAI tool schemas expose and require them.
3. Keep `knowledge_seeds` optional and keep all generated specialist assets staged until user confirmation.

## Acceptance

- `propose_specialist_blueprint` model-visible schemas include every backend-required top-level field.
- `tool_boundaries` exposes browser/write/external-send/long-memory boundaries with `mode` and `notes`.
- Dispatch validation still uses `proposeSpecialistBlueprintSchema`.
- Incomplete proposals continue to enter clarification or validation failure, not direct agent creation.

## Verification

- `npx tsx --test src/__tests__/propose-specialist-blueprint-tool.test.ts`
- `npm run verify:specialist-blueprint`
- `npm run typecheck`
- `git diff --check`
