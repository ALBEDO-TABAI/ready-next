---
title: P3a Browser Abort / Policy Signal Implementation
date: 2026-06-20
branch: agent-evolution/phase1
status: complete
enforce: true
source:
  - outputs/agent-audit/fix-plan/P3-browser-tool-signal.md
  - outputs/agent-audit/final/02-CODEX-INDEPENDENT-CANONICAL-FINDINGS.md
  - outputs/agent-audit/fix-plan/198-CLAUDE-P3A-ABORT-POLICY-PLAN.md
  - outputs/agent-audit/fix-plan/199-CLAUDE-P3A-IMPLEMENTATION-REVIEW.md
  - outputs/agent-audit/fix-plan/200-P3A-BROWSER-ABORT-POLICY-CLOSEOUT.md
---

# P3a Browser Abort / Policy Signal Implementation

## Scope

P3a closes only C10 and C11:

- C10: browser tool aborts must rethrow `AbortError` so the run loop/finalizer owns cancellation.
- C11: policy denials must use top-level `errorKind` values instead of being nested under `host_unavailable`.

This plan does not include P3b/C09 browser failure structuring, P3c/C08 browser script templates, browser identity isolation, UI locking, or specialist-agent product work.

## Contract

1. `executeBrowserTool` must rethrow browser abort errors before any `ToolDomainError` handling or string-flattening path.
2. Policy denials must emit top-level `internal_tool_not_allowed` or `tool_restricted_this_turn`.
3. Policy denials must not be encoded as `errorKind: 'host_unavailable'` plus a policy `reason`.
4. `host_unavailable` remains valid only for real host/infrastructure missing cases and must still map to `upstream_error`.
5. P3a gates must be wired into `verify:evolution-p1`.

## Files

- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/tools/tool-executor.ts`
- `src/main/modules/agent-control/tools-runtime/tool-runtime.ts`
- `src/__tests__/browser-abort-signal.test.ts`
- `src/__tests__/tool-envelope-pilot.test.ts`
- `scripts/check-browser-abort-rethrow.cjs`
- `scripts/check-policy-deny-errorkind.cjs`
- `package.json`

## Acceptance

- `node scripts/check-browser-abort-rethrow.cjs`
- `node scripts/check-policy-deny-errorkind.cjs`
- `node scripts/check-tool-error-shape.cjs`
- `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/browser-abort-signal.test.ts src/__tests__/tool-envelope-pilot.test.ts src/__tests__/abort-initiator-threading.test.ts`
- `npm run verify:evolution-p1`
- `npm run typecheck`
- `git diff --check` on tracked touched files

## Status

Complete. See `outputs/agent-audit/fix-plan/200-P3A-BROWSER-ABORT-POLICY-CLOSEOUT.md`.
