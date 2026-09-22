---
title: P6e · SDK / TurnEngine capability parity admission precheck
date: 2026-06-20
phase: P6e
scope: C29 admission precheck before TurnEngine retirement and C30 splits
enforce: false
source:
  - outputs/agent-audit/fix-plan/284-CLAUDE-P6E-PARITY-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/285-SUBAGENT-P6E-PARITY-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/287-CLAUDE-P6E-PARITY-PLAN-REVISED.md
  - outputs/agent-audit/fix-plan/288-CONSENSUS-P6E-SDK-TURNENGINE-CAPABILITY-PARITY-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6e · SDK / TurnEngine Capability Parity Admission Precheck

## Goal

Add a machine-verifiable admission precheck before C29 retirement and C30 move-only splits.

The check proves that the live SDK capability-resolution shape and the TurnEngine/controller preparation path agree for representative turns. If they diverge, C29 retirement stops and the divergence becomes the next fix target.

## In Scope

- Add `src/__tests__/sdk-turnengine-capability-parity.test.ts`.
- Use public entries only:
  - `prepareInitialRun`;
  - `reconcileAfterBrowserDecision`;
  - `resolveCapabilityResolution`.
- Compare:
  - visible capability group ids;
  - suppressed capability group ids;
  - host-only capability group ids;
  - per-group status and reason;
  - `supportsVision`;
  - controller-side `toolPolicy.allowBrowserTools`;
  - controller-side `toolPolicy.allowDocumentTools`;
  - controller-side `preferredSkillToolNames`;
  - selected-skill vs no-skill behavior;
  - research intent;
  - browser upload / browser workflow / free-tool-loop cases;
  - document/widget arbitration demoting browser workflow.
- Add `verify:evolution-p6e`.
- Wire the test into `test:c:focus`, so it is reached by `verify:c`.
- Update `AGENTS.md` and `CLAUDE.md`.
- Update roadmap and closeout docs after implementation.

## Out Of Scope

- TurnEngine retirement.
- DirectChat `sendMessage` retirement.
- Dormant compaction deletion.
- C29 closure.
- C30 giant-file split.
- C31-b primitive-wide path redaction.
- Full errorKind taxonomy.
- P2b isolation.
- Browser identity isolation.
- Specialist-agent product work.
- Claiming `verify:c`, `verify:d`, `verify:l:gates`, or `verify:t` passed unless the command actually ran and passed.

## Test Shape

The test must avoid a shallow tautology.

For each representative case, build controller-side capability preparation through `prepareInitialRun` or `reconcileAfterBrowserDecision`, then compare its `capabilityResolution` with an SDK-shaped direct call to `resolveCapabilityResolution`.

The SDK-shaped call may only compare `CapabilityResolution`, because the SDK default-tools path calls `resolveCapabilityResolution` directly and does not produce a full `toolPolicy`. Controller-side `toolPolicy` expectations must be asserted separately.

Representative cases:

- free-tool-loop without browser intent;
- browser workflow;
- browser upload workflow;
- collection-style free-tool-loop exposure;
- selected skill vs no skill;
- research intent;
- vision-capable vs vision-denied config;
- document/widget arbitration that demotes browser workflow.

## Verification

Required:

- `npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/sdk-turnengine-capability-parity.test.ts`
- `npm run verify:evolution-p6e`
- `npm run typecheck`

Adjacent proof:

- `npm run verify:stability`
- `npm run verify:evolution-p4`
- `npm run verify:c`

If `verify:c` fails on the existing lint baseline before or after the new test, closeout must record that honestly and must not count `verify:c` as passed.

## Closeout Language

Allowed:

- P6e adds the SDK/TurnEngine capability parity admission precheck.
- The representative matrix proves `CapabilityResolution` parity for the compared cases.
- Controller-side tool-policy invariants are covered for those cases.
- This unblocks planning C29 retirement, but does not perform it.

Forbidden:

- TurnEngine retired.
- DirectChat `sendMessage` retired.
- Dormant compaction removed.
- C29 closed.
- C30 split done.
- C31-b closed.
- Full P6 complete.
- Broad verify chains passed without current evidence.
