---
name: Y0-7-mcp-not-shipped-labeling-implementation
stage: Y0.7
date: 2026-05-23
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
scope_lock: §11.0b (Y0.7 MCP transport-or-labeling P0 scope lock)
acceptance_reference: §11.0b labeling branch + §3.1 Y0.7 row + §3.2 non-deferrable carve-out + §3.3 §0.7 exit criterion
---

# Y0.7 — MCP "not shipped" labeling implementation plan

## 0. Decision

Stage Y picks the **labeling path** (§11.0b option b) over the transport
path (§11.0b option a).

Rationale (per §11.0b + §4.3 budget):

- The labeling path is the minimum P0 disposition (~1-2h, per §4.3 Y0.7
  row "OR 1-2 h labeling path").
- The transport path requires bundling an MCP server (filesystem or
  fetch), an install UI, a full tool round-trip, and process lifecycle
  guarantees (~6-8h). That scope is real-product work; landing it
  inside Stage Y P0 budget would force a quality compromise on either
  the lifecycle test or the install UI.
- Stage Z explicitly owns the real transport landing per §13 Stage Z
  entry contract; this sub-plan documents the carry-over in
  `release-handoff.md` § "Stage Z MCP carry-over" so Stage Z does not
  inherit MCP as an orphan.
- Stage T already proved the MCP authorization plumbing
  (`src/main/modules/mcp/{client,oauth,deferred-filter,registry,
  tool-discovery}.ts` + `src/__tests__/mcp-tools-authorization.test.ts`);
  leaving that plumbing in place with a visible "not shipped" label
  keeps the contract preserved without falsely advertising a feature
  to end users.

This decision satisfies §11.0b labeling-branch acceptance verbatim:

> "Labeling-branch acceptance: Settings MCP section shows the 'not
> shipped' label; the existing authorization plumbing (Stage T) is left
> in place but visibly inert in UI."

## 1. Scope

In scope:

- Add a new Settings section `mcp` to `src/renderer/pages/Settings.tsx`
  whose body renders a "MCP 暂未发布 / MCP not shipped in this release;
  see Stage Z roadmap for transport landing" label.
- Visibly inert state: render a disabled placeholder where the MCP
  server install / configure controls would normally live, so the user
  sees the shape of the future feature without any actionable button.
- Reference (read-only) that the Stage T authorization plumbing exists
  but does not surface any tool until the Stage Z transport ships. No
  user-facing button is enabled.
- Add a behavior test
  (`src/__tests__/settings-mcp-not-shipped-labeling.test.ts`) that
  asserts the section label, the disabled state, and the absence of
  actionable install controls.
- Append a Y0.7 disposition row to
  `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md`
  marking the row green via the labeling path (bucket
  `Stage Z release-candidate` denotes the follow-up transport-landing
  work — NOT `deferred-with-owner`, which is forbidden by §3.2 for
  Y0.7).
- Add a § "Stage Z MCP carry-over" subsection to
  `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md`
  populating the previously-empty §5b placeholder, documenting (a) the
  labeling-path choice rationale, (b) Stage Z scope (real transport for
  ≥1 provider), (c) expected file touch surface.

Out of scope:

- Actual MCP transport (stdio / streaming-http / sse) — Stage Z scope
  per §13.
- New IPC channels — Stage T already shipped the auth contract; this
  phase only labels the Settings UI and does not touch
  `src/preload/index.ts` or `src/main/modules/mcp/*`.
- Main-process changes to `src/main/modules/mcp/*` — the plumbing
  stays exactly as Stage T left it.
- Y0.8 (cache quota) or Y0.5 (dogfood matrix) work — those are
  separate dispatch slots per §11.0a / §9.

## 2. Files to touch

| File | Change | Reason |
| --- | --- | --- |
| `src/renderer/pages/Settings.tsx` | (1) Import `Plug2` icon from `lucide-react`; (2) add `mcp` row to `settingsData`; (3) add `McpSettingsPanel()` function rendering the not-shipped banner + inert placeholder; (4) wire `currentSection.id === 'mcp'` into the render switch; (5) add `'mcp'` to `isDynamicSection` list. | The single renderer entry point for Settings; Y0.7 §11.0b labeling-branch acceptance lands here. |
| `src/__tests__/settings-mcp-not-shipped-labeling.test.ts` | New behavior test asserting the section header text, the "not shipped" label string, the disabled-state attribute, and the absence of actionable install/configure controls. Uses the same source-grep pattern as `settings-ai-layout-contract.test.ts` + carries a documented waiver because there is no JSDOM harness for `Settings.tsx` (a 3092-line React component coupled to Zustand stores and Electron IPC). | Per `docs/superpowers/testing-conventions.md` the source-grep waiver is allowed when the production seam lacks an isolated harness; this matches the precedent set by `settings-ai-layout-contract.test.ts` and `settings-shell-visual-contract.test.ts`. |
| `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md` | Append Y0.7 disposition row (bucket `Stage Z release-candidate` for the FOLLOW-UP transport work; the Y0.7 row itself is green via the labeling path). | §3.1 + §3.3 §0.7 exit criterion; ledger row required so `check-stage-y-p0-ledger.cjs` can validate Y0.7 closure. |
| `docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md` | Populate §5b "MCP carry-over (Y0.7 path-(b) labeling branch only)" with rationale + Stage Z scope + expected file touch surface. | §10.3 release-handoff covenant: every P0 deferred-to-Z handoff has a §5x section so Stage Z does not inherit orphans. |

No main-process change. No `src/preload/index.ts` change. No new IPC
channel.

## 3. Acceptance

Per §11.0b labeling-branch acceptance + §3.3 exit criterion §0.7:

- Settings page mounts; the new `mcp` section is visible in the
  sidebar.
- Selecting the section shows the "MCP 暂未发布 / MCP not shipped"
  label prominently.
- All install / configure controls are disabled OR rendered as
  non-actionable placeholders.
- Stage T authorization plumbing (`src/main/modules/mcp/*` +
  `mcp-tools-authorization.test.ts`) is untouched and continues to pass
  its existing tests (verified via `npm run test`).
- New test `settings-mcp-not-shipped-labeling.test.ts` passes.
- `npm run typecheck` exit 0.
- `npm run lint:check` exit 0 (warning count must not GROW above the
  pre-edit baseline of 773; the budget ceiling in
  `docs/superpowers/operations/lint-warning-debt-ledger.md` is 771 and
  is independently 2 over baseline pre-this-PR — that drift is
  pre-existing and is not introduced by Y0.7).
- `npm run test` exit 0 (including the new test).
- `npm run verify:ipc-contract` exit 0 (no new IPC channel added; the
  contract surface is unchanged).

## 4. Step-by-step

1. Read this sub-plan + plan §11.0b + §3.1 + §3.2.
2. Search `src/renderer/` for existing MCP references — confirm none
   exist (renderer was never given MCP UI; main-process plumbing
   shipped at Stage T).
3. Edit `src/renderer/pages/Settings.tsx`:
   - Import `Plug2` from `lucide-react`.
   - Insert `mcp` row into `settingsData` (placed near the AI / agent
     family of sections for sidebar adjacency).
   - Implement `McpSettingsPanel()`:
     - Header card with the not-shipped label (CN + EN).
     - Disabled placeholder card listing the future transport-install
       affordance with `disabled` attribute and `aria-disabled`.
     - Reference paragraph noting Stage T authorization plumbing
       remains in-tree but does not surface any tool in this release.
   - Wire `currentSection.id === 'mcp'` to render `<McpSettingsPanel />`.
   - Add `'mcp'` to the `isDynamicSection` ID list so the generic
     settings-item map does not also render.
4. Write `src/__tests__/settings-mcp-not-shipped-labeling.test.ts`:
   - Read `src/renderer/pages/Settings.tsx`.
   - Assert presence of the not-shipped label string (CN + EN).
   - Assert presence of `disabled` attribute on the install control.
   - Assert the `McpSettingsPanel` function exists and is wired into
     the section switch.
   - Carry the source-grep waiver comment.
5. Append Y0.7 row to `deferred-work-ledger.md`.
6. Populate §5b in `release-handoff.md`.
7. Run verify chains:
   - `npm run typecheck`
   - `npm run lint:check`
   - `npm run test`
   - `npm run verify:ipc-contract`
8. Commit per task instructions.

## 5. Rollback

If the labeling causes visual regression in another section (e.g.,
sidebar overflow on small viewport) revert the Settings.tsx edits and
re-implement the label as a banner inside the existing `external-services`
section header instead. The ledger row + handoff section stay in place
because the Y0.7 P0 disposition is still satisfied — only the rendering
surface changes.

## 6. Predecessor links

- Roadmap: `docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md`
  §11.0b + §3.1 Y0.7 row + §3.2 carve-out + §3.3 §0.7 exit criterion.
- Stage T MCP authorization landing (preserved, not edited):
  `src/main/modules/mcp/{client,oauth,deferred-filter,registry,tool-discovery}.ts`
  + `src/__tests__/mcp-tools-authorization.test.ts`.
- Closeout bundle:
  `docs/superpowers/audits/2026-05-23-stage-y-closeout/` (ledger +
  handoff land here).
