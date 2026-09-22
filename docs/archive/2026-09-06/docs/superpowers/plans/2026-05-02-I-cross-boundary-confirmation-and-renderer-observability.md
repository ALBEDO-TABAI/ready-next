---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# I — Cross-boundary Confirmation and Renderer Observability

> Date: 2026-05-02
> Status: implemented and verified
> Paired implementation plan: `2026-05-02-I-cross-boundary-confirmation-and-renderer-observability-implementation.md`
> Pre-flight audit: `2026-05-02-I-cross-boundary-confirmation-and-renderer-observability-pre-flight-audit-report.md`

## Decision

I is split into I1 and I2.

- I1 closes the send confirmation contract, agent-send friendly errors, and renderer metric channel.
- I2 freezes the renderer silent-catch baseline and extends the H gate to `src/renderer/`.

## Corrected Scope

- `sendScoped` owns persistence confirmation for ordinary agent sends.
- Renderer no longer assumes a send is durable before main confirms scope and user-message persistence.
- Attachments are confirmed as user-message metadata plus model-input inclusion, not independent attachment rows.
- `requestId` stays a run correlation id and is not part of the persistence contract.
- Assistant-message persistence failure is observed and reported through renderer metrics.

## Out of Scope

- runtime chaos harness
- soak tests
- log rotation
- global renderer error copy cleanup
- new registry/coordinator/plugin/i18n systems

## Final Record

- Verification branch: `codex/i-cross-boundary-confirmation`
- Verification base HEAD: `4b315a4f0a9ecf07f8d3c3e11145859d776a85f3`
- Final verification: `npm run verify:i` passed.
- Renderer silent catch baseline: `N0=82`, `N_FINAL=81`, total baseline entries `279`.
- Note: `audits/` was already untracked and is not part of this I-stage change.
