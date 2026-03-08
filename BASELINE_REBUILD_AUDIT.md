# Baseline Rebuild Audit

## Summary
- Source of truth: `/Users/user/Documents/ready`
- Branch for rebuild work: `codex/baseline-rebuild-20260307`
- The snapshot repository is currently functionally complete enough to serve as the rebuild baseline.
- The earlier sliced integration approach was wrong for this repo because the product is strongly coupled across browser, agent runtime, renderer shell, document tooling, skills runtime, RSS, and sidecar support.

## Validation
- `npm run typecheck`: passed
- `npm test`: passed
- `npm run build`: passed

## What This Means
- The snapshot is not "dirty and broken". It is "dirty and integrated".
- Baseline rebuild must preserve the full integrated product first, then clean structure around it.
- No further feature slicing should happen until the repository has a clean full-product baseline checkpoint.

## High-Confidence Preserve Set
- `src/main/modules/browser-engine`
- `src/main/modules/agent-control`
- `src/main/modules/claude-bridge`
- `src/main/modules/tools`
- `src/main/modules/database.ts` and `src/main/modules/migrations.ts`
- `src/main/modules/document-engine`
- `src/main/modules/rss-engine`
- `src/main/modules/settings-engine`
- `src/main/modules/skills-runtime`
- `src/main/modules/video-engine`
- `src/main/modules/design-engine`
- `src/preload`
- `src/renderer/components/layout`
- `src/renderer/components/ready`
- `src/renderer/components/browser`
- `src/renderer/components/document`
- `src/renderer/components/calendar`
- `src/renderer/components/rss`
- `src/renderer/components/settings`
- `src/renderer/components/creative`
- `src/renderer/components/design`
- `src/renderer/pages`
- `src/renderer/stores`
- `src/renderer/utils`
- `src/shared`
- `src/python/ready_sidecar`
- `assets/embedded-skills`

## Current Baseline Risks
- Nested Git/worktree content still exists at `.claude/worktrees/design-module`; this keeps the repo from being truly clean and needs a dedicated decision.
- Generated Python cache files were committed under `src/python/ready_sidecar/__pycache__`; these should be removed from version control.
- The snapshot contains very broad scope changes relative to `origin/main`, so commit hygiene is poor even though runtime checks pass.
- Build warnings show some module-loading inefficiency:
  - mixed static/dynamic import usage around `src/main/modules/database.ts`
  - `CalendarMode.tsx` is both statically and dynamically imported
- Renderer bundle sizes are large and need later optimization, but they do not currently block baseline correctness.

## Rebuild Rules
- Preserve full-product behavior before refactoring structure.
- Clean only obviously non-source artifacts first.
- Keep the repository runnable after every cleanup step.
- Do not remove subsystems based on intuition; remove only after proving they are independent and non-essential.
- Treat the snapshot branch commit `96d8f52` as archival reference; rebuild work happens on `codex/baseline-rebuild-20260307`.

## Rebuild Sequence
1. Remove generated artifacts and update ignore rules.
2. Decide how to handle `.claude/worktrees/design-module`:
   - detach from the repo index if it is just an embedded worktree
   - or convert it into an intentional submodule-like dependency with documentation
3. Create a full-product baseline checkpoint commit on the rebuild branch.
4. Audit runtime boundaries and imports without deleting features:
   - browser/agent runtime
   - renderer shell/layout
   - document/calendar/rss/settings/video/design
   - sidecar/skills/assets
5. Only after the full baseline is stable, split cleanup into focused structural passes.

## Immediate Next Step
- Remove tracked Python cache artifacts and make the rebuild branch the only place where repository cleanup continues.
