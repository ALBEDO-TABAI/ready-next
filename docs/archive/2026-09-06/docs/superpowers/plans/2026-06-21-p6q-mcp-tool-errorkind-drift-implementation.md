---
title: P6q · MCP tool errorKind drift implementation
date: 2026-06-21
phase: P6q
enforce: false
depends:
  - outputs/agent-audit/fix-plan/400-CLAUDE-P6-REMAINING-AFTER-P6P-PROMPT.md
  - outputs/agent-audit/fix-plan/401-CLAUDE-P6-REMAINING-AFTER-P6P-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/402-CONSENSUS-P6Q-MCP-TOOL-ERRORKIND-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6q · MCP Tool ErrorKind Drift Implementation

## Goal

Centralize Ready-owned MCP tool dispatcher failure codes and prevent future local copies:

- `mcp_tool_unregistered`
- `mcp_authorization_denied`
- `mcp_client_missing`
- `mcp_tool_failed`

This is a narrow C32 follow-up only. It does not close full C32 or P6.

## Scope

Change only:

- `src/main/modules/agent-control/contracts/error-kinds.ts`
- `src/main/modules/tools/mcp-tools.ts`
- `src/main/modules/tools/tool-result-envelope.ts`
- `scripts/check-shared-enum-drift.cjs`
- `scripts/__tests__/check-shared-enum-drift.test.cjs`
- `src/__tests__/mcp-tool-error-kinds.test.ts`
- `src/__tests__/tool-envelope-mapping.test.ts`
- `package.json`

Documentation and closeout files may be added under:

- `outputs/agent-audit/fix-plan/`

## Contract

### Shared Source

Add `MCP_TOOL_ERROR_KINDS` to `error-kinds.ts` with metadata for:

- `mcp_tool_unregistered`
- `mcp_authorization_denied`
- `mcp_client_missing`
- `mcp_tool_failed`

Wire it into:

- `ALL_REGISTERED_CODES`
- `lookupErrorKindMeta()`

### Producer Usage

`mcp-tools.ts` must import the shared family from the real registry path and use `.code` values instead of local literals for Ready-owned dispatcher failures.

External MCP server dynamic `result.error.kind` values are not owned by this slice and must not be globally rewritten here.

### Envelope Mapping

`tool-result-envelope.ts` must import `MCP_TOOL_ERROR_KINDS` and explicitly map:

- `toolUnregistered` -> `not_found`
- `authorizationDenied` -> `denied_by_policy`
- `clientMissing` -> `upstream_error`
- `toolFailed` -> `upstream_error`

`authorizationDenied` is deliberately policy/consent scoped here. If token-expired needs separate UX later, split a more specific MCP auth errorKind.

### Drift Gate

Extend `check-shared-enum-drift.cjs` to verify:

- the family exists and owns all four required codes;
- `mcp-tools.ts` consumes the shared family;
- `tool-result-envelope.ts` consumes the shared family;
- neither file copies the codes as bare literals or object keys;
- all four codes have explicit envelope mappings;
- wrong-path imports do not satisfy the import proof.

### Tests

Add or update tests so these fake-green cases fail:

- MCP family missing or renamed to the wrong family;
- producer imports from a fake registry path;
- producer keeps a local literal copy;
- envelope keeps a local object-key copy;
- envelope omits the explicit `mcp_authorization_denied` mapping.

Add runtime proof that:

- all four MCP codes are registered;
- all four MCP codes map explicitly to the intended action-oriented envelope kind.
- `executeMcpTool` emits the shared Ready-owned codes for unregistered, unauthorized, missing-client, thrown-client-error, and non-ok-without-kind paths.
- `executeMcpTool` preserves external MCP server dynamic `result.error.kind` values.

## Verification

Required:

```bash
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/mcp-tool-error-kinds.test.ts src/__tests__/tool-envelope-mapping.test.ts src/__tests__/mcp-tools-authorization.test.ts
npm run verify:evolution-p6q
npm run typecheck
```

Because the shared drift gate is reused by previous P6 slices, also run:

```bash
npm run verify:evolution-p6h
npm run verify:evolution-p6i
npm run verify:evolution-p6k
npm run verify:evolution-p6l
npm run verify:evolution-p6m
npm run verify:evolution-p6n
npm run verify:native
```

## Explicit Exclusions

This slice does not cover:

- MCP OAuth/consent architecture changes;
- token-expired vs scope-consent-missing split;
- external MCP server dynamic `result.error.kind` values;
- clip/content-study/search/map/file-emergence errorKinds;
- child-runner / skill-runner close reason families;
- broad fallback errorKinds such as `host_unavailable`, `runtime_unavailable`, `aborted`, or `tool_failed`;
- C29 DirectChat/TurnEngine retirement;
- C30 move-only splitting;
- C31 redaction expansion;
- P2b OS isolation;
- browser identity isolation;
- P8 product/UI work;
- full C32 or full P6 closure.
