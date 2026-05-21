import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { performDocAction } from '../renderer/modules/agent/documentActions'
import { useDocTabs } from '../renderer/stores/useDocTabs'

describe('document widget authoring with OpenUI component specs', () => {
  it('inserts a compiled widget fence from a component spec', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n\nhello\n')

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'release_callout',
      componentSpec: {
        component: 'callout_block',
        props: {
          heading: '发布提醒',
          body: '今晚 20:00 前完成封面和标题检查。',
          tone: 'warning',
        },
      },
      position: 'append_end',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /插入 widget/)
    assert.match(updated?.content || '', /```show-widget/)
    assert.match(updated?.content || '', /"title":"release_callout"/)
    assert.match(updated?.content || '', /发布提醒/)
  })

  it('resolves calendar snapshots for real-data component specs before writing', async () => {
    const today = new Date()
    const startTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 30, 0)
    const endTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 0, 0)
    const startUnix = Math.floor(startTime.getTime() / 1000)
    const endUnix = Math.floor(endTime.getTime() / 1000)
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        calendar: {
          getEvents: async () => ({
            success: true,
            data: [
              {
                id: 'evt-1',
                title: '晨会',
                startTime: startUnix,
                endTime: endUnix,
                calendarId: 'work',
                color: '#5B8DEF',
                description: '',
                allDay: false,
              },
            ],
          }),
          getSources: async () => ({
            success: true,
            data: [{ id: 'work', name: '工作', color: '#5B8DEF', enabled: true }],
          }),
        },
      },
    }

    try {
      const store = useDocTabs.getState()
      const tab = store.tabs[0]
      store.setTabContent(tab.id, '# Intro\n')

      const result = await performDocAction({
        type: 'insert_widget',
        title: 'today_schedule',
        componentSpec: {
          component: 'day_schedule_card',
          dataSource: { type: 'calendar', preset: 'today' },
        },
        position: 'append_end',
        tabId: tab.id,
      })

      const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
      assert.match(result, /插入 widget/)
      assert.match(updated?.content || '', /晨会/)
      assert.match(updated?.content || '', /今天|今日/)
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('accepts kimi-style info card component specs with flat fields', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# Intro\n\nhello\n')

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'learning_summary_card',
      componentSpec: {
        componentType: 'info_card',
        title: '📚 学习重点总结',
        content: '本文档核心知识点与关键要点汇总',
        items: [
          { label: '核心概念', value: '掌握基础理论与关键定义' },
          { label: '实践要点', value: '注重实际操作与应用场景' },
        ],
        footer: '建议定期复习巩固',
      },
      position: 'append_end',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /插入 widget/)
    assert.match(updated?.content || '', /学习重点总结/)
    assert.match(updated?.content || '', /本文档核心知识点与关键要点汇总/)
    assert.match(updated?.content || '', /核心概念/)
    assert.match(updated?.content || '', /建议定期复习巩固/)
  })

  it('inserts relationship graph component specs without raw coordinate SVG', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, '# 人物关系图\n')

    const result = await performDocAction({
      type: 'insert_widget',
      title: 'idiot_relationship_graph',
      componentSpec: {
        component: 'relationship_graph',
        props: {
          heading: '《白痴》人物关系图',
          groups: [
            { id: 'core', label: '核心三角', position: 'center' },
            { id: 'family', label: '叶班钦家族', position: 'right' },
          ],
          nodes: [
            { id: 'duke', label: '梅诗金公爵', group: 'core', emphasis: 'primary' },
            { id: 'nastasya', label: '娜斯塔霞', group: 'core', emphasis: 'primary' },
            { id: 'aglaia', label: '阿格拉雅', group: 'family' },
          ],
          edges: [
            { from: 'duke', to: 'nastasya', kind: 'emotion', label: '怜悯/吸引' },
            { from: 'aglaia', to: 'duke', kind: 'emotion', label: '好奇' },
          ],
        },
      },
      position: 'append_end',
      tabId: tab.id,
    })

    const updated = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
    assert.match(result, /插入 widget/)
    assert.match(updated?.content || '', /"component":"relationship_graph"/)
    assert.match(updated?.content || '', /data-rg-root/)
    assert.doesNotMatch(updated?.content || '', /<line\b[^>]*x1=/)
  })
})
