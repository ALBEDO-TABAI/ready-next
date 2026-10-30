import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { parseCalendarDeepLink } from '../shared/calendar/desktop'
import { captureCalendarOpen, consumeCalendarOpens } from '../main/calendar-open-intents'

const uri = 'ready://calendar/event/series#occurrence=1793350800000'
const eventId = 'series#1793350800'

test('OS queue retains timed and all-day instance identities and rejects daily Ready links', () => {
  const received: unknown[] = []
  const stop = consumeCalendarOpens(intent => received.push(parseCalendarDeepLink(intent.value)))
  try {
    assert.equal(captureCalendarOpen({ kind: 'url', value: uri }), false)
    captureCalendarOpen({ kind: 'url', value: uri.replace('ready:', 'ready-next:') })
    captureCalendarOpen({ kind: 'url', value: 'ready-next://calendar/event/day#occurrence=2026-10-30' })
    assert.deepEqual(received, [{ kind: 'event', eventId }, { kind: 'event', eventId: 'day#1793318400' }])
    assert.equal(parseCalendarDeepLink('ready://calendar/event/x#occurrence=bad'), null)
  } finally { stop() }
})

test('workbench, attachment click and rendered message links retain the selected instance', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const saved = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true })
  }
  const { useMode } = await import('../renderer/stores/useMode')
  const { useCalendarSession } = await import('../renderer/stores/useCalendarSession')
  const { collectWorkbenchSurfaceResources } = await import('../renderer/stores/agent-workbench-resources')
  const { useAttachmentPreview } = await import('../renderer/components/agent/chat-panel/attachments-preview/use-attachment-preview')
  const { renderInline } = await import('../renderer/components/agent/chat-panel/markdown')
  const oldMode = useMode.getState(), oldCalendar = useCalendarSession.getState()
  const calls: string[] = [], errors: unknown[] = []
  let available = true
  Object.defineProperty(dom.window, 'electronAPI', { value: { calendar: { revealEvent: async (id: string) => { calls.push(id); return available ? { success: true } : { success: false, error: '日程已不存在' } } } } })
  let preview: ReturnType<typeof useAttachmentPreview> | undefined
  function Harness() {
    preview = useAttachmentPreview({ setActiveAttachmentPreview: value => errors.push(value), setAttachmentPreviewLoading: () => {} })
    return createElement('div', null, ...renderInline(`[second](${uri}) ${uri}`))
  }
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    useMode.setState({ workbenchMode: 'calendar', splitMode: null })
    useCalendarSession.setState({ selectedEventId: eventId, selectedEventTitle: 'Second', visibleRangeStart: null, visibleRangeEnd: null })
    assert.deepEqual(collectWorkbenchSurfaceResources().map(r => r.kind === 'calendar_event' ? r.eventId : r.kind), [eventId])
    flushSync(() => root.render(createElement(Harness)))
    await preview!({ id: 'ref', name: 'Second', source: 'calendar-event', path: uri, type: 'text', size: 0, ext: '' })
    assert.deepEqual(calls, [eventId])
    const links = dom.window.document.querySelectorAll('a,button')
    assert.equal(links.length, 2)
    for (const link of links) {
      link.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.deepEqual(calls, [eventId, eventId, eventId])
    assert.equal(errors.length, 0)
    available = false
    await preview!({ id: 'gone', name: 'Gone', source: 'calendar-event', path: uri, type: 'text', size: 0, ext: '' })
    assert.equal((errors[0] as { error: string }).error, '日程已不存在')
    links[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(dom.window.document.querySelector('[role="alert"]')?.textContent, '日程已不存在')
    // No legacy URI gets a clickable runtime parser.
    const old = renderInline('[old](calendar-event://series)')
    assert.equal(old.some(node => typeof node === 'object' && node !== null && ['a','button'].includes(String((node as ReactElement).type))), false)
  } finally {
    flushSync(() => root.unmount()); await new Promise(resolve => setTimeout(resolve, 20)); useMode.setState(oldMode, true); useCalendarSession.setState(oldCalendar, true)
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
})

export const __breaksInvariants = ['renderer.navigation-stores-restored-after-isolated-reference-test'] as const
