---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# A0 W0 Lint Baseline Cleanup

> Snapshot command: `npm run lint:check` on 2026-04-30.
> Scope: clear the 23 current lint errors only. Warnings are intentionally left untouched.

## Summary

`lint:check` currently reports 23 errors and 527 warnings. All 23 errors are mechanical lint issues, not behavior changes.

## Classification

### Safe Mechanical Fixes

- `src/__tests__/phase-1-persistence-wiring.test.ts`: 2 `no-regex-spaces` errors in source-regex tests. Replace counted spaces with `{2}`.
- `src/__tests__/pipeline.widget-draft.cache-invalidation-on-failure.test.ts`: 1 `no-regex-spaces` error. Replace counted spaces with `{2}`.
- `src/__tests__/runtimeDriver-tool-event-log.test.ts`: 2 `no-useless-escape` errors. Remove unnecessary quote escapes in a generated regex string.
- `src/__tests__/skill-reference-output-contract.test.ts`: 1 `no-regex-spaces` and 1 `no-empty-object-type` error. Replace counted spaces with `{2}` and remove the empty-object cast.
- `src/__tests__/skill-session-cleanup-contract.test.ts`: 1 `no-regex-spaces` error. Replace counted spaces with `{2}`.
- `src/main/modules/agent-control/run-budget-policy.ts`: 6 `no-redeclare` errors caused by TypeScript overload signatures. Disable the base ESLint `no-redeclare` rule in TS config.
- `src/main/modules/agent-control/skill-detection-inputs.ts`: 1 `no-useless-escape` error. Remove unnecessary `[` escape in a character class.
- `src/main/modules/agent-control/tool-gateway.ts`: 1 `no-empty-object-type` error. Replace the empty extending interface with a type alias.
- `src/renderer/modules/agent/documentActions.ts`: 1 `no-empty` error. Make the intentional best-effort catch body explicit.
- `src/shared/document-graph-parse.ts`: 2 `no-irregular-whitespace` errors and 4 `no-useless-escape` errors. Replace literal zero-width characters with unicode escapes and remove unnecessary `[` escapes.

### Needs Review

- None.

### Historical Keep / Ignore

- None.

## Verification

- `npm run lint:check` must report 0 errors after W0.
