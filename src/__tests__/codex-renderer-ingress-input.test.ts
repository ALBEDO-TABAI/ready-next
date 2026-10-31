import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexIngressInputWithDiagnostics,
  resolveReferencedFilePoolAttachments,
} from '../renderer/modules/agent/messageComposer'

const capturedSelection = { kind: 'document_selection' as const, id: 'selected', name: 'Selection', libraryId: 'a'.repeat(64), target: { kind: 'object' as const, uri: 'ready://doc/page/page' }, version: 'b'.repeat(64), range: { start: 0, end: 4 }, summary: { characters: 4, digest: 'c'.repeat(64) }, access: 'text' as const }

test('Codex renderer ingress sends verbatim user text and a body-free local image selection', async () => {
  const priorWindow = globalThis.window
  let readFileForAICalls = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      electronAPI: {
        chat: {
          async readFileForAI() {
            readFileForAICalls += 1
            return {
              success: true,
              data: { type: 'image', base64: 'aW1hZ2U=', mimeType: 'image/png' },
            }
          },
        },
      },
    },
  })
  try {
    const result = await buildCodexIngressInputWithDiagnostics({
      content: '用户原文',
      attachments: [{
        id: 'image-1', name: 'secret.png', path: '/private/secret.png',
        type: 'image', size: 5, ext: '.png', source: 'file',
      }],
    })
    assert.equal(result.message, '用户原文')
    assert.deepEqual(result.resources, [{
      kind: 'local_file',
      id: 'image-1',
      name: 'secret.png',
      path: '/private/secret.png',
      size: 5,
      ext: '.png',
      rendererType: 'image',
    }])
    assert.equal(JSON.stringify(result.message).includes('/private/secret.png'), false)
    assert.equal(JSON.stringify(result).includes('aW1hZ2U='), false)
    assert.equal(readFileForAICalls, 0)
    assert.equal(result.diagnostics.inputIncludedCount, 1)
    assert.equal(result.diagnostics.inputFailedCount, 0)
  } finally {
    if (priorWindow === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: priorWindow })
  }
})

test('non-image resources remain body-free selections instead of becoming prompt text', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '阅读这个文件',
    attachments: [{
      id: 'doc-1', name: 'secret.txt', path: '/private/secret.txt',
      type: 'text', size: 5, ext: '.txt', source: 'file',
    }],
  })
  assert.equal(result.message, '阅读这个文件')
  assert.deepEqual(result.resources, [{
    kind: 'local_file',
    id: 'doc-1',
    name: 'secret.txt',
    path: '/private/secret.txt',
    size: 5,
    ext: '.txt',
    rendererType: 'text',
  }])
  assert.equal(result.diagnostics.inputIncludedCount, 1)
  assert.equal(result.diagnostics.inputFailedCount, 0)
  assert.equal(JSON.stringify(result.message).includes('/private/secret.txt'), false)
})

test('directory and installed-skill selections use distinct body-free contracts', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '使用这些资源',
    attachments: [
      {
        id: 'folder-1', name: '资料', path: '/private/资料', type: 'other',
        isDirectory: true, size: 0, ext: '', source: 'file',
      },
      {
        id: 'skill-1', name: '总结技能', path: '/managed/skills/summary', type: 'other',
        size: 0, ext: '', source: 'skill-folder', skillId: 'summary',
      },
    ],
  })
  assert.deepEqual(result.resources, [
    { kind: 'local_directory', id: 'folder-1', name: '资料', path: '/private/资料' },
    {
      kind: 'skill', id: 'skill-1', name: '总结技能', path: '/managed/skills/summary',
      skillId: 'summary',
    },
  ])
  assert.equal(result.diagnostics.inputIncludedCount, 2)
  assert.equal(result.diagnostics.inputFailedCount, 0)
})

test('browser, calendar and selected document text use narrow structured reference contracts', async () => {
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '看看这个',
    attachments: [
      {
        id: 'browser-1', name: '网页', path: 'ready://web?url=https%3A%2F%2Fexample.test', type: 'other',
        size: 0, ext: '', source: 'browser-tab', browserTabId: 'tab-1',
      },
      {
        id: 'calendar-1', name: '评审会', path: 'ready://calendar/event/event-1', type: 'text',
        size: 0, ext: '.calendar', source: 'calendar-event', eventId: 'event-1',
      },
      {
        id: 'quote-1', name: '方案.md', path: '/workspace/方案.md', type: 'text',
        size: 4, ext: '.quote', source: 'document-quote', selection: '准确摘录',
        documentTitle: '方案.md', lineStart: 4, lineEnd: 4, libraryResource: capturedSelection,
      },
    ],
  })
  assert.deepEqual(result.resources, [
    { kind: 'browser_tab', id: 'browser-1', name: '网页', tabId: 'tab-1' },
    { kind: 'calendar_event', id: 'calendar-1', name: '评审会', eventId: 'event-1' },
    capturedSelection,
  ])
  assert.equal(result.message, '看看这个')
  assert.equal(result.diagnostics.inputIncludedCount, 3)
  assert.equal(result.diagnostics.inputFailedCount, 0)
})

test('a clean Windows document tab remains a file reference instead of being mistaken for an unsaved quote', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { objects: { locate: async () => ({ objectId: 'doc-object', path: "C:\\workspace\\方案.md", revision: 1 }) } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '阅读这个文档',
    attachments: [{
      id: 'windows-doc', name: '方案.md', path: 'ready://doc/page/doc-object', type: 'text',
      size: 12, ext: '.md', source: 'document-tab', dirty: false, selection: 'visible selection',
    }],
  })
  assert.deepEqual(result.resources, [{
    kind: 'local_file', id: 'windows-doc', name: '方案.md', path: 'C:\\workspace\\方案.md',
    size: 12, ext: '.md', rendererType: 'text',
  }])
})

// 2026-10-06: after a turn left card edits unsaved, re-attaching the open document sent a 30k-character pasted copy
// next to the live document instead of pointing at it.
test('the focused document tab with unsaved edits is still the current document, not a pasted copy', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { objects: { locate: async () => ({ objectId: 'doc-object', path: "/Users/reader/阅读回顾.md", revision: 1 }) } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window') })
  const chip = (id: string, tabId: string) => ({
    id, name: '阅读回顾.md', path: 'ready://doc/page/doc-object', type: 'text' as const, size: 40, ext: '.md',
    source: 'document-tab' as const, tabId, dirty: true, selection: '# 阅读回顾\n\n未保存的信息卡',
  })
  const currentDocumentAnchor = {
    kind: 'current_document' as const, logicalResourceId: 'ready-current-document:scope-1:doc-264', tabId: 'doc-264',
    title: '阅读回顾.md', pane: 'primary' as const, pathDigest: 'a'.repeat(64), incarnationKey: 'b'.repeat(64),
    currentVersion: `sha256:${'c'.repeat(64)}`, currentDigest: 'c'.repeat(64), supersedesVersion: null, policyEpoch: 1,
    readScope: { operation: 'read_section' as const, maxChars: 30_000 },
  }
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '把文档中这些引用块卡片换成 Ready 信息卡',
    attachments: [chip('focused-chip', 'doc-264')],
    currentDocumentAnchor,
  })
  assert.deepEqual(result.resources, [
    { kind: 'local_file', id: 'focused-chip', name: '阅读回顾.md', path: '/Users/reader/阅读回顾.md',
      size: 40, ext: '.md', rendererType: 'text' },
  ])
})

test('@ references reuse the same structured resource identities without duplicating a repeated mention', async () => {
  const filePool = [
    {
      id: 'browser-pool', name: '网页资料', path: 'ready://web?url=https%3A%2F%2Fexample.test', type: 'text' as const,
      size: 0, ext: '.url', source: 'browser-tab' as const, browserTabId: 'tab-pool',
    },
    {
      id: 'quote-pool', name: '摘录', path: '', type: 'text' as const,
      size: 4, ext: '.quote', source: 'document-quote' as const, selection: '原文事实', libraryResource: capturedSelection,
    },
  ]
  const referenced = resolveReferencedFilePoolAttachments(
    '比较 @[网页资料] 和 @[摘录]，再看一次 @[网页资料]',
    filePool,
  )
  assert.deepEqual(referenced.map((item) => item.id), ['browser-pool', 'quote-pool'])
  const result = await buildCodexIngressInputWithDiagnostics({
    content: '比较 @[网页资料] 和 @[摘录]',
    attachments: referenced,
  })
  assert.deepEqual(result.resources, [
    { kind: 'browser_tab', id: 'browser-pool', name: '网页资料', tabId: 'tab-pool' },
    capturedSelection,
  ])
})

test('quotes without captured identity and nonfocused dirty buffers cannot become pasted model input', async () => {
  await assert.rejects(buildCodexIngressInputWithDiagnostics({ content: 'read', attachments: [{ id: 'q', name: 'q', path: '', type: 'text', size: 6, ext: '', source: 'document-quote', selection: 'SECRET' }] }), /library_selection_identity_unavailable/)
  await assert.rejects(buildCodexIngressInputWithDiagnostics({ content: 'read', attachments: [{ id: 'd', name: 'd', path: '', type: 'text', size: 6, ext: '', source: 'document-tab', dirty: true, selection: 'SECRET' }] }), /library_buffer_identity_unavailable/)
})

test('captured document selection preserves exact range and version, disambiguates lines, and survives attachment persistence without body in input', async () => {
  const { buildLibraryDocumentSelection } = await import('../renderer/modules/agent/libraryResourceSelection')
  const { serializePersistedAttachments, extractAttachmentsFromMeta } = await import('../renderer/modules/agent/messageComposer')
  const tab = { id: 'tab', objectId: 'page', content: 'same\nSECRET\nsame\n', path: '/fixture/page.md', isDirty: false }
  const attachment = { id: 'q', name: 'q', path: 'ready://doc/page/page', type: 'text' as const, size: 4, ext: '.quote', source: 'document-quote' as const, selection: 'same', lineStart: 3, lineEnd: 3 }
  const selected = await buildLibraryDocumentSelection(attachment, tab, '/fixture')
  assert.equal(selected.kind, 'document_selection')
  if (selected.kind !== 'document_selection') assert.fail('document selection required')
  assert.deepEqual(selected.range, { start: 12, end: 16 })
  const restored = extractAttachmentsFromMeta({ attachments: serializePersistedAttachments([{ ...attachment, libraryResource: selected }]) })!
  const input = await buildCodexIngressInputWithDiagnostics({ content: 'Read', attachments: restored })
  assert.deepEqual(input.resources, [selected])
  assert.equal(JSON.stringify(input).includes('SECRET'), false)
  assert.equal(JSON.stringify(input).includes('same'), false)
  await assert.rejects(buildLibraryDocumentSelection({ ...attachment, lineStart: undefined, lineEnd: undefined }, tab, '/fixture'), /library_selection_ambiguous/)
  await assert.rejects(buildLibraryDocumentSelection(attachment, undefined, '/fixture'), /library_selection_identity_unavailable/)
})


test('M7 exact editor range disambiguates repeated text and keeps CRLF offsets', async () => {
  const { buildLibraryDocumentSelection } = await import('../renderer/modules/agent/libraryResourceSelection')
  const content = '# Title\r\nthe cat saw the dog'
  const start = content.lastIndexOf('the')
  const selection = await buildLibraryDocumentSelection({ id: 'q', name: 'Q', path: '', type: 'text', size: 3, ext: '.quote', source: 'document-quote', selection: 'the' },
    { id: 'tab', objectId: 'page', path: '/fixture/a.md', content, isDirty: false }, '/fixture', undefined, { start, end: start + 3 })
  assert.equal(selection.kind, 'document_selection')
  if (selection.kind === 'document_selection') assert.deepEqual(selection.range, { start, end: start + 3 })
})

test('M7 rendered selection maps formatted text and repeated words using the actual DOM range and source line', async () => {
  const { JSDOM } = await import('jsdom')
  const { librarySelectionRangeFromDOM } = await import('../renderer/modules/agent/libraryResourceSelection')
  const content = '# Heading\n\nThis is **important** text\n\nthe cat saw the dog'
  const dom = new JSDOM('<div data-ready-block-source-line="3"><p>This is <strong>important</strong> text</p></div><div data-ready-block-source-line="5"><p>the cat saw the dog</p></div>')
  try {
    const p = dom.window.document.querySelector('p')!, range = dom.window.document.createRange()
    range.selectNodeContents(p)
    assert.deepEqual(librarySelectionRangeFromDOM(content, range), { start: content.indexOf('This'), end: content.indexOf(' text') + 5 })
    const text = dom.window.document.querySelectorAll('p')[1].firstChild!
    range.setStart(text, 12); range.setEnd(text, 15)
    const start = content.lastIndexOf('the')
    assert.deepEqual(librarySelectionRangeFromDOM(content, range), { start, end: start + 3 })
    dom.window.document.querySelectorAll('p')[1].textContent = 'changed'
    const stale = dom.window.document.createRange(); stale.selectNodeContents(dom.window.document.querySelectorAll('p')[1])
    assert.throws(() => librarySelectionRangeFromDOM(content, stale), /library_selection_ambiguous/)
  } finally { dom.window.close() }
})

for (const ext of ['txt', 'markdown']) test(`M7 ${ext} references use registered file kind`, async () => {
  const { buildLibraryDocumentSelection } = await import('../renderer/modules/agent/libraryResourceSelection')
  const result = await buildLibraryDocumentSelection({ id: 'q', name: 'Q', path: '', type: 'text', size: 5, ext: '.quote', source: 'document-quote', selection: 'hello' },
    { id: 'tab', objectId: 'page', path: `/fixture/a.${ext}`, content: 'hello', isDirty: false }, '/fixture')
  assert.equal(result.kind === 'document_selection' && result.target.kind === 'object' && result.target.uri, 'ready://doc/file/page')
})


test('M7 send preparation errors produce the existing attachment notice and retain input', async t => {
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useMode } = await import('../renderer/stores/useMode')
  const { makeEmptySessionSlice } = await import('../renderer/stores/agent-store-helpers')
  const { makeScopeHeadActionProjection } = await import('./product-turn-action-projection-fixture')
  const { mapBackendErrorToFriendly } = await import('../renderer/modules/agent/error-message-mapping')
  const previous = useAgent.getState(), previousMode = useMode.getState(), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let calls = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { agent: { sendScoped: async () => { calls++; throw new Error('unexpected_dispatch') } } } } })
  t.after(() => { useAgent.setState(previous, true); useMode.setState(previousMode, true); if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
  useMode.setState({ workbenchMode: 'browser', splitMode: null })
  const attachment = { id: 'dirty-quote', name: 'Unsaved', path: '', type: 'text' as const, size: 4, ext: '.quote', source: 'document-quote' as const, selection: 'edit' }
  const scope = { id: 'm7-scope', agent: 'butler', title: 'Test', sourceKind: 'local' as const, sourceId: 'app', threadKey: 'm7-scope', meta: {}, createdAt: '', updatedAt: '', lastMessageAt: null }
  const slice = { ...makeEmptySessionSlice(scope.id), aliasGeneration: 1, inputValue: 'Read this', attachments: [attachment], scopeHeadActionProjection: makeScopeHeadActionProjection(scope.id) }
  useAgent.setState({ currentAgent: 'butler', currentScopeId: scope.id, currentScope: scope, activeSessionId: 'm7-session', sessionId: 'm7-session', sessions: { 'm7-session': slice }, attachments: [attachment], inputValue: 'Read this', pendingContinuationIntent: null, retiredScopeIds: {} })
  const result = await useAgent.getState().sendMessage('Read this')
  assert.equal(result.success, false); assert.equal(result.errorKind, 'attachment_unavailable')
  assert.match(mapBackendErrorToFriendly({ errorKind: result.errorKind }).friendlyMessage, /重新选择/)
  assert.equal(useAgent.getState().inputValue, 'Read this'); assert.deepEqual(useAgent.getState().attachments, [attachment]); assert.equal(calls, 0)
})

test('M7 closing an actual open draft removes its selectable buffer; the open control is accepted by the composer', async t => {
  const { useDocTabs } = await import('../renderer/stores/useDocTabs')
  const { useMode } = await import('../renderer/stores/useMode')
  const { buildCodexCurrentDocumentAnchor } = await import('../renderer/modules/agent/codexCurrentDocumentAnchor')
  const before = useDocTabs.getState(), beforeMode = useMode.getState(), previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { vault: { get: async () => ({ status: 'ready', root: '/fixture' }) } } } })
  t.after(() => { useDocTabs.setState(before, true); useMode.setState(beforeMode, true); if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
  useMode.setState({ workbenchMode: 'document', splitMode: null })
  useDocTabs.setState({ tabs: [{ id: 'draft', title: 'Draft', draftId: 'persistent-draft', path: null, content: 'open text', isDirty: true }], activeTabId: 'draft', focusedPaneTabId: 'draft', splitTabId: null })
  const anchor = await buildCodexCurrentDocumentAnchor('m7')
  assert.ok(anchor)
  const attachment = { id: 'buffer', name: 'Draft', path: '', type: 'text' as const, size: 9, ext: '.md', source: 'document-tab' as const, tabId: 'draft', dirty: true, selection: 'open text' }
  const opened = await buildCodexIngressInputWithDiagnostics({ content: 'Read', attachments: [attachment], currentDocumentAnchor: anchor })
  assert.equal(opened.resources[0].kind, 'document_selection')
  useDocTabs.setState({ tabs: [], activeTabId: null, focusedPaneTabId: null })
  await assert.rejects(buildCodexIngressInputWithDiagnostics({ content: 'Read', attachments: [attachment], currentDocumentAnchor: anchor }), /library_selection_identity_unavailable/)
})
