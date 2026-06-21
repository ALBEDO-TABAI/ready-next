---
title: P6t · C29 DirectChat Legacy Send Excision Implementation
date: 2026-06-21
phase: P6t
enforce: true
depends:
  - outputs/agent-audit/fix-plan/427-CLAUDE-P6-REMAINING-AFTER-P6S-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/428-SUBAGENT-P6T-ROUTE-SELECTION-REVIEW.md
  - outputs/agent-audit/fix-plan/429-CONSENSUS-P6T-C29-DIRECTCHAT-SEND-EXCISION-ROUTE.md
---

# P6t · C29 DirectChat Legacy Send Excision Implementation

## Goal

Remove the remaining callable legacy `DirectChatEngine.sendMessage` entry.

This closes one narrow C29 slice: DirectChat is no longer a hidden dormant turn executor. The only live send entry remains `AgentSdkRuntime.sendMessage`.

## Scope

Allowed changes:

- remove `DirectChatEngine.sendMessage`, `private readonly turnEngine`, `new TurnEngine()`, and `this.turnEngine.execute(...)` from `direct-chat.ts`;
- keep `DirectChatEngine` as the domain adapter / skill context / provider host shell;
- update the DirectChat / TurnEngine boundary gate so it forbids the removed entry from returning;
- update gate self-tests and stale contract tests;
- update the message-capability gate to stop requiring DirectChat current-turn intake;
- add `verify:evolution-p6t`;
- update closeout, no-output, and roadmap docs.

## Required Gate Behavior

`check-directchat-turnengine-dormant-boundary.cjs` must pass on the new shell and fail on:

- `TurnEngine` import from `direct-chat.ts`;
- `TurnEngine` dynamic import from `direct-chat.ts`;
- `turnEngine` member declaration;
- `this.turnEngine` reference;
- `DirectChatEngine.sendMessage` method or async property;
- `new TurnEngine()` in DirectChat;
- any production re-entry into non-SDK `.sendMessage(...)`.

## Required Tests

`verify:evolution-p6t` must include:

- DirectChat / TurnEngine boundary gate;
- boundary gate self-tests;
- message-capability gate;
- `turn-engine-contract.test.ts`;
- `agent-runtime-host-contract.test.ts`;
- `agent-event-single-source-runtime-only.test.ts`;
- `agent-sdk-runtime.test.ts`.

## Verification

Required commands:

```bash
npm run verify:evolution-p6t
npm run typecheck
npm run verify:evolution-p6f
npm run verify:evolution-p6j
git diff --check
```

## Explicit Exclusions

This slice does not:

- delete `TurnEngine`;
- delete `DirectChatEngine`;
- remove provider clients;
- remove domain adapters;
- rewrite compaction;
- split `run-contracts.ts`;
- touch C32 errorKind families;
- touch C31 redaction;
- implement P2b shell isolation;
- implement browser identity/profile/session isolation;
- implement specialist-agent product/UI work;
- close full C29 or full P6.
