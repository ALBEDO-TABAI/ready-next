import { prepareFileDragRef } from '../renderer/modules/workbench/file-drag-ref'
import { createDraftFixture } from './helpers/ready-drafts-fixture'
import { configureDrafts, drafts } from '../renderer/modules/document/drafts/runtime'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import {
  canAcceptDocumentPaneDrop,
  getDocumentPaneDropPath,
} from '../renderer/modules/document/documentPaneDrop'
import { useDocTabs } from '../renderer/stores/useDocTabs'

function resetDocTabs() {
  useDocTabs.setState({
    tabs: [
      {
        id: 'left',
        path: '/tmp/left.md',
        title: 'left.md',
        content: 'dirty left',
        isDirty: true,
      },
      {
        id: 'right',
        path: '/tmp/right.md',
        title: 'right.md',
        content: 'clean right',
        isDirty: false,
      },
    ],
    activeTabId: 'left',
    splitTabId: 'right',
    focusedPaneTabId: 'left',
    documentSplitRatio: 50,
    pendingReveal: null,
  })
}

function fakeDataTransfer(
  data: Record<string, string>,
  files: File[] = [],
): DataTransfer {
  return {
    types: files.length > 0 ? ['Files'] : Object.keys(data),
    files,
    getData: (type: string) => data[type] || '',
  } as unknown as DataTransfer
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  resetDocTabs()
})

test('openTabInPane replaces only the primary pane and preserves the previous dirty tab', () => {
  resetDocTabs()

  const nextId = useDocTabs.getState().openTabInPane('/tmp/next.md', 'primary')
  const state = useDocTabs.getState()

  assert.equal(state.activeTabId, nextId)
  assert.equal(state.splitTabId, 'right')
  assert.equal(state.focusedPaneTabId, nextId)
  assert.equal(state.tabs.filter((tab) => tab.path === '/tmp/next.md').length, 1)
  assert.deepEqual(
    state.tabs.find((tab) => tab.id === 'left'),
    {
      id: 'left',
      path: '/tmp/left.md',
      title: 'left.md',
      content: 'dirty left',
      isDirty: true,
    },
  )
})

test('openTabInPane replaces only the split pane', () => {
  resetDocTabs()

  const nextId = useDocTabs.getState().openTabInPane('/tmp/next.md', 'split')
  const state = useDocTabs.getState()

  assert.equal(state.activeTabId, 'left')
  assert.equal(state.splitTabId, nextId)
  assert.equal(state.focusedPaneTabId, nextId)
  assert.equal(state.tabs.filter((tab) => tab.path === '/tmp/next.md').length, 1)
})

test('openTabInPane swaps panes when dropping the visible split document onto primary', () => {
  resetDocTabs()

  const nextId = useDocTabs.getState().openTabInPane('/tmp/right.md', 'primary')
  const state = useDocTabs.getState()

  assert.equal(nextId, 'right')
  assert.equal(state.activeTabId, 'right')
  assert.equal(state.splitTabId, 'left')
  assert.equal(state.focusedPaneTabId, 'right')
})

test('openTabInPane swaps panes when dropping the visible primary document onto split', () => {
  resetDocTabs()

  const nextId = useDocTabs.getState().openTabInPane('/tmp/left.md', 'split')
  const state = useDocTabs.getState()

  assert.equal(nextId, 'left')
  assert.equal(state.activeTabId, 'right')
  assert.equal(state.splitTabId, 'left')
  assert.equal(state.focusedPaneTabId, 'left')
})

test('openTabInPane reuses an already-open non-visible tab instead of duplicating it', () => {
  resetDocTabs()
  useDocTabs.setState({
    tabs: [
      ...useDocTabs.getState().tabs,
      {
        id: 'third',
        path: '/tmp/third.pdf',
        title: 'third.pdf',
        content: '',
        isDirty: false,
      },
    ],
  })

  const nextId = useDocTabs.getState().openTabInPane('/tmp/third.pdf', 'split')
  const state = useDocTabs.getState()

  assert.equal(nextId, 'third')
  assert.equal(state.activeTabId, 'left')
  assert.equal(state.splitTabId, 'third')
  assert.equal(state.tabs.filter((tab) => tab.path === '/tmp/third.pdf').length, 1)
})

test('ordinary tab activation swaps a visible split document into primary', () => {
  resetDocTabs()

  useDocTabs.getState().openTab('/tmp/right.md')
  const state = useDocTabs.getState()

  assert.equal(state.activeTabId, 'right')
  assert.equal(state.splitTabId, 'left')
  assert.equal(state.focusedPaneTabId, 'right')
})

test('image activation swaps a visible split preview into primary', () => {
  resetDocTabs()
  useDocTabs.setState({
    tabs: useDocTabs.getState().tabs.map((tab) => (
      tab.id === 'right' ? { ...tab, path: '/tmp/right.png', title: 'right.png' } : tab
    )),
  })

  const imageId = useDocTabs.getState().openImageTab('/tmp/next.png')
  const state = useDocTabs.getState()

  assert.equal(imageId, 'right')
  assert.equal(state.activeTabId, 'right')
  assert.equal(state.splitTabId, 'left')
  assert.equal(state.focusedPaneTabId, 'right')
  assert.equal(state.tabs.find((tab) => tab.id === 'right')?.path, '/tmp/next.png')
})

test('closing primary promotes the visible split document and clears split mode', async () => {
  const fixture = createDraftFixture()
  configureDrafts({ ...fixture.port, tabs: () => useDocTabs.getState().tabs,
    patch: (id, patch) => useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id && tab.kind !== 'library' ? { ...tab, ...patch } : tab) })),
  })
  resetDocTabs()
  drafts.changed(useDocTabs.getState().tabs[0], 'disk left')
  await drafts.flush('left')

  useDocTabs.getState().closeTab('left')
  const state = useDocTabs.getState()

  assert.equal(state.activeTabId, 'right')
  assert.equal(state.splitTabId, null)
  assert.equal(state.focusedPaneTabId, 'right')
})

test('split target rejects the primary document and unknown ids', () => {
  resetDocTabs()

  useDocTabs.getState().setSplitTab('left')
  assert.equal(useDocTabs.getState().splitTabId, 'right')
  useDocTabs.getState().setSplitTab('missing')
  assert.equal(useDocTabs.getState().splitTabId, 'right')
})

test('pane focus accepts only one of the two visible documents', () => {
  resetDocTabs()
  useDocTabs.getState().setFocusedPaneTab('right')
  assert.equal(useDocTabs.getState().focusedPaneTabId, 'right')

  useDocTabs.getState().setFocusedPaneTab('not-visible')
  assert.equal(useDocTabs.getState().focusedPaneTabId, 'right')

  useDocTabs.getState().setSplitTab(null)
  assert.equal(useDocTabs.getState().focusedPaneTabId, 'left')
})

test('document pane drop accepts Ready page/file identities, rejects folders and foreign references', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { objects: { resolvePath: async (path: string) => ({ objectId: path, path }) } } } })
  for (const [path, directory] of [['/tmp/brief.md', false], ['/tmp/sheet.csv', false], ['/tmp/folder.md', true]] as const) {
    const ref = await prepareFileDragRef(path, directory)
    const data = fakeDataTransfer({ 'application/x-ready-ref': JSON.stringify(ref) })
    assert.equal(getDocumentPaneDropPath(data), directory ? null : path)
    assert.equal(canAcceptDocumentPaneDrop(data), !directory)
  }
  const foreign = fakeDataTransfer({ 'application/x-ready-ref': JSON.stringify({ kind: 'web', url: 'https://example.com' }) })
  assert.equal(getDocumentPaneDropPath(foreign), null)
  assert.equal(canAcceptDocumentPaneDrop(foreign), false)
  assert.equal(getDocumentPaneDropPath(fakeDataTransfer({ 'text/plain': '/tmp/archive.zip' })), null)
})

test('protected Ready drag is accepted until its reference can be checked at drop', () => {
  const data = fakeDataTransfer({ 'application/x-ready-ref': '' })
  assert.equal(canAcceptDocumentPaneDrop(data), true)
  assert.equal(getDocumentPaneDropPath(data), null)
})

test('retired internal drag payloads have no receiving path', () => {
  for (const type of ['application/x-ready-drag', 'application/x-ready-document-tab', 'application/x-ready-workspace-item']) {
    const data = fakeDataTransfer({ [type]: JSON.stringify({ type: 'file', path: '/tmp/file.md' }) })
    assert.equal(getDocumentPaneDropPath(data), null)
    assert.equal(canAcceptDocumentPaneDrop(data), false)
  }
})

test('document pane drop resolves native file drops through Electron file paths', () => {
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      getFilePathFromDrop: () => '/tmp/report.pdf',
    },
  }

  const nativeDrop = fakeDataTransfer({}, [{ name: 'report.pdf', size: 1 } as File])

  assert.equal(canAcceptDocumentPaneDrop(nativeDrop), true)
  assert.equal(getDocumentPaneDropPath(nativeDrop), '/tmp/report.pdf')
})
