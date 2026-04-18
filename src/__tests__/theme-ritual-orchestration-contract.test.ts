import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('theme transitions route through the ritual overlay and the per-selector transition whitelist is gone', () => {
  const themeStore = readWorkspaceFile('src/renderer/stores/useTheme.ts')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const ritualCss = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const ritualOverlay = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')
  const themeChoreography = readWorkspaceFile('src/renderer/components/overlay/ThemeRitualChoreography.tsx')

  // Theme store uses withRitual for animated switches and synchronous apply for animate: false.
  assert.match(themeStore, /import \{ withRitual \} from '\.\.\/modules\/overlay\/useRitualOverlay'/)
  assert.match(themeStore, /withRitual\('theme-transition',/)
  assert.match(themeStore, /const direction = resolved === 'dark' \? 'to-dark' : 'to-light'/)
  assert.match(themeStore, /signalReady\(\)/)
  // System theme changes must still bypass the ritual (animate: false path).
  assert.match(themeStore, /if \(state\.theme === 'system'\) \{[\s\S]*animate: false/)
  assert.match(themeStore, /if \(!animate[\s\S]*\|\| resolved === currentResolved\) \{[\s\S]*applyThemeImmediate/)

  // Legacy token + multi-RAF plumbing is gone.
  assert.doesNotMatch(themeStore, /let themeTransitionToken/)
  assert.doesNotMatch(themeStore, /themeDomFrameId/)
  assert.doesNotMatch(themeStore, /THEME_TRANSITION_DURATION_MS/)

  // The per-selector transition whitelist block was removed.
  assert.doesNotMatch(styles, /html\[data-theme-transitioning='true'\]\s*\{/)
  assert.doesNotMatch(styles, /html\[data-theme-transitioning='true'\] body/)

  // Safety body-level transition remains for reduce-motion users who bypass the overlay.
  assert.match(styles, /body\s*\{\s*transition:\s*background-color 140ms ease/)

  // Ritual CSS exists and exposes theme choreography directions.
  assert.match(ritualCss, /\[data-ritual-overlay\]/)
  assert.match(ritualCss, /\[data-phase='entering'\]/)
  assert.match(ritualCss, /\[data-phase='holding'\]/)
  assert.match(ritualCss, /\[data-phase='leaving'\]/)
  assert.match(ritualCss, /\[data-direction='to-dark'\]/)
  assert.match(ritualCss, /\[data-direction='to-light'\]/)
  assert.match(ritualCss, /@media \(prefers-reduced-motion: reduce\)/)

  // Theme glyph uses lucide-matching outline style.
  assert.match(themeChoreography, /viewBox="0 0 48 48"/)
  assert.match(themeChoreography, /stroke="var\(--color-blue\)"/)
  assert.match(themeChoreography, /strokeWidth="2"/)
  assert.match(themeChoreography, /fill="none"/)
  assert.match(themeChoreography, /data-glyph="sun"/)
  assert.match(themeChoreography, /data-glyph="moon"/)

  // Overlay component paints the theme choreography only for theme-transition stage.
  assert.match(ritualOverlay, /session\.stage === 'theme-transition'\s*\?\s*<ThemeRitualChoreography/)
  assert.match(ritualOverlay, /data-direction=\{session\.meta\.direction/)

  // Topbar disables the toggle while the theme ritual is running.
  assert.match(topBar, /useRitualOverlayStore/)
  assert.match(topBar, /state\.session\?\.stage === 'theme-transition'/)
  assert.match(topBar, /disabled=\{isThemeRitualRunning\}/)
})
