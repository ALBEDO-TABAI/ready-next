---
title: P6 Final F3 Primitive Model-Visible Path Redaction Implementation
date: 2026-06-21
branch: agent-evolution/phase1
enforce: true
source:
  - outputs/agent-audit/fix-plan/501-P6-FINAL-REMAINING-FIXED-LIST.md
  - outputs/agent-audit/fix-plan/519-CODEX-P6F3-PLAN-REVIEW.md
---

# P6 Final F3 Primitive Model-Visible Path Redaction Implementation

## Goal

Close the fixed P6-F3 item by proving that real primitive-produced path fields
are redacted only in model-visible copies while raw runtime handles remain
unchanged.

## Scope

In:

- cover canonical static roots such as macOS `/private/var/...` when the public
  tmp root is `/var/...`;
- prove real `skill_write_artifact`, `skill_read_artifact`, and
  `skill_inspect_run_state` outputs redact their model-visible path copies;
- prove raw `absolutePath`, `artifactRoot`, `outputDir`, `runStatePath`,
  `framePatch.activeArtifactRoots`, and `contextModifier` roots remain raw;
- add a narrow gate for model-visible primitive path redaction;
- add `verify:evolution-p6-f3`.

Out:

- no UI/log/DB/artifact redaction;
- no OS sandbox or P2b isolation;
- no primitive permission, root resolution, or filesystem behavior change;
- no new P6 slice beyond P6-F3/F4;
- no full C31/P6 claim.

## Implementation Steps

1. Extend static-root redaction to also redact the canonical `realpath` variant
   of a known static root.
2. Add real primitive behavior tests in `tool-result-types.test.ts`.
3. Add `check-model-visible-primitive-path-redaction.cjs` and self-tests.
4. Add `verify:evolution-p6-f3`.
5. Update the fixed queue and roadmap after implementation review.

## Acceptance

- Real write/read artifact model-visible payloads do not include raw
  `absolutePath` or `artifactRoot`.
- Real inspect-run-state model-visible payloads do not include raw `outputDir`
  or `runStatePath`.
- Raw output data, `framePatch`, and `contextModifier` keep original paths.
- `contextModifier` is not serialized into the model-visible payload.
- Canonical static root support is protected by the new gate.
- `npm run verify:evolution-p6-f3` passes.

## Anti-Overclaim

This closes only P6-F3. It does not close global path redaction, full C31,
full P6, P2b shell isolation, browser identity isolation, or specialist-agent
product work.
