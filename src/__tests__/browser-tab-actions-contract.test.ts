import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser tab actions resync renderer tabs from backend truth after create, switch, and close', () => {
  const source = readWorkspaceFile('src/renderer/modules/browser/useBrowserTabActions.ts')

  assert.match(source, /const syncTabsFromBackend = useCallback\(async \(\) => \{/)
  assert.match(source, /const backendTabs = await window\.electronAPI\?\.browser\?\.getTabs\?\.\(\)/)
  // syncTabsFromBackend reconciles through the group-preserving merge (P1 §6): the
  // backend member set + metadata win, renderer-only order + groupId are preserved.
  assert.match(source, /setTabs\(mergeBackendTabsPreservingGroups\(useBrowserTabs\.getState\(\)\.tabs, hydratedTabs\)\)/)
  assert.match(source, /setActiveTabId\(activeTab\?\.id \|\| hydratedTabs\[hydratedTabs\.length - 1\]\?\.id \|\| null\)/)
  assert.match(source, /setUrlInput\(activeTab\?\.url === DEFAULT_BROWSER_URL \? '' : activeTab\?\.url \|\| ''\)/)
  assert.match(source, /await syncTabsFromBackend\(\)/)
})
