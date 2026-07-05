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
  const app = readWorkspaceFile('src/renderer/App.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')
  const ritualOverlay = readWorkspaceFile('src/renderer/components/overlay/RitualOverlay.tsx')
  const themeChoreography = readWorkspaceFile('src/renderer/components/overlay/ThemeRitualChoreography.tsx')

  // Theme store uses withRitual for animated switches and synchronous apply for animate: false.
  assert.match(themeStore, /import \{[\s\S]*?\bwithRitual\b[\s\S]*?\} from '\.\.\/modules\/overlay\/useRitualOverlay'/)
  assert.match(themeStore, /withRitual\('theme-transition',/)
  assert.match(themeStore, /const direction = resolved === 'dark' \? 'to-dark' : 'to-light'/)
  assert.match(themeStore, /signalReady\(\)/)
  // System theme changes must still bypass the ritual (animate: false path).
  assert.match(themeStore, /if \(state\.theme === 'system'\) \{[\s\S]*animate: false/)
  assert.match(themeStore, /if \([\s\S]*?!animate[\s\S]*?\|\| resolved === currentResolved[\s\S]*?\) \{[\s\S]*?applyThemeImmediate/)

  // Bypass-path gate: panel-resize and reduce-motion are caught before entering withRitual so
  // the animation-skipping paths never leave DOM out of sync with store.
  assert.match(themeStore, /isRitualBypassActive\(\)/)

  // data-theme flips at the START of holding, but nativeTheme sync is delayed until
  // AFTER the renderer-side hold finishes so system window materials cannot flash early.
  assert.match(themeStore, /document\.documentElement\.setAttribute\('data-theme', resolved\)[\s\S]*?syncNativeTheme\(option\)[\s\S]*?await waitForThemeSettleFrames\(2,\s*abortSignal\)[\s\S]*?signalReady\(\)/)

  // Abort / error recovery: only the newest request may reconcile DOM / native theme after aborts.
  assert.match(themeStore, /const ensureDomThemeMatches = /)
  assert.match(themeStore, /let themeTransitionRequestToken = 0/)
  assert.match(themeStore, /let themeDomReconcileTimer: number \| null = null/)
  assert.match(themeStore, /const requestToken = \+\+themeTransitionRequestToken/)
  assert.match(themeStore, /if \(themeDomReconcileTimer\) \{\s*window\.clearTimeout\(themeDomReconcileTimer\)/)
  assert.match(themeStore, /\.catch\([\s\S]*?requestToken === themeTransitionRequestToken[\s\S]*?ensureDomThemeMatches\(resolved, option\)/)

  // Legacy multi-RAF plumbing is gone in favor of the explicit settle-frame gate.
  assert.doesNotMatch(themeStore, /THEME_TRANSITION_DURATION_MS/)

  // toggleTheme collapses to strict 2-way (never lands on 'system') so every click yields a
  // visible change. 3-way cycle would produce apparent click-no-ops when system resolves to
  // the same value as the current theme.
  assert.match(themeStore, /toggleTheme: \(\) => \{[\s\S]*?state\.resolvedTheme === 'dark' \? 'light' : 'dark'/)
  assert.doesNotMatch(themeStore, /state\.theme === 'dark' \? 'system' : 'light'/)

  // The per-selector transition whitelist block was removed.
  assert.doesNotMatch(styles, /html\[data-theme-transitioning='true'\]\s*\{/)
  assert.doesNotMatch(styles, /html\[data-theme-transitioning='true'\] body/)

  // Safety body-level transition remains for reduce-motion users who bypass the overlay.
  assert.match(styles, /body\s*\{\s*transition:\s*background-color 140ms ease/)

  // App shell keeps the app itself as the glass state; no dedicated transition base layer.
  assert.doesNotMatch(app, /ready-theme-ritual-base/)
  assert.match(app, /className="ready-theme-ritual-tint"/)
  assert.match(app, /className="ready-app-content h-full min-h-0 flex flex-col"/)

  // Ritual CSS exists and exposes theme choreography directions.
  assert.match(ritualCss, /\[data-ritual-overlay\]/)
  assert.match(ritualCss, /\[data-phase='entering'\]/)
  assert.match(ritualCss, /\[data-phase='holding'\]/)
  assert.match(ritualCss, /\[data-phase='leaving'\]/)
  assert.match(ritualCss, /\[data-direction='to-dark'\]/)
  assert.match(ritualCss, /\[data-direction='to-light'\]/)
  assert.match(ritualCss, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(ritualCss, /\[data-ritual-overlay\]\[data-phase='leaving'\]\s*\{[\s\S]*opacity:\s*0[\s\S]*transition:\s*opacity var\(--ritual-leave-duration,\s*900ms\)/)

  // The overlay itself is transparent during theme-transition; there is no separate ritual base.
  // The app's own glass background stays in place, while a low-alpha tint overlay carries the
  // light->dark / dark->light color drift.
  assert.doesNotMatch(ritualCss, /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\s*\{[^}]*backdrop-filter:/)
  assert.doesNotMatch(ritualCss, /\[data-ritual-overlay\]\[data-stage='theme-transition'\]\s*\{[^}]*background-color:/)
  assert.doesNotMatch(ritualCss, /\.ready-theme-ritual-base/)
  assert.match(styles, /\.ready-app-bg::before\s*\{[\s\S]*opacity:\s*1/)
  assert.match(styles, /\.ready-app-bg::after\s*\{[\s\S]*opacity:\s*0/)
  assert.match(styles, /\.ready-app-bg::before,\s*\.ready-app-bg::after\s*\{[\s\S]*calc\(var\(--ritual-hold-duration,\s*320ms\)\s*-\s*40ms\)/)
  assert.match(styles, /html\[data-theme='dark'\]\s+\.ready-app-bg::before\s*\{[\s\S]*opacity:\s*0/)
  assert.match(styles, /html\[data-theme='dark'\]\s+\.ready-app-bg::after\s*\{[\s\S]*opacity:\s*1/)
  assert.match(styles, /\.ready-theme-ritual-tint\s*\{[\s\S]*opacity:\s*0/)
  assert.match(styles, /\.ready-theme-ritual-tint\s*\{[\s\S]*opacity 60ms cubic-bezier\(0\.4,\s*0,\s*0\.6,\s*1\)/)
  assert.match(styles, /\.ready-theme-ritual-tint\s*\{[\s\S]*background-color calc\(var\(--ritual-hold-duration,\s*320ms\)\s*-\s*80ms\)/)
  assert.match(ritualCss, /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-dark'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*opacity:\s*1/)
  assert.match(ritualCss, /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-light'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*opacity:\s*1/)
  assert.match(ritualCss, /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-light'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*background-color:\s*color-mix\(in srgb,\s*var\(--workbench-mode-bg-light\)\s*32%,\s*transparent\)/)
  // Leaving fades the tint out in lockstep with the overlay's own opacity (900ms), instead of
  // keeping it at opacity:1 and relying on a separate background-color drain. Unifies the
  // leave-phase brightness transition so destination lands exactly when the icon disappears.
  assert.match(ritualCss, /html\[data-theme-ritual-phase='leaving'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?opacity:\s*0[\s\S]*?opacity var\(--ritual-leave-duration,\s*900ms\)/)
  assert.match(ritualCss, /html\[data-theme-ritual-direction='to-light'\]\[data-theme-ritual-phase='leaving'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?opacity var\(--ritual-to-light-leave-duration,\s*1120ms\)/)
  // @starting-style gives the entering phase a real opacity fade-in. Without it the
  // overlay matches [data-phase='entering']'s opacity:1 rule from the first paint and
  // pops in instantly instead of fading.
  assert.match(ritualCss, /@starting-style\s*\{[\s\S]*\[data-ritual-overlay\][\s\S]*?\[data-phase='entering'\][\s\S]*?opacity:\s*0/)
  // The content fade must target the app-content layer, not the shell, and should
  // keep a faint blurred residual so the existing app glass remains visible instead of a separate plate.
  assert.match(ritualCss, /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-content\s*\{[\s\S]*opacity:\s*0\.(0[1-9]|1\d)[\s\S]*filter:\s*blur\(/)
  assert.match(ritualCss, /html\[data-theme-ritual-phase='holding'\]\s+\.ready-app-content\s*\{[\s\S]*opacity:\s*0\.0[0-9]/)
  // Content restoration rides the full leave duration so it can't produce a mid-leave snap-reveal.
  assert.match(ritualCss, /html\[data-theme-ritual-phase='leaving'\]\s+\.ready-app-content\s*\{[\s\S]*opacity var\(--ritual-leave-duration,\s*900ms\)/)
  assert.match(ritualCss, /html\[data-theme-ritual-direction='to-light'\]\[data-theme-ritual-phase='leaving'\]\s+\.ready-app-content\s*\{[\s\S]*opacity var\(--ritual-to-light-leave-duration,\s*1120ms\)/)
  assert.doesNotMatch(ritualCss, /linear-gradient|radial-gradient/)
  assert.doesNotMatch(ritualCss, /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-shell\s*\{[\s\S]*opacity:\s*0/)

  // Constant colors live in :root so there's one source of truth for the light/dark canvas
  // colors. data-theme/data-skin branches alias these via var() to prevent drift.
  assert.match(styles, /:root\s*\{[\s\S]*--workbench-mode-bg-light:\s*#F6F1E7/)
  assert.match(styles, /:root\s*\{[\s\S]*--workbench-mode-bg-dark:\s*#192131/)
  assert.match(styles, /:root\s*\{[\s\S]*--ritual-overlay-bg:\s*var\(--workbench-mode-bg\)/)
  // [^{]* 容忍选择器列表（fastcard overlay 窗口与主窗共享此规则块）
  assert.match(styles, /html\[data-skin='liquid-glass'\][^{]*\{[\s\S]*?--workbench-mode-bg:\s*var\(--workbench-mode-bg-light\)/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\s*\{[\s\S]*--workbench-mode-bg:\s*var\(--workbench-mode-bg-dark\)/)
  // color-scheme hint is present so native form controls/scrollbars render in the right scheme from the first frame.
  assert.match(styles, /:root\s*\{[\s\S]*color-scheme:\s*light dark/)
  assert.match(styles, /html\[data-theme='dark'\]\s*\{[\s\S]*color-scheme:\s*dark/)

  // Theme glyph uses lucide-matching outline style.
  assert.match(themeChoreography, /viewBox="0 0 48 48"/)
  assert.match(themeChoreography, /stroke="var\(--color-blue\)"/)
  assert.match(themeChoreography, /strokeWidth="2"/)
  assert.match(themeChoreography, /fill="none"/)
  assert.match(themeChoreography, /data-glyph="sun"/)
  assert.match(themeChoreography, /data-glyph="moon"/)

  // Overlay component paints the theme choreography only for theme-transition stage and
  // mirrors the phase + direction onto <html> so CSS can drive the base/content layers.
  assert.match(ritualOverlay, /session\.stage === 'theme-transition'\s*\?\s*<ThemeRitualChoreography/)
  assert.match(ritualOverlay, /data-direction=\{session\.meta\.direction/)
  assert.match(ritualOverlay, /setAttribute\('data-theme-ritual-direction'/)
  // --ritual-hold-duration must be exposed as an inline CSS var so the overlay's bg transition
  // matches the engine's actual holding timeline (not a hardcoded CSS fallback).
  assert.match(ritualOverlay, /--ritual-hold-duration[\s\S]*?holdingMinDurationMs/)

  // The rail settings menu disables the theme toggle while the theme ritual is running.
  assert.match(iconRail, /useRitualOverlayStore/)
  assert.match(iconRail, /state\.session\?\.stage === 'theme-transition'/)
  // 守卫形态演进：disabled prop → 条件调用 + enabled 标志（仪式期间禁切主题的语义不变）
  assert.match(iconRail, /if \(!isThemeRitualRunning\) toggleTheme\(\)/)
  assert.match(iconRail, /enabled: !isThemeRitualRunning/)
})

test('Stage 3 — will-change is scoped to ritual phase only, not in base .ready-app-content rule', () => {
  const ritualCss = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  // base .ready-app-content 规则**不能含** will-change。否则 Chromium 永久把元素提到
  // GPU compositor 层，配合 ritual 的 filter:blur 会缓存 raster；data-theme 翻转后
  // 子元素重栅格化被吃掉，导致部分 UI 颜色不变（Bug 1-A）。
  const baseContentMatch = ritualCss.match(/\n\.ready-app-content\s*\{([\s\S]*?)\n\}/)
  assert.ok(baseContentMatch, 'base .ready-app-content rule should exist')
  const baseBody = baseContentMatch![1]
  assert.doesNotMatch(
    baseBody,
    /will-change/,
    'base .ready-app-content rule MUST NOT include will-change (causes GPU layer caching across ritual)',
  )

  // will-change: opacity 必须只在 ritual phase 期间生效——通过 [data-theme-ritual-phase=...]
  // 限定符。ritual 结束 phase attr 移除时 will-change 也消失，Chromium 释放 GPU 层重栅格化。
  assert.match(
    ritualCss,
    /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-content[\s\S]*?html\[data-theme-ritual-phase='holding'\]\s+\.ready-app-content[\s\S]*?html\[data-theme-ritual-phase='leaving'\]\s+\.ready-app-content\s*\{[\s\S]*?will-change:\s*opacity/,
    'will-change: opacity should be scoped to all three ritual phase selectors',
  )
})

test('Stage 3 — ritual visual parameters unchanged (spec §3.4 red lines)', () => {
  const ritualCss = readWorkspaceFile('src/renderer/styles/ritual-overlay.css')

  // filter: blur(18px) 数值不变（saturate 数值在 0.7x 区间内）
  assert.match(ritualCss, /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-content\s*\{[\s\S]*?filter:\s*blur\(18px\)\s+saturate\(0\.7\d?\)/)
  assert.match(ritualCss, /html\[data-theme-ritual-phase='holding'\]\s+\.ready-app-content\s*\{[\s\S]*?filter:\s*blur\(18px\)\s+saturate\(0\.7\d?\)/)

  // 内容层 opacity 0.06 (entering) / 0.04 (holding) 数值不变
  assert.match(ritualCss, /html\[data-theme-ritual-phase='entering'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity:\s*0\.06/)
  assert.match(ritualCss, /html\[data-theme-ritual-phase='holding'\]\s+\.ready-app-content\s*\{[\s\S]*?opacity:\s*0\.04/)

  // .ready-theme-ritual-tint 的 entering 18% / holding 28% alpha 不变
  assert.match(
    ritualCss,
    /html\[data-theme-ritual-phase='entering'\]\[data-theme-ritual-direction='to-dark'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?color-mix\(in srgb,\s*var\(--workbench-mode-bg-light\)\s*18%,\s*transparent\)/,
    'entering tint (to-dark) must stay at 18% alpha source theme color',
  )
  assert.match(
    ritualCss,
    /html\[data-theme-ritual-phase='holding'\]\[data-theme-ritual-direction='to-dark'\]\s+\.ready-theme-ritual-tint\s*\{[\s\S]*?color-mix\(in srgb,\s*var\(--workbench-mode-bg-dark\)\s*28%,\s*transparent\)/,
    'holding tint (to-dark) must stay at 28% alpha target theme color',
  )
})

test('Stage 3 — no offsetHeight / getComputedStyle reflow hack in theme code (spec §3.4)', () => {
  const themeStore = readWorkspaceFile('src/renderer/stores/useTheme.ts')
  const ritualOverlay = readWorkspaceFile('src/renderer/modules/overlay/useRitualOverlay.ts')
  const appShell = readWorkspaceFile('src/renderer/App.tsx')

  // 这三个文件是 ritual + theme flip 的核心路径。
  // 禁止使用 offsetHeight / getComputedStyle 作为强制 reflow 的 hack——
  // 那是 spec §3.4 明确禁止的修法（不解释根因，靠拍桌子让浏览器重画）。
  for (const [source, name] of [[themeStore, 'useTheme.ts'], [ritualOverlay, 'useRitualOverlay.ts'], [appShell, 'App.tsx']] as const) {
    assert.doesNotMatch(
      source,
      /\.offsetHeight\b/,
      `${name} must not use .offsetHeight as a reflow hack`,
    )
    assert.doesNotMatch(
      source,
      /getComputedStyle/,
      `${name} must not use getComputedStyle as a reflow hack`,
    )
  }
})
