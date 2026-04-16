import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser bootstrap keeps the shell in an empty state until navigation is explicit', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const tabActions = readWorkspaceFile('src/renderer/modules/browser/useBrowserTabActions.ts')

  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*urlInput=\{urlInput\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onUrlChange=\{setUrlInput\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onNavigate=\{\(\) => void handleNavigate\(\)\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onFocus=\{handleUrlFocus\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onBlur=\{handleUrlBlur\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onEditStart=\{handleBrowserEditStart\}/)
  assert.match(browserMode, /<BrowserModeEmptyState[\s\S]*onEditEnd=\{handleBrowserEditEnd\}/)

  assert.match(tabActions, /if \(!activeTabId\) \{[\s\S]*window\.electronAPI\?\.browser\?\.createTab\(targetUrl\)/)
  assert.doesNotMatch(runtimeHook, /const hasTabs = await ensureBrowserRuntime\(\{ allowNewTab: true \}\)/)
  assert.match(runtimeHook, /const hasTabs = await ensureBrowserRuntime\(\)/)
})
