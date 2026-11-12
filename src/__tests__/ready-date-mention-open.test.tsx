import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'

test('C9 openReadyRef reveals and briefly highlights the correct repeated mention after unsaved prefix edits', async t => {
  const link = '[交稿](ready://calendar/day/2026-11-03?at=15:00&remind=0)'
  const f = await editorFixture(t, link + '\n\n第二处 ' + link)
  const { openReadyRef } = await import('../renderer/modules/workbench/open-ready-ref')
  const { useMentionNavigation } = await import('../renderer/modules/calendar/workbench/layers/mention-navigation')
  const original = f.buffer.snapshot.content, start = original.lastIndexOf(link), path = '/vault/Test.md'
  const customEvent = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent')
  Object.defineProperty(globalThis, 'CustomEvent', { value: f.dom.window.CustomEvent, configurable: true })
  t.after(() => { useMentionNavigation.setState({ target: null }); if (customEvent) Object.defineProperty(globalThis, 'CustomEvent', customEvent); else Reflect.deleteProperty(globalThis, 'CustomEvent') })
  await act(() => f.useDocTabs.setState(state => ({ activeTabId: t.name, tabs: state.tabs.map(tab => ({ ...tab, path, objectBinding: { status: 'resolved' as const } })) })))
  Object.assign(f.dom.window, { electronAPI: { navigationHistory: memoryNavigationAPI(),
    objects: { locate: async () => ({ path }) },
    dateMentions: { locate: async () => ({ path, content: original, start, end: start + link.length }) },
  } })
  let scrolled: HTMLElement | undefined, highlighted: HTMLElement | undefined, duration = 0
  Object.defineProperty(f.dom.window.HTMLElement.prototype, 'scrollIntoView', { value: function(this: HTMLElement) { scrolled = document.querySelector(`[data-block-start="${this.dataset.blockStart}"]`) ?? undefined } })
  Object.defineProperty(f.dom.window.HTMLElement.prototype, 'animate', { value: function(this: HTMLElement, _frames: unknown, options: { duration: number }) { highlighted = document.querySelector(`[data-block-start="${this.dataset.blockStart}"]`) ?? undefined; duration = options.duration } })
  await act(() => f.buffer.replace('未保存的前言\n\n' + original))
  await act(async () => openReadyRef({ kind: 'file', id: 'doc', anchor: 'date-mention:one' }, 'calendar'))
  assert.equal(f.useDocTabs.getState().activeTabId, t.name)
  assert.ok(scrolled?.textContent?.includes('第二处'))
  assert.equal(highlighted, scrolled); assert.ok(duration > 0 && duration < 3000)
  assert.equal(useMentionNavigation.getState().target, null)
  assert.equal(f.buffer.snapshot.content, '未保存的前言\n\n' + original, 'navigation does not save or alter the buffer')
})
