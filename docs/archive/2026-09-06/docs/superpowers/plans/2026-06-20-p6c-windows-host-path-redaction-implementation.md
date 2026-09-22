---
title: P6c Windows host-path redaction implementation
date: 2026-06-20
phase: P6c
scope: C31-a
enforce: false
source:
  - outputs/agent-audit/fix-plan/267-CLAUDE-P6C-MICRO-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/268-SUBAGENT-P6C-PLAN-REVIEW.md
  - outputs/agent-audit/fix-plan/269-CONSENSUS-P6C-WINDOWS-HOST-PATH-REDACTION-ROUTE.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P6c Windows Host-Path Redaction Implementation

## Goal

Close C31-a only: `skill_run_shell` output redaction must cover Windows host path shapes in addition to the existing macOS/Linux shapes.

## Completion Standard

P6c is complete only when:

- `redactHostPaths()` redacts:
  - `C:\Users\<name>\...`
  - drive-letter case variants;
  - `%USERPROFILE%\...`;
  - runtime `process.env.USERPROFILE` values when present.
- Existing `/Users/<name>`, `/home/<name>`, and `process.env.HOME` behavior does not regress.
- Plain relative backslash paths that are not user-home paths remain unchanged.
- `check-shell-output-host-path-redacted.cjs` additively requires Windows redaction support and still requires the existing three redaction call sites.
- C31-b is explicitly recorded as deferred/unresolved in the Windows handoff document.

## Files

- `src/main/modules/tools/skill-primitives/host-path-redactor.ts`
- `src/__tests__/shell-output-host-path-redacted.test.ts`
- `scripts/check-shell-output-host-path-redacted.cjs`
- `docs/archive/2026-09-06/docs/superpowers/plans/2026-06-16-windows-sync-handoff.md`

## Out Of Scope

- C31-b primitive-wide absolute-path redaction implementation.
- P2b OS/container shell isolation.
- C32 shared enum drift gate.
- TurnEngine / DirectChat retirement.
- C30 giant-file split.
- Browser identity isolation.
- Specialist agent product work.
- Full-repo lint cleanup or `verify:d` unblock.

## Implementation Notes

- Keep the redactor as a pure string transform.
- Add Windows patterns without weakening the current HOME, `/Users/`, and `/home/` behavior.
- Prefer extending the existing redaction behavior test over creating a second single-purpose file.
- Do not claim Windows runtime behavior is verified; this slice proves string redaction behavior on macOS.

## Verification

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/shell-output-host-path-redacted.test.ts
node scripts/check-shell-output-host-path-redacted.cjs
npm run typecheck
npm run verify:t
git diff --check -- \
  src/main/modules/tools/skill-primitives/host-path-redactor.ts \
  src/__tests__/shell-output-host-path-redacted.test.ts \
  scripts/check-shell-output-host-path-redacted.cjs \
  docs/archive/2026-09-06/docs/superpowers/plans/2026-06-16-windows-sync-handoff.md
```

If `verify:t` fails because of unrelated pre-existing upstream gates, record the exact blocker and do not count `verify:t` as passed.
