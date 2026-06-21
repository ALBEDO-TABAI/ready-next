---
title: P6n · web research errorKind drift implementation
date: 2026-06-21
phase: P6n
enforce: true
depends:
  - outputs/agent-audit/fix-plan/365-CLAUDE-P6-REMAINING-AFTER-P6M-PROMPT.md
  - outputs/agent-audit/fix-plan/366-CLAUDE-P6-REMAINING-AFTER-P6M-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/367-CONSENSUS-P6N-WEB-RESEARCH-ERRORKIND-ROUTE.md
---

# P6n · Web Research ErrorKind Drift Implementation

## Goal

Centralize the two web research tool failure codes and prevent future local copies:

- `web_search_failed`
- `web_fetch_failed`

This is a C32 follow-up slice only. It does not close full C32 or P6.

## Scope

Change only:

- `src/main/modules/agent-control/contracts/error-kinds.ts`
- `src/main/modules/tools/builtins/web-search.ts`
- `src/main/modules/tools/builtins/web-fetch.ts`
- `src/main/modules/tools/tool-result-envelope.ts`
- `scripts/check-shared-enum-drift.cjs`
- `scripts/__tests__/check-shared-enum-drift.test.cjs`
- `src/__tests__/web-research-error-kinds.test.ts`
- `src/__tests__/tool-envelope-mapping.test.ts`
- `src/__tests__/web-search-tool.test.ts`
- `src/__tests__/web-fetch-tool.test.ts`
- `package.json`

Documentation and closeout files may be added under:

- `outputs/agent-audit/fix-plan/`

## Contract

### Shared Source

Add `WEB_RESEARCH_ERROR_KINDS` to `error-kinds.ts` with metadata for:

- `web_search_failed`
- `web_fetch_failed`

Wire it into:

- `ALL_REGISTERED_CODES`
- `lookupErrorKindMeta`

### Producer Usage

`web-search.ts` and `web-fetch.ts` must import the shared family from the real registry path and use `.code` values instead of local literals.

### Envelope Mapping

`tool-result-envelope.ts` must import `WEB_RESEARCH_ERROR_KINDS` and explicitly map both codes to `upstream_error`.

### Drift Gate

Extend `check-shared-enum-drift.cjs` to verify:

- the family exists and owns both required codes;
- both producers consume the shared family;
- producers do not copy bare literals;
- `tool-result-envelope.ts` consumes the shared family;
- both codes are explicitly mapped to `upstream_error`;
- wrong-path imports do not satisfy the import proof.

### Tests

Add or update tests so these cases fail before the production wiring and pass after:

- missing `WEB_RESEARCH_ERROR_KINDS` family;
- producer local literal copy;
- wrong import path fake-green;
- envelope local object-key copy;
- missing explicit `web_fetch_failed` mapping.

Add runtime proof that:

- both web research codes are registered;
- both map to `upstream_error`.

Add direct producer behavior proof that:

- dual-backend web search failure throws `WEB_RESEARCH_ERROR_KINDS.webSearchFailed.code`;
- dual-backend web fetch failure throws `WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code`.

## Verification

Required:

```bash
node scripts/check-shared-enum-drift.cjs
node --test scripts/__tests__/check-shared-enum-drift.test.cjs
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/web-research-error-kinds.test.ts src/__tests__/tool-envelope-mapping.test.ts
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/web-search-tool.test.ts src/__tests__/web-fetch-tool.test.ts
npm run verify:evolution-p6n
npm run typecheck
```

Because the shared drift gate is reused by previous P6 slices, also run:

```bash
npm run verify:evolution-p6h
npm run verify:evolution-p6i
npm run verify:evolution-p6k
npm run verify:evolution-p6l
npm run verify:evolution-p6m
```

## Explicit Exclusions

This slice does not cover:

- `clip_*` or content-study errorKinds;
- broad fallback errorKinds such as `host_unavailable`, `runtime_unavailable`, `aborted`, or `tool_failed`;
- child-runner / skill-runner close reason families;
- map/search-engine/file-emergence IPC errorKinds;
- C29 dormant `compressContext` cleanup;
- C30 move-only splitting;
- P2b OS isolation;
- browser identity isolation;
- P8 product/UI work;
- full C32 or full P6 closure.
