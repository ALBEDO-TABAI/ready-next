import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('topbar module switcher uses stable widths and avoids vertical position jitter during mode changes', () => {
  const topBar = readWorkspaceFile('src/renderer/components/layout/TopBar.tsx')
  const iconRail = readWorkspaceFile('src/renderer/components/layout/IconRail.tsx')

  assert.match(topBar, /className="mode-tab-button relative flex h-\[24px\] w-\[34px\]/)
  assert.doesNotMatch(topBar, /GooeySegmentedControl/)
  assert.match(topBar, /transition-colors duration-150/)
  assert.match(iconRail, /hover:bg-\[var\(--bg-hover\)\]/)
})

test('browser rss and calendar shells align their left edge with the shared workbench canvas contract', () => {
  const browserTabBar = readWorkspaceFile('src/renderer/components/browser/BrowserTabBar.tsx')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(browserTabBar, /className="glass-surface-panel flex-shrink-0"/)
  assert.match(browserTabBar, /paddingLeft: WORKBENCH_HEADER_EDGE_X/)

  assert.match(rssFeed, /WORKBENCH_HEADER_EDGE_X/)
  assert.match(rssFeed, /padding:\s*`0 \$\{WORKBENCH_HEADER_EDGE_X\}px 16px`/)
  assert.match(rssFeed, /padding:\s*`12px \$\{WORKBENCH_HEADER_EDGE_X\}px`/)

  assert.match(calendarMode, /className="workbench-mode-root calendar-mode-shell"/)
  assert.match(calendarMode, /className="workbench-canvas-shell flex h-full min-h-0 overflow-hidden"/)
  assert.match(calendarMode, /background: 'rgba\(241, 244, 249, 0\.94\)'/)
  assert.doesNotMatch(calendarMode, /borderRadius: 0/)
  assert.doesNotMatch(calendarMode, /borderTopRightRadius:/)
  assert.doesNotMatch(calendarMode, /borderBottomRightRadius:/)
  assert.doesNotMatch(calendarMode, /className="content-surface-panel flex-1 flex flex-col"/)
  assert.doesNotMatch(calendarMode, /className="panel-hover-scrollbar content-surface-panel/)
  assert.doesNotMatch(calendarMode, /borderBottom: '1px solid transparent'/)
  assert.match(scheduleCss, /\.sx__week-header\s*\{\s*border-bottom:\s*none !important;/)
  assert.match(scheduleCss, /\.sx__week-header-border\s*\{\s*display:\s*none !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__calendar-wrapper \{\s*background: transparent !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-wrapper,[\s\S]*background: transparent !important;/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.calendar-mode-shell \.workbench-canvas-shell \{/)
  assert.match(styles, /background: rgba\(241, 244, 249, 0\.94\) !important;/)
  assert.match(styles, /border: 1px solid rgba\(224, 230, 240, 0\.96\) !important;/)
})

test('browser visibility handoff cancels stale re-show work and rss shell keeps a rounded outline in liquid glass', () => {
  const browserMode = readWorkspaceFile('src/renderer/pages/modes/BrowserMode.tsx')
  const tabShell = readWorkspaceFile('src/main/modules/browser-engine/tab-shell-service.ts')
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')
  const styles = readWorkspaceFile('src/renderer/styles/index.css')

  assert.match(browserMode, /if \(!isActive\) \{\s*window\.electronAPI\?\.browser\?\.hideAll\(\)/)
  assert.match(browserMode, /window\.electronAPI\?\.browser\?\.showActive\(\)/)
  assert.doesNotMatch(browserMode, /window\.electronAPI\?\.browser\?\.switchTab\(currentActive\)/)
  assert.match(browserMode, /cancelAnimationFrame\(activationFrameRef\.current\)/)
  assert.match(tabShell, /if \(!this\.host\.shouldPresentHosts\(\)\) \{\s*return \{ success: true \}/)
  assert.match(hostLayout, /const timer = this\.boundsFlushTimers\.get\(view\)/)

  assert.match(styles, /html\[data-skin='liquid-glass'\] \.rss-mode-shell \.workbench-canvas-shell \{/)
  assert.match(styles, /border-color:\s*var\(--lg-border-soft\) !important;/)
})
