# Liquid Glass VisionOS Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `liquid-glass` skin so the Ready workbench reads as a visionOS-style layered lens system across chrome, document shells, widget cards, and compact controls.

**Architecture:** Keep the current renderer component tree, but replace the flat glass token strategy with explicit material tiers in `src/renderer/styles/index.css` and `src/renderer/styles/tiptap.css`. Add minimal `data-liquid-role` hooks to key renderer components so shell glass, primary content glass, lens cards, control lenses, and floating lenses can be styled separately and protected by source-contract tests.

**Tech Stack:** React 19, TypeScript 5, Tailwind CSS v4, global CSS variables, Tiptap/ProseMirror, `node:test` via `tsx`

---

## File Structure

- `docs/superpowers/specs/2026-03-16-liquid-glass-visionos-design.md`
  Purpose: approved design source of truth for the material model and regional mapping.
- `src/renderer/styles/index.css`
  Purpose: liquid-glass skin tokens, atmosphere background, shell/content/control/floating lens tiers, shared workbench surface rules.
- `src/renderer/styles/tiptap.css`
  Purpose: document widget card, preview shell, and editor-specific lens card styling.
- `src/renderer/components/layout/TopBar.tsx`
  Purpose: top shell glass and compact control-lens hooks.
- `src/renderer/components/layout/SidePanel.tsx`
  Purpose: left shell glass hooks and search/control lens hooks.
- `src/renderer/components/layout/GlobalSearchPanel.tsx`
  Purpose: floating/shell lens mapping for search surfaces.
- `src/renderer/components/workbench/WorkbenchProjectTabs.tsx`
  Purpose: tab row shell mapping and nested control-lens support.
- `src/renderer/components/motion/MorphSegmentedControl.tsx`
  Purpose: active compact-lens treatment for segmented controls.
- `src/renderer/components/layout/ModeSlider.tsx`
  Purpose: compact lens treatment for the mode pill.
- `src/renderer/components/agent/ChatHeader.tsx`
  Purpose: right shell glass and floating lens trigger hooks.
- `src/renderer/components/agent/ChatPanel.tsx`
  Purpose: chat shell/content core/composer lens mapping.
- `src/renderer/pages/modes/DocumentMode.tsx`
  Purpose: primary content glass shell and document top-control hooks.
- `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
  Purpose: document lens-card root hooks.
- `src/renderer/components/document/WidgetRenderer.tsx`
  Purpose: lens-card core and widget content-core hooks.
- `src/renderer/components/document/NotePreview.tsx`
  Purpose: preview shell/content-core hooks so preview widgets and media inherit the new hierarchy.
- `src/__tests__/liquid-glass-visionos-contract.test.ts`
  Purpose: source-contract regression tests for material tokens and critical liquid-skin guardrails.

## Chunk 1: Material Tokens And Regression Guard

### Task 1: Add a failing liquid-glass contract test

**Files:**
- Create: `src/__tests__/liquid-glass-visionos-contract.test.ts`
- Test: `src/__tests__/liquid-glass-visionos-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create a source-contract test that reads `src/renderer/styles/index.css` and asserts all of the following:

- liquid-glass defines atmosphere tokens such as `--lg-atmosphere-cool` and `--lg-atmosphere-warm`
- liquid-glass defines separate tier tokens for shell/content/lens/control/floating surfaces
- the non-liquid flattening selectors are explicitly gated behind `html:not([data-skin='liquid-glass'])`
- the workbench root applies an atmosphere background under `html[data-skin='liquid-glass'] .workbench-mode-root`

Use `node:test`, `node:assert/strict`, and `readFileSync`.

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/index.css'), 'utf8')

test('liquid glass defines visionOS atmosphere tokens', () => {
  assert.match(css, /--lg-atmosphere-cool:/)
  assert.match(css, /--lg-atmosphere-warm:/)
  assert.match(css, /--lg-shell-bg:/)
  assert.match(css, /--lg-lens-card-bg:/)
  assert.match(css, /--lg-control-lens-bg:/)
})

test('flattened panel overrides are disabled for liquid glass', () => {
  assert.match(css, /html:not\\(\\[data-skin='liquid-glass'\\]\\) \\.glass-surface-panel/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/__tests__/liquid-glass-visionos-contract.test.ts`
Expected: FAIL because the new atmosphere/tier tokens do not exist yet.

- [ ] **Step 3: Implement the minimal token architecture**

Modify `src/renderer/styles/index.css` to introduce explicit liquid-glass tiers:

- atmosphere: `--lg-atmosphere-cool`, `--lg-atmosphere-warm`, `--lg-atmosphere-base`
- shell: `--lg-shell-bg`, `--lg-shell-border`, `--lg-shell-shadow`
- primary content: `--lg-content-shell-bg`, `--lg-content-core-bg`
- lens cards: `--lg-lens-card-bg`, `--lg-lens-card-border`, `--lg-lens-card-shadow`
- controls: `--lg-control-lens-bg`, `--lg-control-lens-border`, `--lg-control-lens-shadow`
- floating: `--lg-floating-lens-bg`, `--lg-floating-lens-border`, `--lg-floating-lens-shadow`

Also update the liquid-skin selectors so:

- `html[data-skin='liquid-glass'] .workbench-mode-root` uses the new atmosphere field
- shared glass classes no longer collapse back to `--panel-unified-bg` when liquid glass is active
- shell/content/card/floating surfaces visibly separate

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/__tests__/liquid-glass-visionos-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

## Chunk 2: Document Shell And Lens Cards

### Task 2: Add a failing document-lens contract

**Files:**
- Modify: `src/__tests__/liquid-glass-visionos-contract.test.ts`
- Test: `src/__tests__/liquid-glass-visionos-contract.test.ts`

- [ ] **Step 1: Extend the failing test**

Add assertions that the document surface stack exposes explicit hooks:

- `DocumentMode.tsx` contains `data-liquid-role="document-shell"`
- `DocumentWidgetBlockCard.tsx` contains `data-liquid-role="lens-card"`
- `WidgetRenderer.tsx` contains `data-liquid-role="lens-card-core"`
- `NotePreview.tsx` contains `data-liquid-role="document-preview-core"`

```ts
const documentMode = readFileSync(resolve(process.cwd(), 'src/renderer/pages/modes/DocumentMode.tsx'), 'utf8')
assert.match(documentMode, /data-liquid-role="document-shell"/)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/__tests__/liquid-glass-visionos-contract.test.ts`
Expected: FAIL because the new hooks do not exist yet.

- [ ] **Step 3: Add the minimal structural hooks**

Modify the following components:

- `src/renderer/pages/modes/DocumentMode.tsx`
  Add `data-liquid-role="document-shell"` on the main `workbench-canvas-shell` container and `data-liquid-role="document-top-controls"` on the edit/preview pill wrapper.
- `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
  Add `data-liquid-role="lens-card"` on the outer card and `data-liquid-role="lens-card-header"` / `data-liquid-role="lens-card-actions"` where useful for CSS targeting.
- `src/renderer/components/document/WidgetRenderer.tsx`
  Add `data-liquid-role="lens-card-core"` on the shell and `data-liquid-role="lens-card-media"` on the iframe/static content container.
- `src/renderer/components/document/NotePreview.tsx`
  Add `data-liquid-role="document-preview-core"` on the root preview shell and `data-liquid-role="document-widget-preview"` around previewed widget blocks.

- [ ] **Step 4: Implement document lens-card styling**

Modify:

- `src/renderer/styles/tiptap.css`
- `src/renderer/styles/index.css`

Required CSS outcomes:

- `.ready-doc-widget-card` reads as a suspended lens card, not a flat white card
- the widget header has stronger edge light and a calmer readable inner strip
- widget action buttons use control-lens styling
- widget preview/media areas sit in a denser inner core for readability
- preview mode widgets and media inherit the same lens-card hierarchy

- [ ] **Step 5: Run the contract test to verify it passes**

Run: `npx tsx --test src/__tests__/liquid-glass-visionos-contract.test.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

## Chunk 3: Shell Glass, Compact Controls, And Floating Lenses

### Task 3: Add a failing workbench-shell contract

**Files:**
- Modify: `src/__tests__/liquid-glass-visionos-contract.test.ts`
- Test: `src/__tests__/liquid-glass-visionos-contract.test.ts`

- [ ] **Step 1: Extend the failing test**

Add assertions that the major workbench chrome surfaces expose explicit liquid roles:

- `TopBar.tsx` includes `data-liquid-role="shell-glass"`
- `SidePanel.tsx` includes `data-liquid-role="shell-glass"`
- `ChatHeader.tsx` includes `data-liquid-role="shell-glass"`
- `ChatPanel.tsx` includes `data-liquid-role="chat-composer-shell"` or `data-liquid-role="control-lens"`
- `MorphSegmentedControl.tsx` renders active pills with `data-liquid-role="control-lens-active"`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/__tests__/liquid-glass-visionos-contract.test.ts`
Expected: FAIL because the chrome hooks do not exist yet.

- [ ] **Step 3: Add minimal liquid-role hooks to workbench chrome**

Modify:

- `src/renderer/components/layout/TopBar.tsx`
- `src/renderer/components/layout/SidePanel.tsx`
- `src/renderer/components/layout/GlobalSearchPanel.tsx`
- `src/renderer/components/workbench/WorkbenchProjectTabs.tsx`
- `src/renderer/components/layout/ModeSlider.tsx`
- `src/renderer/components/motion/MorphSegmentedControl.tsx`
- `src/renderer/components/agent/ChatHeader.tsx`
- `src/renderer/components/agent/ChatPanel.tsx`

Rules:

- outer shells use `data-liquid-role="shell-glass"`
- active pills/buttons/input shells use control-lens hooks
- floating menus/dropdowns use `data-liquid-role="floating-lens"`
- remove hardcoded opaque backgrounds like `background: 'var(--bg-content)'` from critical shell surfaces when they fight the lens treatment

- [ ] **Step 4: Implement shell/control/floating styling**

Modify `src/renderer/styles/index.css` so:

- top/side/chat shells visibly float above the atmosphere layer
- compact controls read as nested lenses with brighter borders and tighter shadows
- current tabs and segmented pills feel like small suspended lenses
- composer/search/dropdown surfaces inherit the same compact-lens language

- [ ] **Step 5: Run the contract test to verify it passes**

Run: `npx tsx --test src/__tests__/liquid-glass-visionos-contract.test.ts`
Expected: PASS

- [ ] **Step 6: Run full verification**

Run: `npm run build`
Expected: PASS, with no new liquid-glass-specific errors. Existing unrelated bundler warnings may remain.

## Chunk 4: Visual Review And Tuning

### Task 4: Validate the visionOS hierarchy

**Files:**
- Review: `src/renderer/styles/index.css`
- Review: `src/renderer/styles/tiptap.css`
- Review: `src/renderer/pages/modes/DocumentMode.tsx`
- Review: `src/renderer/components/document/DocumentWidgetBlockCard.tsx`
- Review: `src/renderer/components/document/WidgetRenderer.tsx`
- Review: `src/renderer/components/layout/TopBar.tsx`
- Review: `src/renderer/components/agent/ChatPanel.tsx`

- [ ] **Step 1: Capture visual checkpoints**

Open the app and visually inspect:

- top bar + active tab
- left file panel search and icon controls
- main document shell
- at least one document widget card
- right chat panel and composer

Expected: at least three obvious material depths are visible.

- [ ] **Step 2: Tune for readability**

If dense text feels washed out:

- increase inner-core opacity
- reduce blur at content centers
- keep strong highlights mainly on the frame and shell edges

- [ ] **Step 3: Re-run final verification**

Run:

- `npm run typecheck`
- `npm run build`

Expected: PASS

- [ ] **Step 4: Review against the spec**

Re-read:

- `docs/superpowers/specs/2026-03-16-liquid-glass-visionos-design.md`

Confirm the implementation matches:

- atmosphere background
- shell glass
- primary content glass
- lens cards
- control lenses

