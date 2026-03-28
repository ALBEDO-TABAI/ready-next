import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser startup gates chrome until host restoration completes and main process primes native theme before browser pages load', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const emptyState = readWorkspaceFile('src/renderer/components/browser/BrowserModeEmptyState.tsx')
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const mainIndex = readWorkspaceFile('src/main/index.ts')
  const rendererMain = readWorkspaceFile('src/renderer/main.tsx')
  const preload = readWorkspaceFile('src/preload/index.ts')
  const electronTypes = readWorkspaceFile('src/renderer/types/electron.d.ts')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(browserMode, /const shouldShowStartupPlaceholder =\s*!activeTab\?\.error &&\s*!shouldShowFreezeFrame &&\s*\(!browserRuntimeReady \|\| !isBrowserSurfaceReady\)/)
  assert.match(browserMode, /className="browser-surface-startup-mask"/)
  assert.match(browserMode, /animation:\s*['"]browserStartupSpinner/)
  assert.match(styles, /@keyframes browserStartupSpinner/)

  // Verify startup placeholder does NOT hide the header (unified shell experience)
  assert.doesNotMatch(browserMode, /shouldShowStartupPlaceholder.*\{\s*return\s+null/)
  assert.doesNotMatch(browserMode, /shouldShowStartupPlaceholder.*&&.*<BrowserHeader/)
  assert.match(browserMode, /shouldShowStartupPlaceholder\s*&&\s*\(/)

  // Verify startup mask covers the entire shell (header + content) via absolute positioning
  assert.match(browserMode, /position:\s*'absolute'/)
  assert.match(browserMode, /inset:\s*0/)
  assert.match(browserMode, /zIndex:\s*50/)
  assert.match(browserMode, /borderRadius:\s*'var\(--workbench-canvas-radius\)'/)

  // Verify the startup mask has pointerEvents: 'auto' to absorb interactions during load
  assert.match(browserMode, /pointerEvents:\s*'auto'/)

  assert.match(runtimeHook, /const \[browserRuntimeReady, setBrowserRuntimeReady\] = useState\(!isElectron\)/)
  assert.match(runtimeHook, /const hasHydratedRuntimeRef = useRef\(!isElectron\)/)
  assert.match(runtimeHook, /const hydrationPromiseRef = useRef<Promise<boolean> \| null>\(null\)/)
  assert.match(runtimeHook, /const ensureBrowserRuntime = useCallback\(async \(\{ allowNewTab \}: \{ allowNewTab: boolean \}\) => \{/)
  assert.match(runtimeHook, /void ensureBrowserRuntime\(\{ allowNewTab: false \}\)/)
  assert.match(runtimeHook, /const hasTabs = await ensureBrowserRuntime\(\{ allowNewTab: true \}\)/)
  assert.match(runtimeHook, /if \(!isActive\) \{[\s\S]*if \(!hasHydratedRuntimeRef\.current\) \{[\s\S]*setBrowserRuntimeReady\(false\)/)
  assert.match(runtimeHook, /setBrowserRuntimeReady\(true\)/)
  assert.match(browserMode, /const \{\s*browserRuntimeReady,\s*\} = useBrowserRuntimeEffects\(/)
  assert.match(browserMode, /const shouldPresentBrowserHost = isActive && isMotionSettled/)
  assert.match(browserMode, /useEffect\(\(\) => \{[\s\S]*if \(!isElectron \|\| !shouldPresentBrowserHost\) return/)
  assert.match(browserMode, /if \(!browserRuntimeReady \|\| tabs\.length === 0\) \{[\s\S]*browser\?\.hideAll\?\.\(\)/)
  assert.match(browserMode, /await sendBoundsImmediate\(\{ forceExact: true \}\)/)
  assert.match(browserMode, /await window\.electronAPI\?\.browser\?\.showActive\?\.\(\)/)
  assert.match(browserMode, /const hostVisibleRef = useRef\(false\)/)
  assert.match(browserMode, /hostVisibleRef\.current = browserRuntimeReady && tabs\.length > 0/)
  assert.match(browserMode, /if \(!browserRuntimeReady \|\| tabs\.length === 0\)/)
  assert.match(browserMode, /<BrowserModeEmptyState onNewTab=\{handleNewTab\} contentRef=\{contentRef\} loading=\{!browserRuntimeReady\}/)
  assert.doesNotMatch(browserMode, /startupRevealSentRef/)
  assert.doesNotMatch(browserMode, /readyToShow/)
  assert.match(emptyState, /loading\?: boolean/)
  assert.match(emptyState, /loading \? '浏览器启动中…' : '当前没有打开的标签页'/)
  assert.match(rendererMain, /const themeResult = await window\.electronAPI\?\.theme\.get\(\)/)
  assert.doesNotMatch(rendererMain, /window\.electronAPI\?\.browser\?\.getTabs\(\)/)
  assert.doesNotMatch(rendererMain, /useBrowserTabs\.setState\(/)
  assert.doesNotMatch(rendererMain, /readyToShow/)
  assert.match(preload, /get: \(\) => ipcRenderer\.invoke\('theme:get'\)/)
  assert.match(electronTypes, /get: \(\) => Promise<\{ success: boolean; data\?: \{ option: ThemeOption; resolved: ResolvedTheme \}; error\?: string \}>/)
  assert.doesNotMatch(preload, /readyToShow:/)
  assert.doesNotMatch(electronTypes, /readyToShow:/)
  assert.match(mainIndex, /const THEME_SETTING_KEY = 'ui_theme_option'/)
  assert.match(mainIndex, /ipcMain\.handle\('theme:get'/)
  assert.doesNotMatch(mainIndex, /window:readyToShow/)
  assert.doesNotMatch(mainIndex, /flushWindowReveal/)
  assert.doesNotMatch(mainIndex, /rendererReadyToShow/)
  assert.match(mainIndex, /nativeTheme\.themeSource = resolveStoredThemeSource\(\)/)
  assert.match(mainIndex, /getDatabase\(\)\.setSetting\(THEME_SETTING_KEY, nextTheme\)/)
})
