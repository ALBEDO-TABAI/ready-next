import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { performDocAction } from '../renderer/modules/agent/documentActions'
import { useDocTabs } from '../renderer/stores/useDocTabs'

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
