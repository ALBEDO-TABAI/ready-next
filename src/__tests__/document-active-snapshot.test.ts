import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { getActiveDocumentSnapshot } from '../renderer/modules/agent/documentActions'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'

afterEach(() => {
  useMode.setState({
    appMode: 'workbench',
    workbenchMode: 'browser',
    splitMode: null,
    workbenchSplitRatio: 50,
    readySubMode: 'browser',
  })
  useDocTabs.setState({
    tabs: [{ id: 'welcome', title: '未命名', path: null, content: '', isDirty: false }],
    activeTabId: 'welcome',
    splitTabId: null,
    documentSplitRatio: 50,
    pendingReveal: null,
  })
})

describe('active document snapshot', () => {
  it('returns the full active document content in document mode', () => {
    const content = '# Ready\n\n这是完整正文，不应该被截断。'
    useMode.getState().setWorkbenchMode('document')
    useDocTabs.setState({
      tabs: [{
        id: 'doc-1',
        title: '需求文档.md',
        path: null,
        content,
        isDirty: true,
      }],
      activeTabId: 'doc-1',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })

    const snapshot = getActiveDocumentSnapshot()

    assert.deepEqual(snapshot, {
      title: '需求文档.md',
      path: null,
      content,
      isDirty: true,
      charCount: content.length,
    })
  })

  it('returns null when document mode is not active', () => {
    useMode.getState().setWorkbenchMode('browser')

    assert.equal(getActiveDocumentSnapshot(), null)
  })
})
