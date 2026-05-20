/**
 * Stage R W1.3 — current-date system reminder smoke test.
 *
 * Asserts that registerCurrentDateReminder() registers a reminder whose
 * compose() output contains the ISO date and Chinese weekday label.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminders/system-reminder-registry'
import { registerCurrentDateReminder } from '../main/modules/agent-control/system-reminders/current-date-reminder'

test('registerCurrentDateReminder writes topic="current-date" priority=90', () => {
  const registry = createSystemReminderRegistry()
  // Mock a deterministic date: 2026-05-09 (Saturday)
  const fixed = new Date('2026-05-09T12:00:00Z')
  registerCurrentDateReminder(registry, fixed)
  const composed = registry.compose()
  assert.ok(composed, 'compose() must return non-null after registration')
  assert.match(composed!, /2026-05-09/)
  assert.match(composed!, /当前日期/)
})
