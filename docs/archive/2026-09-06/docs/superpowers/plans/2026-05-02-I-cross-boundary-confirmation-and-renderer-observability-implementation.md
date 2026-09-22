---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# I — Cross-boundary Confirmation and Renderer Observability Implementation

> W0 is complete in `2026-05-02-I-cross-boundary-confirmation-and-renderer-observability-pre-flight-audit-report.md`.
> This implementation follows the corrected current-main facts and splits I into I1/I2.

## Summary

- I1 lands the send confirmation contract, agent friendly error mapping, and renderer metric channel.
- I2 lands renderer silent-catch scanning and baseline freeze.
- `verify:i1` must embed `verify:h`; final `verify:i` must embed `verify:i1`.

## ESCALATE Handling

| Trigger | Action |
| --- | --- |
| W0 evidence drift >30% | Correct documents before code. Done in W0. |
| renderer silent catch N0 >80 | Split I1/I2. Triggered with N0 `82`. |
| broad friendly error false positives >30% | I1 only covers agent-send surfaces; other products are follow-up. |
| main cannot prove send persistence | Stop; do not patch renderer-only retry. |

## I1 Land Order

### W1 — Main Send Confirmation Contract

Files: `runtime.ts`, IPC/preload/types, focused tests.

- Extend `agent:sendScoped` payload with an optional `userMessage` bundle.
- Persist the user message in main before starting the run.
- Return `persistence.scope`, `persistence.message`, `persistence.attachments`, `persistence.inputAttachments`, and `errorKind`.
- Do not run the agent when user message persistence fails.

### W2 — Renderer Send Gate

Files: `useAgent.ts`, `messageComposer.ts`, store tests.

- Build composed input with attachment diagnostics.
- Stop sending when attachment input fails.
- Send user-message metadata through `sendScoped`; stop using renderer-side `chat:saveMessage` for the user message.
- On persistence failure, surface friendly UI and restore pending attachments.

### W3 — Friendly Agent Error Mapping

Files: agent renderer module, soft failure capsule, runtime driver.

- Add a simple mapping function, not a registry/i18n/plugin system.
- Apply it to send failure, terminal `agent:error`, and soft failure capsule.
- Keep technical details out of chat message body.

### W4 — Renderer Metric Channel

Files: shared metric names, preload/types, IPC handler, renderer helper, gate script.

- Add fixed renderer metric names only.
- Emit metrics for send persistence failure, attachment input failure, friendly error display, and assistant persistence failure.
- Gate main handler + preload API + renderer dogfood emit points.

### W5 — I1 Docs and Gate

- Add `test:i1:gates`, `test:i1:focus`, and `verify:i1`.
- Record I1 Final Record after verification.

## I2 Land Order

### W6 — Renderer Silent-catch Baseline

- Add `src/renderer` to `check-silent-catch.cjs`.
- Freeze current renderer silent catches in the existing baseline.
- Update checker tests so a renderer silent catch fails without baseline/comment/log/metric/throw.

### W7 — Final I Gate and Docs

- Add final `verify:i`.
- Record final HEAD, `verify:i` result, N0/N_FINAL, and break coverage.

## Test Plan

- `send-scoped-confirmation` covers scope lazy-create, user message persistence failure, attachment metadata/input states, and non-unknown errorKind.
- renderer tests cover no raw send error display, no send after attachment input failure, and friendly mapping use.
- mapping tests cover scope missing, attachment missing, host unavailable/circuit break, message persistence failure, and fallback.
- gate tests cover renderer metric wiring and renderer error friendliness.
- final verification: `npm run verify:i`.

## Final Record

- Verification branch: `codex/i-cross-boundary-confirmation`
- Verification base HEAD: `4b315a4f0a9ecf07f8d3c3e11145859d776a85f3`
- `verify:i` output: pass on 2026-05-02 after `npm rebuild better-sqlite3` restored the Node test ABI.
- Renderer silent catch baseline: `N0=82`, `N_FINAL=81`, total baseline entries `279`.
- Break coverage:
  - main send confirmation: scope lazy-create, user-message persistence before run, persistence failure stops run, attachment metadata/input status split.
  - renderer send gate: attachment input failure stops send and preserves attachments/input; send persistence failure shows friendly copy and preserves input.
  - friendly error mapping: scope missing, attachment unavailable, host/circuit unavailable, message persistence failure, unknown fallback.
  - renderer metrics: send persistence failure, attachment input failure, friendly error display, assistant persistence failure.
  - I2 gate: `check-silent-catch.cjs` scans `src/renderer/` and rejects new renderer silent catches unless logged, thrown, metriced, commented, or baselined.
