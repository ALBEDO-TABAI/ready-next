import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyDocActionMutationOutcome,
  performDocAction,
} from '../../renderer/modules/agent/documentActions'
import { useDocTabs } from '../../renderer/stores/useDocTabs'

describe('document_insert_widget action', () => {
  it('appends a widget fence to the active document', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n\nhello\n')

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'chart_1',
      widgetCode: '<div>Chart</div>',
      position: 'append_end',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /插入 widget/)
    assert.match(updated?.content || '', /```show-widget/)
    assert.match(updated?.content || '', /"title":"chart_1"/)
  })

  it('inserts a widget fence after a section', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n\nA\n\n## Section\n\nB\n\n## Next\n\nC\n')

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'chart_2',
      widgetCode: '<div>Widget</div>',
      position: 'after_section',
      sectionTitle: 'Section',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /章节/)
    assert.match(updated?.content || '', /## Section[\s\S]*```show-widget[\s\S]*## Next/)
  })

  it('auto-wraps bare widget JSON when append_content is used', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n')

    const result = await performDocAction({
      type: 'append_content',
      content: '{"title":"reading_summary_card","widget_code":"<div>Chart</div>"}',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /追加 1 个 widget/)
    assert.match(updated?.content || '', /```show-widget/)
    assert.match(updated?.content || '', /"widget_code":"<div>Chart<\/div>"/)
  })

  it('rejects split Mermaid source that would expose diagram code in preview', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n')

    const result = await performDocAction({
      type: 'set_content',
      content: [
        '# 人物关系图',
        '',
        '```mermaid',
        'graph LR',
        '公爵["梅诗金公爵"]',
        '娜斯塔霞["娜斯塔霞"]',
        '```',
        '',
        '公爵 --- "一见钟情" --> 娜斯塔霞',
        '%% 叶班钦家族',
        '将军["叶班钦将军"] --- "父女" --> 大姐["亚历山德拉"]',
      ].join('\n'),
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /文档写入已拒绝/)
    assert.match(result, /Mermaid/)
    assert.equal(updated?.content, '# Intro\n')
  })

  it('rejects section rewrites that would expose relationship graph source', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, [
      '# 白痴笔记',
      '',
      '## 二、人物关系图',
      '',
      '旧内容。',
      '',
      '## 三、主题',
      '',
      '保留内容。',
    ].join('\n'))

    const result = await performDocAction({
      type: 'rewrite_section',
      sectionTitle: '二、人物关系图',
      content: [
        'duke -- "一见钟情/命运纠葛" ---- nastasya rogohin -- "疯狂追求" --> nastasya',
        '',
        '%% 叶班钦家族 epanchin["叶班钦将军"] epanchinW["叶丽扎薇塔<br/>（将军夫人）"]',
        'epanchin -- "夫妻" --- epanchinW',
      ].join('\n'),
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /章节重写已拒绝/)
    assert.match(result, /Mermaid/)
    assert.match(updated?.content || '', /旧内容/)
    assert.doesNotMatch(updated?.content || '', /duke --/)
  })

  it('rejects malformed Mermaid blocks that preview would expose as code', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n')

    const result = await performDocAction({
      type: 'set_content',
      content: [
        '# 人物关系图',
        '',
        '```mermaid',
        'graph TD',
        'duke -- "一见钟情" --- nastasya',
        '```',
      ].join('\n'),
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /文档写入已拒绝/)
    assert.match(result, /Mermaid/)
    assert.match(result, /边标签/)
    assert.equal(updated?.content, '# Intro\n')
  })

  it('rejects text replacement inside show-widget fences with a structured boundary reason', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    const original = [
      '# Intro',
      '',
      '```show-widget',
      '{"title":"card","widget_code":"<div>Old</div>"}',
      '```',
      '',
      'Old outside',
    ].join('\n')
    store.setTabContent(tab.id, original)

    const result = await performDocAction({
      type: 'replace_text',
      from: 'Old',
      to: 'New',
      tabId: tab.id,
    })
    const outcome = classifyDocActionMutationOutcome({ type: 'replace_text' }, result)

    assert.match(result, /show-widget/)
    assert.match(result, /document_update_widget/)
    assert.deepEqual(outcome, {
      mutated: false,
      mutationReason: 'rejected',
      errorKind: 'widget_boundary_violation',
      recoverable: true,
    })
    assert.equal(useDocTabs.getState().tabs.find((item) => item.id === tab.id)?.content, original)
  })

  it('classifies mutation outcomes for all document writing actions', () => {
    const mutationActions = [
      'set_content',
      'append_content',
      'insert_widget',
      'update_widget',
      'remove_widget',
      'replace_text',
      'replace_exact',
      'format_section',
      'rewrite_section',
    ]
    const changedSummaryByAction: Record<string, string> = {
      set_content: '已写入文档：测试.md',
      append_content: '已追加内容：测试.md',
      insert_widget: '已在文档尾部插入 widget（测试.md）',
      update_widget: '已更新 widget：关系图',
      remove_widget: '已删除 widget：关系图',
      replace_text: '已替换 1 处文本：测试.md',
      replace_exact: '已精准替换 1 处文本：测试.md',
      format_section: '已优化章节格式：人物关系图',
      rewrite_section: '已重写章节：人物关系图',
    }

    for (const type of mutationActions) {
      assert.deepEqual(
        classifyDocActionMutationOutcome({ type }, changedSummaryByAction[type]),
        { mutated: true, mutationReason: 'changed' },
      )
      assert.deepEqual(
        classifyDocActionMutationOutcome({ type }, '未匹配到目标片段，未做改动'),
        { mutated: false, mutationReason: 'no_match' },
      )
      assert.deepEqual(
        classifyDocActionMutationOutcome({ type }, '内容未变化，已跳过'),
        { mutated: false, mutationReason: 'identical' },
      )
      assert.deepEqual(
        classifyDocActionMutationOutcome({ type }, '操作已取消'),
        { mutated: false, mutationReason: 'cancelled' },
      )
      assert.deepEqual(
        classifyDocActionMutationOutcome({ type }, '写入已拒绝：不允许覆盖原文'),
        { mutated: false, mutationReason: 'rejected' },
      )
      assert.deepEqual(
        classifyDocActionMutationOutcome({ type }, '文档写入已拒绝：目标文档里的 Mermaid 代码块使用了不兼容的边标签语法。'),
        {
          mutated: false,
          mutationReason: 'validation_failed',
          errorKind: 'document_visual_syntax_invalid',
          recoverable: true,
        },
      )
    }
  })

  it('updates an existing widget with the same title instead of appending duplicates', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, [
      '# Intro',
      '',
      '```show-widget',
      '{"title":"reading_dashboard","widget_code":"<div>Old</div>"}',
      '```',
      '',
    ].join('\n'))

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'reading_dashboard',
      widgetCode: '<div>New</div>',
      position: 'append_end',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /更新同标题 widget/)
    assert.equal((updated?.content.match(/```show-widget/g) || []).length, 1)
    assert.match(updated?.content || '', /"widget_code":"<div>New<\/div>"/)
    assert.doesNotMatch(updated?.content || '', /<div>Old<\/div>/)
  })

  it('merges appended widget fences by title instead of stacking repeats', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, [
      '# Intro',
      '',
      '```show-widget',
      '{"title":"reading_summary_card","widget_code":"<div>Before</div>"}',
      '```',
      '',
    ].join('\n'))

    const result = await performDocAction({
      type: 'append_content',
      content: [
        '```show-widget',
        '{"title":"reading_summary_card","widget_code":"<div>After</div>"}',
        '```',
      ].join('\n'),
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /更新 1 个 widget/)
    assert.equal((updated?.content.match(/```show-widget/g) || []).length, 1)
    assert.match(updated?.content || '', /"widget_code":"<div>After<\/div>"/)
    assert.doesNotMatch(updated?.content || '', /<div>Before<\/div>/)
  })

  it('rejects incomplete background-only SVG widgets', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n')

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'reading_summary_card',
      widgetCode: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="400" height="200" /></svg>',
      position: 'append_end',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /widget 写入已拒绝/)
    assert.equal((updated?.content.match(/```show-widget/g) || []).length, 0)
  })

  it('lists widgets in the active document', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, [
      '# Intro',
      '',
      '```show-widget',
      '{"title":"reading_summary_card","widget_code":"<svg><text>One</text></svg>"}',
      '```',
      '',
      '```show-widget',
      '{"title":"chart_demo","widget_code":"<div>Chart</div><script>console.log(1)</script>"}',
      '```',
    ].join('\n'))

    const result = await performDocAction({
      type: 'list_widgets',
      tabId: tab.id,
    })

    assert.match(result, /当前文档共有 2 个 widget/)
    assert.match(result, /1\. reading_summary_card \[static-svg\]/)
    assert.match(result, /2\. chart_demo \[scripted\]/)
  })

  it('updates an existing widget by title', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, [
      '# Intro',
      '',
      '```show-widget',
      '{"title":"chart_demo","widget_code":"<div>Old</div><script>console.log(1)</script>"}',
      '```',
    ].join('\n'))

    const result = await performDocAction({
      type: 'update_widget',
      target: 'chart_demo',
      widgetCode: '<div>New</div><script>console.log(2)</script>',
      title: 'chart_demo_v2',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /已更新 widget：chart_demo_v2/)
    assert.match(updated?.content || '', /"title":"chart_demo_v2"/)
    assert.match(updated?.content || '', /console\.log\(2\)/)
    assert.doesNotMatch(updated?.content || '', /console\.log\(1\)/)
  })

  it('removes an existing widget by index', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, [
      '# Intro',
      '',
      '```show-widget',
      '{"title":"widget_one","widget_code":"<div>One</div>"}',
      '```',
      '',
      '```show-widget',
      '{"title":"widget_two","widget_code":"<div>Two</div>"}',
      '```',
    ].join('\n'))

    const result = await performDocAction({
      type: 'remove_widget',
      target: '1',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /已删除 widget：widget_one/)
    assert.doesNotMatch(updated?.content || '', /widget_one/)
    assert.match(updated?.content || '', /widget_two/)
  })
})
