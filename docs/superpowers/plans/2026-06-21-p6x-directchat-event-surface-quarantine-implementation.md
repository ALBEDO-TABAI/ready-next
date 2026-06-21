---
title: P6x DirectChat Event Surface Quarantine Implementation
date: 2026-06-21
phase: P6x
priority: P2
enforce: true
depends:
  - docs/superpowers/plans/2026-06-21-p6t-directchat-legacy-send-excision-implementation.md
  - outputs/agent-audit/fix-plan/463-CONSENSUS-P6X-DIRECTCHAT-EVENT-SURFACE-QUARANTINE.md
---

# P6x DirectChat Event Surface Quarantine Implementation

## Goal

Close one narrow C29 follow-up: `DirectChatEngine` must no longer be a
renderer-facing event producer shape.

The DirectChat shell can continue hosting domain adapters, provider clients,
and skill-context dependencies, but output/tool-action events for live runs must
flow through SDK runtime request emitters.

## Scope In

1. Remove `EventEmitter` inheritance from `DirectChatEngine`.
2. Remove DirectChat-local `this.emit('output'|'status'|'error'|'toolAction')`
   event producer capability.
3. Keep document deterministic flow streaming by passing live request emitters
   from `DocumentDomainAdapter` into `DocumentDomainOrchestrator` method calls.
4. Narrow `ReadyAgentOrchestrator.bindEngineEvents` to `AgentSdkRuntime`.
5. Extend `check-directchat-turnengine-dormant-boundary.cjs` and its self-tests
   to fail if DirectChat regains EventEmitter inheritance or direct emit calls.
6. Add `verify:evolution-p6x`.

## Scope Out

- No full DirectChat deletion.
- No full TurnEngine deletion.
- No removal of DirectChat provider/domain/skill-context shell helpers.
- No C30 `run-contracts.ts` island work.
- No C32 browser task status single-source work.
- No browser identity/session/profile isolation.
- No P2b shell isolation.
- No P8 specialist-agent product work.

## Implementation Steps

1. Add a small emitter override type to `DocumentDomainOrchestrator` method
   params and make flow emissions use the passed emitter when present.
2. In `DocumentDomainAdapter`, pass `params.request.emitters.emitOutput` and
   `params.request.emitters.emitToolAction` into deterministic document flows.
3. Remove DirectChat `EventEmitter` import/extension and direct `this.emit`
   callbacks.
4. Narrow `ReadyAgentOrchestrator.bindEngineEvents` from
   `DirectChatEngine | AgentSdkRuntime` to `AgentSdkRuntime`.
5. Extend the DirectChat boundary gate and self-tests.
6. Add `verify:evolution-p6x`.

## Verification

Required green proof:

```bash
node scripts/check-directchat-turnengine-dormant-boundary.cjs
node --test scripts/__tests__/check-directchat-turnengine-dormant-boundary.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/agent-event-single-source-runtime-only.test.ts src/__tests__/document-domain-orchestrator.test.ts
npm run verify:evolution-p6x
npm run typecheck
git diff --check
```

## Anti-Overclaim

This slice closes only the DirectChat event-producer surface. It does not close
full C29, full P6, TurnEngine retirement, DirectChat shell retirement, C30,
C32, C31, P2b, browser identity isolation, or installed-app interruption
continuity by itself.
