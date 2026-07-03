/**
 * D2 — 验收标准事中自检 reminder 行为测试。
 *
 * 与终态裁决同模板源（resolveCriteria）；断言：结果型任务注入且文案脱
 * 内部术语，非结果型/空 taskType 跳过，注册进 registry 后可组装。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCriteriaSelfCheckText,
  registerCriteriaSelfCheckReminder,
} from '../main/modules/agent-control/system-reminders/criteria-self-check-reminder'
import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminders/system-reminder-registry'
import { resolveCriteria } from '../main/modules/agent-control/quality/criteria-templates'

test('multi_step_task injects the same criteria the terminal adjudication resolves', () => {
  const text = buildCriteriaSelfCheckText('multi_step_task')
  assert.ok(text, 'multi_step_task must inject')
  assert.match(text!, /验收标准/)
  assert.match(text!, /宣布完成前逐条自检/)

  const resolved = resolveCriteria('multi_step_task', 'system')
  for (const item of resolved.items.filter((entry) => !entry.notApplicable)) {
    const mainClause = item.text.split('（')[0].trim()
    assert.ok(text!.includes(mainClause), `自检文案必须含裁决同源条目主句：${mainClause}`)
  }
})

test('criterion text is sanitized — maintainer parentheticals never reach the model', () => {
  const text = buildCriteriaSelfCheckText('multi_step_task')
  assert.ok(text)
  assert.doesNotMatch(text!, /steps_json|C4\.2a/, '括号内维护者注记不得注入模型面')
})

test('browser_transaction picks the browser transaction template', () => {
  const text = buildCriteriaSelfCheckText('browser_transaction')
  assert.ok(text, 'browser_transaction must inject')
  const resolved = resolveCriteria('browser_transaction', 'browser')
  const firstMain = resolved.items.filter((item) => !item.notApplicable)[0]?.text.split('（')[0].trim()
  assert.ok(firstMain && text!.includes(firstMain))
})

test('non-outcome task types and null skip injection entirely', () => {
  assert.equal(buildCriteriaSelfCheckText('direct_answer'), null)
  assert.equal(buildCriteriaSelfCheckText('short_task'), null)
  assert.equal(buildCriteriaSelfCheckText('continuation'), null)
  assert.equal(buildCriteriaSelfCheckText(null), null)
  assert.equal(buildCriteriaSelfCheckText(undefined), null)
})

test('registers through the reminder registry and composes; skips register when not injectable', () => {
  const registry = createSystemReminderRegistry()
  registerCriteriaSelfCheckReminder(registry, 'research')
  const composed = registry.compose()
  assert.ok(composed && composed.includes('验收标准'))

  const emptyRegistry = createSystemReminderRegistry()
  registerCriteriaSelfCheckReminder(emptyRegistry, 'direct_answer')
  assert.equal(emptyRegistry.compose(), null)
})
