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

test('document pane drop accepts document tabs and workspace files but rejects folders and unsupported paths', () => {
  const docTabDrop = fakeDataTransfer({
    'application/x-ready-document-tab': JSON.stringify({
      type: 'doc-tab',
      path: '/tmp/brief.md',
      name: 'brief.md',
      ext: '.md',
    }),
  })
  assert.equal(getDocumentPaneDropPath(docTabDrop), '/tmp/brief.md')
  assert.equal(canAcceptDocumentPaneDrop(docTabDrop), true)

  const fileDrop = fakeDataTransfer({
    'application/x-ready-workspace-item': JSON.stringify({
      type: 'file',
      path: '/tmp/sheet.csv',
      name: 'sheet.csv',
      ext: 'csv',
      isDirectory: false,
    }),
  })
  assert.equal(getDocumentPaneDropPath(fileDrop), '/tmp/sheet.csv')

  const folderDrop = fakeDataTransfer({
    'application/x-ready-drag': JSON.stringify({
      type: 'folder',
      path: '/tmp/folder.md',
      name: 'folder.md',
      ext: 'md',
      isDirectory: true,
    }),
    'text/plain': '/tmp/folder.md',
  })
  assert.equal(getDocumentPaneDropPath(folderDrop), null)

  const unsupportedDrop = fakeDataTransfer({
    'text/plain': '/tmp/archive.zip',
  })
  assert.equal(getDocumentPaneDropPath(unsupportedDrop), null)
  assert.equal(canAcceptDocumentPaneDrop(unsupportedDrop), false)
})

test('document pane dragover accepts Ready custom drags by type before payload data is readable', () => {
  const protectedDocTabDrag = fakeDataTransfer({
    'application/x-ready-document-tab': '',
  })
  const protectedWorkspaceDrag = fakeDataTransfer({
    'application/x-ready-workspace-item': '',
  })

  assert.equal(canAcceptDocumentPaneDrop(protectedDocTabDrag), true)
  assert.equal(canAcceptDocumentPaneDrop(protectedWorkspaceDrag), true)
  assert.equal(getDocumentPaneDropPath(protectedDocTabDrag), null)
})

test('document pane dragover does not claim generic Ready drags that are not document files', () => {
  const browserTabDrag = fakeDataTransfer({
    'application/x-ready-drag': JSON.stringify({
      type: 'browser-tab',
      name: 'Example',
      url: 'https://example.com',
    }),
  })
  const skillDrag = fakeDataTransfer({
    'application/x-ready-drag': JSON.stringify({
      type: 'skill-folder',
      path: '/tmp/my-skill',
      name: 'my-skill',
    }),
    'application/x-ready-skill': '{}',
    'text/plain': '@[my-skill]',
  })

  assert.equal(canAcceptDocumentPaneDrop(browserTabDrag), false)
  assert.equal(canAcceptDocumentPaneDrop(skillDrag), false)
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
