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

  assert.match(runtimeHook, /const \[browserRuntimeReady, setBrowserRuntimeReady\] = useState\(!isElectron\)/)
  assert.match(runtimeHook, /setBrowserRuntimeReady\(false\)/)
  assert.match(runtimeHook, /setBrowserRuntimeReady\(true\)/)
  assert.match(browserMode, /const \{\s*browserRuntimeReady,\s*\} = useBrowserRuntimeEffects\(/)
  assert.match(browserMode, /if \(!browserRuntimeReady \|\| tabs\.length === 0\)/)
  assert.match(browserMode, /<BrowserModeEmptyState onNewTab=\{handleNewTab\} contentRef=\{contentRef\} loading=\{!browserRuntimeReady\}/)
  assert.match(emptyState, /loading\?: boolean/)
  assert.match(emptyState, /loading \? '浏览器启动中…' : '当前没有打开的标签页'/)
  assert.match(mainIndex, /const THEME_SETTING_KEY = 'ui_theme_option'/)
  assert.match(mainIndex, /nativeTheme\.themeSource = resolveStoredThemeSource\(\)/)
  assert.match(mainIndex, /getDatabase\(\)\.setSetting\(THEME_SETTING_KEY, nextTheme\)/)
})
