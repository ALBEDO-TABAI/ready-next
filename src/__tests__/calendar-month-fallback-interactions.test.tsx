import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import CalendarWorkbenchShell from '../renderer/components/calendar/CalendarWorkbenchShell'
import type { CalendarEvent } from '../renderer/components/calendar/schedule-x-utils'

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  })

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    MouseEvent: globalThis.MouseEvent,
    KeyboardEvent: globalThis.KeyboardEvent,
    navigator: globalThis.navigator,
    getComputedStyle: globalThis.getComputedStyle,
  }

  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  })
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  })

  return {
    dom,
    rootElement: dom.window.document.getElementById('root') as HTMLElement,
    cleanup: () => {
      dom.window.close()
      Object.assign(globalThis, {
        window: previous.window,
        document: previous.document,
        HTMLElement: previous.HTMLElement,
        MouseEvent: previous.MouseEvent,
        KeyboardEvent: previous.KeyboardEvent,
        getComputedStyle: previous.getComputedStyle,
      })
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: previous.navigator,
      })
    },
  }
}

function renderMonthShell(overrides: {
  event: CalendarEvent
  onOpenMonthEvent: (event: CalendarEvent) => void
  onCreateMonthEvent: (payload: { date: Date; hour?: number }) => void
}) {
  return createElement(CalendarWorkbenchShell, {
    isMock: false,
    loadError: null,
    currentDate: new Date(2026, 5, 8),
    selectedDate: null,
    eventsForMiniCalendar: [{ startTime: overrides.event.startTime, color: overrides.event.color }],
    eventsForMonthGrid: [overrides.event],
    sources: [],
    headerTitle: '2026年 6月',
    viewType: 'month',
    calendarDropActive: false,
    sxError: null,
    sxContainerRef: { current: null },
    mainViewRef: { current: null },
    createButtonRef: { current: null },
    customPortalNodes: null,
    newEventMenuPos: null,
    newEventCardPos: null,
    newEventCardDay: new Date(2026, 5, 8),
    newEventCardHour: 9,
    newEventCardType: 'event',
    sourcesForView: [],
    displayTimezone: 'Asia/Shanghai',
    assistantOpen: false,
    assistantSummary: {
      todayEvents: [],
      weekEvents: [],
      nextEvent: null,
      weekEventCount: 0,
      weekTotalHours: 0,
      weekCalendarCount: 0,
    },
    onDisplayTimezoneChange: () => {},
    onToggleAssistant: () => {},
    onCloseAssistant: () => {},
    onAssistantAskAgent: () => {},
    onDateChange: () => {},
    onSelectDate: () => {},
    onOpenMonthEvent: overrides.onOpenMonthEvent,
    onCreateMonthEvent: overrides.onCreateMonthEvent,
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
  })
}

test('month fallback renders real events and routes open/create gestures', async () => {
  const { dom, rootElement, cleanup } = installDom()
  const root = createRoot(rootElement)
  const event: CalendarEvent = {
    id: 'evt-1',
    title: '复盘会',
    startTime: new Date(2026, 5, 8, 10, 0),
    endTime: new Date(2026, 5, 8, 11, 0),
    calendarId: 'work',
    color: '#5B8DEF',
  }
  let opened: CalendarEvent | null = null
  const createCalls: Array<{ date: Date; hour?: number }> = []

  try {
    flushSync(() => {
      root.render(renderMonthShell({
        event,
        onOpenMonthEvent: (item) => { opened = item },
        onCreateMonthEvent: (payload) => { createCalls.push(payload) },
      }))
    })

    const eventButton = dom.window.document.querySelector('[data-ready-month-event-id="evt-1"]') as HTMLElement | null
    assert.ok(eventButton)
    assert.match(eventButton.textContent ?? '', /复盘会/)

    eventButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    assert.equal(opened?.id, 'evt-1')

    const emptyDay = dom.window.document.querySelector('[data-date="2026-06-09"]') as HTMLElement | null
    assert.ok(emptyDay)
    emptyDay.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    emptyDay.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))

    assert.equal(createCalls.length, 2)
    assert.deepEqual(
      createCalls.map((payload) => ({
        date: `${payload.date.getFullYear()}-${String(payload.date.getMonth() + 1).padStart(2, '0')}-${String(payload.date.getDate()).padStart(2, '0')}`,
        hour: payload.hour,
      })),
      [
        { date: '2026-06-09', hour: 9 },
        { date: '2026-06-09', hour: 9 },
      ],
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    flushSync(() => root.unmount())
    await new Promise((resolve) => setTimeout(resolve, 0))
    cleanup()
  }
})
