---
title: P6 Final F2 Tool Telemetry Island Implementation
date: 2026-06-21
branch: agent-evolution/phase1
enforce: true
source:
  - outputs/agent-audit/fix-plan/501-P6-FINAL-REMAINING-FIXED-LIST.md
  - outputs/agent-audit/fix-plan/512-CODEX-P6F2-PLAN-REVIEW.md
---

# P6 Final F2 Tool Telemetry Island Implementation

## Goal

Extract only the tool telemetry leaf contracts from
`src/main/modules/agent-control/contracts/run-contracts.ts` into a small
type-only island.

## Scope

In:

- create
  `src/main/modules/agent-control/contracts/tool-telemetry-contracts.ts`;
- move only `RecoveryRecord` and `ToolSnapshot` into that file;
- keep type-only compatibility re-exports from `run-contracts.ts`;
- import telemetry types directly from the new island in
  `turn-response-contracts.ts`;
- add `check-run-contract-tool-telemetry-island.cjs` and its red tests;
- add `verify:evolution-p6-f2`.

Out:

- no `TaskInteractionState` move;
- no broad `run-contracts.ts` cleanup;
- no runtime behavior change;
- no DirectChat, browser, primitive redaction, or final P6 audit work.

## Implementation Steps

1. Add the telemetry island and move the two interfaces.
2. Re-export those interfaces from `run-contracts.ts` with `export type`.
3. Update the visible back-edge in `turn-response-contracts.ts`.
4. Update the runtime contract test so it proves the new island and compatibility
   re-export.
5. Add the anti-reflow gate and self-tests.
6. Add the focused verify script.

## Acceptance

- `run-contracts.ts` does not define `RecoveryRecord` or `ToolSnapshot`.
- `tool-telemetry-contracts.ts` exports both names and imports only the shared
  `CapabilityGroupId` type.
- `turn-response-contracts.ts` does not import either telemetry name from
  `./run-contracts`.
- the new gate rejects:
  - either telemetry type defined in `run-contracts.ts`;
  - missing or value compatibility re-exports;
  - missing island exports;
  - `node:fs`, `fs`, `node:path`, or `path` imports in the island;
  - island imports from `./run-contracts`;
  - wrong-island moves such as `TaskInteractionState`;
  - direct, multiline, or aliased telemetry imports from `./run-contracts` in
    `turn-response-contracts.ts`.
- `npm run verify:evolution-p6-f2` passes.

## Anti-Overclaim

This closes only P6-F2. It does not close all C30 debt, does not redact paths,
does not finish P6, and does not authorize new P6 alphabetic slices.
