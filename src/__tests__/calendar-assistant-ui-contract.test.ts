import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import CalendarAssistantPanel, { type CalendarAssistantSummary } from '../renderer/components/calendar/CalendarAssistantPanel'
import CalendarTimezoneSelector from '../renderer/components/calendar/CalendarTimezoneSelector'
import CalendarWorkbenchShell from '../renderer/components/calendar/CalendarWorkbenchShell'
import { readRendererStyles } from './utils/read-renderer-styles'

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
    eventsForMonthGrid: [],
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
    onOpenMonthEvent: () => {},
    onCreateMonthEvent: () => {},
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
  const styles = readRendererStyles()
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
  const styles = readRendererStyles()
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='native'\] \.calendar-mode-shell \{/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='native'\] \.calendar-mode-shell \{/)
  assert.match(styles, /\.calendar-mode-shell \{[\s\S]*--calendar-sidebar-bg:\s*var\(--calendar-canvas-bg\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{/)
  assert.match(styles, /html\[data-skin='liquid-glass'\] \.calendar-mode-shell \{[\s\S]*--calendar-canvas-bg:\s*var\(--workbench-module-surface-bg\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{[\s\S]*--calendar-canvas-bg:\s*var\(--workbench-module-surface-bg\);/)
  assert.match(styles, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{[\s\S]*--calendar-sidebar-bg:\s*var\(--calendar-canvas-bg\);/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \{/)
  assert.match(scheduleCss, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \{/)
  assert.match(scheduleCss, /:root \{[\s\S]*--sx-ready-grid-chrome-surface:\s*var\(--sx-ready-grid-surface\);/)
  assert.match(scheduleCss, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \{[\s\S]*--sx-ready-grid-chrome-surface:\s*var\(--sx-ready-grid-surface\);/)
  assert.match(styles, /html\[data-theme='dark'\]\[data-skin='liquid-glass'\]\[data-glass-backdrop='ready'\] \.calendar-mode-shell \{/)
})

test('calendar grid lines share one line-width variable across week chrome', () => {
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')
  const hookSource = readWorkspaceFile('src/renderer/modules/calendar/useScheduleXCalendar.ts')

  assert.match(scheduleCss, /--sx-ready-grid-line-width:\s*1px;/)
  assert.match(scheduleCss, /--sx-ready-time-grid-line-color:\s*var\(--sx-ready-grid-line-color\);/)
  assert.match(scheduleCss, /\.calendar-schedule-view-day \{[\s\S]*--sx-ready-visible-day-count:\s*1;/)
  assert.match(scheduleCss, /\.calendar-schedule-view-week \{[\s\S]*--sx-ready-visible-day-count:\s*7;/)
  assert.match(scheduleCss, /\.sx__week-grid__time-axis \{[\s\S]*left:\s*var\(--sx-calendar-week-grid-padding-left\) !important;[\s\S]*right:\s*0 !important;[\s\S]*width:\s*auto !important;[\s\S]*z-index:\s*3;[\s\S]*pointer-events:\s*none;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*min-height:\s*var\(--sx-week-grid-height\) !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-image:[\s\S]*linear-gradient\(to right,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*repeating-linear-gradient\([\s\S]*to bottom,[\s\S]*var\(--sx-ready-time-grid-line-color\) calc\(var\(--sx-week-grid-hour-height\) - var\(--sx-ready-grid-line-width\)\) var\(--sx-week-grid-hour-height\)/)
  assert.doesNotMatch(scheduleCss, /linear-gradient\(to left,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-size:[\s\S]*calc\(100% \/ var\(--sx-ready-visible-day-count,\s*7\)\) 100%,[\s\S]*100% var\(--sx-week-grid-hour-height\) !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis,\s*\.sx__week-grid__time-axis \{[\s\S]*background-position:\s*0 0 !important;/)
  assert.match(scheduleCss, /html\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis \.sx__week-grid__hour,\s*html\[data-theme='dark'\]\[data-skin='liquid-glass'\] \.sx__week-grid__time-axis \.sx__week-grid__hour,\s*\.sx__week-grid__time-axis \.sx__week-grid__hour \{[\s\S]*background:\s*transparent !important;/)
  // Hour rows carry native border-top when Schedule-X renders them; the time-axis overlay also
  // paints the same 24 divisions so a runtime-empty hour row list still keeps the visible grid.
  assert.match(scheduleCss, /\.sx__week-grid__hour \{[\s\S]*border-top:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-time-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__week-grid__hour:first-child \{[\s\S]*visibility:\s*hidden !important;/)
  assert.match(scheduleCss, /\.sx__week-grid__hour:first-child \.sx__week-grid__hour-text \{[\s\S]*visibility:\s*hidden !important;/)
  // Hour labels are centered within their row cell rather than pinned to the divider line.
  assert.match(scheduleCss, /\.sx__week-grid__hour-text \{[\s\S]*top:\s*50% !important;[\s\S]*transform:\s*translateY\(-50%\) !important;/)
  assert.match(scheduleCss, /\.sx__time-grid-day,\s*\.sx__week-grid__date,\s*\.sx__date-grid-day \{[\s\S]*border-inline-start:\s*none !important;/)
  assert.match(scheduleCss, /\.sx__time-grid-day,\s*\.sx__week-grid__date,\s*\.sx__date-grid-day \{[\s\S]*border-inline-end:\s*none !important;[\s\S]*border-left:\s*none !important;[\s\S]*border-right:\s*none !important;/)
  assert.doesNotMatch(scheduleCss, /\.sx__week-grid__date:not\(:first-child\)[\s\S]*border-inline-start:\s*var\(--sx-ready-grid-line-width\)/)
  assert.doesNotMatch(scheduleCss, /\.sx__time-grid-day:not\(:first-child\)[\s\S]*border-inline-start:\s*var\(--sx-ready-grid-line-width\)/)
  assert.match(scheduleCss, /\.sx__week-grid__date-axis::after,\s*\.sx__date-grid::after \{[\s\S]*z-index:\s*2;/)
  // The all-day separator is the only full-width horizontal rule (it crosses the time gutter);
  // the hour-division lines above are body-only and never reach into the gutter.
  assert.match(scheduleCss, /\.sx__week-grid__date-axis::after,\s*\.sx__date-grid::after \{[\s\S]*left:\s*0;[\s\S]*right:\s*0;[\s\S]*height:\s*var\(--sx-ready-grid-line-width\);[\s\S]*background:\s*var\(--sx-ready-grid-line-color\);/)
  // The all-day lane is always a visible row and carries a 全天 label centered in the time gutter.
  assert.match(scheduleCss, /\.sx__date-grid \{[\s\S]*min-height:\s*28px !important;/)
  assert.match(scheduleCss, /\.sx__date-grid \{[\s\S]*background-image:\s*none !important;/)
  assert.doesNotMatch(scheduleCss, /\.sx__date-grid \{[\s\S]*linear-gradient\(to right,\s*var\(--sx-ready-time-grid-line-color\)/)
  assert.match(scheduleCss, /\.sx__date-grid::before \{[\s\S]*content:\s*'全天';[\s\S]*left:\s*calc\(-1 \* var\(--sx-ready-grid-line-width\)\);[\s\S]*width:\s*calc\(var\(--sx-calendar-week-grid-padding-left\) \+ \(2 \* var\(--sx-ready-grid-line-width\)\)\);[\s\S]*background:\s*var\(--sx-ready-grid-chrome-surface\);[\s\S]*z-index:\s*1;/)
  assert.match(scheduleCss, /\.ready-week-hour-labels \{[\s\S]*top:\s*0;[\s\S]*width:\s*var\(--sx-calendar-week-grid-padding-left,\s*75px\);[\s\S]*height:\s*var\(--sx-week-grid-height,\s*1600px\);/)
  assert.match(scheduleCss, /\.ready-week-hour-label \{[\s\S]*transform:\s*translateY\(-50%\);[\s\S]*text-align:\s*center;/)
  assert.match(hookSource, /const WEEK_HOURS = Array\.from\(\{ length:\s*23 \},/)
  assert.match(hookSource, /function installWeekHourLabels\(container:\s*HTMLElement\)/)
  assert.match(hookSource, /weekGrid\.appendChild\(wrapper\)/)
  assert.match(hookSource, /container\.querySelector\('\.sx__week-grid \.ready-week-hour-labels'\)/)
  // Vertical separators are grid overlays on the all-day row and time body; the weekday header
  // stays clean so the top date row is not split by vertical lines.
  assert.doesNotMatch(scheduleCss, /\.sx__week-grid__date::before/)
  assert.doesNotMatch(scheduleCss, /\.sx__date-grid-day::before/)
  assert.doesNotMatch(scheduleCss, /\.sx__week-grid__date:last-child::after/)
  assert.doesNotMatch(scheduleCss, /\.sx__date-grid-day:last-child::after/)
  assert.match(scheduleCss, /\.sx__time-grid-event \{[\s\S]*z-index:\s*4 !important;/)
  assert.match(scheduleCss, /\.sx__current-time-indicator \{[\s\S]*height:\s*var\(--sx-ready-current-time-line-width\) !important;/)
})

test('calendar Schedule-X config keeps day and week hour rows enabled', () => {
  const source = readWorkspaceFile('src/renderer/modules/calendar/useScheduleXCalendar.ts')

  assert.match(source, /weekOptions:\s*\{[\s\S]*gridHeight:\s*1600,/)
  assert.match(source, /weekOptions:\s*\{[\s\S]*nDays:\s*7,/)
  assert.match(source, /weekOptions:\s*\{[\s\S]*eventWidth:\s*100,/)
  assert.match(source, /weekOptions:\s*\{[\s\S]*timeAxisFormatOptions:\s*\{\s*hour:\s*'numeric'\s*\},/)
  assert.match(source, /weekOptions:\s*\{[\s\S]*eventOverlap:\s*true,/)
  assert.match(source, /weekOptions:\s*\{[\s\S]*gridStep:\s*60,/)
})

test('calendar month view uses neutral grid line variables instead of default blue-tinted borders', () => {
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')
  const shellSource = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')

  assert.match(shellSource, /viewType === 'month'[\s\S]*<ReadyMonthGridFallback/)
  assert.match(shellSource, /className="sx__month-grid-wrapper ready-month-grid-fallback"/)
  assert.match(shellSource, /className="sx__month-grid-week"/)
  assert.match(shellSource, /'sx__month-grid-day'/)
  assert.match(shellSource, /data-ready-month-event-id=\{calendarEvent\.id\}/)
  assert.match(shellSource, /className="ready-month-grid-event-title"/)
  assert.match(shellSource, /onDoubleClick=\{\(event\) => openCreateForDay\(event, day\)\}/)
  assert.match(shellSource, /onContextMenu=\{\(event\) => openCreateForDay\(event, day\)\}/)
  assert.match(scheduleCss, /\.sx__month-grid-wrapper \{[\s\S]*background:\s*var\(--sx-ready-grid-surface\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-wrapper \{[\s\S]*border-bottom:\s*none !important;/)
  assert.match(scheduleCss, /\.ready-month-grid-fallback \{[\s\S]*position:\s*absolute !important;[\s\S]*inset:\s*0 !important;[\s\S]*z-index:\s*4;/)
  assert.match(scheduleCss, /\.ready-month-grid-fallback \.sx__month-grid-week \{[\s\S]*display:\s*flex;[\s\S]*min-width:\s*0;/)
  assert.match(scheduleCss, /\.ready-month-grid-fallback \.sx__month-grid-day \{[\s\S]*appearance:\s*none;[\s\S]*border:\s*none;[\s\S]*flex:\s*1 1 0;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;/)
  assert.match(scheduleCss, /\.ready-month-grid-fallback \.sx__month-grid-day:not\(:last-child\) \{[\s\S]*border-inline-end:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.ready-month-grid-fallback \.sx__month-grid-day__events \{[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;/)
  assert.match(scheduleCss, /\.ready-month-grid-event \{[\s\S]*display:\s*flex;[\s\S]*width:\s*100%;[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;/)
  assert.match(scheduleCss, /\.ready-month-grid-event-title \{[\s\S]*text-overflow:\s*clip;[\s\S]*mask-image:\s*linear-gradient\(to right, #000 calc\(100% - 14px\), transparent\);/)
  assert.doesNotMatch(scheduleCss, /\.ready-month-grid-dot/)
  assert.match(scheduleCss, /\.sx__month-grid-week \{[\s\S]*border-top:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-day:not\(:last-child\) \{[\s\S]*border-inline-end:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  // .sx__month-grid-cell is applied to empty blocker placeholders (alignment spacers) as well as
  // real events, so it must NOT carry a border — otherwise empty slots render as gray outlined boxes.
  assert.doesNotMatch(scheduleCss, /\.sx__month-grid-cell \{[^}]*border:/)
  assert.match(scheduleCss, /\.sx__month-grid-day \{[\s\S]*border-bottom:\s*none !important;/)
  // a948f82d style(ui): polish Ready glass theme surfaces — 今日徽标底色改走皮肤可覆写 token（红色为回退值）
  assert.match(scheduleCss, /\.sx__month-grid-day__header-date--is-today,\s*\.sx__month-grid-day__header-date\.sx__is-today \{[\s\S]*background:\s*var\(--ready-calendar-today-bg, var\(--color-red\)\) !important;/)
  assert.doesNotMatch(scheduleCss, /\.sx__month-grid(?:-[^{]+)?[^{]*\{[\s\S]*var\(--border-default\)/)
  // A top band is reserved on the wrapper; the first week keeps a top border that becomes the
  // full-width line below the weekday names, and the names are lifted up into the band (absolute,
  // negative top) so the vertical day separators never run beside them.
  assert.match(scheduleCss, /\.sx__month-grid-wrapper \{[\s\S]*padding-top:\s*24px !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-week:first-child \{[\s\S]*border-top:\s*var\(--sx-ready-grid-line-width\) solid var\(--sx-ready-grid-line-color\) !important;/)
  assert.match(scheduleCss, /\.sx__month-grid-day__header-day-name \{[\s\S]*position:\s*absolute !important;[\s\S]*top:\s*-24px !important;/)
})

test('calendar top toolbar uses the same surface as the calendar grid', () => {
  const shell = readWorkspaceFile('src/renderer/components/calendar/CalendarWorkbenchShell.tsx')
  const scheduleCss = readWorkspaceFile('src/renderer/styles/schedule-x.css')

  assert.match(shell, /className="calendar-schedule-toolbar flex items-center justify-between flex-shrink-0"/)
  assert.match(shell, /background:\s*'var\(--sx-ready-grid-surface\)'/)
  assert.match(scheduleCss, /\.sx__week-header,[\s\S]*\.sx__date-grid-day \{[\s\S]*background:\s*var\(--sx-ready-grid-chrome-surface\) !important;/)
})
