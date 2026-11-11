import { memoryNavigationAPI } from './utils/navigation-memory'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { editorFixture } from './helpers/ready-block-editor-fixture'
import type { ReadyRef } from '../shared/ready-ref'

// W6 T1 / §8: in editable text a capsule is presentation only — the same link element with a class, so the caret and
// input methods see ordinary text and the stored Markdown never changes because a link is drawn as a capsule.
const source = '见 [会议纪要](ready://doc/page/meeting) 与 [[资料/选题库]] 和 [[灵感.canvas]]，日期 [2026-11-03](ready://calendar/day/2026-11-03)，网页 [官网](https://example.com)。'
const text = '见 会议纪要 与 资料/选题库 和 灵感.canvas，日期 2026-11-03，网页 官网。'

test('W6 T1 editor links are capsules by presentation: same text, same Markdown; typing and IME inside edit the link text', async t => {
  const f = await editorFixture(t, source)
  const el = f.rich(text)
  const links = () => [...el.querySelectorAll('a')]
  assert.deepEqual(links().map(a => [a.textContent, a.className, a.dataset.refKind ?? null, a.getAttribute('draggable'), a.hasAttribute('data-ready-ref-capsule')]), [
    ['会议纪要', 'rn-ref', 'page', 'true', true], ['资料/选题库', 'rn-ref', 'page', 'true', true], ['灵感.canvas', 'rn-ref', 'canvas', 'true', true],
    ['2026-11-03', 'rn-ref', 'day', 'true', true], ['官网', '', null, null, false],
  ])
  assert.equal(el.textContent, text, 'no node is added for the icon; the caret walks the same text')
  assert.equal(links()[3].getAttribute('style'), null, 'the date capsule has no inline style of its own')

  // Typing inside a capsule changes the link's text; the source stays a Markdown link to the same target.
  await act(() => {
    (links()[0].firstChild as Text).data = '会议纪要二'
    el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })
  f.bytes(source.replace('[会议纪要]', '[会议纪要二]'))

  // A composition inside a capsule is committed once, when it ends.
  const entries = f.buffer.history.entries.length
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
  await act(() => {
    (links()[0].firstChild as Text).data = '会议纪要二稿'
    el.dispatchEvent(new f.dom.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }))
  })
  f.bytes(source.replace('[会议纪要]', '[会议纪要二]'))
  await act(() => el.dispatchEvent(new f.dom.window.CompositionEvent('compositionend', { bubbles: true, data: '稿' })))
  f.bytes(source.replace('[会议纪要]', '[会议纪要二稿]'))
  assert.equal(f.buffer.history.entries.length, entries + 1)
})

test('W6 T1 editor capsules act like every capsule: click opens, ⌥ quick-looks, ⌘ opens in a new tab, a date click still edits it', async t => {
  const f = await editorFixture(t, source)
  const opened: string[] = [], looks: ReadyRef[] = []
  Object.assign(f.dom.window, { electronAPI: {
    // Opening a reference records it in the shared navigation history (W6 §4).
    navigationHistory: memoryNavigationAPI(),
    objects: { locate: async (id: string) => ({ objectId: id, path: `/vault/${id}.md`, revision: 1 }), resolvePath: async (path: string) => ({ objectId: path.split('/').pop()!.replace(/\.\w+$/, ''), path, revision: 1 }), onMoved: () => () => {} },
    document: { stat: async (path: string) => ({ success: /选题库\.md$|灵感\.canvas$/.test(path), data: {} }) },
  } })
  f.dom.window.addEventListener('ready:open-quick-look', event => looks.push((event as CustomEvent<{ ref: ReadyRef }>).detail.ref))
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const before = useWorkspace.getState()
  t.after(() => useWorkspace.setState(before, true))
  useWorkspace.setState({ workspaceRoot: '/vault', pinnedFolders: [] })
  const unsubscribe = useWorkspace.subscribe(state => { if (state.selectedFile) opened.push(state.selectedFile) })
  t.after(unsubscribe)
  const el = f.rich(text)
  const link = (label: string) => [...el.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.textContent === label)!
  const click = async (label: string, init: MouseEventInit = {}) => {
    await act(async () => {
      link(label).dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  await click('会议纪要')
  assert.deepEqual(opened, ['/vault/meeting.md'])
  // A [[wiki]] capsule resolves against the vault first; a board keeps its .canvas target.
  await click('灵感.canvas', { altKey: true })
  assert.deepEqual(looks, [{ kind: 'canvas', id: '灵感' }])
  await click('资料/选题库', { metaKey: true })
  assert.equal(opened.at(-1), '/vault/选题库.md')
  // A date in the text is a value: a plain click opens its picker; ⌥ looks at the day.
  await click('2026-11-03')
  assert.ok(document.querySelector('[aria-label="日期与提醒"]'), 'the date picker opens')
  await click('2026-11-03', { altKey: true })
  assert.deepEqual(looks.at(-1), { kind: 'day', date: '2026-11-03' })
  // A plain web link is still text: a click places the caret and opens nothing.
  const count = opened.length
  await click('官网')
  assert.equal(opened.length, count)
  f.bytes(source)
})
