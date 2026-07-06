/**
 * P2-1 (T4) — L1 技能目录 reminder：确定性预算算法 + registry 集成。
 * 母合同：2026-07-06 skill-envelope §4 T4。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SKILL_CATALOG_CHAR_BUDGET,
  buildSkillCatalogText,
  registerSkillCatalogReminder,
  type SkillCatalogEntry,
} from '../main/modules/agent-control/system-reminders/skill-catalog-reminder'
import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminders/system-reminder-registry'

const entry = (id: string, name: string, description: string): SkillCatalogEntry => ({ id, name, description })

test('buildSkillCatalogText: empty entries → empty string', () => {
  assert.equal(buildSkillCatalogText([]), '')
})

test('buildSkillCatalogText: header + one line per entry with the @[id]｜name｜description format', () => {
  const text = buildSkillCatalogText([entry('ready-human-touch-ppt', 'Human Touch PPT', '人文感风格幻灯片')])
  assert.ok(text.startsWith('可用技能（引用 @[技能id] 或调用 use_skill 激活；激活前技能工具不可用）：\n'))
  assert.ok(text.includes('- @[ready-human-touch-ppt]｜Human Touch PPT｜人文感风格幻灯片'))
})

test('buildSkillCatalogText: description over the cap is truncated to 117 chars + … (deterministic)', () => {
  const long = 'x'.repeat(200)
  const a = buildSkillCatalogText([entry('s', 'n', long)])
  const b = buildSkillCatalogText([entry('s', 'n', long)])
  assert.equal(a, b) // byte-identical on repeat
  assert.ok(a.includes(`${'x'.repeat(117)}…`))
  assert.equal(a.includes('x'.repeat(118)), false)
})

test('buildSkillCatalogText: at-cap description is not truncated', () => {
  const exact = 'y'.repeat(120)
  const text = buildSkillCatalogText([entry('s', 'n', exact)])
  assert.ok(text.includes(exact))
  assert.equal(text.includes('…'), false)
})

test('buildSkillCatalogText: budget overflow drops the tail and appends a count line', () => {
  const entries = Array.from({ length: 60 }, (_, i) => entry(`skill-${i}`, `Name ${i}`, 'z'.repeat(100)))
  const text = buildSkillCatalogText(entries, 400)
  assert.ok(text.length <= 400 + '（另有 60 个技能，可在技能中心查看或直接 @[技能id] 引用）'.length + 40)
  assert.ok(/（另有 \d+ 个技能，可在技能中心查看或直接 @\[技能id\] 引用）/.test(text), 'count line present')
  // At least one skill dropped → the count is > 0
  const match = text.match(/（另有 (\d+) 个技能/)
  assert.ok(match && Number(match[1]) > 0)
})

test('buildSkillCatalogText: no drop when everything fits under budget → no count line', () => {
  const text = buildSkillCatalogText([entry('a', 'A', 'short'), entry('b', 'B', 'short')], SKILL_CATALOG_CHAR_BUDGET)
  assert.equal(text.includes('另有'), false)
})

test('buildSkillCatalogText: exactly-at-budget line is kept (boundary)', () => {
  // Craft a single entry whose line makes used === budget exactly (used + 1 + line.length === budget).
  const header = '可用技能（引用 @[技能id] 或调用 use_skill 激活；激活前技能工具不可用）：'
  const prefix = '- @[s]｜n｜'
  const budget = header.length + 1 + prefix.length + 5 // description of length 5 → exact fit
  const text = buildSkillCatalogText([entry('s', 'n', 'abcde')], budget)
  assert.ok(text.includes('- @[s]｜n｜abcde'))
  assert.equal(text.includes('另有'), false)
})

test('registerSkillCatalogReminder: registers the catalog into the composed reminder', () => {
  const registry = createSystemReminderRegistry()
  registerSkillCatalogReminder(registry, [entry('ready-human-touch-ppt', 'Human Touch PPT', '人文感风格幻灯片')])
  const composed = registry.compose()
  assert.ok(composed && composed.includes('可用技能'), 'composed reminder must contain the catalog header')
  assert.ok(composed.includes('@[ready-human-touch-ppt]'))
})

test('registerSkillCatalogReminder: empty entries → does not register (no empty section)', () => {
  const registry = createSystemReminderRegistry()
  registerSkillCatalogReminder(registry, [])
  assert.equal(registry.compose(), null)
})
