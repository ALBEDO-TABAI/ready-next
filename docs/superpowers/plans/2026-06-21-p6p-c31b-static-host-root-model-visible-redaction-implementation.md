---
title: P6p C31-b Static Host Root Model-Visible Redaction
date: 2026-06-21
phase: P6p
scope: C31-b residual static host-root display redaction
enforce: true
source:
  - outputs/agent-audit/fix-plan/386-CLAUDE-P6-REMAINING-AFTER-P6O-PROMPT.md
  - outputs/agent-audit/fix-plan/387-CLAUDE-P6P-C31B-RESIDUAL-PLAN.md
  - outputs/agent-audit/fix-plan/388-CODEX-P6P-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/391-SUBAGENT-P6P-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/393-CLAUDE-P6P-C31B-STATIC-HOST-ROOT-PLAN-FINAL.md
---

# P6p · C31-b Static Host Root Model-Visible Redaction

## Completion Standard

P6p is complete only when all of these are true:

1. Model-visible tool output redacts static non-home host roots:
   - `os.tmpdir()` shaped paths;
   - `process.resourcesPath` when present;
   - existing home/UserProfile roots remain covered.
2. Raw tool output, frame patches, context modifiers, run state, and durable handles remain unchanged.
3. The `read_skill` fallback in `SkillContextOrchestrator` redacts its model-visible `tool_result` chunk and session-message injection.
4. A narrow funnel gate prevents known model-visible tool-result files from using raw `serializeToolExecutionOutput`.
5. P6p is not described as full P6, full C31-b, C29-later, C30, C32-later, P2b, browser identity, or specialist-agent product completion.

## Source Scope

- `src/main/modules/tools/skill-primitives/host-path-redactor.ts`
- `src/main/modules/agent-control/skills/skill-context-orchestrator.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/__tests__/tool-result-types.test.ts`
- `src/__tests__/skill-reference-output-contract.test.ts`
- `scripts/check-model-visible-tool-output-funnel.cjs`
- `scripts/__tests__/check-model-visible-tool-output-funnel.test.cjs`
- `package.json`

## Red-Before Proof

Before implementation:

- `tool-result-types.test.ts` must fail when asserting a tmp-root `outputDir` / `runStatePath` is redacted in the model-visible copy.
- `skill-reference-output-contract.test.ts` must fail when asserting fallback `read_skill` model-visible output and session-message injection are redacted.
- `check-model-visible-tool-output-funnel.cjs` must fail on the current `skill-context-orchestrator.ts` fallback and the dead raw serializer import in `direct-chat.ts`.

## Implementation

1. Extend `redactHostPaths` with literal-root redaction for `os.tmpdir()` and `process.resourcesPath`.
2. In the `SkillContextOrchestrator` fallback path, create one `redactModelVisibleToolText(result.text)` copy and use it for:
   - `params.emitOutput(..., 'tool_result')`;
   - `extractSkillReferenceContent(...)`;
   - fallback truncation accounting.
3. Remove the unused raw `serializeToolExecutionOutput` import from `direct-chat.ts`.
4. Add the allowlist-scoped funnel gate and self-tests.
5. Add `verify:evolution-p6p`, and add the gate to `verify:t`.

## Green-After Commands

- `node scripts/check-model-visible-tool-output-funnel.cjs`
- `node --test scripts/__tests__/check-model-visible-tool-output-funnel.test.cjs`
- `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/tool-result-types.test.ts src/__tests__/skill-reference-output-contract.test.ts src/__tests__/skill-reference-inline-injection.test.ts`
- `node scripts/check-shell-output-host-path-redacted.cjs`
- `npm run verify:evolution-p6p`
- `npm run verify:evolution-p6f`
- `npm run verify:evolution-p6o`
- `npm run typecheck`

## Non-Scope

- Arbitrary active artifact roots outside home/tmp/resources remain deferred.
- No runtime-context threading.
- No raw-output mutation.
- No full C31-b claim.
- No full P6 claim.
- No C29-later, C30, C32-later, P2b, browser identity, or specialist-agent product work.
