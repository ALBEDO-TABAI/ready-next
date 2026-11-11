import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveShellLayout,
  SHELL_ASSISTANT_WIDTH,
  SHELL_CONTENT_MIN_WIDTH,
  SHELL_SIDEBAR_WIDTH,
  SHELL_WINDOW_MIN_WIDTH,
} from '../shared/workbench-shell-geometry'

const open = (windowWidth: number) => resolveShellLayout({
  windowWidth,
  sidebarOpen: true,
  sidebarWidth: SHELL_SIDEBAR_WIDTH.default,
  assistantOpen: true,
  assistantWidth: SHELL_ASSISTANT_WIDTH.default,
})

test('wide windows dock everything and keep at least half the window for content', () => {
  const layout = open(1440)
  assert.equal(layout.sidebar, 'docked')
  assert.equal(layout.assistant, 'docked')
  assert.equal(layout.contentWidth, 1440 - 52 - 248 - 380)
  assert.ok(layout.contentWidth / 1440 >= 0.5)
})

test('the assistant gives way first, then the sidebar; content never drops below the minimum', () => {
  for (const width of [1440, 1280, 1100, 980, SHELL_WINDOW_MIN_WIDTH]) {
    const layout = open(width)
    assert.ok(layout.contentWidth >= SHELL_CONTENT_MIN_WIDTH, `${width}: ${layout.contentWidth}`)
  }
  assert.deepEqual([open(1280).sidebar, open(1280).assistant], ['docked', 'docked'])
  assert.deepEqual([open(1100).sidebar, open(1100).assistant], ['docked', 'floating'])
  assert.deepEqual([open(980).sidebar, open(980).assistant], ['docked', 'floating'])
  assert.deepEqual([open(800).sidebar, open(800).assistant], ['floating', 'floating'])
})

test('collapsed columns stay hidden and give their width to the content', () => {
  const layout = resolveShellLayout({ windowWidth: 1440, sidebarOpen: false, sidebarWidth: 248, assistantOpen: false, assistantWidth: 380 })
  assert.equal(layout.sidebar, 'hidden')
  assert.equal(layout.assistant, 'hidden')
  assert.equal(layout.contentWidth, 1440 - 52)
  assert.ok(layout.contentWidth / 1440 >= 0.68)
})

test('stored widths are clamped to their ranges', () => {
  const layout = resolveShellLayout({ windowWidth: 2400, sidebarOpen: true, sidebarWidth: 10, assistantOpen: true, assistantWidth: 9999 })
  assert.equal(layout.sidebarWidth, SHELL_SIDEBAR_WIDTH.min)
  assert.equal(layout.assistantWidth, SHELL_ASSISTANT_WIDTH.max)
})
