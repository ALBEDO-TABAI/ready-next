import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('Ready blank tab is rendered by the browser chrome layer instead of a hardcoded BrowserView page', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const browserShellLayout = readWorkspaceFile('src/renderer/components/browser/BrowserShellLayout.tsx')
  const tabActions = readWorkspaceFile('src/renderer/modules/browser/useBrowserTabActions.ts')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')

  assert.match(browserMode, /isReadyBrowserBlankUrl/)
  assert.match(browserMode, /const isReadyBlankTab = activeTab \? isReadyBrowserBlankUrl\(activeTab\.url\) : false/)
  assert.match(browserMode, /hasError:\s*hasError \|\| isReadyBlankTab/)

  assert.match(browserShellLayout, /import readyWordmark from '\.\.\/\.\.\/assets\/ready-wordmark\.png'/)
  assert.match(browserShellLayout, /const showReadyBlankPage = activeTab \? isReadyBrowserBlankUrl\(activeTab\.url\) && !activeTab\.error : false/)
  assert.match(browserShellLayout, /const showBrowserViewCornerFill = isElectron && Boolean\(activeTab\) && !showReadyBlankPage && !activeTab\?\.error/)
  assert.match(browserShellLayout, /showBrowserViewCornerFill &&/)
  assert.match(browserShellLayout, /showReadyBlankPage &&/)
  assert.match(browserShellLayout, /className="browser-ready-blank-page absolute inset-0 flex items-center justify-center"/)
  assert.match(browserShellLayout, /background:\s*'var\(--workbench-module-surface-bg\)'/)
  assert.match(browserShellLayout, /src=\{readyWordmark\}/)
  assert.match(browserShellLayout, /width:\s*'min\(210px, calc\(100vw - 96px\)\)'/)

  assert.match(tabActions, /const isClosingLastTab = currentTabs\.length <= 1 \|\| remaining\.length === 0/)
  assert.match(tabActions, /if \(isClosingLastTab\) \{[\s\S]*createTab\(DEFAULT_BROWSER_URL\)/)
  assert.match(tabActions, /setTabs\(\[replacementTab\]\)/)
  assert.match(tabActions, /setUrlInput\(''\)/)
  assert.match(tabActions, /await window\.electronAPI\?\.browser\?\.closeTab\(id\)[\s\S]*await syncTabsFromBackend\(\)[\s\S]*return/)

  assert.match(boundsHook, /\[hasError, isActive, isVisibleAllowed, syncBrowserVisibility\]/)
})
