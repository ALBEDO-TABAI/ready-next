---
title: ChatGPT OAuth stream idle parity
status: implementation
enforce: false
date: 2026-08-30
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# ChatGPT OAuth Stream Idle Parity

## Root cause

The visible fallback after `继续第四部第五章` belongs to Ready run `req-1788090869362-vy1l1z`. The gateway admitted the only upstream request at `2026-08-30T11:54:29.916Z`; no `response_completed` exchange exists; Ready closed the native turn at `11:56:32` with `gateway_native_event_idle_timeout`. The terminal candidate contains no assistant item or final delta. Ready therefore did not discard a completed answer in this run: its two-minute gateway deadline ended a still-silent ChatGPT OAuth response and then published the generic failure receipt.

The same signature occurs in other installed failures, while adjacent turns on the same profile and thread succeed. The affected profile is the fixed `custom-chatgpt-oauth` Responses route using `gpt-5.6-sol` with high reasoning. The failed turn contains no automatic compaction exchange and remains below the effective context window. Context size increases time-to-first semantic output, but compaction and the Renderer do not own this failure.

Ready currently gives every provider a 120,000 ms semantic-event idle window. The current official Codex runtime uses a 300,000 ms default stream idle window for OpenAI/ChatGPT Responses and applies it while awaiting each SSE event. The installed ChatGPT Matrix runtime `0.151.0-alpha.7.1` exposes the same `stream_idle_timeout_ms` provider contract.

## Authority

- A validated Responses event resets semantic stream liveness.
- `response.completed`, `response.failed`, or `response.incomplete` owns the Provider terminal; transport EOF remains cleanup only.
- The fixed ChatGPT OAuth profile uses the ChatGPT/Codex stream idle contract of 300,000 ms.
- Other Ready-managed providers retain the existing 120,000 ms default unless they have their own provider contract.
- An explicit constructor timeout remains a test/runtime override and applies exactly as supplied.
- User stop, scope close, reset, gateway stop, and capability revocation still abort immediately.
- A truly silent ChatGPT stream still fails after five minutes. Provisional commentary is not promoted into a successful final answer.

## Machine-verifiable contracts

1. Timeout resolution is pure and identity-bound: only the exact fixed ChatGPT OAuth profile, loopback base URL, and Responses wire API receive 300,000 ms.
2. A generic Responses or Chat Completions provider keeps 120,000 ms.
3. An explicit positive override wins for every provider; non-positive configuration remains invalid.
4. The existing stream-reader behavior gate uses a short explicit timeout to prove that a late valid terminal completes exactly once and that silence still produces the provider-specific idle error.
5. The pure provider-identity gate fixes the production ChatGPT OAuth window at 300,000 ms; no retry or fallback provider is introduced.
6. A terminal already accepted is forwarded immediately and the upstream reader is cancelled without waiting for EOF.
7. Installed proof observes the real answer, successful product closeout, positive context usage, and restart rehydration. It does not pretend that a generic fixture is the fixed ChatGPT OAuth identity.

## Minimal implementation surface

- `codex-model-gateway.ts`: resolve the semantic idle window per frozen upstream profile and pass it to the existing native/chat stream readers.
- Gateway policy tests: prove exact profile matching, override behavior, the old 120-second boundary, and retained five-minute failure.
- Installed proof: verify the packaged gateway, product closeout, context meter, and restart rehydration in one isolated profile.

No context estimator, answer salvage path, blind retry, new provider setting, or second terminal state machine is added.
