import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser bootstrap restores tabs from the main process and auto-opens the default page once on cold start when no real tab exists', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')

  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*urlInput=\{urlInput\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onUrlChange=\{setUrlInput\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onNavigate=\{\(\) => void handleNavigate\(\)\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onFocus=\{handleUrlFocus\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onBlur=\{handleUrlBlur\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onEditStart=\{handleBrowserEditStart\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onEditEnd=\{handleBrowserEditEnd\}/)

  assert.match(runtimeHook, /const startupDefaultTabBootstrapRef = useRef\(!isElectron\)/)
  assert.match(
    runtimeHook,
    /const bootstrapDefaultStartupTab = useCallback\(async \(\) => \{[\s\S]*window\.electronAPI\?\.browser\?\.createTab\(DEFAULT_BROWSER_URL\)[\s\S]*store\.setActiveTabId\(result\.tabId\)[\s\S]*store\.setUrlInput\(''\)/,
  )
  assert.match(
    runtimeHook,
    /if \(!hasTabs && !startupDefaultTabBootstrapRef\.current\) \{[\s\S]*startupDefaultTabBootstrapRef\.current = true[\s\S]*hasTabs = await bootstrapDefaultStartupTab\(\)/,
  )
  assert.match(runtimeHook, /let hasTabs = await ensureBrowserRuntime\(\)/)
  assert.doesNotMatch(runtimeHook, /allowNewTab: true/)
})
