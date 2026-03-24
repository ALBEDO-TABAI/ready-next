import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser mode delegates top-level browser chrome to BrowserHeader', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const emptyState = readWorkspaceFile('src/renderer/components/browser/BrowserModeEmptyState.tsx')

  assert.match(browserMode, /import BrowserHeader from ['"]\.\.\/\.\.\/components\/browser\/BrowserHeader['"]/)
  assert.match(browserMode, /<BrowserHeader/)
  assert.doesNotMatch(browserMode, /import BrowserTabBar from/)
  assert.doesNotMatch(browserMode, /import BrowserAddressBar from/)
  assert.doesNotMatch(browserMode, /<BrowserTabBar/)
  assert.doesNotMatch(browserMode, /<BrowserAddressBar/)
  assert.match(browserMode, /<BrowserModeEmptyState onNewTab=\{handleNewTab\} contentRef=\{contentRef\}/)
  assert.match(emptyState, /contentRef: RefObject<HTMLDivElement \| null>/)
  assert.match(emptyState, /ref=\{contentRef\}/)
})

test('browser header owns a dedicated interaction state hook for active-tab and refresh-dock modes', () => {
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const interactionHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserHeaderInteraction.ts')

  assert.match(browserHeader, /useBrowserHeaderInteraction\(/)
  assert.match(interactionHook, /activeTabMode/)
  assert.match(interactionHook, /'compact'/)
  assert.match(interactionHook, /'primed'/)
  assert.match(interactionHook, /'expanded'/)
  assert.match(interactionHook, /'editing'/)
  assert.match(interactionHook, /refreshDockMode/)
  assert.match(interactionHook, /'idle'/)
  assert.match(interactionHook, /'revealed'/)
  assert.match(interactionHook, /headerRootRef\s*=\s*useRef/)
})

test('browser header renders a dedicated tab rail and active-tab surface', () => {
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const tabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')
  const activeTabSurface = readWorkspaceFile('src/renderer/components/browser/ActiveTabSurface.tsx')

  assert.match(browserHeader, /import TabRail from ['"].\/TabRail['"]/)
  assert.match(browserHeader, /<TabRail/)
  assert.doesNotMatch(browserHeader, /import BrowserTabBar from/)
  assert.doesNotMatch(browserHeader, /import BrowserAddressBar from/)

  assert.match(tabRail, /import ActiveTabSurface from ['"].\/ActiveTabSurface['"]/)
  assert.match(tabRail, /<ActiveTabSurface/)
  assert.match(activeTabSurface, /data-browser-active-hotspot/)
  assert.match(activeTabSurface, /onToggleBookmark/)
  assert.match(activeTabSurface, /onClose/)
  assert.match(activeTabSurface, /<input/)
})

test('browser header extracts refresh dock and right-side utility actions into focused components', () => {
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const tabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')
  const refreshDock = readWorkspaceFile('src/renderer/components/browser/RefreshDock.tsx')
  const utilityActions = readWorkspaceFile('src/renderer/components/browser/HeaderUtilityActions.tsx')

  assert.match(browserHeader, /import HeaderUtilityActions from ['"].\/HeaderUtilityActions['"]/)
  assert.match(browserHeader, /<HeaderUtilityActions/)
  assert.doesNotMatch(browserHeader, /import RefreshDock from ['"].\/RefreshDock['"]/)
  assert.doesNotMatch(browserHeader, /<RefreshDock/)
  assert.match(tabRail, /import RefreshDock from ['"].\/RefreshDock['"]/)
  assert.match(tabRail, /<RefreshDock/)
  assert.match(tabRail, /<RefreshDock[\s\S]*?<ActiveTabSurface/)
  assert.match(refreshDock, /loading/)
  assert.match(refreshDock, /canGoBack/)
  assert.match(refreshDock, /canGoForward/)
  assert.match(refreshDock, /refreshDockMode/)
  assert.match(utilityActions, /activePanel/)
  assert.match(utilityActions, /onTogglePanel/)
  assert.match(utilityActions, /onOpenExternal/)
  assert.match(utilityActions, /onPrint/)
})

test('tab rail can toggle bookmarks from explicit tab affordances, not only from the active address surface', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const panelDataHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserPanelData.ts')
  const tabRail = readWorkspaceFile('src/renderer/components/browser/TabRail.tsx')

  assert.match(panelDataHook, /handleToggleBookmarkForTab/)
  assert.match(browserMode, /handleToggleBookmarkForTab/)
  assert.match(tabRail, /onToggleBookmarkForTab/)
  assert.match(tabRail, /onToggleBookmarkForTab\(tab\)/)
})

test('browser shell layout adds corner fillers so the header chrome visually meets the page surface', () => {
  const browserShellLayout = readWorkspaceFile('src/renderer/components/browser/BrowserShellLayout.tsx')

  assert.match(browserShellLayout, /browser-shell-corner-fill-left/)
  assert.match(browserShellLayout, /browser-shell-corner-fill-right/)
  assert.doesNotMatch(browserShellLayout, /marginRight:\s*WORKBENCH_HEADER_EDGE_X/)
})
