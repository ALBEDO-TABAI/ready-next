import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillDomainAdapter } from '../main/modules/agent-control/skills/skill-domain-adapter'
import { RSSDomainAdapter } from '../main/modules/agent-control/rss-domain-adapter'
import { CalendarDomainAdapter } from '../main/modules/agent-control/calendar-domain-adapter'
import { FeishuDomainAdapter } from '../main/modules/agent-control/feishu-domain-adapter'

function createRoute(executor: 'skill' | 'rss' | 'calendar' | 'feishu') {
  return {
    taskId: 'task-1',
    taskType: 'short_task' as const,
    chain: executor === 'skill' ? 'domain_executor' as const : 'tool_loop' as const,
    executor,
    steps: [],
    continuation: null,
  }
}

test('skill executor routing narrows tool execution to skill/session context and injects a dedicated instruction', () => {
  const allowed = [
    'skill_video_expert_pipeline',
    'memory_search',
    'session_search',
    'rss_capture_session',
    'calendar_list_events',
  ]

  const adapter = new SkillDomainAdapter()
  const prepared = adapter.prepare({
    route: createRoute('skill'),
    allowedToolNames: allowed,
    hasTools: true,
    userText: '用 skill 继续执行这个工作流',
    executionIntentContext: {} as never,
  })

  assert.match(String(prepared.sessionMessages?.[0]?.content || ''), /skill/i)
  assert.deepEqual(prepared.allowedToolNames, [
    'skill_video_expert_pipeline',
    'memory_search',
    'session_search',
  ])
})

test('rss, calendar, and feishu executors each keep only their domain tools plus shared context tools', () => {
  const allowed = [
    'rss_capture_session',
    'skill_rss_status',
    'calendar_list_events',
    'feishu_doc_update',
    'memory_search',
    'session_search',
  ]

  const rssPrepared = new RSSDomainAdapter().prepare({
    route: createRoute('rss'),
    allowedToolNames: allowed,
    hasTools: true,
    userText: '看看 RSS 最近更新',
    executionIntentContext: {} as never,
  })
  const calendarPrepared = new CalendarDomainAdapter().prepare({
    route: createRoute('calendar'),
    allowedToolNames: allowed,
    hasTools: true,
    userText: '安排一下日程',
    executionIntentContext: {} as never,
  })
  const feishuPrepared = new FeishuDomainAdapter().prepare({
    route: createRoute('feishu'),
    allowedToolNames: allowed,
    hasTools: true,
    userText: '把消息发到飞书',
    executionIntentContext: {} as never,
  })

  assert.deepEqual(rssPrepared.allowedToolNames, [
    'rss_capture_session',
    'skill_rss_status',
    'memory_search',
    'session_search',
  ])
  assert.deepEqual(calendarPrepared.allowedToolNames, [
    'calendar_list_events',
    'memory_search',
    'session_search',
  ])
  assert.deepEqual(feishuPrepared.allowedToolNames, [
    'feishu_doc_update',
    'memory_search',
    'session_search',
  ])
})
