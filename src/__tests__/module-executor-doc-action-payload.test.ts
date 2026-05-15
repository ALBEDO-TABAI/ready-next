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

  it('非 update_widget 动作即使 summary 命中关键词也不会被错误标记', async () => {
    // performDocAction 直接走 list_widgets，不受 classifier 影响
    const summary = await performDocAction({ type: 'list_widgets' })
    assert.equal(typeof summary, 'string')
    assert.equal(classifyDocActionFailureReason({ type: 'list_widgets' }, summary), null)
  })
})

describe('performDocAction · save_tab disk drift', () => {
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
