---
title: P6r · Provider errorKind drift implementation
date: 2026-06-21
phase: P6r
enforce: false
depends:
  - outputs/agent-audit/fix-plan/406-CLAUDE-P6-REMAINING-AFTER-P6Q-PROMPT.md
  - outputs/agent-audit/fix-plan/407-CLAUDE-P6-REMAINING-AFTER-P6Q-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/408-CONSENSUS-P6R-PROVIDER-ERRORKIND-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6r · Provider ErrorKind Drift Implementation

## Goal

Close one narrow C32 follow-up: provider errorKind drift.

`PROVIDER_ERROR_KINDS` already exists. P6r makes provider production code consume it and extends the shared enum drift gate so these two provider codes cannot be copied locally:

- `provider_request_failed`
- `provider_thinking_echo_required`

This does not close full C32 or P6.

## Scope

Change only:

- `src/main/modules/claude-bridge/llm-resilience.ts`
- `src/main/modules/agent-control/domain-adapters/message-capability-filter.ts`
- `src/main/modules/agent-control/thinking-compatibility.ts`
- `src/main/modules/claude-bridge/error-contract.ts`
- `scripts/check-shared-enum-drift.cjs`
- `scripts/__tests__/check-shared-enum-drift.test.cjs`
- `scripts/check-ask-user-error-kinds-registered.cjs`
- `scripts/__tests__/check-ask-user-error-kinds-registered.test.cjs`
- focused provider tests if needed
- `package.json`

Documentation and closeout files may be added under:

- `outputs/agent-audit/fix-plan/`

## Contract

### Registry

`PROVIDER_ERROR_KINDS` remains the single source for:

- `providerRequestFailed.code`
- `providerThinkingEchoRequired.code`

### Producer / Consumer Usage

The targeted provider files must import `PROVIDER_ERROR_KINDS` from the real registry path and use `.code` instead of local string literals.

Targeted files:

- `src/main/modules/claude-bridge/llm-resilience.ts`
- `src/main/modules/agent-control/domain-adapters/message-capability-filter.ts`
- `src/main/modules/agent-control/thinking-compatibility.ts`
- `src/main/modules/claude-bridge/error-contract.ts`

### Drift Gate

Extend `check-shared-enum-drift.cjs` to verify:

- the provider family exists and owns both required codes;
- every targeted provider file imports the real registry;
- none of the targeted files copy the provider codes as bare literals or object keys.

Gate tests must include red cases for:

- provider codes missing from the family;
- wrong import path;
- local producer literal;
- local consumer set literal.

`check-ask-user-error-kinds-registered.cjs` must only accept codes owned by `ASK_USER_ERROR_KINDS`. Provider codes being registered under `PROVIDER_ERROR_KINDS` must not make them valid ask-user errorKinds.

Ask-user gate tests must prove:

- an `ASK_USER_ERROR_KINDS` code still passes;
- `provider_request_failed` fails when emitted from the ask-user surface;
- `provider_thinking_echo_required` fails when emitted from the ask-user surface.

### Behavior Tests

Focused tests must still prove:

- thinking echo classification returns `provider_thinking_echo_required`;
- repeated thinking echo failure surfaces `ToolDomainError(provider_request_failed)`;
- manual thinking-mode provider gate throws `provider_request_failed` before fetch;
- media capability mismatch throws `provider_request_failed`;
- provider request failures remain terminal in the agent error contract.

## Verification

Required:

```bash
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
node scripts/check-ask-user-error-kinds-registered.cjs
node --test scripts/__tests__/check-ask-user-error-kinds-registered.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/llm-error-retry.test.ts src/__tests__/provider-thinking-echo-gate.test.ts src/__tests__/message-capability-filter.test.ts src/__tests__/error-contract.test.ts
npm run verify:evolution-p6r
npm run typecheck
npm run verify:evolution-p6q
npm run verify:native
```

## Explicit Exclusions

This slice does not cover:

- provider retry algorithm changes;
- token / provider auth policy changes;
- map tool errorKind drift;
- clipping/content-study families;
- skill primitive families;
- child-runner close/error families;
- file-emergence / renderer IPC families;
- C29 DirectChat/TurnEngine retirement;
- C30 move-only splitting;
- C31 redaction expansion;
- P2b OS isolation;
- browser identity isolation;
- P8 product/UI work;
- full C32 or full P6 closure.
