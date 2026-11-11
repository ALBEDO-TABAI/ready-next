import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { registerHooks } from 'node:module'
import { editorFixture, head, tail } from './helpers/ready-block-editor-fixture'
import { readDocumentSource } from '../shared/document-operations'

test('M5 page title, body, outline and source use exact titles without moving source anchors', async t => {
  const f = await editorFixture(t, '# 保留\r\n\r\n正文')
  const css = registerHooks({ load(url, context, next) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context)
  } })
  t.after(() => css.deregister())
  const { PageDocumentEditor } = await import('../renderer/modules/document/page-ui/PageDocumentEditor')
  const { default: DocumentFloatingPanels } = await import('../renderer/components/document/DocumentFloatingPanels')
  const { useVault } = await import('../renderer/stores/useVault')
  const { useDocumentNavigator } = await import('../renderer/modules/document/navigator/useDocumentNavigator')
  const priorVault = useVault.getState().view, priorView = useDocumentNavigator.getState().view
  useVault.setState({ view: { phase: 'loaded', data: { status: 'ready', root: '/vault', defaultSuggestion: '/vault' } } })
  t.after(() => { useVault.setState({ view: priorVault }); useDocumentNavigator.setState({ view: priorView }) })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { documentPages: {
    properties: async () => ({ ok: true, value: { properties: readDocumentSource(f.buffer.snapshot.content).frontmatter, version: 'fixture' } }),
    onChanged: () => () => {},
  } } })
  const reveals: number[] = []
  async function render(body: string, { prefix = head, view = 'preview', files = false, external = false }:
    { prefix?: string; view?: 'preview' | 'edit'; files?: boolean; external?: boolean } = {}) {
    const content = prefix + body + tail
    await act(() => {
      useDocumentNavigator.setState({ view: files ? 'files' : 'pages' })
      f.useDocTabs.setState({ tabs: [{ id: t.name, title: '文件名.md', path: `${external ? '/outside' : '/vault'}/文件名.md`, content,
        isDirty: false, objectId: body, objectBinding: { status: 'resolved' } }] })
    })
    const tab = f.useDocTabs.getState().tabs[0]
    await act(() => f.root.render(<>
      <PageDocumentEditor tab={tab} viewMode={view} previewEditable isSceneVisible />
      <DocumentFloatingPanels documentPath={tab.path} documentTitle={tab.title} content={content} activeLine={1}
        outlineOpen marksOpen={false} onToggleOutline={() => {}} onToggleMarks={() => {}} onReveal={line => reveals.push(line)} />
    </>))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)) })
    assert.equal(f.buffer.snapshot.content, content, 'presentation never changes source')
    return content
  }
  for (const [heading, hidden] of [
    ['# 保留  ', true], ['#   保留   ###', true], ['保留\r\n===', true],
    ['# 保留！', false], ['# **保留**', false], ['# 保 留', false],
    ['# 别的标题\r\n\r\n# 保留', false], ['# 保留\r\n\r\n# 保留', true],
  ] as const) {
    const body = heading + '\r\n\r\n正文\r\n\r\n## 后续'
    const content = await render(body)
    assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="页面标题"]')?.value, '保留')
    if (heading === '# 保留  ') assert.equal(document.querySelectorAll('[data-ready-heading-title="保留"]:not([data-ready-hidden-title])').length, 0, 'the body must not display the page title again')
    assert.equal(Boolean(document.querySelector('[data-ready-hidden-title]')), hidden, heading)
    const next = document.querySelector<HTMLElement>('[data-ready-heading-title="后续"]')!
    const line = content.slice(0, content.indexOf('## 后续')).split(/\r\n|\n/).length
    assert.equal(Number(next.closest<HTMLElement>('[data-ready-block-source-line]')?.dataset.readyBlockSourceLine), line)
    const rows = [...document.querySelectorAll<HTMLElement>('.document-outline-row')]
    // The skipped row alone disappears: later H1s and their original line numbers remain.
    if (hidden && !heading.includes('\r\n\r\n#')) assert.ok(rows.every(row => !row.textContent?.includes('保留')))
    const nextRow = rows.find(row => row.textContent?.includes('后续'))!
    await act(() => nextRow.click()); assert.equal(reveals.at(-1), line)
    if (heading === '# 保留\r\n\r\n# 保留') assert.equal(document.querySelectorAll('[data-ready-heading-title="保留"]:not([data-ready-hidden-title])').length, 1)
  }
  const repeated = await render('# 保留\r\n\r\n正文\r\n\r\n# 保留')
  const { captureElementScroll, restoreElementScroll } = await import('../renderer/modules/document/documentScrollRuntime')
  const { resolveMarkdownLineFromAnchor } = await import('../renderer/modules/document/documentScrollAnchor')
  const textareaClass = Object.getOwnPropertyDescriptor(globalThis, 'HTMLTextAreaElement')
  Object.defineProperty(globalThis, 'HTMLTextAreaElement', { value: f.dom.window.HTMLTextAreaElement, configurable: true })
  t.after(() => { if (textareaClass) Object.defineProperty(globalThis, 'HTMLTextAreaElement', textareaClass); else Reflect.deleteProperty(globalThis, 'HTMLTextAreaElement') })
  const surface = document.querySelector<HTMLElement>('.document-preview-surface')!
  Object.defineProperties(surface, { scrollHeight: { value: 600 }, clientHeight: { value: 100 } })
  const headings = [...surface.querySelectorAll<HTMLElement>('[data-ready-heading-title]')]
  headings.forEach((el, index) => { el.getBoundingClientRect = () => new f.dom.window.DOMRect(0, index * 200 - surface.scrollTop, 100, el.hasAttribute('data-ready-hidden-title') ? 0 : 30) })
  surface.scrollTop = 200
  const anchor = captureElementScroll(surface, repeated)
  assert.equal(anchor.anchorTitle, '保留'); assert.equal(anchor.anchorOrdinal, 1)
  assert.equal(resolveMarkdownLineFromAnchor(repeated, { ...anchor, anchorProgress: 0 }), repeated.slice(0, repeated.lastIndexOf('# 保留')).split('\n').length)
  surface.scrollTop = 0
  const stopRestore = restoreElementScroll(surface, { ...anchor, anchorProgress: 0 }, repeated)
  assert.equal(surface.scrollTop, 192, 'restoration selects the second source heading, not the hidden first one')
  stopRestore()
  await render('# 保留', { prefix: head.replace('保留', ' 保留 ') })
  assert.ok(document.querySelector('[data-ready-hidden-title]'), 'trim display title boundaries too')
  await render('# title', { prefix: head.replace('保留', 'Title') })
  assert.equal(Boolean(document.querySelector('[data-ready-hidden-title]')), false, 'case is significant')
  await render('# 文件名\r\n\r\n正文', { prefix: '' })
  assert.equal(document.querySelector<HTMLTextAreaElement>('[aria-label="页面标题"]')?.value, '文件名')
  assert.ok(document.querySelector('[data-ready-hidden-title]'))
  await render('```md\r\n# 保留\r\n```\r\n\r\n> # 保留\r\n\r\n# 保留')
  assert.ok(document.querySelector('[data-ready-hidden-title]'), 'fenced and nested headings do not claim the page title')
  assert.equal(document.querySelectorAll('[data-rich-start][data-ready-heading-title="保留"]').length, 1, 'nested heading remains editable')
  for (const options of [{ files: true }, { external: true }]) {
    await render('# 保留', options)
    assert.equal(document.querySelectorAll('[data-ready-heading-title="保留"]:not([data-ready-hidden-title])').length, 1)
    assert.ok([...document.querySelectorAll('.document-outline-row')].some(row => row.textContent?.includes('保留')))
  }
  const source = await render('# 保留  \r\n\r\n正文', { view: 'edit' })
  assert.equal(document.querySelector<HTMLTextAreaElement>('.document-source-textarea')?.value, source.replace(/\r\n?/g, '\n'))
})
