import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import { setCaret } from '../renderer/modules/document/block-editor/dom-inline'

type Fixture = Awaited<ReturnType<typeof editorFixture>>
async function search(f: Fixture, text: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索操作"]')!
  assert.ok(input, 'searchable keyboard menu')
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  await f.key(input, 'Enter')
}
async function blockMenu(f: Fixture, text: string, action: string) {
  const handle = f.rich(text).closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  assert.ok(handle); await f.key(handle, 'Enter'); await search(f, action)
}

for (const [label, expected] of [
  ['段落', '正文'], ['标题 1', '# 正文'], ['标题 2', '## 正文'], ['标题 3', '### 正文'],
  ['无序列表', '- 正文'], ['有序列表', '1. 正文'], ['任务', '- [ ] 正文'], ['引用', '> 正文'],
  ['提示 callout', '> [!TIP]\r\n> 正文'], ['注意 callout', '> [!WARNING]\r\n> 正文'],
  ['笔记 callout', '> [!NOTE]\r\n> 正文'], ['代码', '```\r\n正文\r\n```'], ['分隔线', '---\r\n\r\n正文'],
]) test(`keyboard block conversion: ${label}`, async t => {
  const f = await editorFixture(t, '正文'); await blockMenu(f, '正文', label); f.bytes(expected)
})

test('keyboard drag only previews until drop, one undo restores exact bytes; Escape cancels', async t => {
  const f = await editorFixture(t, '甲\r\n\r\n乙')
  let handle = f.rich('甲').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); f.bytes('甲\r\n\r\n乙')
  await f.key(handle, 'Escape'); f.bytes('甲\r\n\r\n乙'); assert.equal(f.buffer.history.entries.length, 0)
  handle = f.rich('甲').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); await f.key(handle, 'Enter')
  f.bytes('\r\n\r\n乙\r\n\r\n甲'); assert.equal(f.buffer.history.entries.length, 1)
  await f.key(f.rich('甲'), 'z', { ctrlKey: true }); f.bytes('甲\r\n\r\n乙')
})

test('comments and link definitions stay hidden metadata: not shown, not move stops, bytes kept in place', async t => {
  const source = '甲\r\n\r\n<!-- 注释 -->\n\n[参考]: https://example.com\r\n\r\n乙'
  const f = await editorFixture(t, source)
  assert.equal(document.querySelectorAll('[data-block-type="html"], [data-block-type="unknown"]').length, 0, 'metadata blocks are not rendered')
  assert.ok(!document.body.textContent!.includes('<!-- 注释 -->') && !document.body.textContent!.includes('example.com'))
  const handle = f.rich('甲').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); await f.key(handle, 'Enter')
  f.bytes('\r\n\r\n<!-- 注释 -->\n\n[参考]: https://example.com\r\n\r\n乙\r\n\r\n甲')
  await f.key(f.rich('甲'), 'z', { ctrlKey: true }); f.bytes(source)
})

// T4b-fix contract: both DOM shortcut delivery and native editing commands
// must travel the tab history, including when focus is in a portalled control.
for (const action of ['keyboard drag', 'pointer drag', 'conversion', 'toolbar', 'slash'] as const) {
  for (const delivery of ['shortcut', 'native'] as const) test(`${action}: focused ${delivery} undo restores original bytes`, async t => {
    const original = action === 'slash' ? '/' : '正文\r\n\r\n目标'
    const f = await editorFixture(t, original)
    if (action === 'keyboard drag' || action === 'pointer drag') {
      const handle = f.rich('正文').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
      await act(() => handle.focus())
      if (action === 'keyboard drag') {
        await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); await f.key(handle, 'Enter')
      } else {
        const start = new f.dom.window.Event('dragstart', { bubbles: true, cancelable: true })
        Object.defineProperty(start, 'dataTransfer', { value: { setData() {} } })
        await act(() => handle.dispatchEvent(start))
        const target = f.rich('目标').closest('[data-block-start]')!
        await act(() => target.dispatchEvent(new f.dom.window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 1 })))
        await act(() => target.dispatchEvent(new f.dom.window.Event('drop', { bubbles: true, cancelable: true })))
      }
      f.bytes('\r\n\r\n目标\r\n\r\n正文')
    } else if (action === 'conversion') {
      await blockMenu(f, '正文', '标题 2'); f.bytes('## 正文\r\n\r\n目标')
    } else if (action === 'toolbar') {
      await toolbar(f); await buttonKey(f, '粗体'); f.bytes('**正文**\r\n\r\n目标')
    } else {
      await trigger(f, '/'); await search(f, '标题 2'); f.bytes('## ')
    }
    assert.equal(f.buffer.history.entries.length, 1)
    const edited = f.buffer.snapshot.content
    const el = f.rich(action === 'slash' ? '' : '正文')
    await act(() => el.focus())
    assert.equal(document.activeElement, el)
    const event = delivery === 'shortcut'
      ? new f.dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
      : new f.dom.window.InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })
    await act(() => el.dispatchEvent(event))
    assert.equal(event.defaultPrevented, true, 'native undo must not consume the command')
    f.bytes(original)
    assert.equal(f.buffer.history.entries.length, 0)
    const redo = delivery === 'shortcut'
      ? new f.dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
      : new f.dom.window.InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true })
    await act(() => f.rich(action === 'slash' ? '/' : '正文').dispatchEvent(redo))
    assert.equal(redo.defaultPrevented, true)
    assert.deepEqual(Buffer.from(f.buffer.snapshot.content), Buffer.from(edited))
  })
}

test('undo from a focused portalled block menu uses the owning editor history', async t => {
  const f = await editorFixture(t, '正文')
  await blockMenu(f, '正文', '标题 2'); f.bytes('## 正文')
  const handle = f.rich('正文').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, 'Enter')
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索操作"]')!
  assert.equal(document.activeElement, input)
  const event = new f.dom.window.KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
  await act(() => input.dispatchEvent(event))
  assert.equal(event.defaultPrevented, true)
  f.bytes('正文')
})

test('copy block reference inserts one stable id before clipboard write', async t => {
  const f = await editorFixture(t, '正文'); let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
  await blockMenu(f, '正文', '复制块引用')
  assert.match(copied, /^\[\[夹具#\^[a-zA-Z0-9-]+\]\]$/)
  const id = copied.match(/#\^([^\]]+)/)![1]; f.bytes(`正文 ^${id}`)
  assert.equal(f.buffer.history.entries.length, 1)
})

for (const [key, expected, shiftKey] of [
  ['b', '**正文**', false], ['i', '*正文*', false], ['x', '~~正文~~', true],
  ['e', '`正文`', false], ['u', '<u>正文</u>', false],
] as const) test(`inline keyboard ${key} serializes through T1`, async t => {
  const f = await editorFixture(t, '正文'); const el = f.rich('正文')
  await act(() => { el.focus(); setCaret(el, 0, 2) })
  await f.key(el, key, { ctrlKey: true, shiftKey }); f.bytes(expected)
  await f.key(f.rich('正文'), 'z', { ctrlKey: true }); f.bytes('正文')
})

test('slash Widget opens the existing drawer, cancellation leaves bytes untouched', async t => {
  const f = await editorFixture(t, '/')
  const el = f.rich('/'); await f.caret(el, 1)
  await act(() => el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true })))
  await search(f, 'Widget')
  assert.ok(document.querySelector('[role="dialog"][aria-label="编辑 widget"]'))
  f.bytes('/'); await f.key(document.body, 'Escape'); f.bytes('/')
})

test('slash Mermaid and columns are real source blocks', async t => {
  const f = await editorFixture(t, '/'); const el = f.rich('/'); await f.caret(el, 1)
  await act(() => el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true })))
  await search(f, 'Mermaid'); f.bytes('```mermaid\r\ngraph TD\r\n  A --> B\r\n```')
})

async function field(f: Fixture, label: string, value: string) {
  const el = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
  assert.ok(el, label)
  await act(async () => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
    await Promise.resolve()
  })
  return el
}
async function trigger(f: Fixture, text: string) {
  const el = f.rich(text); await f.caret(el, text.length)
  await act(() => el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true })))
}
async function toolbar(f: Fixture) {
  const el = f.rich('正文')
  await act(() => { el.focus(); setCaret(el, 0, 2) })
  await f.key(el, 'F10', { altKey: true })
  assert.ok(document.querySelector('[aria-label="文字格式"]'))
}
test('editor popups leave with their scene: switching mode removes the toolbar and keeps the text intact', async t => {
  const f = await editorFixture(t, '正文')
  const root = document.getElementById('root')!, panel = document.createElement('div')
  panel.setAttribute('data-workbench-mode-panel', 'document'); root.replaceWith(panel); panel.append(root)
  const { useMode } = await import('../renderer/stores/useMode')
  await act(() => useMode.setState({ workbenchMode: 'document' }))
  await toolbar(f)
  await act(() => useMode.setState({ workbenchMode: 'browser' }))
  assert.equal(document.querySelector('[aria-label="文字格式"]'), null, 'no document popup floats over the browser')
  await act(() => useMode.setState({ workbenchMode: 'document' }))
  f.bytes('正文')
})

async function buttonKey(f: Fixture, label: string) {
  const el = [...document.querySelectorAll('button')].find(el => el.textContent === label)!
  assert.ok(el, label); await f.key(el, 'Enter')
}

test('toolbar link editing/removal and token colors preserve source around selection', async t => {
  const f = await editorFixture(t, '正文')
  await toolbar(f); await buttonKey(f, '链接')
  const input = await field(f, '链接地址', 'https://example.com/a'); await f.key(input, 'Enter')
  f.bytes('[正文](https://example.com/a)')
  await toolbar(f); await buttonKey(f, '链接'); await buttonKey(f, '移除链接'); f.bytes('正文')
  for (const [label, expected] of [['文字颜色', '<span style="color: red">正文</span>'], ['背景颜色', '<span style="background-color: red">正文</span>']]) {
    await toolbar(f)
    const select = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
    await act(() => { select.value = 'red'; select.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })) })
    f.bytes(expected); await f.key(f.rich('正文'), 'z', { ctrlKey: true }); f.bytes('正文')
  }
})

test('Widget drawer confirmation inserts a compiled widget, not a markdown stand-in', async t => {
  const f = await editorFixture(t, '/'); await trigger(f, '/'); await search(f, 'Widget')
  const dialog = document.querySelector('[aria-label="编辑 widget"]')!
  const save = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('保存'))!
  assert.ok(save)
  // Native button Enter activation is implemented by the browser; click is its DOM activation event.
  await act(() => save.click())
  const raw = f.buffer.snapshot.content
  assert.match(raw, /```show-widget\r\n\{"id":/)
  assert.match(raw, /"skeleton_spec":\{"skeleton":"single_focus"/)
  assert.match(raw, /"widget_code":"[^\r\n]+/)
  assert.equal(f.buffer.history.entries.length, 1)
  await f.key(f.rich('尾段 é'), 'z', { ctrlKey: true }); f.bytes('/')
})

async function referenceAPI(f: Fixture, t: test.TestContext) {
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const previous = { workspaceRoot: useWorkspace.getState().workspaceRoot, pinnedFolders: useWorkspace.getState().pinnedFolders }
  useWorkspace.setState({ workspaceRoot: '/vault', pinnedFolders: [] })
  t.after(() => useWorkspace.setState(previous))
  const requests: unknown[] = []
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    document: {
      searchIndex: async (request: unknown) => { requests.push(request); return { success: true, data: { items: [
        { path: '/vault/一/同名.md', name: '同名', sourceType: 'document' },
        { path: '/vault/二/同名.md', name: '同名', sourceType: 'document' },
        { path: 'ready://calendar/event/event-id#occurrence=123', name: '会议', sourceType: 'calendar' },
        { path: 'ready://read/book/book-id#chapter%3A1', name: '书籍', sourceType: 'library' },
      ] } } },
      readFile: async () => ({ success: true, data: { content: '# 第一节\n\n正文\n\n## 第二节' } }),
    },
    objects: { onMoved: () => () => {}, resolvePath: async (path: string) => ({ objectId: path.includes('一') ? 'page-one' : 'page-two', path, revision: 1 }) },
  } })
  return requests
}
async function referenceQuery(f: Fixture, query: string) {
  const input = await field(f, '搜索操作', query)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
  return input
}

test('wiki picker uses global search, displays duplicate paths and inserts a heading by keyboard', async t => {
  const f = await editorFixture(t, '[['); const requests = await referenceAPI(f, t); await trigger(f, '[[')
  const input = await referenceQuery(f, '同名')
  assert.ok(requests.length)
  assert.match(document.querySelector('[role="listbox"]')!.textContent!, /\/vault\/一\/同名.md/)
  assert.match(document.querySelector('[role="listbox"]')!.textContent!, /\/vault\/二\/同名.md/)
  await f.key(input, 'ArrowDown'); await f.key(input, 'Enter'); f.bytes('[[/vault/一/同名#第一节]]')
  await f.key(f.rich('/vault/一/同名#第一节'), 'z', { ctrlKey: true }); f.bytes('[[')
})

test('a saved page links to the chosen page relative to its own folder, in one undo step', async t => {
  const f = await editorFixture(t, '[['); await referenceAPI(f, t)
  await act(() => f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, path: '/vault/笔记/当前.md' })) })))
  await trigger(f, '[[')
  const input = await referenceQuery(f, '同名')
  await f.key(input, 'ArrowDown'); await f.key(input, 'Enter'); f.bytes('[[../一/同名#第一节]]')
  await f.key(f.rich('../一/同名#第一节'), 'z', { ctrlKey: true }); f.bytes('[[')
})

for (const [query, down, expected] of [
  ['同名', 0, '[同名](ready://doc/page/page-one)'],
  ['会议', 2, '[会议](ready://calendar/event/event-id#occurrence=123)'],
  ['书籍', 3, '[书籍](ready://read/book/book-id#chapter%3A1)'],
  ['2026-10-31', 0, '[2026-10-31](ready://calendar/day/2026-10-31)'],
] as const) test(`mention inserts ${query} ReadyRef using keyboard`, async t => {
  const f = await editorFixture(t, '@'); await referenceAPI(f, t); await trigger(f, '@')
  const input = await referenceQuery(f, query)
  for (let i = 0; i < down; i++) await f.key(input, 'ArrowDown')
  await f.key(input, 'Enter'); f.bytes(expected)
})

test('picker Escape leaves source intact', async t => {
  const f = await editorFixture(t, '[['); await referenceAPI(f, t); await trigger(f, '[[')
  const input = await referenceQuery(f, '同名'); await f.key(input, 'Escape'); f.bytes('[[')
  assert.equal(document.querySelector('[aria-label="页面和标题"]'), null)
})

test('keyboard drag crosses columns with one operation and can leave a column', async t => {
  const source = '<!-- ready:columns widths=1,1 -->\r\n左\r\n\r\n<!-- ready:column -->\r\n右\r\n\r\n<!-- ready:columns-end -->\r\n\r\n外'
  const f = await editorFixture(t, source)
  const handle = f.rich('左').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); f.bytes(source)
  await f.key(handle, 'Enter')
  const expected = source.replace('左', '').replace('右', '右\r\n\r\n左')
  f.bytes(expected); assert.equal(f.buffer.history.entries.length, 1)
  await f.key(f.rich('左'), 'z', { ctrlKey: true }); f.bytes(source)
  const again = f.rich('左').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(again, ' '); await f.key(again, 'ArrowDown'); await f.key(again, 'ArrowDown'); await f.key(again, 'Enter')
  f.bytes(source.replace('左', '').replace('外', '外\r\n\r\n左'))
  await f.key(f.rich('左'), 'z', { ctrlKey: true }); f.bytes(source)
})

test('stale block menu refuses to replace external content', async t => {
  const f = await editorFixture(t, '正文')
  const handle = f.rich('正文').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, 'Enter')
  await act(() => f.useDocTabs.getState().updateTabContent(t.name, f.buffer.snapshot.content.replace('正文', '外部新文')))
  await search(f, '标题 1'); f.bytes('外部新文')
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /版本|range|原文/)
})

test('drag into an empty column preserves valid markers and one undo restores it', async t => {
  const source = '外\r\n\r\n<!-- ready:columns widths=1,1 -->\r\n\r\n<!-- ready:column -->\r\n右\r\n\r\n<!-- ready:columns-end -->'
  const f = await editorFixture(t, source)
  const handle = f.rich('外').closest('[data-block-start]')!.querySelector<HTMLElement>('[aria-label="块菜单"]')!
  await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); await f.key(handle, 'ArrowDown'); await f.key(handle, 'Enter')
  f.bytes(source.replace('外', '').replace('<!-- ready:column -->', '外\r\n\r\n<!-- ready:column -->'))
  assert.equal(f.buffer.history.entries.length, 1)
  await f.key(f.rich('外'), 'z', { ctrlKey: true }); f.bytes(source)
})

test('subpage is inserted only after the page service confirms; retry keeps its operation id', async t => {
  const f = await editorFixture(t, '/'); await referenceAPI(f, t)
  // Renderer fixture starts from an already resolved parent; page-service transport is the only write substitute.
  await act(() => f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, path: '/vault/父页.md', objectId: 'parent', objectBinding: { status: 'resolved' as const } })) })))
  const requests: Array<{ operationId: string; parentPath: string; title: string }> = []
  let fail = true
  Object.defineProperty(window.electronAPI, 'documentPages', { value: { operate: async (input: typeof requests[number]) => {
    requests.push(input)
    if (fail) return { ok: false, message: '测试写入失败' }
    return { ok: true, value: { operationId: input.operationId, state: 'committed', path: '/vault/父页/子页.md', objectId: 'child', revision: 1 } }
  } } })
  await trigger(f, '/'); await search(f, '子页面')
  const input = await field(f, '子页面标题', '子页')
  const form = input.closest('form')!
  await act(async () => { form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
  f.bytes('/'); assert.match(document.querySelector('[role="alert"]')!.textContent!, /测试写入失败/)
  fail = false
  await act(async () => { form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve() })
  assert.equal(requests.length, 2); assert.equal(requests[0].operationId, requests[1].operationId)
  assert.equal(requests[0].parentPath, '/vault/父页.md'); assert.equal(requests[0].title, '子页')
  // Canonical target: relative to the page's folder, as the object link repair writes it.
  f.bytes('[[父页/子页]]')
})

test('a newer search wins when an older lookup resolves last', async t => {
  const f = await editorFixture(t, '[['); await referenceAPI(f, t)
  let release: (() => void) | undefined
  Object.defineProperty(window.electronAPI.document, 'searchIndex', { value: async ({ query }: { query: string }) => {
    if (query === '旧查询') await new Promise<void>(resolve => { release = resolve })
    return { success: true, data: { items: [{ path: `/vault/${query}.md`, name: query, sourceType: 'document' }] } }
  } })
  await trigger(f, '[['); await referenceQuery(f, '旧查询'); assert.ok(release)
  const input = await referenceQuery(f, '新查询')
  await act(async () => { release!(); await Promise.resolve() })
  assert.doesNotMatch(document.querySelector('[role="listbox"]')!.textContent!, /旧查询/)
  await f.key(input, 'Enter'); f.bytes('[[/vault/新查询]]')
})

for (const [action, expected] of [['复制', '正文\r\n\r\n正文'], ['删除', ''], ['文字颜色：红色', '<span style="color: red">正文</span>']]) {
  test(`keyboard block action ${action}`, async t => {
    const f = await editorFixture(t, '正文'); await blockMenu(f, '正文', action); f.bytes(expected)
    assert.equal(f.buffer.history.entries.length, 1)
  })
}

test('whole Mermaid blocks can be dragged and undone without touching their source', async t => {
  const code = '```mermaid\r\ngraph TD\r\nA-->B\r\n```'
  const f = await editorFixture(t, code + '\r\n\r\n目标')
  const handle = document.querySelector<HTMLElement>('[data-block-start][data-block-type="mermaid"] [aria-label="块菜单"]')!
  await f.key(handle, ' '); await f.key(handle, 'ArrowDown'); await f.key(handle, 'Enter')
  f.bytes('\r\n\r\n目标\r\n\r\n' + code)
  await f.key(f.rich('目标'), 'z', { ctrlKey: true }); f.bytes(code + '\r\n\r\n目标')
})

test('slash columns creates two editable empty columns, keeping their comment markers', async t => {
  const f = await editorFixture(t, '/'); await trigger(f, '/'); await search(f, '分栏')
  f.bytes('<!-- ready:columns widths=1,1 -->\r\n\r\n<!-- ready:column -->\r\n\r\n<!-- ready:columns-end -->')
  assert.equal(document.querySelectorAll('[data-block-type="column"] [contenteditable="true"]').length, 2)
})

test('container color changes its text in a single undo entry and retains list markers', async t => {
  const f = await editorFixture(t, '- 甲\r\n- 乙')
  const handle = document.querySelector<HTMLElement>('[data-block-start][data-block-type="list"] [aria-label="块菜单"]')!
  await f.key(handle, 'Enter'); await search(f, '文字颜色：红色')
  f.bytes('- <span style="color: red">甲</span>\r\n- <span style="color: red">乙</span>')
  assert.equal(f.buffer.history.entries.length, 1)
  await f.key(f.rich('甲'), 'z', { ctrlKey: true }); f.bytes('- 甲\r\n- 乙')
})

test('a callout renders whole through the source renderer, never as a raw [!type] paragraph', async t => {
  const source = '> [!quote|yellow] 书 · [原文](ready://read/book/b#c0:6+5)\r\n> 摘录'
  const f = await editorFixture(t, source)
  const callout = document.querySelector<HTMLElement>('[data-block-start][data-block-type="callout"]')!
  assert.ok(callout, 'the callout keeps its block shell and menu')
  assert.equal(callout.querySelectorAll('[data-rich-start]').length, 0, 'no inline child shows the marker line')
  assert.equal(callout.querySelectorAll('[data-block-type="paragraph"]').length, 0)
  assert.equal(callout.querySelector('pre')!.textContent, source)
  f.bytes(source)
})

test('converting a callout retains its authored title as well as its body', async t => {
  const f = await editorFixture(t, '> [!NOTE] 标题\r\n> 正文')
  const handle = document.querySelector<HTMLElement>('[data-block-start][data-block-type="callout"] [aria-label="块菜单"]')!
  await f.key(handle, 'Enter'); await search(f, '段落'); f.bytes('标题\r\n正文')
})
