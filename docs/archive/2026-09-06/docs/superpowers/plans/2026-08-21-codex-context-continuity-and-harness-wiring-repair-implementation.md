---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Codex context continuity and harness wiring repair

Date: 2026-08-21
Status: accepted

## Assumptions

- A Ready conversation alias represents one continuing Codex conversation until an explicit reset, close, incompatible runtime change, or actual model-visible tool-surface change retires it.
- MCP resources, templates, server metadata, and catalog generation are turn inputs. They are not part of the model-visible dynamic tool identity unless the emitted tool name, description, schema, or execution contract changes.
- A dynamic tool's ordinary failed result belongs to that tool call. It must not terminate the App Server connection. Protocol identity drift, unknown side effects, and response-delivery ambiguity remain fail-closed.
- An App Server interruption is not evidence that the user stopped the turn. Ready may present a user cancellation only when a durable user lifecycle action owns the interrupt.

## Completion contract

1. A second ingress into the same Ready alias resumes the existing native thread when its actual dynamic tool surface is unchanged.
2. Non-tool MCP catalog changes do not retire the native thread; a real model-visible MCP tool definition change does.
3. A valid `skill_ask_user` follow-up can bind, reach the renderer, and return to the same native turn without closing the sidecar.
4. Expected tool failures return `success: false` to Codex and leave the connection available for the model's next step. Protocol and effect-identity failures still close the connection with their specific reason preserved.
5. A runtime-caused interruption is reported as a failure, not as a user stop, unless a durable stop/close/reset action exists.
6. Runtime 0.149.0 request, notification, thread resume, tool response, terminal, history, and MCP surfaces have an explicit handled-or-rejected audit and no silent fallthrough.
7. MCP paginated catalogs are read completely, ambiguous canonical names fail before publication, and catalog refreshes are serialized.
8. RSS terminal-report requests have a bounded wait below the host deadline and return a durable running/paused state instead of timing out ambiguously.

## Verification

- Repository tests reproduce unchanged-surface continuation and real-surface retirement.
- App Server and tool-bridge tests reproduce ordinary tool failure, protocol failure, response delivery, and named close reason behavior.
- A two-turn deterministic App Server scenario proves the second turn sees first-turn context without a paid provider call.
- `verify:codex-runtime-source`, the affected E2/E4 gates, `verify:native`, typecheck, and build pass.
- A packaged/installed Ready proof repeats the deterministic two-turn scenario and records app identity plus result readback.

## Scope boundary

- Preserve all unrelated dirty worktree changes.
- Change only the identity comparison, tool-request error boundary, terminal attribution, the directly exposed MCP catalog and RSS terminal-wait gaps found in the requested upgrade audit, their focused tests, and the affected current runtime contract.
- Do not introduce a compatibility path for the erroneous composite digest and do not mutate existing user data merely to make the test pass.

## Implemented repair

- Native thread identity now hashes only the tool definitions that the model can actually call. MCP resources, templates, metadata, and catalog generation remain turn-scoped facts and no longer split a continuing conversation.
- Candidate and selected skill primitives now feed the same frozen surface into both model admission and execution authorization, including `skill_ask_user`.
- Controlled bridge failures preserve their exact close reason. An unowned native interruption is a runtime failure unless a durable user stop action proves otherwise.
- MCP catalog refresh reads every page, rejects repeated cursors and ambiguous canonical tool names before publication, and serializes overlapping refreshes.
- RSS report reads wait within a bounded job deadline and return durable running or paused state; the Renderer no longer invents a fresh completion time. Pet settings report success only after the pet window has actually applied them.

## Acceptance evidence

- Focused behavior tests: 168 passed; one SQLite ABI case was intentionally skipped there and then covered by the native gate.
- `npm run typecheck`, `verify:codex-runtime-source`, `verify:codex-runtime-e2`, `verify:codex-runtime-e4`, `verify:codex-runtime-e6`, `verify:streaming`, `verify:stability`, and `verify:native` passed.
- The release build, Packer tests, version gate, DMG verification, signature check, empty-seed/slim-package checks, and packaged launch smoke passed.
- Installed two-turn proof: `outputs/codex-context-continuity-installed/a048b2356752b460b276fed3e9a04c4b4b9261e62d6b3447c3c7f46031d1cc56/4faa50d4e5fed6a92ef0e134dab30bc8/installed-proof.json` reports `INSTALLED_CONTEXT_CONTINUITY_PASS`. It records one Ready scope, one non-retired native thread generation, and two distinct completed turns; the second provider request contains the first-turn user and assistant context.
- Candidate package: `Packer/output/Ready-context-continuity-20260821.dmg`, 335701573 bytes, SHA-256 `a048b2356752b460b276fed3e9a04c4b4b9261e62d6b3447c3c7f46031d1cc56`.
- No paid provider call was made. The deterministic provider fixture exercised the real packaged Ready -> Codex App Server -> Ready provider bridge without external spend.
