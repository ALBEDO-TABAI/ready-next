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

test('验证 3 — reconcileStartupTheme guards data-native-fullscreen against HTML5 fullscreen active state', () => {
  const rendererMain = readWorkspaceFile('src/renderer/main.tsx')

  // 启动 reconciliation 必须 AND-NOT：data-native-fullscreen='true' 仅在
  //   (isNativeFullscreen=true) ∧ (document.fullscreenElement 为空) 时设置。
  // 防 OOPIF 路径下 isNativeFullscreen 残留在 main snapshot 里、又叠加 HTML5 fullscreen 时
  // 把"外框黑"状态在首帧就引入。
  assert.match(
    rendererMain,
    /document\.fullscreenElement/,
    'reconcileStartupTheme must consult document.fullscreenElement to gate data-native-fullscreen',
  )
  assert.match(
    rendererMain,
    /isNativeFullscreen\s*&&\s*!htmlFullscreenActive|!htmlFullscreenActive\s*&&\s*isNativeFullscreen/,
    'reconcileStartupTheme must gate setAttribute with (isNativeFullscreen && !htmlFullscreenActive)',
  )
})

test('验证 3 — App.tsx subscribes to fullscreenchange + IPC, AND-NOT reconciles data-native-fullscreen', () => {
  const appTsx = readWorkspaceFile('src/renderer/App.tsx')

  // 关键：renderer 必须独立侦测 HTML5 fullscreen 状态（OOPIF 路径下 BrowserWindow.leave-full-screen
  // IPC 可能不可靠 fire；fullscreenchange 是 W3C 标准事件，renderer 内部同步触发）。
  // 防 iframe 视频全屏退出后 attr 卡死在 'true' 让 .ready-app-bg dark gradient 透过 glass surface 显成"外框黑屏"。
  assert.match(
    appTsx,
    /addEventListener\(['"]fullscreenchange['"]/,
    'App.tsx must subscribe to document.fullscreenchange to track HTML5 fullscreen state independently',
  )
  assert.match(
    appTsx,
    /removeEventListener\(['"]fullscreenchange['"]/,
    'fullscreenchange listener must be cleaned up on unmount',
  )
  // 必须同时订阅 IPC（authoritative 的 native fullscreen 状态）
  assert.match(appTsx, /onFullscreenChanged/, 'App.tsx must still subscribe to native fullscreen IPC')
  // 两个信号必须 AND-NOT 出 data-native-fullscreen
  assert.match(
    appTsx,
    /nativeWindowFullscreenFromIPC\s*&&\s*!htmlFullscreenActive|!htmlFullscreenActive\s*&&\s*nativeWindowFullscreenFromIPC/,
    'data-native-fullscreen must be (nativeWindowFullscreenFromIPC && !htmlFullscreenActive) — IPC is authoritative for native state, fullscreenchange for HTML5 state',
  )
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

test('验证 2 — fullscreen backing is handled by DOM .ready-app-bg, not BrowserWindow.setBackgroundColor', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  // 验证 2：BrowserWindow 的 bg 在 darwin 上永远透明（'#00000000'），
  // fullscreen backing 改由 DOM 层 `.ready-app-bg` 通过 `--app-bg-overlay-opacity` 控制。
  // 这条 CSS 规则是 fullscreen backing 的唯一 DOM-side 来源。
  // 设计动机：避免 BrowserWindow.setBackgroundColor 的"opaque→transparent"切换让 macOS
  // NSVisualEffectView 静默 quiesce（用户报：全屏退出 / ready-glass→liquid-glass 后整片黑屏）。
  assert.match(
    styles,
    /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='native'\]\[data-native-fullscreen='true'\]\s*\{[\s\S]*?--app-bg-overlay-opacity:\s*1/,
    'liquid-glass + native + fullscreen must opt .ready-app-bg into visible (opacity=1) via --app-bg-overlay-opacity (validation 2)',
  )

  // 旧的 .ready-app-shell 全屏 backing 规则（Stage 2.5 删除）不能复活
  assert.doesNotMatch(
    styles,
    /html\[data-native-fullscreen='true'\][\s\S]*?\.ready-app-shell\s*\{[\s\S]*?background:\s*var\(--ready-native-fullscreen-bg\)/,
    '.ready-app-shell fullscreen backing rule must stay deleted (Stage 2.5 found it caused compositor cache issues)',
  )
  assert.doesNotMatch(styles, /--ready-native-fullscreen-bg:/, '--ready-native-fullscreen-bg variable retired')

  // data-glass-backdrop='native' 默认（无 fullscreen）让 --app-bg-overlay-opacity=0
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
