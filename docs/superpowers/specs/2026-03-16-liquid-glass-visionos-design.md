# Ready Liquid Glass VisionOS Redesign

> Date: 2026-03-16
> Status: Draft for review
> Scope: Renderer-only visual redesign for the `liquid-glass` skin

## Goal

Rebuild the existing `liquid-glass` skin so Ready feels closer to Apple/visionOS material design:

- strong suspended-lens hierarchy
- obvious edge highlights and thickness
- a visible atmospheric field behind the glass
- clear separation between shell glass, content glass, and lens cards
- stable readability for document, chat, and list content

This redesign covers the entire workbench, including document widget cards, not just app chrome.

## Non-Goals

- No BrowserView/native-webpage true refraction work
- No new third-party runtime dependency for glass rendering
- No cross-process or BrowserView lifecycle changes
- No attempt to perfectly clone Apple shaders

## Root Cause Summary

The current UI fails to read as liquid glass for structural reasons, not parameter reasons:

1. Too many large regions collapse back into the same light beige / near-opaque surface family.
2. Most panels still read as flat boards instead of suspended lenses.
3. The background field is too quiet, so the glass has nothing meaningful to refract or react to.
4. Widget cards, top chrome, side panels, and controls are visually too similar.
5. Content sits directly on “glass-like” surfaces instead of inside a stable readable core.

The result is “soft frosted cards” rather than “floating liquid lenses”.

## Visual Direction

The target is visionOS-like, not generic macOS frosted glass:

- brighter and more dimensional edge light
- stronger sense of thickness at boundaries
- large shells feel suspended above a lit atmosphere
- controls feel like compact lenses nested inside larger glass bodies
- lens cards inside the document area visibly step forward from the main document layer

## Material Model

The redesign uses five distinct material tiers.

### 1. Atmosphere Background

The background is not a flat canvas. It provides a cold/warm luminous field that gives the glass something to transmit, tint, and contrast against.

Characteristics:

- soft cold and warm radial glow zones
- subtle vertical tonal drift
- low visual noise
- only enabled for the `liquid-glass` skin

### 2. Shell Glass

Used for the top bar, left file rail/panel, right chat/agent panel, and bottom input shell.

Characteristics:

- large suspended glass sheets
- more transparent than current panels
- strong top-edge highlight
- soft environment shadow + light contact shadow
- clear separation from the background

### 3. Primary Content Glass

Used for the main document container or other large content shells.

Characteristics:

- calmer than shell glass
- slightly denser inner body for reading stability
- still visibly glass, but less flashy than shell or floating surfaces

### 4. Lens Cards

Used for widget cards inside the document area.

Characteristics:

- brighter and “thicker” than the primary content shell
- clear specular edge
- stronger nested-lens feeling
- must visibly float above the primary content glass

### 5. Control Lenses

Used for tabs, segmented controls, active pills, dropdowns, buttons, search inputs, and other compact controls.

Characteristics:

- smallest but sharpest lens treatment
- strongest perceived polish
- active states must look like liquid lenses, not flat tinted buttons

## Regional Mapping

### Left File Panel

Map the full panel body to `Shell Glass`.

Nested elements:

- search input: `Control Lens`
- small icon buttons: `Control Lens`
- file list content region: readable inner core with glass shell around it

### Top Bar And Tab Zone

Map the top bar to a continuous `Shell Glass` band.

Nested elements:

- current tab: active lens, not a pasted white tab
- inactive tabs: lighter nested lenses
- mode controls and dropdowns: `Control Lens`

### Main Document Area

Map the outer document container to `Primary Content Glass`.

Nested elements:

- widget cards: `Lens Cards`
- widget control row: `Control Lenses`
- actual chart/text/rendered content: stable inner content core

### Right Agent Panel

Map the panel body to `Shell Glass`.

Nested elements:

- header controls: `Control Lenses`
- messages region: readable inner core
- composer, model picker, action buttons: high-polish `Control Lenses`

### Floating UI

Dropdowns, context menus, popovers, and mini overlays use the brightest `floating-lens` treatment.

They must appear to float above shell glass, not merge into it.

## Readability Rules

These are mandatory guardrails.

1. Body text and dense content must not sit directly on the most translucent layer.
2. Each high-glass shell needs an inner readable core for actual content.
3. Blur and transparency should be concentrated at shell edges and chrome, not at text-heavy centers.
4. Widget previews must remain clean and legible even when their card body becomes more glassy.

## Implementation Strategy

### CSS Architecture

Do not rely on a single transparency pass.

Instead:

- keep `liquid-glass` skin gated by `html[data-skin='liquid-glass']`
- introduce explicit token groups for:
  - atmosphere
  - shell glass
  - primary content glass
  - lens cards
  - control lenses
  - floating lenses
- stop flattening glass surfaces back into `panel-unified-bg` when liquid-glass is active

### Surface Construction

Each glass tier should combine:

- body tint
- top highlight
- angled highlight
- border light
- contact shadow
- environment shadow
- optional atmosphere tint pickup

### Component Strategy

Preserve current component boundaries when possible. Prefer reusing existing `glass-surface-*` entry points, but remap them to better material tiers.

Expected component categories:

- shell surfaces: top bar, side panels, chat shell
- content surfaces: main document container and other large reading shells
- lens cards: document widgets
- control lenses: pills, tabs, search, buttons, dropdown triggers
- floating lenses: menus and overlays

## BrowserView Constraint

BrowserView/native content cannot be treated as true DOM glass underneath overlays.

Therefore, browser-mode glass must depend more on:

- edge highlights
- border thickness cues
- floating shadow separation
- nested-lens hierarchy

and less on actual transmitted page refraction.

## Risk Management

### Risk: Everything becomes noisy

Mitigation:

- atmosphere stays soft
- only edges carry strong highlight
- text cores remain calmer and denser

### Risk: Cards become unreadable

Mitigation:

- add stable inner core under dense content
- keep strongest glass effects on frame and chrome regions

### Risk: All surfaces still look the same

Mitigation:

- enforce visible difference between shell, content, card, and control tiers
- active controls get their own compact lens treatment

## Success Criteria

The redesign is successful when:

1. The interface reads as layered suspended lenses at a glance.
2. Left panel, top chrome, main document shell, widget cards, and right panel show at least three obvious material depths.
3. Active tabs and segmented pills read like glass lenses, not blue-filled controls.
4. Widget cards visibly float above the document container.
5. Dense text remains easy to read.
6. In grayscale, the composition still communicates thickness and hierarchy instead of flat stacked rectangles.

## Verification Plan

Before claiming success, verify:

- `npm run typecheck`
- `npm run build`
- visual inspection in the main workbench UI
- focused screenshot review of:
  - top bar and tab area
  - left file panel
  - main document shell
  - at least one widget card
  - right agent panel
  - composer/input region

## Initial Recommended Delivery Order

1. Atmosphere background and shell glass reset
2. Main document shell and widget lens cards
3. Control lenses: tabs, pills, inputs, dropdown triggers
4. Floating overlays
5. Visual tuning pass for contrast and readability
