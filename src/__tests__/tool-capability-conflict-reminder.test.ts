import assert from 'node:assert/strict'
import test from 'node:test'

import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminders/system-reminder-registry'
import {
  registerToolCapabilityConflictReminder,
  TOOL_CAPABILITY_CONFLICT_REMINDER_MARKER,
} from '../main/modules/agent-control/system-reminders/tool-capability-conflict-reminder'

test('tool capability conflict reminder is absent without a real requested conflict', () => {
  const registry = createSystemReminderRegistry()
  assert.equal(registerToolCapabilityConflictReminder(registry, []), false)
  assert.equal(registry.compose(), null)
})

test('tool capability conflict reminder explains each resolver reason without inventing consent', () => {
  const registry = createSystemReminderRegistry()
  assert.equal(registerToolCapabilityConflictReminder(registry, [
    {
      groupId: 'browser_interaction',
      label: '浏览器交互',
      reason: 'provider_disabled_tools',
    },
    {
      groupId: 'document',
      label: '文档',
      reason: 'environment_unavailable',
    },
  ]), true)

  const text = registry.compose() || ''
  assert.match(text, new RegExp(TOOL_CAPABILITY_CONFLICT_REMINDER_MARKER))
  assert.match(text, /强制开启/)
  assert.match(text, /本地运行环境当前不可用/)
  assert.match(text, /聊天文字本身不能直接修改设置/)
  assert.doesNotMatch(text, /已经开启/)
})
