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
                startTime: new Date('2026-03-30T09:30:00+08:00'),
                endTime: new Date('2026-03-30T10:00:00+08:00'),
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
})
