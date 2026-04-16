import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildExecutorRuntimePolicy,
  selectExecutorAllowedToolNames,
} from '../main/modules/agent-control/task-execution-router'

test('skill executor routing narrows tool execution to skill/session context and injects a dedicated instruction', () => {
  const allowed = [
    'skill_video_expert_pipeline',
    'memory_search',
    'session_search',
    'rss_capture_session',
    'calendar_list_events',
  ]

  const policy = buildExecutorRuntimePolicy('skill')
  const filtered = selectExecutorAllowedToolNames('skill', allowed)

  assert.match(policy.instruction || '', /skill/i)
  assert.deepEqual(policy.toolPrefixes, ['skill_', 'memory_', 'session_'])
  assert.deepEqual(filtered, [
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

  assert.deepEqual(selectExecutorAllowedToolNames('rss', allowed), [
    'rss_capture_session',
    'skill_rss_status',
    'memory_search',
    'session_search',
  ])
  assert.deepEqual(selectExecutorAllowedToolNames('calendar', allowed), [
    'calendar_list_events',
    'memory_search',
    'session_search',
  ])
  assert.deepEqual(selectExecutorAllowedToolNames('feishu', allowed), [
    'feishu_doc_update',
    'memory_search',
    'session_search',
  ])
})
