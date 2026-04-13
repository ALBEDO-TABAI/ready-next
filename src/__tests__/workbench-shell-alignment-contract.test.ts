import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('topbar module switcher uses stable widths and avoids vertical position jitter during mode changes', () => {
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const draggableModeTabs = readWorkspaceFile('src/renderer/components/layout/DraggableModeTabs.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')

  assert.match(topBar, /<DraggableModeTabs/)
  assert.doesNotMatch(topBar, /GooeySegmentedControl/)
  assert.match(draggableModeTabs, /className="draggable-mode-tabs"/)
  assert.match(draggableModeTabs, /className={`draggable-mode-tabs__icon/)
  assert.match(draggableModeTabs, /transform: `translateX\(\$\{position \* 100\}%\)`/)
  assert.match(iconRail, /hover:bg-\[var\(--bg-hover\)\]/)
})

test('browser rss and calendar shells align their left edge with the shared workbench canvas contract', () => {
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const calendarShell = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')
  const workbenchTabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(browserHeader, /className="browser-header-surface glass-surface-panel flex-shrink-0"/)
  assert.match(browserHeader, /paddingLeft: WORKBENCH_HEADER_EDGE_X/)
  assert.match(workbenchTabs, /className="workbench-tabs-surface glass-surface-panel flex-shrink-0"/)
  assert.match(documentMode, /className="document-path-bar flex items-center min-w-0"/)
  assert.match(markdownEditor, /className="panel-hover-scrollbar document-editor-surface flex-1 overflow-auto"/)
  assert.match(markdownEditor, /className="panel-hover-scrollbar document-preview-surface flex-1 overflow-auto"/)

  assert.match(rssFeed, /WORKBENCH_HEADER_EDGE_X/)
  assert.match(rssFeed, /className="rss-feed-surface/)
  assert.match(rssFeed, /rss-workbench-surface/)
  assert.match(rssFeed, /content-surface-panel/)
  assert.match(rssFeed, /flex flex-col h-full/)
  assert.match(rssFeed, /className="rss-feed-toolbar flex items-center justify-between flex-shrink-0"/)
  assert.match(rssFeed, /className="rss-feed-list rss-feed-scroll flex-1 overflow-auto transition-all duration-300"/)
  assert.match(rssFeed, /padding:\s*`0 \$\{WORKBENCH_HEADER_EDGE_X\}px 16px`/)
  assert.match(rssFeed, /padding:\s*`12px \$\{WORKBENCH_HEADER_EDGE_X\}px`/)

  assert.match(calendarMode, /import CalendarWorkbenchShell/)
  assert.match(calendarMode, /<CalendarWorkbenchShell/)
  assert.match(calendarShell, /className="workbench-mode-root calendar-mode-shell"/)
  assert.match(calendarShell, /className="workbench-canvas-shell flex h-full min-h-0 overflow-hidden"/)
  assert.match(calendarShell, /background: 'rgba\(241, 244, 249, 0\.94\)'/)
  assert.doesNotMatch(calendarShell, /borderRadius: 0/)
  assert.doesNotMatch(calendarShell, /borderTopRightRadius:/)
  assert.doesNotMatch(calendarShell, /borderBottomRightRadius:/)
  assert.doesNotMatch(calendarShell, /className="content-surface-panel flex-1 flex flex-col"/)
  assert.doesNotMatch(calendarShell, /className="panel-hover-scrollbar content-surface-panel/)
  assert.doesNotMatch(calendarShell, /borderBottom: '1px solid transparent'/)
  assert.match(scheduleCss, /\.sx__week-header\s*\{\s*border-bottom:\s*none !important;/)
  assert.match(scheduleCss, /\.sx__week-header-border\s*\{\s*display:\s*none !important;/)
  assert.match(scheduleCss, /--sx-ready-liquid-neutral-bg:\s*rgba\(247,\s*248,\s*251,\s*0\.96\);/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__calendar-wrapper \{[\s\S]*background: var\(--sx-ready-liquid-neutral-bg\) !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__calendar-wrapper \{[\s\S]*backdrop-filter: blur\(18px\) saturate\(0%\);/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__calendar,\s*html\[data-skin='liquid-glass'\] \.sx-react-calendar-wrapper \{[\s\S]*border-radius: 0 !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-wrapper,[\s\S]*background: var\(--sx-ready-liquid-neutral-bg\) !important;/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.calendar-mode-shell \.workbench-canvas-shell \{/)
  assert.match(styles, /background: rgba\(241, 244, 249, 0\.94\) !important;/)
  assert.match(styles, /border: 1px solid rgba\(224, 230, 240, 0\.96\) !important;/)
  assert.match(styles, /--workbench-liquid-chrome-bg:\s*rgba\(241,\s*244,\s*249,\s*0\.94\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.browser-header-surface,[\s\S]*\.workbench-tabs-surface,[\s\S]*\.document-path-bar,[\s\S]*\.document-editor-surface,[\s\S]*\.document-preview-surface,[\s\S]*\.rss-workbench-surface \{/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.browser-header-surface,[\s\S]*backdrop-filter:\s*blur\(20px\) saturate\(0%\) !important;/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.rss-feed-toolbar,[\s\S]*\.rss-feed-list \{/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.rss-feed-toolbar,[\s\S]*backdrop-filter:\s*blur\(20px\) saturate\(0%\) !important;/)
})

test('browser visibility handoff cancels stale re-show work and rss shell keeps a rounded outline in liquid glass', () => {
  const browserRuntimeEffects = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const tabShell = readWorkspaceFile('src/main/modules/browser-engine/tab-shell-service.ts')
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.doesNotMatch(browserRuntimeEffects, /window\.electronAPI\?\.browser\?\.hideAll\(\)/)
  assert.doesNotMatch(browserRuntimeEffects, /window\.electronAPI\?\.browser\?\.showActive\(\)/)
  assert.doesNotMatch(browserRuntimeEffects, /window\.electronAPI\?\.browser\?\.switchTab\(currentActive\)/)
  assert.match(browserRuntimeEffects, /cancelAnimationFrame\(activationFrameRef\.current\)/)
  assert.match(boundsHook, /if \(!isActive\) return/)
  assert.match(boundsHook, /window\.electronAPI\?\.browser\?\.showActive\(\)/)
  assert.match(tabShell, /if \(!this\.host\.shouldPresentHosts\(\)\) \{\s*return \{ success: true \}/)
  assert.match(hostLayout, /showHost\(view: BrowserHostView, bounds: BrowserRect\): void \{[\s\S]*this\.setHostBoundsNow\(view, bounds\)/)

  assert.match(styles, /html\[data-skin='liquid-glass'\] \.rss-mode-shell \.workbench-canvas-shell \{/)
  assert.match(styles, /border-color:\s*var\(--lg-border-soft\) !important;/)
})
