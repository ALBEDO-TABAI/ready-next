import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import CalendarAssistantPanel, { type CalendarAssistantSummary } from '../renderer/components/calendar/CalendarAssistantPanel'
import CalendarTimezoneSelector from '../renderer/components/calendar/CalendarTimezoneSelector'
import CalendarWorkbenchShell from '../renderer/components/calendar/CalendarWorkbenchShell'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('calendar timezone chrome uses compact city labels instead of raw IANA ids', () => {
  const markup = renderToStaticMarkup(createElement(CalendarTimezoneSelector, {
    value: 'Asia/Shanghai',
    onChange: () => {},
  }))

  assert.match(markup, /上海 \/ 北京/)
  assert.doesNotMatch(markup, /Asia\/Shanghai/)
})

test('calendar shell exposes assistant drawer and keeps timezone in the sidebar', () => {
  const summary: CalendarAssistantSummary = {
    todayEvents: [],
    weekEvents: [],
    nextEvent: null,
    weekEventCount: 0,
    weekTotalHours: 0,
    weekCalendarCount: 0,
  }
  const markup = renderToStaticMarkup(createElement(CalendarWorkbenchShell, {
    isMock: false,
    loadError: null,
    currentDate: new Date('2026-05-17T00:00:00+08:00'),
    selectedDate: null,
    eventsForMiniCalendar: [],
    sources: [],
    headerTitle: '五月 2026',
    viewType: 'week',
    calendarDropActive: false,
    sxError: null,
    sxContainerRef: createRef<HTMLDivElement>(),
    mainViewRef: createRef<HTMLDivElement>(),
    createButtonRef: createRef<HTMLButtonElement>(),
    customPortalNodes: null,
    newEventMenuPos: null,
    newEventCardPos: null,
    newEventCardDay: new Date('2026-05-17T00:00:00+08:00'),
    newEventCardHour: 9,
    newEventCardType: 'event',
    sourcesForView: [],
    displayTimezone: 'Asia/Shanghai',
    assistantOpen: true,
    assistantSummary: summary,
    onDisplayTimezoneChange: () => {},
    onToggleAssistant: () => {},
    onCloseAssistant: () => {},
    onAssistantAskAgent: () => {},
    onDateChange: () => {},
    onSelectDate: () => {},
    onToggleSource: () => {},
    onAddSource: () => {},
    onUpdateSource: () => {},
    onDeleteSource: () => {},
    onOpenCreateMenu: () => {},
    onViewTypeChange: () => {},
    onGoToToday: () => {},
    onNavigateDate: () => {},
    onCalendarDragOver: () => {},
    onCalendarDragLeave: () => {},
    onCalendarDrop: () => {},
    onQuickMenuSelect: () => {},
    onCloseQuickCreate: () => {},
    onQuickCardSubmit: () => {},
    onCloseQuickCard: () => {},
  }))

  assert.match(markup, /calendar-timezone-dock/)
  assert.match(markup, /background:var\(--calendar-sidebar-bg\)/)
  assert.match(markup, /显示时区/)
  assert.match(markup, /calendar-toolbar-actions/)
  assert.match(markup, /calendar-view-segment/)
  assert.match(markup, /calendar-assistant-toggle is-active/)
  assert.match(markup, /calendar-schedule-view calendar-schedule-view-week/)
  assert.match(markup, /calendar-assistant-drawer calendar-assistant-surface/)
})

test('calendar assistant uses rss-style right drawer motion without transition-all', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const summary: CalendarAssistantSummary = {
    todayEvents: [],
    weekEvents: [],
    nextEvent: null,
    weekEventCount: 0,
    weekTotalHours: 0,
    weekCalendarCount: 0,
  }
  const markup = renderToStaticMarkup(createElement(CalendarAssistantPanel, {
    open: true,
    summary,
    displayTimezone: 'Asia/Shanghai',
    onClose: () => {},
    onAskAgent: () => {},
  }))

  assert.match(markup, /calendar-assistant-drawer calendar-assistant-surface/)
  assert.doesNotMatch(markup, /transition-all/)
  assert.match(styles, /\.calendar-toolbar-actions \{[\s\S]*-webkit-app-region:\s*no-drag;/)
  assert.match(styles, /\.calendar-toolbar-button,\n\.calendar-icon-button \{[\s\S]*-webkit-app-region:\s*no-drag;/)
  assert.match(styles, /\.calendar-view-segment \{[\s\S]*-webkit-app-region:\s*no-drag;/)
  assert.match(styles, /\.calendar-assistant-drawer \{[\s\S]*transform:\s*translateX\(12px\);[\s\S]*opacity 240ms cubic-bezier\(0\.22, 0\.61, 0\.36, 1\),[\s\S]*transform 240ms cubic-bezier\(0\.22, 0\.61, 0\.36, 1\);/)
  assert.match(styles, /\.calendar-assistant-drawer\.is-entered \{[\s\S]*opacity:\s*1;[\s\S]*transform:\s*translateX\(0\);/)
})

test('calendar theme variables cover transparent and stable glass combinations', () => {
  const styles = readWorkspaceFile('src/renderer/styles/index.css')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='native'\] \.calendar-mode-shell \{/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='native'\] \.calendar-mode-shell \{/)
  assert.match(styles, /\.calendar-mode-shell \{[\s\S]*--calendar-sidebar-bg:\s*var\(--calendar-canvas-bg\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{[\s\S]*--calendar-canvas-bg:\s*var\(--workbench-liquid-chrome-bg,\s*var\(--workbench-module-surface-bg\)\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{[\s\S]*--calendar-sidebar-bg:\s*var\(--calendar-canvas-bg\);/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \{/)
  assert.match(scheduleCss, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \{/)
  assert.match(scheduleCss, /:root \{[\s\S]*--sx-ready-grid-chrome-surface:\s*var\(--sx-ready-grid-surface\);/)
  assert.match(scheduleCss, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \{[\s\S]*--sx-ready-grid-chrome-surface:\s*var\(--sx-ready-week-solid-surface\);/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{/)
})

test('calendar grid lines share one line-width variable across week chrome', () => {
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(scheduleCss, /--sx-ready-grid-line-width:\s*1px;/)
  assert.match(scheduleCss, /--sx-ready-time-grid-line-color:\s*var\(--sx-ready-grid-line-color\);/)
  assert.match(scheduleCss, /\.calendar-schedule-view-day \{[\s\S]*--sx-ready-visible-day-count:\s*1;/)
  assert.match(scheduleCss, /\.calendar-schedule-view-week \{[\s\S]*--sx-ready-visible-day-count:\s*7;/)
  assert.match(scheduleCss, /\.sx__week-grid__time-axis \{[\s\S]*left:\s*var\(--sx-calendar-week-grid-padding-left\) !important;[\s\S]*right:\s*0 !important;[\s\S]*width:\s*auto !important;[\s\S]*z-index:\s*3;[\s\S]*pointer-events:\s*none;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-image:[\s\S]*linear-gradient\(to right,\s*var\(--sx-ready-time-grid-line-color\)[\s\S]*linear-gradient\(to bottom,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.doesNotMatch(scheduleCss, /linear-gradient\(to left,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-size:[\s\S]*calc\(100% \/ var\(--sx-ready-visible-day-count,\s*7\)\) 100%,[\s\S]*100% var\(--sx-week-grid-hour-height\) !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-position:[\s\S]*0 0,[\s\S]*0 var\(--sx-week-grid-hour-height\) !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis \.sx__week-grid__hour,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis \.sx__week-grid__hour,\s*\.sx__week-grid__time-axis \.sx__week-grid__hour \{[\s\S]*background:\s*transparent !important;/)
  assert.match(scheduleCss, /\.sx__week-grid__hour \{[\s\S]*border-top:\s*none !important;/)
  assert.match(scheduleCss, /\.sx__week-grid__hour:first-child \{[\s\S]*visibility:\s*hidden !important;/)
  assert.match(scheduleCss, /\.sx__week-grid__hour:first-child \.sx__week-grid__hour-text \{[\s\S]*visibility:\s*hidden !important;/)
  assert.match(scheduleCss, /\.sx__time-grid-day,\s*\.sx__week-grid__date,\s*\.sx__date-grid-day \{[\s\S]*border-left:\s*none !important;/)
  assert.match(scheduleCss, /\.sx__time-grid-day:last-child,\s*\.sx__week-grid__date:last-child,\s*\.sx__date-grid-day:last-child \{[\s\S]*border-right:\s*none !important;/)
  assert.match(scheduleCss, /\.sx__week-grid__date-axis::after,[\s\S]*\.sx__date-grid-day::before \{[\s\S]*z-index:\s*2;/)
  assert.match(scheduleCss, /\.sx__week-grid__date-axis::after,\s*\.sx__date-grid::after \{[\s\S]*height:\s*var\(--sx-ready-grid-line-width\);[\s\S]*background:\s*var\(--sx-ready-grid-line-color\);/)
  assert.match(scheduleCss, /\.sx__week-grid__date::before,\s*\.sx__date-grid-day::before \{[\s\S]*width:\s*var\(--sx-ready-grid-line-width\);[\s\S]*background:\s*var\(--sx-ready-time-grid-line-color\);/)
  assert.match(scheduleCss, /\.sx__week-grid__date::before,\s*\.sx__date-grid-day::before \{[\s\S]*left:\s*0;/)
  assert.doesNotMatch(scheduleCss, /\.sx__week-grid__date:last-child::after/)
  assert.doesNotMatch(scheduleCss, /\.sx__date-grid-day:last-child::after/)
  assert.match(scheduleCss, /\.sx__time-grid-event \{[\s\S]*z-index:\s*4 !important;/)
  assert.match(scheduleCss, /\.sx__current-time-indicator \{[\s\S]*height:\s*var\(--sx-ready-current-time-line-width\) !important;/)
})

test('calendar month view uses neutral grid line variables instead of default blue-tinted borders', () => {
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(scheduleCss, /\.sx__month-grid-wrapper \{[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-wrapper \{[\s\S]*border-bottom:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-week \{[\s\S]*border-top:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-day:not\(:last-child\) \{[\s\S]*border-inline-end:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-cell \{[\s\S]*border:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-day \{[\s\S]*border-bottom:\s*none !important;/)
  assert.doesNotMatch(scheduleCss, /\.sx__month-grid(?:-[^{]+)?[^{]*\{[\s\S]*var\(--border-default\)/)
})

test('calendar top toolbar uses the same surface as the grid header band', () => {
  const shell = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(shell, /className="calendar-schedule-toolbar flex items-center justify-between flex-shrink-0"/)
  assert.match(shell, /background:\s*'var\(--sx-ready-grid-chrome-surface\)'/)
  assert.match(scheduleCss, /\.sx__week-header,[\s\S]*\.sx__date-grid-day \{[\s\S]*background:\s*var\(--sx-ready-grid-chrome-surface\) !important;/)
})
