---
title: P8g-9b/P8g-9c Professional Agent Designer Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: false
scope:
  - outputs/agent-audit/fix-plan/175-CONSENSUS-P8G9B-PROFESSIONAL-AGENT-DESIGNER-ROUTE.md
  - outputs/agent-audit/fix-plan/178-CLAUDE-P8G9B-P8G9C-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/180-CLAUDE-P8G9B-P8G9C-IMPLEMENTATION-REVIEW.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P8g-9b/P8g-9c Professional Agent Designer

## Goal

Make "我要一个 xxx 类型的专项 agent" enter a canonical professional design flow before any specialist is created.

This batch closes the shape layer:

- P8g-9b: a professional interview contract with at most three high-impact questions;
- P8g-9c: a versioned foundation authoring pack with canonical sections and deterministic preview coverage.

After Claude cross-review, P8g-9b also requires runtime wiring: broad type-label blueprint gaps must return this professional interview contract, not only mention it in model-visible prose.

## Assumptions

- The existing `propose_specialist_blueprint` path remains the only conversation-to-blueprint write path.
- The existing `ask_user_questions` tool remains the user-facing interview card surface.
- The existing confirmed blueprint adoption path remains the only create path.
- Production semantic review remains explicitly unavailable unless a future provider is configured.

## Scope

### WP1 · Professional Interview Contract

Add a contract that turns a bare type-label request into three professional interview questions:

1. work object, stable scenario, success criteria, and output form;
2. non-goals, main-agent split, suitable examples, and unsuitable examples;
3. required inputs, source materials, initial knowledge, tool/memory boundaries, routing hints, and lifecycle assumptions.

Acceptance:

- The contract asks at most three questions.
- The questions are separate; there is no single mega free-text prompt.
- The contract maps each answer to concrete `propose_specialist_blueprint` fields.
- `userRequestVerbatim` stays as the original user wording.
- Broad type-label `needs_clarification` results return this contract at runtime.

### WP2 · Answer-To-Blueprint Mapping

Add a deterministic compiler that converts the interview answers into field-level draft hints for `propose_specialist_blueprint`.

Acceptance:

- The compiler never creates an agent.
- The compiler never activates routing.
- The compiler includes all core blueprint field targets: charter, domain, role persona, non-goals, recurring tasks, required inputs, expected outputs, task examples, main/specialist split, rules, knowledge seeds, tool boundaries, safety notes, memory policy, lifecycle, and routing triggers.
- Every generated field can trace back to the original request or a specific interview answer id.
- List-like draft hints are split into concrete field-specific items instead of copying one answer wholesale into every list.

### WP3 · Foundation Authoring Pack

Version the foundation preview as a canonical pack instead of an implicit renderer shape.

Acceptance:

- The pack has a stable version id.
- The pack exposes the canonical sections before confirmation:
  - provenance;
  - role persona;
  - charter;
  - operating model;
  - scope;
  - task examples;
  - main-vs-specialist split;
  - inputs;
  - outputs;
  - rules;
  - knowledge seeds;
  - routing;
  - tool boundaries;
  - memory/profile policy;
  - lifecycle;
  - quality checks.
- Tests fail if the renderer drops any canonical section.

## Non-Goals

- No automatic specialist creation.
- No active routing before confirmation.
- No new semantic judge provider.
- No Studio active-agent content editor; that remains P8g-8b.
- No task-output-to-agent-evolution loop; that remains P8g-8c.
- No browser identity/session isolation claim.

## Files

Expected touch points:

- `src/shared/agent-specialist-blueprint-clarification.ts`
- `src/main/modules/agent-control/agents/specialist-blueprint-quality.ts`
- `src/main/modules/tools/agent-interaction-tool-defs.ts`
- `src/__tests__/agent-specialist-blueprint-clarification.test.ts`
- `src/__tests__/specialist-blueprint-quality.test.ts`
- `src/__tests__/propose-specialist-blueprint-tool.test.ts`
- `src/main/modules/tools/builtins/propose-specialist-blueprint.ts`
- `scripts/check-specialist-professional-designer-contract.cjs`
- `scripts/__tests__/check-specialist-professional-designer-contract.test.cjs`

## Verification

```bash
npx tsx@^4.19.2 --test src/__tests__/agent-specialist-blueprint-clarification.test.ts src/__tests__/specialist-blueprint-quality.test.ts src/__tests__/propose-specialist-blueprint-tool.test.ts
npm run verify:specialist-blueprint
npm run typecheck
git diff --check
```
