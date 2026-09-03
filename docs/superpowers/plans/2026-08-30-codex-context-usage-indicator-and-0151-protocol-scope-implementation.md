---
title: Codex context usage indicator and 0.151 protocol scope
status: implementation
enforce: true
date: 2026-08-30
---

# Codex Context Usage Indicator and 0.151 Protocol Scope

## Current finding

The Renderer already has a context usage model and meter, but the Codex production path cannot populate it. Runtime 0.149.0 emits `thread/tokenUsage/updated` with the exact thread, turn, last request usage, cumulative thread usage, and effective model context window. Ready currently classifies that notification as passive and drops it. Two downstream gaps compound the loss: the common finalizer did not pass the candidate snapshot into canonical closeout, and an idle lifecycle refresh deleted an exact latest terminal Renderer state before the meter could retain it. Codex product closeout therefore persisted zero usage, while the live meter and restart path could both become empty.

This is not a token-counting or compaction problem. The missing boundary is the native notification projection and durable product receipt.

## Authority

- The native app-server owns thread and turn identity plus `thread/tokenUsage/updated`.
- `tokenUsage.last.inputTokens` owns the latest model request's effective input size shown by the meter.
- `tokenUsage.modelContextWindow` owns the effective window when present.
- `tokenUsage.total` is cumulative runtime telemetry. Ready validates it for ordering but does not reinterpret its opaque `totalTokens` field as per-turn billing; Renderer never computes billing or token counts.
- Ready owns the exact run/scope binding, durable terminal candidate, product receipt, and current-scope projection.
- OpenAI Responses usage remains the upstream semantic reference: a completed response reports input/output/total token usage, while compaction is opaque continuation state and must not be inspected to invent usage.

## Machine-verifiable contracts

1. The 0.149.0 and audited 0.151.0 schemas for `ThreadTokenUsageUpdatedNotification`, `ThreadTokenUsage`, and `TokenUsageBreakdown` are byte-for-byte semantically equal.
2. Ready accepts the notification only when thread ID, turn ID, every usage integer, totals, cached/reasoning bounds, and optional context window are valid.
3. A usage notification is routed only to the exact bound native thread and turn. It cannot establish a provisional turn identity by itself or leak across scope, generation, run, or epoch. Late telemetry from a settled turn is consumed without claiming or quarantining the next provisional turn; provisional telemetry is retained only after another native event or start response has established the same turn ID.
4. The live scope event publishes the latest positive `last.inputTokens` and effective window. A zero-input tail cannot erase the previous positive snapshot.
5. A later valid request may report a lower input size after compaction; timestamp/turn identity, not a monotonic token assumption, decides freshness.
6. Multiple model requests in one native turn update the meter to the latest positive request. The runtime may emit a zero-input or stale terminal usage frame after a failed request, so Ready does not invent a per-turn aggregate from cumulative totals.
7. Terminal candidate persistence contains the final attributable context snapshot. Canonical closeout writes its effective window to `context_window` in the same transaction; existing run usage columns remain untouched unless a separate exact owner supplies them.
8. Product turn receipt v2 carries `contextUsage`; Renderer applies the same receipt during live completion and conversation rehydration.
9. Starting a new run preserves the previous snapshot until that exact run reports a new positive request. Reset/close continues to clear the scope through the existing lifecycle boundary.
10. An idle lifecycle refresh preserves a non-busy terminal state only when its request ID equals the durable latest run ID; running or stale identities are still cleared.
11. The packaged panel harness serializes context usage from the same visible run mirror consumed by ChatPanel, so installed proof measures the user-visible state rather than a separate test-only projection.
12. No text-length estimate, tokenizer replay, `/responses/input_tokens` call, extra provider request, retry, fallback, or second context state machine is introduced.

## Minimal implementation surface

- `codex-native-runtime.ts`: validate and project the existing native notification.
- `codex-provisional-inbound-buffer.ts`: treat usage as identity-bound telemetry, not an action-bearing frame, and keep late settled-turn telemetry from claiming the next provisional owner.
- `codex-turn-collector.ts`: own the latest attributable live snapshot without converting cumulative telemetry into billing.
- `codex-task-activity-projector.ts`: publish the snapshot through the existing scope event.
- `codex-runtime-production-composition.ts`, the common run finalizer, and canonical closeout: carry one candidate-owned snapshot into durable run facts and terminal execution.
- `codex-product-turn-presentation.ts`, shared IPC contract, and Renderer receipt reducer: expose and rehydrate product receipt v2.
- Renderer lifecycle hydration preserves only the exact latest terminal snapshot, while existing meter remains the only UI consumer; no second indicator component is added.
- Installed proof distinguishes first- and second-turn usage, verifies the immediate meter, session reactivation, full process-tree restart rehydration, durable window rows, and explicit retry lineage.

## Runtime 0.149.0 to 0.151.0 protocol scope

The context usage structures do not change, so this repair stays on 0.149.0.

Schema comparison against the audited official 0.151.0 arm64 binary:

- Stable schema: 150 definitions added, 36 changed, 0 removed; 64 method literals added, 0 removed. Most of this is experimental 0.149 surface becoming stable.
- Full experimental schema used for compatibility review: 38 definitions added, 27 changed, 0 removed; 8 method literals added, 0 removed.
- New experimental method families: MCP event streaming, realtime item lifecycle/transcript, thread timeline listing, and turn settings update.
- Changed structures relevant to Ready include thread/turn start and resume parameters, turn errors, thread items, response items, MCP status, browser/computer requirements, hooks, and collaboration-agent tool status.

An actual runtime upgrade is a separate migration and must update as one source-bound set:

1. Official signed binary, SHA, licenses, runtime manifest, and source lock.
2. Stable/experimental combined and v2 schemas plus generated file inventory.
3. Native protocol captures for ordinary turns, tools, automatic/manual compaction, restart/resume, errors, and resource context.
4. Request validators for changed thread/turn start and resume shapes.
5. Notification allow/passive/opt-out registries for the eight new methods and changed error/item variants.
6. App-server client routing, provisional buffering, terminal collection, and diagnostics parsing where schemas changed.
7. Focused protocol gates, real app-server E2E, compaction/restart proof, structural package receipt, and isolated installed proof.

No new 0.151 capability is enabled merely because it appears in schema. Each product surface remains closed until Ready ownership, authorization, budget, persistence, and closeout contracts exist.
