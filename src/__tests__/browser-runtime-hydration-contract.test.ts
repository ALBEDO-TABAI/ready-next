import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser runtime restores tab truth from the main process and rebuilds native tabs from persisted renderer cache when main is empty', () => {
  const runtimeHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')

  assert.match(runtimeHook, /const existingTabs = await window\.electronAPI\?\.browser\?\.getTabs\(\)/)
  assert.match(runtimeHook, /const rebuildRuntimeFromPersistedTabs = useCallback/)
  assert.match(runtimeHook, /const result = await window\.electronAPI\?\.browser\?\.createTab\(tab\.url\)/)
  assert.match(runtimeHook, /store\.setTabs\(recoveredTabs\)/)
  assert.match(runtimeHook, /window\.electronAPI\?\.browser\?\.switchTab\(nextActiveTabId\)/)
  assert.match(runtimeHook, /const rebuilt = await rebuildRuntimeFromPersistedTabs\(store\)/)
  assert.match(runtimeHook, /if \(rebuilt\) return true/)
  assert.match(runtimeHook, /store\.setTabs\(hydratedTabs\)/)
  assert.match(runtimeHook, /store\.setActiveTabId\(activeTab\?\.id \|\| hydratedTabs\[hydratedTabs\.length - 1\]\?\.id \|\| null\)/)
  assert.match(runtimeHook, /store\.setUrlInput\(activeTab\?\.url === DEFAULT_BROWSER_URL \? '' : activeTab\?\.url \|\| ''\)/)
  assert.doesNotMatch(runtimeHook, /prehydratedTabsExist/)
  assert.doesNotMatch(runtimeHook, /useState\(!isElectron \|\| prehydratedTabsExist\)/)
  assert.doesNotMatch(runtimeHook, /useRef\(!isElectron \|\| prehydratedTabsExist\)/)
  assert.match(runtimeHook, /hydrationPromiseRef\.current = restoreExistingTabs\(\)/)
  assert.match(runtimeHook, /const hasTabs = await hydrationTask/)
  assert.match(runtimeHook, /store\.setTabs\(\[\]\)/)
  assert.match(runtimeHook, /store\.setActiveTabId\(null\)/)
  assert.match(runtimeHook, /store\.setUrlInput\(''\)/)
  assert.doesNotMatch(runtimeHook, /browserTabWarmStart/)
})
