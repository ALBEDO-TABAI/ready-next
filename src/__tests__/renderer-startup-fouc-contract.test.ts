import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('renderer first frame already carries data-theme + data-skin to prevent FOUC into the debug-white state', () => {
  const indexHtml = readWorkspaceFile('src/renderer/index.html')
  const rendererMain = readWorkspaceFile('src/renderer/main.tsx')
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  // CSP must still allow inline scripts — the head bootstrap runs inline, before main.tsx.
  assert.match(
    indexHtml,
    /Content-Security-Policy[\s\S]*script-src[^;]*'unsafe-inline'/,
    'CSP must allow inline scripts for the head theme-bootstrap to execute',
  )

  // An inline <script> in <head> must synchronously seed data-theme + data-skin from localStorage
  // so the first paint already resolves the liquid-glass cascade instead of the :root default.
  const headMatch = indexHtml.match(/<head[\s\S]*?<\/head>/i)
  assert.ok(headMatch, 'index.html must have a <head>')
  const headSection = headMatch![0]
  assert.match(headSection, /<script>[\s\S]*localStorage\.getItem\(['"]ready-theme['"]\)[\s\S]*<\/script>/)
  assert.match(headSection, /setAttribute\(['"]data-theme['"]/)
  assert.match(headSection, /setAttribute\(['"]data-skin['"]/)
  assert.match(headSection, /localStorage\.getItem\(['"]ready-theme-skin['"]\)/)
  // system mode should resolve to prefers-color-scheme result, not fall back to light.
  assert.match(headSection, /prefers-color-scheme: dark/)

  // main.tsx is now a reconciler — it aligns localStorage/DOM with the main-process source after the first paint,
  // rather than being the first code to write data-theme.
  assert.match(rendererMain, /reconcileStartupTheme/)
  assert.match(rendererMain, /const themeResult = await window\.electronAPI\?\.theme\.get\(\)/)
  assert.doesNotMatch(rendererMain, /hydrateStartupTheme/)

  // Windows/Linux get a theme-matched backgroundColor at window creation so the native frame
  // doesn't flash white before the renderer paints.
  assert.match(
    mainIndex,
    /backgroundColor:\s*process\.platform === 'darwin' \? '#00000000' : nonMacFirstFrameBg/,
  )
  assert.match(mainIndex, /nonMacFirstFrameBg = nativeTheme\.shouldUseDarkColors \? '#1A1B1E' : '#F7F9FC'/)
})

test('Stage 1 — reconcileStartupTheme syncs four <html> attrs from main snapshot', () => {
  const rendererMain = readWorkspaceFile('src/renderer/main.tsx')

  // theme:get 现在返回 { option, resolved, skin, isNativeFullscreen }；
  // reconcileStartupTheme 必须把这四个值映射到 4 个 <html> attr。
  assert.match(rendererMain, /skin/, 'reconcileStartupTheme should read skin from snapshot')
  assert.match(rendererMain, /isNativeFullscreen/, 'reconcileStartupTheme should read isNativeFullscreen')

  // data-theme = resolved
  assert.match(rendererMain, /setAttribute\(['"]data-theme['"]/)
  // data-skin 永远是 'liquid-glass'（与 useTheme.applySkin 行为一致，兼容 CSS selector）
  assert.match(rendererMain, /setAttribute\(['"]data-skin['"],\s*['"]liquid-glass['"]\)/)
  // data-glass-backdrop = 'ready' 或 'native'（按 skin 派生）
  assert.match(rendererMain, /setAttribute\(['"]data-glass-backdrop['"]/)
  // data-native-fullscreen 仅在 isNativeFullscreen=true 时设置；否则 removeAttribute
  assert.match(rendererMain, /setAttribute\(['"]data-native-fullscreen['"]/)
  assert.match(rendererMain, /removeAttribute\(['"]data-native-fullscreen['"]\)/)
})

test('Stage 1 — theme:get IPC response shape includes skin and isNativeFullscreen', () => {
  const mainIndex = readWorkspaceFile('src/main/index.ts')

  // ThemeSnapshot type must carry skin + isNativeFullscreen
  assert.match(mainIndex, /skin:\s*ThemeSkin/)
  assert.match(mainIndex, /isNativeFullscreen:/)

  // getThemeSnapshot must populate all four fields
  const snapshotFnMatch = mainIndex.match(/function getThemeSnapshot[\s\S]*?\n\}/)
  assert.ok(snapshotFnMatch, 'getThemeSnapshot function should exist')
  const snapshotBody = snapshotFnMatch![0]
  assert.match(snapshotBody, /option:/)
  assert.match(snapshotBody, /resolved:/)
  assert.match(snapshotBody, /skin:/)
  assert.match(snapshotBody, /isNativeFullscreen:/)
})

test('Stage 1+2.5 — fullscreen backing is handled by main process bg only (no DOM CSS fallback)', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  // Stage 2.5: 删除了 .ready-app-shell[data-native-fullscreen]  CSS 规则。
  // 历史背景：原本是"防 IPC 延迟"的双保险，但实测发现 .ready-app-shell 在 isolation:isolate
  // compositor 层上对 CSS 变量级联响应不及时，导致全屏中切主题时视觉卡死。
  // 改成：main 进程的 setBackgroundColor 是 backing 色的唯一来源，DOM 层 .ready-app-shell 永远透明。
  assert.doesNotMatch(
    styles,
    /html\[data-native-fullscreen='true'\][\s\S]*?\.ready-app-shell\s*\{[\s\S]*?background:\s*var\(--ready-native-fullscreen-bg\)/,
    'fullscreen backing CSS rule on .ready-app-shell should be removed (main process bg is single source of truth)',
  )
  // --ready-native-fullscreen-bg 变量定义也应该清掉（CSS 里不再有消费者）
  assert.doesNotMatch(styles, /--ready-native-fullscreen-bg:/)

  // 但 data-native-fullscreen attr 本身还是要设/清的——给未来可能的 renderer 状态判断用，
  // 也作为"main 进程 fullscreen lifecycle 已通知 renderer"的可观察信号。
  // 测试 1 已断言 reconcileStartupTheme 仍然同步这个 attr。

  // data-glass-backdrop='native' 让 --app-bg-overlay-opacity 变 0（藏掉 .ready-app-bg 渐变，
  // 让 vibrancy 桌面壁纸做底）；data-glass-backdrop='ready' 不覆盖，沿用 liquid-glass scope 的 1
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='native'\]\s*\{[\s\S]*?--app-bg-overlay-opacity:\s*0/,
  )

  // 不再有 .ready-app-bg { opacity: 0 } 硬覆盖（旧的两条规则已删，改用变量级联）
  assert.doesNotMatch(
    styles,
    /html\[data-skin='liquid-glass'\]\s*\.ready-app-bg\s*\{\s*background:\s*transparent;\s*opacity:\s*0/,
    '.ready-app-bg opacity:0 hard overrides should be removed (variable cascade handles it)',
  )
})
