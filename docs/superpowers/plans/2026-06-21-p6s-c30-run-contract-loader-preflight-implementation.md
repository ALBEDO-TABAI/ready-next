---
title: P6s · C30 run-contract loader preflight implementation
date: 2026-06-21
phase: P6s
enforce: true
depends:
  - outputs/agent-audit/fix-plan/418-CLAUDE-P6S-OPUS-DYNAMIC-WORKFLOW-PROMPT.md
  - outputs/agent-audit/fix-plan/419-CLAUDE-P6S-OPUS-DYNAMIC-WORKFLOW-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/420-SUBAGENT-P6S-ROUTE-SELECTION-REVIEW.md
  - outputs/agent-audit/fix-plan/421-CONSENSUS-P6S-C30-RUN-CONTRACT-LOADER-ROUTE.md
---

# P6s · C30 Run-Contract Loader Preflight Implementation

## Goal

Close one narrow C30 preflight: extract the `SkillRunContract` loader island from `run-contracts.ts` without behavior changes.

This proves the giant-file split can be guarded by a real contract before broader C30 work begins.

## Scope

Change only:

- `src/main/modules/agent-control/contracts/run-contracts.ts`
- `src/main/modules/agent-control/contracts/skill-run-contract-loader.ts`
- `scripts/check-run-contract-loader-island.cjs`
- `scripts/__tests__/check-run-contract-loader-island.test.cjs`
- `package.json`
- focused docs / closeout under `outputs/agent-audit/fix-plan/`

## Contract

### Loader Ownership

`skill-run-contract-loader.ts` owns:

- `LoadSkillRunContractParams`
- `loadSkillRunContract`
- `buildContractFramePatch`
- loader-only helper functions
- `node:fs` / `node:path` imports needed to read `run_state.json`

### Public Compatibility

`run-contracts.ts` keeps the public import path stable by re-exporting:

- `LoadSkillRunContractParams`
- `loadSkillRunContract`
- `buildContractFramePatch`

Existing tests and call sites must continue importing from `run-contracts.ts`.

### Gate

`check-run-contract-loader-island.cjs` must enforce:

- `run-contracts.ts` has no `node:fs` or `node:path` imports;
- `run-contracts.ts` does not directly define `loadSkillRunContract` or `buildContractFramePatch`;
- `run-contracts.ts` re-exports the loader API from `./skill-run-contract-loader`;
- `skill-run-contract-loader.ts` exports the loader API;
- `skill-run-contract-loader.ts` owns the `node:fs` and `node:path` imports.

Gate self-tests must include old-shape and missing-re-export failures.

## Behavior Tests

Focused tests must prove:

- `loadSkillRunContract` still returns a contract from supervisor snapshot + output handles;
- no-handle input still returns null;
- `buildContractFramePatch` still produces `runContract`, `activeArtifactRoots`, and `livenessHint`;
- child-run exact identity lookup still binds to the intended row.

## Verification

Required:

```bash
node scripts/check-run-contract-loader-island.cjs
node --test scripts/__tests__/check-run-contract-loader-island.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-run-contract-shape.test.ts src/__tests__/skill-child-run-end-to-end.test.ts
npm run verify:evolution-p6s
npm run typecheck
git diff --check
```

## Explicit Exclusions

This slice does not cover:

- moving `SkillRunContract`;
- deleting or broadly splitting `run-contracts.ts`;
- extracting `agent-sdk-runtime.ts`, `browser-tools.ts`, `turn-engine.ts`, or `skill-child-runner.ts`;
- changing child-run, task projection, or frame patch behavior;
- C29 dormant runtime retirement;
- C31 redaction;
- C32 errorKind families;
- P2b shell isolation;
- browser identity/profile/session isolation;
- specialist-agent product/UI work;
- full C30 or full P6 closure.
