import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('ritual overlay infrastructure: store, withRitual hook, mask, component, css mount', () => {
  const store = readWorkspaceFile('src/renderer/modules/overlay/useRitualOverlay.ts')
  const mask = readWorkspaceFile('src/renderer/modules/overlay/browserViewMask.ts')
  const overlay = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')
  const choreography = readWorkspaceFile('src/renderer/components/overlay/ThemeRitualChoreography.tsx')
  const css = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')
  const app = readWorkspaceFile('src/renderer/App.tsx')
  const main = readWorkspaceFile('src/renderer/main.tsx')

  // store + hook
  assert.match(store, /export type RitualStage = 'mode-switch' \| 'theme-transition'/)
  assert.match(store, /export type RitualPhase = 'idle' \| 'entering' \| 'holding' \| 'leaving'/)
  assert.match(store, /export const useRitualOverlayStore = create<RitualOverlayState>/)
  assert.match(store, /export async function withRitual<T>\(\s*stage: RitualStage,\s*workFn: \(args: WithRitualArgs\) => Promise<T> \| T,/)
  assert.match(store, /if \(currentAbortController\) \{\s*currentAbortController\.abort\(\)/)
  assert.match(store, /const reduceMotion = prefersReducedMotion\(\)/)
  assert.match(store, /if \(reduceMotion\) \{[\s\S]*runReduceMotionFlash\(stage\)/)
  assert.match(store, /enterDurationMs: 120,[\s\S]*holdingMinDurationMs: 100,[\s\S]*leaveDurationMs: 100/)
  assert.match(store, /enterDurationMs: 160,[\s\S]*holdingMinDurationMs: 440,[\s\S]*leaveDurationMs: 720/)
  assert.match(store, /store\.getState\(\)\._setPhase\(id, 'holding'\)/)
  assert.match(store, /store\.getState\(\)\._setPhase\(id, 'leaving'\)/)

  // browser mask
  assert.match(mask, /export const BROWSER_OVERLAY_LOCK_EVENT = 'ready:browser-overlay-lock'/)
  assert.match(mask, /export function beginBrowserMask/)
  assert.match(mask, /export async function endBrowserMask/)
  assert.match(mask, /detail: \{ locked: true \}/)
  assert.match(mask, /detail: \{ locked: false \}/)
  assert.match(mask, /requestAnimationFrame\(\(\) => \{\s*window\.requestAnimationFrame\(\(\) => resolve\(\)\)/)

  // overlay component
  assert.match(overlay, /data-ritual-overlay=""/)
  assert.match(overlay, /data-stage=\{session\.stage\}/)
  assert.match(overlay, /data-phase=\{session\.phase\}/)
  assert.match(overlay, /data-direction=\{session\.meta\.direction \?\? undefined\}/)
  assert.match(overlay, /beginBrowserMask\(\)/)
  assert.match(overlay, /endBrowserMask\(\)/)
  assert.match(overlay, /session\.stage === 'theme-transition' \? <ThemeRitualChoreography \/> : null/)

  // choreography — sun + moon glyphs
  assert.match(choreography, /data-glyph="sun"/)
  assert.match(choreography, /data-glyph="moon"/)
  assert.match(choreography, /stroke="var\(--color-blue\)"/)
  assert.match(choreography, /strokeWidth="2"/)
  assert.match(choreography, /fill="none"/)

  // css contract
  assert.match(css, /\[data-ritual-overlay\]\s*\{[\s\S]*position:\s*fixed;[\s\S]*inset:\s*0;[\s\S]*z-index:\s*9999/)
  assert.match(css, /\[data-ritual-overlay\]\[data-phase='entering'\],[\s\S]*\[data-ritual-overlay\]\[data-phase='holding'\]\s*\{[\s\S]*opacity:\s*1/)
  assert.match(css, /\[data-ritual-overlay\]\[data-phase='leaving'\]\s*\{[\s\S]*opacity:\s*0/)
  assert.match(css, /\[data-ritual-reduce-flash\]/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)

  // mount
  assert.match(app, /import RitualOverlay from '\.\/components\/overlay\/RitualOverlay'/)
  assert.match(app, /<RitualOverlay \/>/)
  assert.match(main, /import '\.\/styles\/ritual-overlay\.css'/)
})
