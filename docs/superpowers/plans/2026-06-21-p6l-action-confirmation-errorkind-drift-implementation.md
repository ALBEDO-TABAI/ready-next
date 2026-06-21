---
title: P6l Action-Confirmation ErrorKind Drift Implementation
date: 2026-06-21
branch: agent-evolution/phase1
enforce: true
source:
  - outputs/agent-audit/fix-plan/349-CONSENSUS-P6L-ACTION-CONFIRMATION-ERRORKIND-ROUTE.md
---

# P6l Action-Confirmation ErrorKind Drift Implementation

## Completion Standard

P6l is complete only when:

1. The four action-confirmation errorKinds have one shared source in `ACTION_CONFIRMATION_ERROR_KINDS`.
2. `isRegisteredErrorKind()` and `lookupErrorKindMeta()` recognize all four codes.
3. `tool-executor.ts`, `browser-tools.ts`, and `tool-result-envelope.ts` consume shared constants instead of copied literals.
4. The shared-enum drift gate fails on P6l copied literals and passes on the real codebase after wiring.
5. Behavior tests prove confirmation policy, frozen-call release, live-target guard, and envelope mapping did not change.
6. `verify:evolution-p6l` exists and passes.
7. Closeout/no-output/roadmap documents state this is only a narrow C32 follow-up.

## In Scope

Codes:

- `denied_manual_only`
- `denied_pending_confirmation`
- `confirmation_denied_by_user`
- `confirmation_expired`

Files:

- `src/main/modules/agent-control/contracts/error-kinds.ts`
- `src/main/modules/tools/tool-executor.ts`
- `src/main/modules/tools/browser-tools.ts`
- `src/main/modules/tools/tool-result-envelope.ts`
- `scripts/check-shared-enum-drift.cjs`
- `scripts/__tests__/check-shared-enum-drift.test.cjs`
- `src/__tests__/action-confirmation-error-kinds.test.ts`
- `package.json`

## Out Of Scope

- any other errorKind family;
- C29 later work;
- C30 file splitting;
- C31-b primitive-wide redaction;
- P2b isolation;
- browser identity isolation;
- P8 product work;
- mandatory `AGENTS.md` / `CLAUDE.md` changes unless a hard user-visible rule changes.

## Implementation Steps

1. Add gate/harness red cases.
   - Verify: `node scripts/check-shared-enum-drift.cjs` fails on the current copied literals.
   - Verify: `node --test scripts/__tests__/check-shared-enum-drift.test.cjs` fails only on the real-codebase pass while new fixture cases pass.
2. Add `ACTION_CONFIRMATION_ERROR_KINDS` and runtime helper registration.
   - Verify: `src/__tests__/action-confirmation-error-kinds.test.ts` fails before helper registration and passes after registration.
3. Replace in-scope production literals with constants.
   - Verify: shared-enum gate passes.
4. Preserve behavior.
   - Verify focused action-confirmation and envelope tests pass.
5. Add `verify:evolution-p6l`.
   - Verify the new script passes.
6. Close out docs.
   - Verify no-output refresh records `345` excluded and `348` counted.
   - Verify roadmap sync covers source/revision, refresh paragraph, §0, §1, §2, §3, §4, and §5.

## Required Red Fixtures

`scripts/__tests__/check-shared-enum-drift.test.cjs` must include fixture coverage for:

- missing `ACTION_CONFIRMATION_ERROR_KINDS` or missing one of the four codes;
- `tool-executor.ts` positional literal, e.g. `deniedOutput('confirmation_expired', ...)`;
- `browser-tools.ts` positional `new ToolDomainError('denied_manual_only', ...)`;
- browser password reroute `'denied_pending_confirmation'`;
- `tool-result-envelope.ts` bare object map key such as `{ denied_manual_only: 'denied_by_policy' }`;
- target files missing `ACTION_CONFIRMATION_ERROR_KINDS` usage/import.

## Required Verification

Minimum green proof:

```bash
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/action-confirmation-error-kinds.test.ts \
  src/__tests__/action-confirmation-policy.test.ts \
  src/__tests__/frozen-call-release.test.ts \
  src/__tests__/action-confirmation-live-target.test.ts \
  src/__tests__/tool-envelope-mapping.test.ts \
  src/__tests__/tool-envelope-pilot.test.ts
npm run verify:evolution-p6l
npm run typecheck
git diff --check --
```

Broader regression checks when practical:

```bash
node scripts/check-tool-error-shape.cjs
node scripts/check-policy-deny-errorkind.cjs
npm run verify:evolution-p6d
npm run verify:evolution-p6h
npm run verify:evolution-p6i
npm run verify:evolution-p6k
npm run verify:native
```
