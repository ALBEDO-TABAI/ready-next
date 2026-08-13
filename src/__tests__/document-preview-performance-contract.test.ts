import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  __getDocumentWidgetRenderCodeCacheStatsForTests,
  __resetDocumentWidgetRenderCodeCacheForTests,
  resolveDocumentWidgetRenderCode,
} from '../shared/document-widget-render-code'
import { areDocumentWidgetPreviewBlockPropsEqual } from '../renderer/components/document/DocumentWidgetPreviewBlock'
import { arePreviewEmbedPropsEqual } from '../renderer/components/document/NotePreview'
import {
  __getWidgetThemeObserverStatsForTests,
  __resetWidgetThemeObserverForTests,
  subscribeWidgetThemeChanges,
} from '../renderer/components/document/widget-theme-observer'
import type { PreviewBlock } from '../renderer/components/document/note-preview-parser'
import {
  buildPreviewBlockRenderKeys,
  buildPreviewBlockSourceLines,
} from '../renderer/modules/document/notePreviewBlockIdentity'
import { scopeMermaidSvgIds } from '../renderer/modules/document/mermaidRenderCache'
import {
  isDocumentSaveShortcutAvailable,
  readyShortcutBypassesEditableGuard,
  resolveDocumentSaveTarget,
} from '../renderer/hooks/useKeyboardShortcuts'
import {
  areRetainedDocumentEditorPropsEqual,
  resolveRetainedDocumentScene,
  shouldRetainDocumentSceneWhileHidden,
} from '../renderer/modules/document/documentSceneRetention'

afterEach(() => {
  __resetDocumentWidgetRenderCodeCacheForTests()
  __resetWidgetThemeObserverForTests()
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver
  delete (globalThis as { document?: unknown }).document
})

function markdownBlock(id: string, start: number, end: number, markdown: string): PreviewBlock {
  return { id, type: 'markdown', markdown, source: { start, end } }
}

test('preview render identity survives shifted ranges and changes only edited block content', () => {
  const before = 'first\nSECOND\nthird'
  const beforeBlocks = [
    markdownBlock('before-1', 0, 5, 'first'),
    markdownBlock('before-2', 6, 12, 'SECOND'),
    markdownBlock('before-3', 13, 18, 'third'),
  ]
  const after = 'first\nSECOND changed\nthird'
  const afterBlocks = [
    markdownBlock('after-1', 0, 5, 'first'),
    markdownBlock('after-2', 6, 20, 'SECOND changed'),
    markdownBlock('after-3', 21, 26, 'third'),
  ]
  const beforeKeys = buildPreviewBlockRenderKeys(before, beforeBlocks)
  const afterKeys = buildPreviewBlockRenderKeys(after, afterBlocks)

  assert.equal(beforeKeys.get('before-1'), afterKeys.get('after-1'))
  assert.notEqual(beforeKeys.get('before-2'), afterKeys.get('after-2'))
  assert.equal(beforeKeys.get('before-3'), afterKeys.get('after-3'))
  assert.deepEqual(Array.from(buildPreviewBlockSourceLines(after, afterBlocks).values()), [1, 2, 3])
})

test('unchanged widget preview props remain memo-compatible after surrounding text reparses', () => {
  const callback = () => undefined
  const previous = {
    renderIdentity: 'widget:stable:0',
    widget: { title: 'Card', widgetCode: '<div>Card</div>', rawFence: 'before ranges' },
    renderCode: '<div>Card</div>',
    widgetState: null,
    widgetStateSignature: 'null',
    preferManualPreview: false,
    canEdit: true,
    onWidgetQuote: callback,
  }
  const shifted = {
    ...previous,
    widget: { ...previous.widget, rawFence: 'same source parsed into a fresh object' },
  }
  assert.equal(areDocumentWidgetPreviewBlockPropsEqual(previous, shifted), true)
  assert.equal(areDocumentWidgetPreviewBlockPropsEqual(previous, {
    ...shifted,
    widgetState: { controls: [{ index: 0, tag: 'input' as const, value: 'next' }] },
    widgetStateSignature: '{"controls":[{"index":0,"tag":"input","value":"next"}]}',
  }), false)
  assert.equal(areDocumentWidgetPreviewBlockPropsEqual(previous, {
    ...shifted,
    renderIdentity: 'widget:changed:0',
  }), false)
})

test('unchanged rich-media blocks remain memo-compatible after parser object renewal', () => {
  const onOpen = () => undefined
  const embed = {
    id: 'image-1',
    kind: 'image' as const,
    source: 'body' as const,
    url: 'local-file:///tmp/image.png',
    displayUrl: 'image.png',
    title: 'Image',
    localPath: '/tmp/image.png',
  }
  assert.equal(arePreviewEmbedPropsEqual({ embed, onOpen }, { embed: { ...embed }, onOpen }), true)
  assert.equal(arePreviewEmbedPropsEqual({ embed, onOpen }, {
    embed: { ...embed, url: 'local-file:///tmp/changed.png' },
    onOpen,
  }), false)
})

test('widget render-code cache is bounded and evicts the least-recently-used entry', () => {
  __resetDocumentWidgetRenderCodeCacheForTests()
  for (let index = 0; index < 140; index += 1) {
    resolveDocumentWidgetRenderCode({ widgetCode: `<div>${index}</div>` })
  }
  assert.deepEqual(__getDocumentWidgetRenderCodeCacheStatsForTests(), { size: 128, compileCount: 140 })
  resolveDocumentWidgetRenderCode({ widgetCode: '<div>0</div>' })
  assert.deepEqual(__getDocumentWidgetRenderCodeCacheStatsForTests(), { size: 128, compileCount: 141 })
})

test('cached Mermaid SVG ids are rebased per mounted block', () => {
  const source = '<svg aria-labelledby="title desc"><defs><clipPath id="clip" /></defs><style>#shape{clip-path:url(#clip)}</style><title id="title">Title</title><desc id="desc">Desc</desc><rect id="shape" clip-path="url(#clip)" href="#shape" /></svg>'
  const left = scopeMermaidSvgIds(source, 'left')
  const right = scopeMermaidSvgIds(source, 'right')

  assert.notEqual(left, right)
  assert.doesNotMatch(left, /id="(?:clip|title|desc|shape)"/)
  assert.match(left, /aria-labelledby="left-1 left-2"/)
  assert.match(left, /url\(#left-0\)/)
  assert.match(left, /href="#left-3"/)
})

test('all widget instances share one theme observer and a faulty listener is isolated', () => {
  let observerCallback: MutationCallback | null = null
  let observeCount = 0
  let disconnectCount = 0
  class FakeMutationObserver {
    constructor(callback: MutationCallback) { observerCallback = callback }
    observe() { observeCount += 1 }
    disconnect() { disconnectCount += 1 }
    takeRecords(): MutationRecord[] { return [] }
  }
  ;(globalThis as { MutationObserver?: unknown }).MutationObserver = FakeMutationObserver
  ;(globalThis as { document?: unknown }).document = { documentElement: {} }

  let healthyCalls = 0
  const unsubscribeFaulty = subscribeWidgetThemeChanges(() => { throw new Error('stale widget') })
  const unsubscribeHealthy = subscribeWidgetThemeChanges(() => { healthyCalls += 1 })
  assert.deepEqual(__getWidgetThemeObserverStatsForTests(), { listeners: 2, observing: true })
  assert.equal(observeCount, 1)

  observerCallback?.([], {} as MutationObserver)
  assert.equal(healthyCalls, 1)
  unsubscribeFaulty()
  unsubscribeHealthy()
  assert.equal(disconnectCount, 1)
  assert.deepEqual(__getWidgetThemeObserverStatsForTests(), { listeners: 0, observing: false })
})

test('document save target follows the focused visible pane and safely falls back to primary', () => {
  const tabs = [{ id: 'primary' }, { id: 'split' }, { id: 'hidden' }]
  assert.equal(resolveDocumentSaveTarget(tabs, 'primary', 'split', 'split'), 'split')
  assert.equal(resolveDocumentSaveTarget(tabs, 'primary', 'split', 'hidden'), 'primary')
  assert.equal(resolveDocumentSaveTarget(tabs, 'primary', null, 'closed'), 'primary')
  assert.equal(resolveDocumentSaveTarget(tabs, 'missing', null, null), null)
  assert.equal(readyShortcutBypassesEditableGuard('save-document', true), true)
  assert.equal(readyShortcutBypassesEditableGuard('save-document', false), false)
  assert.equal(readyShortcutBypassesEditableGuard('toggle-sidebar'), false)
})

test('document save shortcut only intercepts keys while a document pane is visible in workbench', () => {
  assert.equal(isDocumentSaveShortcutAvailable({
    pathname: '/',
    appMode: 'workbench',
    workbenchMode: 'document',
    splitMode: null,
  }), true)
  assert.equal(isDocumentSaveShortcutAvailable({
    pathname: '/workbench',
    appMode: 'workbench',
    workbenchMode: 'document',
    splitMode: null,
  }), true)
  assert.equal(isDocumentSaveShortcutAvailable({
    pathname: '/workbench',
    appMode: 'workbench',
    workbenchMode: 'browser',
    splitMode: 'document',
  }), true)
  assert.equal(isDocumentSaveShortcutAvailable({
    pathname: '/settings',
    appMode: 'workbench',
    workbenchMode: 'document',
    splitMode: null,
  }), false)
  assert.equal(isDocumentSaveShortcutAvailable({
    pathname: '/workbench',
    appMode: 'workbench',
    workbenchMode: 'rss',
    splitMode: null,
  }), false)
})

test('hidden document mode retains only scenes that contain interactive widgets', () => {
  assert.equal(shouldRetainDocumentSceneWhileHidden({
    content: '# Rich document\n\n![hero](hero.png)\n',
  }), false)
  assert.equal(shouldRetainDocumentSceneWhileHidden({
    content: '# Card\n\n```show-widget\n{"title":"Card","widget_code":"<div>Card</div>"}\n```',
  }), true)
})

test('retained widget scenes ignore hidden content updates and catch up when shown', () => {
  const callback = () => undefined
  const previous = {
    tab: { id: 'doc', path: '/tmp/card.md', title: 'Card', content: 'before', isDirty: false },
    viewMode: 'preview' as const,
    onVisibleLineChange: callback,
    onActivate: callback,
    isSceneVisible: true,
  }
  const changed = {
    ...previous,
    tab: { ...previous.tab, content: 'after' },
  }

  assert.equal(areRetainedDocumentEditorPropsEqual(previous, { ...changed, isSceneVisible: false }), true)
  assert.equal(areRetainedDocumentEditorPropsEqual(previous, changed), false)
})

test('split widget retention preserves pane structure without retaining the plain editor', () => {
  const activeTab = { content: '# Plain' }
  const splitTab = { content: '```show-widget\n{}\n```' }
  const visible = resolveRetainedDocumentScene({
    isSceneVisible: true,
    wasSceneVisible: false,
    activeTab,
    splitTab,
    retained: { activeTab: null, splitTab: null, retainActiveEditor: false, retainSplitEditor: false },
  })
  const hidden = resolveRetainedDocumentScene({
    isSceneVisible: false,
    wasSceneVisible: true,
    activeTab,
    splitTab,
    retained: visible,
  })

  assert.equal(hidden.activeTab, activeTab)
  assert.equal(hidden.splitTab, splitTab)
  assert.equal(hidden.retainActiveEditor, false)
  assert.equal(hidden.retainSplitEditor, true)
})
