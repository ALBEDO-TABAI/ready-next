import assert from 'node:assert/strict'
import test, { describe, it } from 'node:test'

import {
  classifyDocActionFailureReason,
  performDocAction,
  type DocActionPayload,
} from '../renderer/modules/agent/documentActions'
import { executeModuleToolAction } from '../renderer/modules/agent/moduleExecutor'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { shouldApplyAsyncDocumentLoad } from '../renderer/components/document/documentLoadGuard'

function buildGuideFenceFixture(): string {
  return [
    '# 指引',
    '',
    '```show-widget',
    JSON.stringify({
      id: 'widget_guide_fixed',
      title: '指引',
      widget_code: '<div class="p-4"><h3>heading</h3><p>body</p></div>',
      component_spec: {
        component: 'info_card',
        props: { heading: 'heading', body: 'body', tone: 'neutral' },
      },
    }),
    '```',
    '',
  ].join('\n')
}

describe('classifyDocActionFailureReason', () => {
  it('id-like target 的"未找到与你选择的卡片对应的 widget"归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_deadbeef00', componentSpecPatch: {} }
    const summary = '未找到与你选择的卡片对应的 widget（当前文档共有 1 个 widget），请重新选择卡片或在消息里提供标题。'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('空文档 + id-like target 的"先插入"文案归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_abc123', componentSpecPatch: {} }
    const summary = '当前文档里还没有 widget，请先插入一个再发起修改。'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('非 id 兜底"请用标题或序号重试"归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: '未知标题', componentSpecPatch: {} }
    const summary = '未找到可更新的 widget，请用标题或序号重试（当前文档共有 3 个 widget）。'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('数字序号未找到文案归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: '9', componentSpecPatch: {} }
    const summary = '未找到序号为 9 的 widget'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('标题模糊未找到文案归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: '不存在', componentSpecPatch: {} }
    const summary = '未找到标题匹配“不存在”的 widget'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('成功更新文案返回 null', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_guide_fixed', componentSpecPatch: {} }
    const summary = '已更新 widget（字段级 patch）：指引（笔记.md）'
    assert.equal(classifyDocActionFailureReason(action, summary), null)
  })

  it('非 update_widget action 返回 null（即使 summary 里含关键词）', () => {
    const action: DocActionPayload = { type: 'list_widgets' }
    const summary = '未找到标题匹配“x”的 widget'
    assert.equal(classifyDocActionFailureReason(action, summary), null)
  })

  it('空 summary 返回 null', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_x', componentSpecPatch: {} }
    assert.equal(classifyDocActionFailureReason(action, ''), null)
  })
})

describe('performDocAction · document target safety', () => {
  it('rejects set_content without an explicit tool target instead of overwriting a saved visible document', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    const result = await performDocAction({ type: 'set_content', content: '# Notes\n' })

    assert.match(result, /文档写入已拒绝/)
    assert.equal(useDocTabs.getState().tabs[0]?.content, '# Source\n\nOriginal text\n')
  })

  it('rejects other mutating writes without an explicit tool target on a saved visible document', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    const result = await performDocAction({ type: 'append_content', content: '\n# Notes\n' })

    assert.match(result, /文档写入已拒绝/)
    assert.equal(useDocTabs.getState().tabs[0]?.content, '# Source\n\nOriginal text\n')
  })

  it('does not fall back to the visible document when the remembered tool target disappears', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    await performDocAction({ type: 'new_tab', title: 'target', path: '/tmp/target.md' })
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    const result = await performDocAction({ type: 'set_content', content: '# Notes\n' })

    assert.match(result, /文档写入已拒绝/)
    assert.equal(useDocTabs.getState().tabs[0]?.content, '# Source\n\nOriginal text\n')
  })
})

describe('executeModuleToolAction · document.updateWidget payload 合约', () => {
  function makeParams(tool: string, args: Record<string, unknown>) {
    return {
      scopeId: 'test-scope',
      agentName: 'test-agent',
      tool,
      args,
      runId: 'test-run',
      activateWorkbenchMode: () => {},
      upsertScopeRunState: () => {},
      getScopeRunState: () => null,
    }
  }

  it('patch 失败分支把 ok: false / reason: target_not_resolved 并入 payload', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, buildGuideFenceFixture())

    const result = await executeModuleToolAction(makeParams('document.updateWidget', {
      target: 'widget_deadbeef00',
      componentSpecPatch: { props: { tone: 'warning' } },
      tabId: tab.id,
    }))

    assert.equal(result.handled, true)
    assert.ok(result.payload, 'payload 应存在')
    const payload = result.payload!
    assert.equal(payload.intent, 'document.updateWidget')
    assert.equal(typeof payload.summary, 'string')
    assert.match(payload.summary as string, /未找到与你选择的卡片对应的 widget/)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'target_not_resolved')
  })

  it('patch 成功分支 payload 只含 summary（不出现 ok/reason）', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, buildGuideFenceFixture())

    const result = await executeModuleToolAction(makeParams('document.updateWidget', {
      target: 'widget_guide_fixed',
      componentSpecPatch: { props: { tone: 'warning' } },
      tabId: tab.id,
    }))

    assert.equal(result.handled, true)
    const payload = result.payload!
    assert.match(payload.summary as string, /已更新 widget（字段级 patch）/)
    assert.equal(payload.ok, undefined)
    assert.equal(payload.reason, undefined)
  })

  it('mutation 成功分支 payload 带结构化文档身份和保存状态', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-target', path: '/tmp/agent-target.md', title: 'agent-target.md', content: '# 标题\n\n旧内容\n', isDirty: false },
      ],
      activeTabId: 'doc-target',
      splitTabId: null,
    })

    const result = await executeModuleToolAction(makeParams('document.replaceExact', {
      target: '旧内容',
      replacement: '新内容',
      tabId: 'doc-target',
    }))

    assert.equal(result.handled, true)
    const payload = result.payload!
    assert.equal(payload.mutated, true)
    assert.deepEqual(payload.document, {
      tabId: 'doc-target',
      title: 'agent-target.md',
      path: '/tmp/agent-target.md',
      dirty: true,
      requiresSave: true,
      saveState: 'dirty',
    })
    assert.equal(payload.documentTabId, 'doc-target')
    assert.equal(payload.documentPath, '/tmp/agent-target.md')
    assert.equal(payload.documentRequiresSave, true)
  })

  it('非 update_widget 动作即使 summary 命中关键词也不会被错误标记', async () => {
    // performDocAction 直接走 list_widgets，不受 classifier 影响
    const summary = await performDocAction({ type: 'list_widgets' })
    assert.equal(typeof summary, 'string')
    assert.equal(classifyDocActionFailureReason({ type: 'list_widgets' }, summary), null)
  })
})

describe('performDocAction · save_tab disk drift', () => {
  it('目标路径还不存在时不能把读取失败当成已保存，必须写出文件', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: false, error: 'ENOENT' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-target', path: '/tmp/new-target.md', title: 'new-target.md', content: '# 新笔记\n', isDirty: false },
        ],
        activeTabId: 'doc-target',
        splitTabId: null,
      })

      const result = await performDocAction({ type: 'save_tab', tabId: 'doc-target' })

      assert.match(result, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/new-target.md', content: '# 新笔记\n' }])
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('dirty 标记已清但磁盘内容不同步时仍会写回文件', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '\n' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      const store = useDocTabs.getState()
      const tab = store.tabs[0]
      store.setActiveTab(tab.id)
      store.setTabPath(tab.id, '/tmp/agent-target.md')
      store.setTabContent(tab.id, '# 新内容\n')
      store.markTabSaved(tab.id)

      const result = await performDocAction({ type: 'save_tab', tabId: tab.id })

      assert.match(result, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/agent-target.md', content: '# 新内容\n' }])
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('工具写入后即使编辑器异步加载把标签重置为干净态，保存仍使用待落盘内容', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '\n' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      const store = useDocTabs.getState()
      const tab = store.tabs[0]
      store.setActiveTab(tab.id)
      store.setTabPath(tab.id, '/tmp/agent-target.md')
      store.setTabContent(tab.id, '\n')
      store.markTabSaved(tab.id)

      await performDocAction({ type: 'set_content', content: '# 人物关系图\n', tabId: tab.id })
      store.setTabContent(tab.id, '\n')
      store.markTabSaved(tab.id)

      const result = await performDocAction({ type: 'save_tab', tabId: tab.id })

      assert.match(result, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/agent-target.md', content: '# 人物关系图\n' }])
      const savedTab = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
      assert.equal(savedTab?.content, '# 人物关系图\n')
      assert.equal(savedTab?.isDirty, false)
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})

describe('performDocAction · background document targets', () => {
  it('simulates a read-then-write task without letting an early ambiguous write touch visible panes', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: false, error: 'ENOENT' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/visible-source.md', title: 'visible-source.md', content: '# Source\n\nKeep this.\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/visible-side.md', title: 'visible-side.md', content: '# Side\n\nKeep this too.\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      const earlyWrite = await performDocAction({ type: 'set_content', content: '# Wrong target\n' })
      assert.match(earlyWrite, /文档写入已拒绝/)
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-a')?.content, '# Source\n\nKeep this.\n')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')?.content, '# Side\n\nKeep this too.\n')

      await performDocAction({ type: 'new_tab', title: 'target-note', path: '/tmp/target-note.md' })
      await performDocAction({ type: 'set_content', content: '# Target note\n\nFinished.\n' })
      const saved = await performDocAction({ type: 'save_tab' })

      assert.match(saved, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/target-note.md', content: '# Target note\n\nFinished.\n' }])
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-a')?.content, '# Source\n\nKeep this.\n')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')?.content, '# Side\n\nKeep this too.\n')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('updates a visible split-pane target when the tool carries that tab id', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async (path: string) => ({ success: true, content: path.endsWith('B.md') ? '# B old\n' : '' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/A.md', title: 'A.md', content: '# A\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/B.md', title: 'B.md', content: '# B old\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      await performDocAction({ type: 'set_content', tabId: 'doc-b', content: '# B updated\n' })
      const saved = await performDocAction({ type: 'save_tab', tabId: 'doc-b' })

      assert.match(saved, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/B.md', content: '# B updated\n' }])
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-a')?.content, '# A\n')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')?.content, '# B updated\n')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('creates and writes a target document without stealing the visible panes', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/A.md', title: 'A.md', content: '# A\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/B.md', title: 'B.md', content: '# B\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      const created = await performDocAction({
        type: 'new_tab',
        title: 'C',
        path: '/tmp/C.md',
      })
      assert.match(created, /C\.md/)
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')

      await performDocAction({ type: 'set_content', content: '# C\n' })
      const target = useDocTabs.getState().tabs.find((item) => item.path === '/tmp/C.md')
      assert.equal(target?.content, '# C\n')
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')

      const saved = await performDocAction({ type: 'save_tab' })
      assert.match(saved, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/C.md', content: '# C\n' }])
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('refreshes an already visible split-pane target without changing the primary pane', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '# B refreshed\n' }),
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/A.md', title: 'A.md', content: '# A\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/B.md', title: 'B.md', content: '# B old\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      const opened = await performDocAction({ type: 'open_tab', path: '/tmp/B.md' })

      assert.match(opened, /已打开并载入文档/)
      const split = useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')
      assert.equal(split?.content, '# B refreshed\n')
      assert.equal(split?.isDirty, false)
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})

describe('shouldApplyAsyncDocumentLoad', () => {
  it('异步加载完成前标签已被写入时不覆盖现有内容', () => {
    const initial = { id: 'tab-1', path: '/tmp/新文档.md', content: '', isDirty: false }
    const current = { id: 'tab-1', path: '/tmp/新文档.md', content: '# 已写入\n', isDirty: true }

    assert.equal(shouldApplyAsyncDocumentLoad(initial, current), false)
  })

  it('同一标签未被修改时允许提交加载结果', () => {
    const initial = { id: 'tab-1', path: '/tmp/新文档.md', content: '', isDirty: false }
    const current = { id: 'tab-1', path: '/tmp/新文档.md', content: '', isDirty: false }

    assert.equal(shouldApplyAsyncDocumentLoad(initial, current), true)
  })
})

test('DOC_ACTION_TARGET_NOT_RESOLVED_PATTERNS 覆盖所有 P-6 文案与 resolveWidgetRecord 错误', () => {
  // 防回归：若 documentActions.ts 的失败文案变更，这里必须同步 classifier 的正则
  const copySamples = [
    '未找到与你选择的卡片对应的 widget（当前文档共有 2 个 widget），请重新选择卡片或在消息里提供标题。',
    '当前文档里还没有 widget，请先插入一个再发起修改。',
    '未找到可更新的 widget，请用标题或序号重试（当前文档共有 5 个 widget）。',
    '未找到序号为 7 的 widget',
    '未找到标题匹配“任意标题”的 widget',
  ]
  for (const copy of copySamples) {
    const reason = classifyDocActionFailureReason(
      { type: 'update_widget', target: 'x', componentSpecPatch: {} },
      copy,
    )
    assert.equal(reason, 'target_not_resolved', `未被归类：${copy}`)
  }
})
