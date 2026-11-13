import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { readRendererStyles } from '../utils/read-renderer-styles'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('workbench shell does not show the default no-workspace reminder banner', () => {
  const workbenchMode = readWorkspaceFile('src/renderer/pages/WorkbenchMode.tsx')

  assert.doesNotMatch(workbenchMode, /请选择一个工作区目录/)
  assert.doesNotMatch(workbenchMode, /选择项目目录后才能启用文件搜索与索引/)
})

test('browser rss and calendar shells align their left edge with the shared workbench canvas contract', () => {
  const browserHeader = readWorkspaceFile('src/renderer/components/browser/BrowserHeader.tsx')
  const documentMode = readWorkspaceFile('src/renderer/pages/modes/DocumentMode.tsx')
  const markdownEditor = readWorkspaceFile('src/renderer/components/document/MarkdownEditor.tsx')
  const rssFeed = readWorkspaceFile('src/renderer/components/rss/RSSFeed.tsx')
  const rssVirtualList = readWorkspaceFile('src/renderer/components/rss/RSSVirtualList.tsx')
  const calendarMode = readWorkspaceFile('src/renderer/pages/modes/CalendarMode.tsx')
  const workbenchTabs = readWorkspaceFile('src/renderer/components/workbench/WorkbenchProjectTabs.tsx')
  const styles = readRendererStyles()

  // V11: the browser's header row is the shared panel head (.rn-panel__head owns the row's height and edge padding).
  assert.match(browserHeader, /className="rn-panel__head browser-head no-drag"/)
  assert.match(workbenchTabs, /className="workbench-tabs-surface glass-surface-panel flex-shrink-0"/)
  // Document mode, like the calendar, has no shell surface of its own: Inkwell's sidebar and page panels fill it.
  assert.match(documentMode, /className="workbench-canvas-shell flex min-h-0 h-full flex-col" style=\{\{ background: 'transparent', boxShadow: 'none' \}\}/)
  assert.match(documentMode, /className="ink-scope ink-doc-app"/)
  assert.doesNotMatch(styles, /document-workbench-canvas-shell|document-workbench-body|document-path-bar/)
  assert.match(markdownEditor, /className="panel-hover-scrollbar document-editor-surface flex-1 overflow-auto"/)
  assert.match(markdownEditor, /panel-hover-scrollbar document-preview-surface flex-1 overflow-auto/)

  // V11: 资讯 is one block. The panel (.rn-panel) holds its head row (the way back, the breadcrumb, the view's tools)
  // and every RSS view as its body; nothing sits on the ground above it. The body paints no sheet of its own (no panel
  // on a panel). Its navigation lives in the shell's one sidebar (W2-T4), not in the body.
  const rssMode = readWorkspaceFile('src/renderer/pages/modes/RSSMode.tsx')
  // V22: the canvas does not clip; the panel inside clips itself and its shadow reaches past the box.
  assert.match(rssMode, /className="workbench-canvas-shell rss-workbench-canvas relative flex h-full min-h-0"/)
  assert.match(rssMode, /<div className="rss-feed-sheet rn-panel">\s*<div className="rss-topbar rn-panel__head no-drag">/)
  assert.match(rssMode, /<ShellNavigator mode="rss" label="资讯">\s*<RSSNavigation/)
  assert.doesNotMatch(rssMode, /rss-workbench-body|workbench-tabs-surface/)
  assert.match(rssMode, /className="rss-content-frame rn-panel__body"/)
  const rssFrame = styles.match(/\.rss-mode-shell \.rss-content-frame \{[^}]*\}/)?.[0] || ''
  assert.ok(rssFrame && !/background|box-shadow|border-radius/.test(rssFrame), 'the body inside the panel paints nothing of its own')
  assert.doesNotMatch(styles, /--rss-rail/)
  assert.match(rssFeed, /className="rss-feed-surface/)
  assert.match(rssFeed, /rss-workbench-surface/)
  assert.match(rssFeed, /content-surface-panel/)
  assert.match(rssFeed, /WORKBENCH_HEADER_EDGE_X/)
  // 98c06c55 — the list frame is a fixed clip; scrolling (rss-feed-scroll) moved to the virtual list holder.
  assert.match(rssFeed, /className="rss-feed-list"/)
  assert.match(styles, /\.rss-feed-list \{[\s\S]*?min-height: 0;/)
  assert.match(rssFeed, /<RSSVirtualList /)
  assert.match(rssVirtualList, /data-liquid-scroll-root="rss-feed-list" className=\{`\$\{props\.className \|\| ''\} rss-feed-scroll`\}/)
  // Card text lines up with the heading: row inset + card padding = the frame gutter.
  assert.match(styles, /--rss-row-x: calc\(var\(--rss-gutter\) - 16px\);/)
  assert.match(styles, /\.rss-workspace-heading \{[\s\S]*?padding: var\(--rn-s6\) var\(--rss-gutter\) 0;/)

  // The paper keeps the same box in every mode: the calendar uses the shared top, side and bottom paddings.
  assert.match(calendarMode, /WORKBENCH_CANVAS_OUTER_PADDING_TOP/)
  assert.match(calendarMode, /WORKBENCH_CANVAS_OUTER_PADDING_X/)
  assert.match(calendarMode, /WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM/)
  assert.match(calendarMode, /workbench-canvas-shell/)
  assert.match(calendarMode, /background:'transparent',boxShadow:'none'/)
  // W1 T6: the module surface tint (--workbench-liquid-chrome-bg) is retired; modes sit on the one root glass.
  assert.doesNotMatch(styles, /--workbench-(?:liquid-chrome|module-surface)-bg/)
  assert.match(styles, /html:root \.workbench-tabs-surface \{/)
  // 资讯's original-page preview carries no blur of its own (W1-T5, B13): backdrop-filter comes only from material classes.
  assert.doesNotMatch(styles, /\.rss-preview-surface/)
  // B13: the tab rows and the browser's address bar sit on the window glass (W1 DL1, DL11a); the browser's page frame
  // paints no corner patches, so the bar has no surface or blur of its own.
  assert.match(styles, /html:root \.workbench-tabs-surface \{\s*background:\s*transparent !important;\s*\}/)
  assert.doesNotMatch(styles, /\.browser-header-surface \{/)
  // Inside the document's paper the frame is only a clip; 资讯's content is paper itself (W1 DL2).
  assert.match(styles, /html:root \.document-content-frame \{[\s\S]*?background:\s*transparent !important;/)
  assert.match(styles, /html:root \.document-editor-surface,[\s\S]*\.document-preview-surface,[\s\S]*\.rss-feed-list,\s*html:root \.rss-preview-content \{[\s\S]*background:\s*transparent !important;/)
  assert.match(styles, /html:root \.rss-workbench-surface,[\s\S]*\.rss-feed-list,\s*html:root \.rss-preview-content \{/)
  // V11: 资讯's panel (.rss-feed-sheet.rn-panel) takes its glass from .rn-panel alone; no module rule repaints it.
  assert.doesNotMatch(styles, /\.rss-feed-sheet \{[^}]*(?:background|box-shadow)/)
})

test('browser visibility handoff cancels stale re-show work and rss shell stays borderless in liquid glass', () => {
  const browserRuntimeEffects = readWorkspaceFile('src/renderer/modules/browser/useBrowserRuntimeEffects.ts')
  const tabShell = readWorkspaceFile('src/main/modules/browser-engine/tab-shell-service.ts')
  const hostLayout = readWorkspaceFile('src/main/modules/browser-engine/host-layout-service.ts')
  const boundsHook = readWorkspaceFile('src/renderer/modules/browser/useBrowserViewBounds.ts')
  const styles = readRendererStyles()

  assert.doesNotMatch(browserRuntimeEffects, /window\.electronAPI\?\.browser\?\.hideAll\(\)/)
  assert.doesNotMatch(browserRuntimeEffects, /window\.electronAPI\?\.browser\?\.showActive\(\)/)
  assert.doesNotMatch(browserRuntimeEffects, /window\.electronAPI\?\.browser\?\.switchTab\(currentActive\)/)
  assert.match(browserRuntimeEffects, /cancelAnimationFrame\(activationFrameRef\.current\)/)
  assert.match(boundsHook, /const emitHideAll = \(\) => \{\s*window\.electronAPI\?\.browser\?\.sendIntent\(\{\s*kind: 'hide-all'/)
  assert.match(boundsHook, /if \(!isActiveRef\.current\) \{\s*emitHideAll\(\)\s*return\s*\}/)
  assert.match(boundsHook, /kind: 'show'/)
  assert.match(tabShell, /if \(!this\.host\.shouldPresentHosts\(\)\) \{\s*return \{ success: true \}/)
  assert.match(hostLayout, /showHost\(view: BrowserHostView, bounds: BrowserRect\): void \{[\s\S]*this\.setHostBoundsNow\(view, bounds\)/)

  // B13, V15: every mode's outer frame is a borderless, shadowless box (W1 DL1); the panel inside paints and clips.
  assert.match(styles, /\.workbench-canvas-shell \{[^}]*border: 0;[^}]*box-shadow: none;/)
  assert.doesNotMatch(styles, /html:root \.rss-mode-shell \.workbench-canvas-shell \{/)
  // V22: nothing between a panel and the window cuts its soft shadow. The box does not clip; the content column and the
  // mode scene clip with the shadow's reach as margin; the calendar's root contains layout, not paint (which clips).
  const canvasRule = styles.match(/\.workbench-canvas-shell \{[^}]*\}/)?.[0] ?? ''
  assert.doesNotMatch(canvasRule, /overflow|border-radius/)
  const shell = readWorkspaceFile('src/renderer/modules/workbench/shell/shell.css')
  assert.match(shell, /\[data-shell-region='content'\] \{\s*overflow-clip-margin: var\(--rn-panel-shadow-reach\);/)
  assert.match(readWorkspaceFile('src/renderer/styles/ritual-overlay.css'), /\.workbench-mode-scene \{[^}]*overflow: clip;\s*overflow-clip-margin: var\(--rn-panel-shadow-reach\);/)
  const calendarRoot = readWorkspaceFile('src/renderer/modules/calendar/workbench/styles/app.css').match(/\n\.ready-calendar \{[^}]*\}/)?.[0] ?? ''
  assert.match(calendarRoot, /overflow: clip; overflow-clip-margin: var\(--rn-panel-shadow-reach\); contain: layout;/)
  assert.doesNotMatch(calendarRoot, /contain: layout paint|overflow: hidden/)
})
