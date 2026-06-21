---
title: P6-F1 DirectChat Host Callback Excision Implementation
date: 2026-06-21
phase: P6-F1
priority: P2
depends: P6ab final queue freeze
covers: [C29]
enforce: true
source:
  - outputs/agent-audit/fix-plan/501-P6-FINAL-REMAINING-FIXED-LIST.md
  - outputs/agent-audit/fix-plan/505-CONSENSUS-P6F1-DIRECTCHAT-HOST-CALLBACK-EXCISION.md
---

# P6-F1 DirectChat Host Callback Excision

## Completion Standard

DirectChat no longer owns the legacy TurnEngine execution-host callback shell,
and a gate prevents that ownership from returning.

This means `src/main/modules/claude-bridge/direct-chat.ts` must not import,
construct, store, call, or declare:

- `ExecutionLoopOrchestrator`;
- `HostCapabilityDispatcher`;
- `requestSimpleText`;
- `requestToolLoopResponse`.

## Implementation Scope

Edit only the narrow DirectChat ownership seam:

1. Remove stale DirectChat imports, fields, constructor assignments, and private
   methods for the four legacy host pieces above.
2. Remove `VideoFallbackService` from DirectChat if it becomes unused by step 1.
3. Invert `agent-runtime-host-contract.test.ts` so DirectChat must not own those
   pieces while TurnEngine may still use the dormant/test host contract.
4. Extend `check-directchat-turnengine-dormant-boundary.cjs` with DirectChat-only
   guards for imports, dynamic imports, construction, member declarations, method
   declarations, arrow/computed/constructor-assigned method forms, and legacy
   callback calls.
5. Extend the gate self-test fixtures to prove those guards fail red.
6. Add `agent-runtime-host-contract.test.ts` to `verify:evolution-p6f`.

## Explicit Exclusions

Do not:

- delete TurnEngine;
- delete DirectChat;
- edit `TurnEngineHost` / `run-contracts.ts` for this slice;
- edit `turn-engine.ts` behavior;
- edit `AgentSdkRuntime`;
- rewrite DomainAdapters;
- touch P6-F2/F3/F4, C30 type islands, C31 path redaction, or C32 drift work;
- claim full C29 or full P6 closure.

## Verification

Focused proof:

```bash
node scripts/check-directchat-turnengine-dormant-boundary.cjs
node --test scripts/__tests__/check-directchat-turnengine-dormant-boundary.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/agent-runtime-host-contract.test.ts
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/runtimeDriver-tool-event-log.test.ts
```

Batch proof:

```bash
npm run verify:evolution-p6f
npm run typecheck
git diff --check
```
