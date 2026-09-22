---
title: P6k Tool Admission ErrorKind Drift Implementation
date: 2026-06-21
branch: agent-evolution/phase1
enforce: false
source:
  - outputs/agent-audit/fix-plan/338-CONSENSUS-P6K-TOOL-ADMISSION-ERRORKIND-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6k Tool Admission ErrorKind Drift Implementation

## Completion Standard

P6k is complete only when:

1. `TOOL_ADMISSION_ERROR_KINDS` exists in `error-kinds.ts` and is part of `isRegisteredErrorKind` / `lookupErrorKindMeta`.
2. The five in-scope admission/control signals are consumed from that shared family in the live target files.
3. The shared-enum drift gate fails on copied local P6k literals and passes on the real codebase.
4. Existing behavior remains unchanged for registration, authorization, internal visibility, turn allowlist, user negation, and envelope mapping.
5. `verify:evolution-p6k` exists and passes.
6. Closeout and roadmap docs make clear this is only a narrow C32 slice.

## In Scope

Shared family:

- `tool_not_registered`
- `authorization_denied`
- `internal_tool_not_allowed`
- `tool_restricted_this_turn`
- `denied_by_user_negation`

Files:

- `src/main/modules/agent-control/contracts/error-kinds.ts`
- `src/main/modules/tools/tool-executor.ts`
- `src/main/modules/agent-control/tools-runtime/tool-runtime.ts`
- `src/main/modules/agent-control/tools-runtime/tool-registry.ts`
- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
- `src/main/modules/tools/tool-result-envelope.ts`
- `scripts/check-shared-enum-drift.cjs`
- `scripts/check-policy-deny-errorkind.cjs`
- `scripts/__tests__/check-shared-enum-drift.test.cjs`
- focused admission/envelope tests
- `package.json`

## Out Of Scope

- `denied_pending_confirmation` and the wider confirmation-card family.
- `host_unavailable`, `runtime_unavailable`, `aborted`, `tool_failed`.
- Map/general-research domain-local `tool_not_registered` emitters.
- Full C32 taxonomy.
- C29 retirement, C30 splitting, P2b isolation, browser identity isolation.

## Implementation Steps

1. Add P6k gate/harness red cases.
   - Verify: `node --test scripts/__tests__/check-shared-enum-drift.test.cjs` must fail before production wiring.
2. Add `TOOL_ADMISSION_ERROR_KINDS` and registry lookup coverage.
   - Verify: missing registration red case passes.
3. Replace in-scope production literals with shared constants.
   - Verify: shared-enum gate passes.
4. Update source-shape gates/tests that currently expect raw literals.
   - Verify: `check-policy-deny-errorkind.cjs`, `tool-executor-contract.test.ts`, and `tool-executor-authorization.test.ts` continue to protect behavior without requiring copied literals.
5. Preserve behavior and envelope mapping.
   - Verify focused tests for tool error shape, authorization, negation, and envelope mapping.
6. Add `verify:evolution-p6k`.
   - Verify the new script passes.
7. Close out docs.
   - Verify roadmap/current-order/gate index/no-output ledger updates are internally consistent.

## Required Verification

Minimum:

```bash
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
node scripts/check-tool-error-shape.cjs
node scripts/check-policy-deny-errorkind.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/tool-error-shape-mutual-exclusivity.test.ts src/__tests__/tool-executor-authorization.test.ts src/__tests__/tool-executor-contract.test.ts src/__tests__/negation-intent.test.ts src/__tests__/tool-envelope-mapping.test.ts src/__tests__/tool-envelope-pilot.test.ts
npm run verify:evolution-p6k
npm run typecheck
git diff --check --
```

Also rerun the prior C32 gate chain when practical:

```bash
npm run verify:evolution-p6d
npm run verify:evolution-p6h
npm run verify:evolution-p6i
```
