# Ready Document Generative UI Unified Widget Runtime

> Date: 2026-03-17
> Status: Draft for review
> Scope: Document module generative UI runtime, authoring contract, and export strategy

## Goal

Make `show-widget` blocks inside the document module reliably interactive in-app while keeping them:

- safe to run locally
- stable across edit and preview modes
- easy for the agent to create and update
- compatible with later PDF and overnight export workflows

## Problem Summary

The current widget experience fails on simple local interaction cases such as a score calculator:

- users can type into inputs
- derived values do not update
- edit mode and preview mode do not behave consistently

This is not primarily a widget-authoring problem. It is a runtime contract problem.

## Root Cause

Ready currently splits `show-widget` rendering into two different paths:

1. widgets containing `<script>` render inside a sandboxed iframe
2. widgets without `<script>` render as inline sanitized HTML

That split creates a broken middle state:

- non-script widgets can still contain interactive-looking controls like `<input>`
- inline handlers such as `oninput` and `onclick` are stripped when no `<script>` is present
- the widget still appears editable, but no local recomputation occurs

As a result, the same widget can look interactive while being functionally static.

## External Reference

Reference project reviewed:

- CodePilot: [https://github.com/op7418/CodePilot](https://github.com/op7418/CodePilot)
- Implementation write-up: [https://github.com/op7418/CodePilot/blob/main/docs/generative-ui-article.md](https://github.com/op7418/CodePilot/blob/main/docs/generative-ui-article.md)

Key lessons from CodePilot that fit Ready:

- treat widgets as a unified runtime unit, not as separate static and script modes
- use a sandbox iframe receiver as the stable rendering boundary
- keep theming, link interception, and runtime messaging at the iframe boundary
- design export separately from runtime interactivity

Ready does not need to copy CodePilot exactly, but it should adopt the same core abstraction.

## Decision

Adopt a unified widget runtime:

- all `show-widget` blocks ultimately render through the same sandboxed iframe receiver
- widget interactivity is not gated by the presence of `<script>`
- both simple inline-event widgets and script-backed widgets are supported
- edit mode and preview mode should share the same widget execution contract

This is the recommended path because it best serves:

- immediate in-app interaction quality
- future agent-driven widget updates
- later snapshot-based export and PDF workflows

## Non-Goals

- no network-backed widget runtime
- no form submission workflow inside widgets
- no iframe nesting inside widget content
- no arbitrary third-party script loading beyond the current whitelist policy
- no attempt to preserve live interactivity inside exported PDFs

## User Experience Targets

### In-App

- a calculator widget updates immediately after local input changes
- edit mode card preview and preview mode behave consistently
- widget theming stays aligned with Ready themes
- widget links continue to open through Ready browser integration

### Agent Authoring

- the agent can insert a widget once and update it later without duplicating it
- a stable `title` remains the default widget identity
- the agent does not need to reason about separate static and script rendering modes

### Export

- exported PDFs remain visually stable
- export does not depend on live iframe execution during print
- interactive widgets are frozen into deterministic static output before export

## Proposed Architecture

### 1. Unified Renderer

`WidgetRenderer` becomes the single execution path for document widgets.

Changes:

- remove the runtime branch that renders non-script widgets directly via `dangerouslySetInnerHTML`
- always create a sandbox iframe receiver
- continue using a receiver document that owns:
  - script execution
  - height reporting
  - theme synchronization
  - link interception

Effect:

- `input + oninput` widgets work
- `script` widgets still work
- widget behavior no longer depends on brittle authoring heuristics

### 2. Sanitization Model

Sanitization should no longer answer the question "iframe or not." It should answer "what is allowed to run inside the iframe."

Recommended model:

- strip dangerous container tags such as nested iframe, object, embed, base, meta, and link
- reject network behaviors such as form submission and script sources outside the whitelist
- keep inline event handlers when rendering finalized widget content inside the sandbox
- keep local inline scripts when they satisfy the whitelist and local-only rules
- keep `javascript:` URL stripping in all cases

This preserves local interaction while keeping the sandbox boundary as the actual safety layer.

### 3. Edit And Preview Parity

The document editor currently shows a card wrapper in edit mode and a richer render in preview mode. That is fine, but the widget runtime underneath should be the same.

Recommended behavior:

- edit mode keeps the card shell, source controls, and delete/update actions
- edit mode embedded preview uses the same iframe runtime as preview mode
- preview mode uses the same renderer without the editor affordances

This avoids a common failure mode where the user tests a widget in one place and gets different behavior in another.

### 4. Runtime Bridge

The iframe receiver remains the place to centralize widget-side communication:

- resize events
- theme updates
- link opens
- future agent or follow-up message triggers if needed later

This does not require a full interactive agent bridge immediately. It only preserves the correct extension point so we do not need another runtime redesign later.

## Widget Authoring Contract

The existing `show-widget` fence format should stay unchanged:

````text
```show-widget
{"title":"score_calculator","widget_code":"..."}
```
````

### Contract Rules

- `title` is the stable widget identity and should normally not change during updates
- `widget_code` may use either:
  - pure HTML plus inline local handlers such as `oninput` and `onclick`
  - HTML plus a small inline `<script>`
- widgets must remain self-contained and local
- disallow:
  - `fetch`
  - `XMLHttpRequest`
  - websocket usage
  - form submission
  - nested iframe content
  - non-whitelisted external scripts

### Agent Guidance

The agent-facing guidance should be updated so that:

- simple local interactivity is allowed without forcing `<script>`
- complex local interactivity may use a small inline `<script>`
- the agent should prefer updating an existing widget by `title`
- `document_update_widget` is the default path for iterative refinement
- prompt guidance explicitly says:
  - local-only computation
  - no network
  - no form submit
  - one stable widget title

## Export Strategy

Live runtime and exported output should be treated as separate concerns.

### Decision

Do not export live widget iframes directly to PDF.

Instead:

- render widgets live in-app
- create export-time static snapshots before PDF generation

### Snapshot Priority

1. SVG widget: preserve or export as SVG when possible
2. HTML widget: capture current rendered state as image
3. Calculator-like widgets: export the current visible settled state, not live controls

### Why

Printing iframes directly is brittle:

- layout timing can drift
- script execution can race with print
- cross-theme rendering can vary
- overnight batch export becomes fragile

A snapshot pipeline makes export deterministic and retryable.

## Implementation Impact

Primary files likely affected:

- `src/renderer/components/document/WidgetRenderer.tsx`
- `src/renderer/components/document/widget-sanitizer.ts`
- `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
- `src/renderer/components/document/NotePreview.tsx`
- `src/renderer/components/document/TiptapEditor.tsx`
- `src/renderer/components/document/MarkdownEditor.tsx`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/tools/document-tools.ts`
- related widget tests under `src/__tests__/`

## Risks

### Risk 1: More widgets run inside iframes than before

Impact:

- slightly heavier rendering path

Mitigation:

- keep the receiver small
- preserve height cache
- keep sandbox policy strict

### Risk 2: Existing "static" widgets expose unexpected inline handlers

Impact:

- old content may start behaving differently once routed through the iframe runtime

Mitigation:

- keep sanitization conservative
- add tests for allowed and disallowed handler cases
- forbid network and submit behavior regardless of widget type

### Risk 3: Export becomes an afterthought again

Impact:

- runtime works, but PDF remains unstable

Mitigation:

- include export snapshot hooks in the design now
- do not couple export to live iframe printing

## Recommended Rollout

### Phase 1: Runtime Unification

- make all widgets render through the iframe receiver
- preserve theme sync, link interception, and height sync
- ensure local inline-event widgets recompute correctly

### Phase 2: Authoring Contract Tightening

- update agent prompt guidance and document tool descriptions
- clarify local-only widget rules
- add tests for score-calculator style widgets

### Phase 3: Export Hooks

- define a widget snapshot preparation step
- prepare stable SVG or image export for later PDF integration

## Validation Checklist

- a `score_calculator` widget updates total score in edit mode card preview
- the same widget updates in preview mode
- script-backed widgets still render correctly
- external network behavior remains blocked
- widget links still open through Ready browser behavior
- existing `document_update_widget` flows remain usable
- export design remains snapshot-oriented rather than live-iframe printing

## Recommendation

Proceed with the unified iframe runtime design.

This is the best balance of:

- immediate product correctness
- future agent maintainability
- export stability

It also directly addresses the current failure case without forcing the model or user to memorize a brittle "interactive only if script exists" rule.
