---
title: Codex provider terminal continuity repair
status: implementation
enforce: false
date: 2026-08-30
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Codex Provider Terminal Continuity Repair

## Problem

Ready currently validates a Provider terminal event, then waits for the HTTP body to reach EOF before forwarding that terminal to Codex. A valid upstream that keeps the transport open therefore turns an already completed response into `gateway_native_post_terminal_timeout` or `gateway_chat_post_terminal_timeout`.

Installed evidence shows the model's complete final answer in the Codex rollout before Ready publishes a failed product turn. Neither failing thread contains a compaction item, and both remain below the runtime context window. The visible multi-turn symptom is therefore a Provider terminal ownership bug, not a compaction algorithm failure.

## Authority

- Provider Responses SSE owns response completion through `response.completed`, `response.failed`, or `response.incomplete`.
- Chat Completions streaming owns completion through `[DONE]` after a valid finish reason and usage payload.
- Transport EOF is cleanup evidence only. It cannot override an accepted protocol terminal.
- Codex app-server continues to own native thread/turn completion after the gateway forwards the Provider terminal.

## Machine-verifiable contracts

1. A native Responses stream that emits a valid terminal and remains open produces exactly one matching terminal downstream and no post-terminal timeout.
2. A Chat Completions stream that emits valid finish/usage data plus `[DONE]` and remains open produces exactly one `response.completed` downstream and no post-terminal timeout.
3. The gateway cancels its upstream reader after the protocol terminal instead of waiting for EOF.
4. Events already present after a terminal in the same parsed batch remain invalid; pre-terminal UTF-8, identity, schema, byte, item, structural-event, and idle failures remain fail-closed.
5. Tool admission and durable response evidence complete before a successful terminal is forwarded.
6. Installed long-conversation acceptance proves the answer remains visible and the product turn closes successfully when the upstream transport stays open after terminal.

## Minimal change

- Remove the post-terminal EOF deadline from the native and Chat gateway lanes.
- Stop reading and cancel the upstream body after the validated protocol terminal.
- Keep the existing Provider event registry, item ownership, size limits, idle deadline, tool admission, evidence receipt, Codex collector, lifecycle adapter, and canonical closeout.
- Do not add a retry, fallback, second terminal state machine, or compaction workaround.

## Harness decision

The bundled runtime remains an independent versioned dependency. Runtime 0.151.0 may be adopted only after its binary, schemas, manifests, source locks, captures, diagnostics, compaction/restart checks, and installed proof all pass. The terminal repair must pass on its own and must not depend on that upgrade.

## Verification

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/codex-provider-stream-policy.test.ts \
  src/__tests__/codex-model-gateway-adversarial.test.ts
npm run verify:streaming
npm run verify:codex-runtime-source
npm run typecheck
```

Package acceptance must additionally exercise a long native thread across the automatic-compaction threshold and a deliberately open-after-terminal upstream fixture.
