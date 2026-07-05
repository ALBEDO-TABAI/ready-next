import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

// Regression contract for the "theme toggle → dark flash → light → dark" bug.
// Root cause: App.tsx had a useEffect that wrote <html data-theme> synchronously on
// every resolvedTheme change, racing the ritual overlay (which intentionally defers
// the write until the overlay's holding phase so the frosted-glass cross-fade can
// absorb the swap). The store in src/renderer/stores/useTheme.ts is now the sole
// owner of data-theme. This file locks that ownership in place + locks the "same glass,
// UI fades out" ritual so we never reintroduce a separate solid transition shell.
test('App.tsx does not race the theme ritual and the glass-state content fade is wired', () => {
  const app = readWorkspaceFile('src/renderer/App.tsx')
  const styles = readRendererStyles()
  const overlayComponent = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')
  const overlayCss = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  // 1. App.tsx must NOT write <html data-theme> — that's the race. Narrow regex: only
  //    catches exact 'data-theme' (not 'data-theme-ritual-phase' or 'data-theme-toggle').
  assert.doesNotMatch(app, /setAttribute\(\s*['"]data-theme['"]\s*,/)

  // 2. App.tsx must NOT subscribe to resolvedTheme. The subscription itself is the
  //    trigger — a dead subscription would still pass #1 but would re-render the tree
  //    on every toggle for no reason and invites someone to re-add the useEffect.
  assert.doesNotMatch(app, /useTheme\(\s*s\s*=>\s*s\.resolvedTheme\s*\)/)

  // 3. App shell must NOT introduce a dedicated ritual base layer; the app itself is the glass.
  assert.doesNotMatch(app, /ready-theme-ritual-base/)
  assert.match(app, /className="ready-theme-ritual-tint"/)
  assert.match(app, /className="ready-app-content h-full min-h-0 flex flex-col"/)

  // 4. RitualOverlay must write <html data-theme-ritual-phase> + direction ONLY for
  //    theme-transition, and must clean up on session end.
  assert.match(overlayComponent, /session\.stage === 'theme-transition'/)
  assert.match(overlayComponent, /setAttribute\(\s*['"]data-theme-ritual-phase['"]\s*,\s*session\.phase\s*\)/)
  assert.match(overlayComponent, /setAttribute\(\s*['"]data-theme-ritual-direction['"]\s*,/)
  assert.match(overlayComponent, /removeAttribute\(\s*['"]data-theme-ritual-phase['"]\s*\)/)
  assert.match(overlayComponent, /removeAttribute\(\s*['"]data-theme-ritual-direction['"]\s*\)/)

  // 5. CSS must fade ONLY the app content layer, never the whole shell.
  assert.doesNotMatch(
    overlayCss,
    /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-shell\s*\{[\s\S]*?opacity:\s*0/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity:\s*0\.(0[1-9]|1\d)[\s\S]*?filter:\s*blur\(/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='holding'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity:\s*0\.(0[1-9]|1\d)[\s\S]*?filter:\s*blur\(/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='holding'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity:\s*0\.0[0-9][\s\S]*?filter:\s*blur\(/,
  )
  // Leaving content reveal is keyed to --ritual-leave-duration so it rides the overlay's
  // opacity fade instead of snapping back in 120ms. Locks the unified-reveal fix in place.
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='leaving'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity:\s*1[\s\S]*?filter:\s*none[\s\S]*?opacity var\(--ritual-leave-duration,\s*900ms\)/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-direction='to-light'\]\[data-theme-ritual-phase='leaving'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity var\(--ritual-to-light-leave-duration,\s*1120ms\)[\s\S]*?filter var\(--ritual-to-light-leave-duration,\s*1120ms\)/,
  )

  // 6. CSS must NOT define a dedicated ritual base layer. A low-alpha tint overlay cross-fades
  // the existing glass state between light/dark during the ritual.
  assert.doesNotMatch(overlayCss, /\.ready-theme-ritual-base/)
  assert.match(styles, /\.ready-theme-ritual-tint\s*\{[\s\S]*?opacity:\s*0/)
  assert.match(styles, /\.ready-theme-ritual-tint\s*\{[\s\S]*?transition:\s*opacity 60ms cubic-bezier\(0\.4,\s*0,\s*0\.6,\s*1\)/)
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='entering'\]\[data-theme-ritual-direction='to-dark'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?opacity:\s*1[\s\S]*?background-color:\s*color-mix\([^)]*var\(--workbench-mode-bg-light\)[^)]*transparent\)/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-dark'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?background-color:\s*color-mix\([^)]*var\(--workbench-mode-bg-dark\)[^)]*transparent\)/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='entering'\]\[data-theme-ritual-direction='to-light'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?background-color:\s*color-mix\([^)]*var\(--workbench-mode-bg-dark\)[^)]*transparent\)/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-light'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?background-color:\s*color-mix\([^)]*var\(--workbench-mode-bg-light\)[^)]*transparent\)/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-light'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?background-color:\s*color-mix\(in srgb,\s*var\(--workbench-mode-bg-light\)\s*32%,\s*transparent\)/,
  )
  // During leaving, the tint fades in lockstep with the overlay (opacity 1 → 0 over the full
  // leave duration) so the destination brightness is reached at exactly the moment the icon
  // finishes fading. The previous `opacity: 1` rule produced a visible tint-pop at session end.
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-phase='leaving'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?opacity:\s*0[\s\S]*?opacity var\(--ritual-leave-duration,\s*900ms\)[\s\S]*?background-color var\(--ritual-leave-duration,\s*900ms\)/,
  )
  assert.match(
    overlayCss,
    /html\[data-theme-ritual-direction='to-light'\]\[data-theme-ritual-phase='leaving'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?opacity var\(--ritual-to-light-leave-duration,\s*1120ms\)[\s\S]*?background-color var\(--ritual-to-light-leave-duration,\s*1120ms\)/,
  )
  assert.match(styles, /\.ready-app-bg::before\s*\{[\s\S]*?opacity:\s*1/)
  assert.match(styles, /\.ready-app-bg::after\s*\{[\s\S]*?opacity:\s*0/)
  assert.match(styles, /\.ready-app-bg::before,\s*\.ready-app-bg::after\s*\{[\s\S]*?transition:\s*opacity calc\(var\(--ritual-hold-duration,\s*320ms\)\s*-\s*40ms\)/)
  assert.match(styles, /\.ready-theme-ritual-tint\s*\{[\s\S]*?background-color calc\(var\(--ritual-hold-duration,\s*320ms\)\s*-\s*80ms\)/)
  assert.doesNotMatch(overlayCss, /linear-gradient|radial-gradient/)

  // 7. Reduced-motion must disable the content fade instead of zeroing the whole shell.
  assert.match(
    overlayCss,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?html\[data-theme-ritual-phase\][\s\S]*?\.ready-app-content[\s\S]*?opacity:\s*1\s*!important/,
  )
})
