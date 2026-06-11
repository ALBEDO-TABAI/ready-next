import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { getActiveDocumentSnapshot, performDocAction } from '../renderer/modules/agent/documentActions'
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
      tabId: 'doc-1',
      title: '需求文档.md',
      path: null,
      content,
      isDirty: true,
      charCount: content.length,
    })
  })

  it('supports reading a specific document tab by tabId', () => {
    useMode.getState().setWorkbenchMode('document')
    useDocTabs.setState({
      tabs: [
        {
          id: 'doc-1',
          title: '文档 A.md',
          path: null,
          content: 'A',
          isDirty: false,
        },
        {
          id: 'doc-2',
          title: '文档 B.md',
          path: '/tmp/b.md',
          content: 'B 内容',
          isDirty: true,
        },
      ],
      activeTabId: 'doc-1',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })

    const snapshot = getActiveDocumentSnapshot('doc-2')

    assert.deepEqual(snapshot, {
      tabId: 'doc-2',
      title: '文档 B.md',
      path: '/tmp/b.md',
      content: 'B 内容',
      isDirty: true,
      charCount: 'B 内容'.length,
    })
  })

  it('returns null when document mode is not active', () => {
    useMode.getState().setWorkbenchMode('browser')

    assert.equal(getActiveDocumentSnapshot(), null)
  })

  it('reads a numbered section beyond the active document context excerpt', async () => {
    const longIntro = '前置摘要内容。'.repeat(160)
    const thirdSectionEnglish = [
      '"Read the intent in the user language: what they said, what repetition or ambition implies, what outcome would help."',
      '',
      'The operating-architecture skill should preserve the original English signal.',
    ].join('\n')
    const content = [
      '1. 总览',
      '',
      longIntro,
      '',
      '2. 文本通道',
      '',
      '第二部分正文。',
      '',
      '3. 意图理解规格',
      '',
      thirdSectionEnglish,
      '',
      '4. 后续章节',
      '',
      '第四部分正文。',
    ].join('\n')
    useMode.getState().setWorkbenchMode('document')
    useDocTabs.setState({
      tabs: [{
        id: 'doc-1',
        title: '需求文档.md',
        path: '/tmp/需求文档.md',
        content,
        isDirty: false,
      }],
      activeTabId: 'doc-1',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })

    const summary = await performDocAction({ type: 'read_section', tabId: 'current', range: 'section:3' })

    assert.match(summary, /已读取文档片段：需求文档\.md/)
    assert.match(summary, /命中章节: 意图理解规格/)
    assert.match(summary, /what repetition or ambition implies/)
    assert.match(summary, /operating-architecture skill/)
    assert.doesNotMatch(summary, /前置摘要内容。/)
    assert.doesNotMatch(summary, /第四部分正文。/)
  })
})
