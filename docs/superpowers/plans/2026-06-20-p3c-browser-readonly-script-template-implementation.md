---
title: P3c Browser Read-Only Script Template Implementation
date: 2026-06-20
branch: agent-evolution/phase1
status: complete
enforce: true
source:
  - outputs/agent-audit/fix-plan/P3-browser-tool-signal.md
  - outputs/agent-audit/final/02-CODEX-INDEPENDENT-CANONICAL-FINDINGS.md
  - outputs/agent-audit/fix-plan/201-CLAUDE-P3C-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/202-CONSENSUS-P3C-READONLY-SCRIPT-TEMPLATE-ROUTE.md
  - outputs/agent-audit/fix-plan/203-CLAUDE-P3C-IMPLEMENTATION-REVIEW.md
  - outputs/agent-audit/fix-plan/204-P3C-READONLY-SCRIPT-TEMPLATE-CLOSEOUT.md
---

# P3c Browser Read-Only Script Template Implementation

## Scope

P3c closes C08: ordinary-site browser script-like tools must not run model-authored freeform JavaScript. Only code-owned named read-only templates are allowed.

## Contract

1. `highControlScriptGuard` remains first and unchanged.
2. Ordinary-site script-like inputs must pass through `resolveScriptReadOnlyVerdict` before lease acquisition or controller execution.
3. Freeform script fields are rejected with structured `freeform_script_denied`.
4. Named templates compile into fixed code-side read-only JavaScript.
5. Content extraction template paths without custom script continue to work.
6. P3c behavior tests and no-freeform gate are wired into `verify:evolution-p1`.

## Files

- `src/main/modules/tools/browser-readonly-script-templates.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/browser-engine/agent-browser-errors.ts`
- `src/main/modules/tools/tool-result-envelope.ts`
- `src/main/modules/tools/schemas/browser-content-schemas.ts`
- `src/main/modules/tools/schemas/browser-interaction-schemas.ts`
- `src/__tests__/browser-script-m1-net.test.ts`
- `src/__tests__/browser-high-control-guard.test.ts`
- `src/__tests__/tool-envelope-mapping.test.ts`
- `scripts/check-browser-script-no-freeform-passthrough.cjs`
- `package.json`
- `AGENTS.md`
- `CLAUDE.md`

## Acceptance

- Red tests fail before implementation.
- `node scripts/check-browser-script-no-freeform-passthrough.cjs`
- P3 focused tests:
  - `browser-script-m1-net.test.ts`
  - `browser-high-control-guard.test.ts`
  - `browser-tool-failure-envelope.test.ts`
  - `browser-abort-signal.test.ts`
  - `tool-envelope-pilot.test.ts`
  - `tool-envelope-mapping.test.ts`
  - `abort-initiator-threading.test.ts`
- P3 gates:
  - `check-browser-abort-rethrow.cjs`
  - `check-policy-deny-errorkind.cjs`
  - `check-browser-tool-no-json-failure.cjs`
  - `check-browser-script-no-freeform-passthrough.cjs`
- `npm run typecheck`
- `npm run verify:evolution-p1`
- `git diff --check` on touched files

## Status

Complete. See `outputs/agent-audit/fix-plan/204-P3C-READONLY-SCRIPT-TEMPLATE-CLOSEOUT.md`.
