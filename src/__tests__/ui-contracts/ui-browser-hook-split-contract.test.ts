import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser mode delegates panel data and diagnostics synchronization to focused hooks', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const tabActionsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserTabActions.ts')

  assert.match(browserMode, /import \{ useBrowserPanelData \} from/)
  assert.match(browserMode, /import \{ useBrowserDiagnosticsState \} from/)
  assert.match(browserMode, /import \{ useBrowserRuntimeEffects \} from/)
  assert.match(browserMode, /import \{ useBrowserTabActions \} from/)
  assert.match(browserMode, /import BrowserDiagnosticsDock from/)
  assert.match(browserMode, /const \{\s*isBookmarked,/)
  assert.match(browserMode, /useBrowserDiagnosticsState\(/)
  assert.match(browserMode, /useBrowserTabActions\(/)
  assert.match(browserMode, /adblockState,/)
  assert.match(browserMode, /useBrowserRuntimeEffects\(/)
  assert.doesNotMatch(browserMode, /const \[bookmarks, setBookmarks\] = useState/)
  assert.doesNotMatch(browserMode, /const \[historyItems, setHistoryItems\] = useState/)
  assert.doesNotMatch(browserMode, /const \[downloads, setDownloads\] = useState/)
  assert.doesNotMatch(browserMode, /const \[adblockState, setAdblockState\] = useState/)
  assert.doesNotMatch(browserMode, /const \[browserDiagnostics, setBrowserDiagnostics\] = useState/)
  assert.doesNotMatch(browserMode, /const handleNewTab = useCallback/)
  assert.doesNotMatch(browserMode, /const handleCloseTab = useCallback/)
  assert.doesNotMatch(browserMode, /const handleNavigate = useCallback/)
  assert.doesNotMatch(browserMode, /onTabUpdate/)
  assert.doesNotMatch(browserMode, /onTabOpened/)
  assert.match(browserMode, /<BrowserDiagnosticsDock/)
  assert.match(browserMode, /browserDiagnostics=\{browserDiagnostics\}/)
  assert.match(browserMode, /onRefresh=\{\(\) => void refreshAdblockState\(\)\}/)
  assert.match(runtimeHook, /browser\?\.getTabs\(\)/)
  assert.match(runtimeHook, /setTabs\(/)
  assert.match(runtimeHook, /setActiveTabId\(/)
  assert.match(runtimeHook, /await sendBoundsImmediate\(\{ forceExact: true \}\)/)
  assert.match(runtimeHook, /onTabOpened\(\(tab: BrowserTabOpenedEvent\) => \{[\s\S]*store\.setActiveTabId\(openedTab\.id\)/)
  assert.doesNotMatch(runtimeHook, /window\.electronAPI\?\.browser\?\.showActive\(\)/)
  assert.doesNotMatch(runtimeHook, /window\.electronAPI\?\.browser\?\.hideAll\(\)/)
  assert.match(tabActionsHook, /await sendBoundsImmediate\(\{ forceExact: true \}\)/)
})
