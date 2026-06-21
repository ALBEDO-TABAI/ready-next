---
title: P6f · DirectChat/TurnEngine dormant execution boundary
date: 2026-06-21
phase: P6f
priority: P2
depends: P6e SDK/TurnEngine capability parity admission precheck
covers: [C29]
enforce: true
source:
  - outputs/agent-audit/fix-plan/298-CONSENSUS-P6F-DIRECTCHAT-TURNENGINE-DORMANT-BOUNDARY-ROUTE.md
---

# P6f · DirectChat/TurnEngine Dormant Execution Boundary

## Goal

Make the current live/dormant execution boundary machine-checkable:

- live production turns execute through `AgentSdkRuntime.sendMessage`;
- `DirectChatEngine.sendMessage` and `TurnEngine.execute` remain present but dormant;
- `DirectChatEngine` may still provide domain adapters, skill context, dependency wiring, session reset, and stop-generation bridging.

## Non-Goals

- Do not delete `TurnEngine`.
- Do not delete `DirectChatEngine.sendMessage`.
- Do not clean dormant compaction calls.
- Do not split C30 giant files.
- Do not implement C31-b primitive path redaction.
- Do not expand C32 taxonomy.
- Do not touch P2b, browser identity isolation, or specialist-agent product work.

## Implementation

1. Add `scripts/check-directchat-turnengine-dormant-boundary.cjs`.
   - Assert `ReadyAgentOrchestrator` calls `this.sdkEngine.sendMessage(...)`.
   - Reject `this.domainAdapterEngine.sendMessage(...)`.
   - Reject any production `src/main` `.sendMessage(...)` call except the SDK runtime call.
   - Reject production static or runtime dynamic imports of the `TurnEngine` class outside `direct-chat.ts`.
   - Reject production `TurnEngine.execute(...)` re-entry through direct variables, `this.turnEngine`, aliases, namespaces, runtime dynamic imports, type-only imports, inline import types, and type aliases.
   - Reject production `DirectChatEngine.sendMessage(...)` re-entry through runtime imports, aliases, namespaces, type-only imports, inline import types, and type aliases.
   - Keep DirectChat dependency/session methods allowed.
2. Add `scripts/__tests__/check-directchat-turnengine-dormant-boundary.test.cjs`.
   - Prove the gate accepts the current allowed boundary.
   - Prove it fails if orchestrator calls `domainAdapterEngine.sendMessage`.
   - Prove it fails across static, dynamic, alias, namespace, type-only, inline type, and non-SDK `sendMessage` bypass shapes.
3. Update `orchestrator.ts` and `agent-event-single-source-runtime-only.test.ts` wording.
   - Claim only "no production turn execution / no renderer event emission from DirectChat".
   - Do not call DirectChat read-only/provider-only.
4. Wire verification.
   - Add `verify:evolution-p6f`.
   - Add the new gate/self-test to `verify:d`.
   - Update `AGENTS.md` and `CLAUDE.md` with the P6f regression entry.

## Verification

Run:

```bash
node scripts/check-directchat-turnengine-dormant-boundary.cjs
node --test scripts/__tests__/check-directchat-turnengine-dormant-boundary.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/agent-event-single-source-runtime-only.test.ts
npm run verify:evolution-p6e
node scripts/check-dormant-compaction-not-in-live-path.cjs
npm run verify:evolution-p6f
npm run typecheck
npm run test:c:focus
npm run verify:stability
```

If full `verify:c` / `verify:d` remains blocked by the existing lint baseline, record that honestly in closeout.

## Completion Standard

P6f is complete only when:

- the new dormant-boundary gate and self-test pass;
- the runtime single-event-producer test passes;
- P6e parity and dormant compaction safety net still pass;
- no production code path can call `DirectChatEngine.sendMessage` or `TurnEngine.execute`;
- production `src/main` has no `.sendMessage(...)` call except `this.sdkEngine.sendMessage(...)`;
- closeout states that C29 is still not fully retired and C31-b/C30/C32 remain open.
