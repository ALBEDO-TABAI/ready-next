import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { JSDOM } from 'jsdom'
import type { ShellRailProps } from '../renderer/modules/workbench/shell/ShellRail'

// Only the CSS import is replaced: React, the rail, its glyph group and store stay real.
const hooks = registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return next(url, context)
} })
const { default: ShellRail } = await import('../renderer/modules/workbench/shell/ShellRail')
const { useFastCard } = await import('../renderer/stores/useFastCard')
hooks.deregister()

// The FastCard singleton is seeded only in this isolated test process and restored on cleanup.
export const __breaksInvariants = ['renderer.fastcard-singleton.seeded-between-isolated-tests'] as const

test('ShellRail dispatches mode, split and global actions and renders current state', async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const globals = { window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const original = useFastCard.getState()
  const root = createRoot(dom.window.document.getElementById('root')!)
  t.after(async () => {
    await act(async () => root.unmount())
    useFastCard.setState(original)
    dom.window.close()
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const modes: string[] = [], splits: string[] = []
  let assistantOpens = 0, searches = 0
  dom.window.addEventListener('ready:open-quick-switcher', () => { searches += 1 })
  const props: ShellRailProps = { mode: 'document', splitMode: 'rss',
    onModeChange: mode => modes.push(mode), onSplitToggle: mode => splits.push(mode),
    assistantOpen: true, onAssistantOpen: () => { assistantOpens += 1 } }
  function Location() { return <output>{useLocation().pathname}</output> }
  const render = (patch: Partial<ShellRailProps> = {}) => act(async () => root.render(
    <MemoryRouter><ShellRail {...props} {...patch} /><Location /></MemoryRouter>,
  ))
  const button = (label: string) => {
    const result = dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    assert.ok(result, `${label} button must exist`)
    return result
  }
  await render()
  for (const [label, mode] of [['浏览器', 'browser'], ['文档', 'document'], ['资讯', 'rss'], ['日历', 'calendar']]) {
    modes.length = 0; splits.length = 0
    await act(async () => button(label).click())
    assert.deepEqual(modes, [mode]); assert.deepEqual(splits, [])
    modes.length = 0
    for (const modifier of ['altKey', 'shiftKey']) {
      splits.length = 0
      await act(async () => button(label).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, [modifier]: true })))
      assert.deepEqual(splits, [mode]); assert.deepEqual(modes, [])
    }
  }
  assert.equal(button('文档').getAttribute('aria-pressed'), 'true')
  assert.ok(button('文档').classList.contains('is-active'))
  assert.equal(button('文档').getAttribute('data-active-glyph'), 'fill')
  assert.ok(button('文档').querySelector('.is-filled'))
  assert.equal(button('资讯').getAttribute('aria-pressed'), 'false')
  assert.equal(button('资讯').getAttribute('data-split'), 'true')
  assert.equal(button('文档').hasAttribute('data-split'), false)
  await render({ mode: 'rss', splitMode: null })
  assert.equal(button('资讯').getAttribute('aria-pressed'), 'true')
  assert.equal(button('资讯').getAttribute('data-active-glyph'), 'stroke')
  assert.equal(button('资讯').querySelector('.is-filled'), null)
  assert.equal(button('文档').getAttribute('aria-pressed'), 'false')
  assert.equal(dom.window.document.querySelector('[data-split="true"]'), null)
  for (const label of ['文件', '查找与替换', '技能中心', '反向链接', '关系图谱']) {
    assert.equal(dom.window.document.querySelector(`button[aria-label="${label}"]`), null)
  }
  assert.equal(dom.window.document.querySelector('[aria-label="助手 Tab"]'), null)
  await render({ assistantOpen: false })
  await act(async () => button('助手 Tab').click())
  assert.equal(assistantOpens, 1)
  assert.equal(button('收集').querySelector('.shell-rail__badge'), null)
  await act(async () => useFastCard.setState({ items: [{ id: 'note', kind: 'text', text: '暂存', createdAt: 1 }] }))
  assert.equal(button('收集').querySelector('.shell-rail__badge')?.textContent, '1')
  await act(async () => useFastCard.setState({ items: [] }))
  assert.equal(button('收集').querySelector('.shell-rail__badge'), null)
  await act(async () => button('搜索 ⌘K').click())
  assert.equal(searches, 1)
  await act(async () => button('设置 ⌘,').click())
  assert.equal(dom.window.document.querySelector('output')?.textContent, '/settings')
})
