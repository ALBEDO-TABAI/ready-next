---
title: P6z SkillRunContract Declaration Island Implementation
date: 2026-06-21
phase: P6z
priority: P2
enforce: true
depends:
  - outputs/agent-audit/fix-plan/484-CONSENSUS-P6Z-SKILL-RUN-CONTRACT-ISLAND-ROUTE.md
---

# P6z SkillRunContract Declaration Island Implementation

## Goal

Close one narrow C30 follow-up: move the `SkillRunContract` declaration out of
`run-contracts.ts` into its own type-only contract island while preserving the
existing `run-contracts.ts` import surface.

This continues the P6s/P6u/P6v/P6y pattern. It is not a full `run-contracts.ts`
split and does not complete C30 or P6.

## Scope In

1. Add `src/main/modules/agent-control/contracts/skill-run-contract.ts`.
2. Move only the `SkillRunContract` interface and directly attached contract
   comments into that island.
3. Keep `run-contracts.ts` compatibility by re-exporting the type from
   `./skill-run-contract`.
4. Change `skill-run-contract-loader.ts` to import `SkillRunContract` from the
   new island instead of `./run-contracts`.
5. Update only directly stale comments that say the `SkillRunContract` shape
   lives in `run-contracts.ts`.
6. Add `scripts/check-run-contract-skill-contract-island.cjs`.
7. Add `scripts/__tests__/check-run-contract-skill-contract-island.test.cjs`.
8. Add `verify:evolution-p6z`, chained to `verify:evolution-p6y`.

## Scope Out

- Do not move `TaskProjectionRecord`, `TurnEngineHost`, `TurnEngineRequest`,
  `RunMessage`, `TurnEngineSession`, budget types, projection types, or turn
  response types.
- Do not edit broad consumer import paths.
- Do not delete `run-contracts.ts`.
- Do not perform C29 DirectChat/TurnEngine work.
- Do not perform C32 browser task status work.
- Do not include P2b isolation, browser identity/session work, or specialist
  product/UI work.

## Gate Requirements

`check-run-contract-skill-contract-island.cjs` must fail when:

- `run-contracts.ts` still defines `interface SkillRunContract`;
- `run-contracts.ts` does not type-re-export `SkillRunContract` from
  `./skill-run-contract`;
- `skill-run-contract.ts` is missing `export interface SkillRunContract`;
- `skill-run-contract.ts` imports `node:fs`, `fs`, `node:path`, or `path`;
- `skill-run-contract.ts` defines `loadSkillRunContract` or
  `buildContractFramePatch`;
- `skill-run-contract-loader.ts` still imports `SkillRunContract` from
  `./run-contracts`.

The gate self-test must include one passing temp fixture plus red fixtures for
the failure modes above.

## Verification

Run:

```bash
node scripts/check-run-contract-skill-contract-island.cjs
node --test scripts/__tests__/check-run-contract-skill-contract-island.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/skill-run-contract-shape.test.ts src/__tests__/skill-run-contract-continuation.test.ts src/__tests__/skill-child-run-end-to-end.test.ts src/__tests__/skill-child-run-migration.test.ts src/__tests__/turn-frame-patch.test.ts src/__tests__/frame-resolver-seed.test.ts
npm run verify:evolution-p6z
npm run typecheck
git diff --check
```

## Anti-Overclaim

P6z only extracts the `SkillRunContract` declaration island and adds an
anti-reflow gate. It does not complete C30/P6, does not close C29, and does not
touch C32 browser task status semantics.

## Stop Points

- If moving the type creates an import cycle, stop and reassess the island
  boundary.
- If any broad consumer import path must change, stop and preserve the
  `run-contracts.ts` re-export instead.
- If implementation needs to move anything beyond `SkillRunContract`, stop and
  reopen the plan.
- If `verify:evolution-p6z` does not chain through `verify:evolution-p6y`, stop
  and fix the chain before closeout.
