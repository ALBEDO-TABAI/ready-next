import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { registerHooks } from 'node:module'
import { editorFixture, head, tail } from './helpers/ready-block-editor-fixture'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { configureDocumentWriteService } from '../main/modules/document-engine/document-write-service'
import { writeDocumentEditableText } from '../main/modules/document-engine/document-editable-text'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// T4a-fix contract: real page/source components, tab buffer, draft controller,
// save registration and global shortcut. Browser geometry, IPC transport and
// indexing use adapters; drafts and file writes use real SQLite and temporary files.
test('page edits, split undo and Widget source save exact bytes through Cmd+S in both views', async t => {
  if (skipIfSqliteUnavailable(t, 'Block editor save (run with Electron)')) return
  const widget = '```show-widget\r\n{"title":"验收卡","widget_code":"<p>Widget 原文</p>"}\r\n```'
  const other = '```show-widget\r\n{"id":"other-card","title":"旁卡","widget_code":"<input>"}\r\n```'
  const body = '编辑甲乙\r\n\r\n' + widget + '\r\n\r\n' + other
  const f = await editorFixture(t, body)
  const css = registerHooks({ load(url, context, next) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context)
  } })
  t.after(() => css.deregister())
  const { default: MarkdownEditor } = await import('../renderer/components/document/MarkdownEditor')
  const { useKeyboardShortcuts } = await import('../renderer/hooks/useKeyboardShortcuts')
  const { useMode } = await import('../renderer/stores/useMode')
  const { MemoryRouter } = await import('react-router-dom')
  const { runRegisteredDocumentSave, waitForRegisteredDocumentSave, getDocumentSaveSerializationKey } = await import('../renderer/modules/document/documentSaveRegistry')
  const runtime = await import('../renderer/modules/document/drafts/runtime')
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-block-save-')))
  const path = join(directory, 'save.md')
  writeFileSync(path, head + body + tail)
  const db = new Database(':memory:'); runMigrations(db)
  const registry = new ObjectRegistry(db)
  const service = new DocumentDraftService(db, { registry, index: async () => {} })
  configureDocumentWriteService({ index: async () => {} })
  runtime.configureDrafts({
    api: () => ({
      create: async input => ({ ok: true, value: service.create(input) }),
      save: async (...args) => ({ ok: true, value: service.save(...args) }),
      read: async id => ({ ok: true, value: service.read(id) }),
      list: async id => ({ ok: true, value: service.list(directory, id) }),
      discard: async (...args) => ({ ok: true, value: service.discard(...args) }),
      finalize: async (...args) => ({ ok: true, value: await service.finalize(...args) }),
      importLegacy: async items => ({ ok: true, value: service.importLegacy(directory, items) }),
    }),
    tabs: () => f.useDocTabs.getState().tabs,
    patch: (id, patch) => f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
    root: async () => directory, resolve: async file => registry.register(file).id,
    locate: async id => registry.get(id)!.current_path!, read: async file => readFileSync(file, 'utf8'),
  }, () => {})
  t.after(async () => { await runtime.drafts.flush(t.name); configureDocumentWriteService(null); db.close(); rmSync(directory, { recursive: true, force: true }) })
  const writes: string[] = []
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { document: {
    readFile: async () => ({ success: true, content: head + body + tail }),
    writeFile: async (target: string, content: string) => { assert.equal(target, path); writes.push(content); return writeDocumentEditableText(target, content) },
  } } })
  await act(() => {
    f.useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, path })), activeTabId: t.name, splitTabId: null, focusedPaneTabId: t.name }))
    useMode.setState({ appMode: 'workbench', workbenchMode: 'document', splitMode: null })
  })
  function Surface({ view }: { view: 'edit' | 'preview' }) {
    useKeyboardShortcuts()
    const tab = f.useDocTabs(state => state.tabs.find(item => item.id === t.name)!)
    return <MarkdownEditor tab={tab} viewMode={view} previewEditable />
  }
  const view = async (mode: 'edit' | 'preview') => {
    await act(() => f.root.render(<MemoryRouter initialEntries={['/workbench']}><Surface view={mode} /></MemoryRouter>))
  }
  const save = async (target: HTMLElement) => {
    const count = writes.length
    await f.key(target, 's', { metaKey: true })
    await act(async () => { await waitForRegisteredDocumentSave(getDocumentSaveSerializationKey(t.name, path)) })
    assert.equal(writes.length, count + 1, document.body.textContent ?? 'save must write')
  }
  await view('preview')
  const paragraph = f.rich('编辑甲乙')
  await f.caret(paragraph, 4); await f.input(paragraph, '编辑甲乙中文')
  await f.caret(paragraph, 4); await f.key(paragraph, 'Enter')
  f.bytes(body.replace('编辑甲乙', '编辑甲乙\r\n\r\n中文'))
  await f.key(f.rich('中文'), 'z', { metaKey: true })
  f.bytes(body.replace('编辑甲乙', '编辑甲乙中文'))
  assert.equal(f.useDocTabs.getState().tabs[0].isDirty, true)
  const card = document.querySelector('[data-block-type="widget"]')!
  await f.click('编辑源码', card)
  const source = card.querySelector('textarea')!
  await act(() => {
    Object.getOwnPropertyDescriptor(f.dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(source, source.value.replace('原文', '新文'))
    source.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }))
  })
  // The real iframe reports this even for a static card after loading/hydration.
  const iframe = card.querySelector('iframe')!
  const token = /var widgetToken='([^']+)'/.exec(iframe.srcdoc)?.[1]
  assert.ok(token)
  await act(() => window.dispatchEvent(new f.dom.window.MessageEvent('message', {
    data: { type: 'widget:state', token, state: { controls: [], activeTargets: [] } },
  })))
  await f.click('完成', card)
  const expectedBody = body.replace('编辑甲乙', '编辑甲乙中文').replace('原文', '新文')
  await save(document.body)
  f.bytes(expectedBody)
  assert.deepEqual(Buffer.from(writes.at(-1)!), Buffer.from(head + expectedBody + tail))
  assert.deepEqual(readFileSync(path), Buffer.from(head + expectedBody + tail))
  await act(async () => { await runtime.drafts.flush(t.name) })
  assert.equal(f.useDocTabs.getState().tabs[0].isDirty, false)
  await f.caret(f.rich('编辑甲乙中文'), 6)
  await save(f.rich('编辑甲乙中文'))
  await view('edit')
  await save(document.querySelector('textarea.document-source-textarea')!)
  await view('preview')
  await act(async () => { assert.equal(await runRegisteredDocumentSave(t.name), true) })
  for (const written of writes) assert.deepEqual(Buffer.from(written), Buffer.from(head + expectedBody + tail))
  // A real Widget state change edits only that fence and survives saving;
  // its hydration echo after saving must leave the tab clean.
  const state = { controls: [{ index: 0, tag: 'input', type: 'text', value: '填写', checked: false }], activeTargets: [] }
  const reportState = (value: typeof state) => {
    const otherFrame = document.querySelectorAll<HTMLIFrameElement>('[data-block-type="widget"] iframe')[1]
    const token = /var widgetToken='([^']+)'/.exec(otherFrame.srcdoc)?.[1]
    assert.ok(token)
    return window.dispatchEvent(new f.dom.window.MessageEvent('message', { data: { type: 'widget:state', token, state: value } }))
  }
  await act(() => reportState(state))
  assert.equal(f.useDocTabs.getState().tabs[0].isDirty, true)
  const withState = expectedBody.replace(other, other.replace('"<input>"}', '"<input>","widget_state":' + JSON.stringify(state) + '}'))
  f.bytes(withState)
  await save(f.rich('编辑甲乙中文'))
  assert.deepEqual(readFileSync(path), Buffer.from(head + withState + tail))
  await act(() => reportState(state))
  assert.equal(f.useDocTabs.getState().tabs[0].isDirty, false)
  const empty = { controls: [], activeTargets: [] }
  await act(() => reportState(empty))
  assert.equal(f.useDocTabs.getState().tabs[0].isDirty, true, 'clearing an existing state is an edit')
  const cleared = withState.replace(JSON.stringify(state), JSON.stringify(empty))
  f.bytes(cleared)
  await save(f.rich('编辑甲乙中文'))
  assert.deepEqual(readFileSync(path), Buffer.from(head + cleared + tail))
})
