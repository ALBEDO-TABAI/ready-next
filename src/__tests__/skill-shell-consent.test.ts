/**
 * P3-2 — per-skill shell-execution consent policy.
 * 母合同 §4 T6 + P3 §2: embedded skills (shipped + CI-reviewed) may run scripts by default;
 * custom/imported skills require explicit per-skill consent. Missing consent + a scripts/ dir →
 * a selected-turn reminder that points to the settings toggle (so the model doesn't fabricate
 * script results). All policy here is pure; the DB-backed get/set are thin wrappers.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseShellConsentMap,
  resolveSkillShellAllowed,
} from '../main/modules/skills-runtime/skill-shell-consent'
import {
  skillShellConsentReminderText,
  registerSkillShellConsentReminder,
} from '../main/modules/agent-control/system-reminders/skill-shell-consent-reminder'
import { createSystemReminderRegistry } from '../main/modules/agent-control/system-reminders/system-reminder-registry'

test('parseShellConsentMap: valid map keeps only true values; bad/absent JSON → {}', () => {
  assert.deepEqual(parseShellConsentMap('{"a":true,"b":false,"c":true}'), { a: true, c: true })
  assert.deepEqual(parseShellConsentMap(null), {})
  assert.deepEqual(parseShellConsentMap(undefined), {})
  assert.deepEqual(parseShellConsentMap('not json'), {})
  assert.deepEqual(parseShellConsentMap('[1,2,3]'), {})
  assert.deepEqual(parseShellConsentMap('"str"'), {})
})

test('resolveSkillShellAllowed: embedded+scripts → allow; custom needs consent; no scripts → always deny', () => {
  // embedded + scripts → allow (default trusted)
  assert.equal(resolveSkillShellAllowed({ hasScripts: true, isEmbedded: true, hasConsent: false }), true)
  // custom + scripts + no consent → deny
  assert.equal(resolveSkillShellAllowed({ hasScripts: true, isEmbedded: false, hasConsent: false }), false)
  // custom + scripts + consent → allow
  assert.equal(resolveSkillShellAllowed({ hasScripts: true, isEmbedded: false, hasConsent: true }), true)
  // no scripts → deny regardless
  assert.equal(resolveSkillShellAllowed({ hasScripts: false, isEmbedded: true, hasConsent: true }), false)
})

test('skillShellConsentReminderText: only when scripts present, not embedded, and no consent', () => {
  assert.equal(
    skillShellConsentReminderText({ skillName: 'X', hasScripts: true, isEmbedded: false, hasConsent: false })?.includes('X'),
    true,
  )
  assert.match(
    skillShellConsentReminderText({ skillName: 'X', hasScripts: true, isEmbedded: false, hasConsent: false }) || '',
    /允许运行脚本/,
  )
  assert.equal(skillShellConsentReminderText({ skillName: 'X', hasScripts: false, isEmbedded: false, hasConsent: false }), null)
  assert.equal(skillShellConsentReminderText({ skillName: 'X', hasScripts: true, isEmbedded: true, hasConsent: false }), null)
  assert.equal(skillShellConsentReminderText({ skillName: 'X', hasScripts: true, isEmbedded: false, hasConsent: true }), null)
})

test('registerSkillShellConsentReminder: registers a reminder only when scripts + !embedded + !consent', () => {
  const needed = createSystemReminderRegistry()
  registerSkillShellConsentReminder(needed, { skillName: '我的技能', hasScripts: true, isEmbedded: false, hasConsent: false })
  assert.match(needed.compose(), /我的技能/)

  const embedded = createSystemReminderRegistry()
  registerSkillShellConsentReminder(embedded, { skillName: 'X', hasScripts: true, isEmbedded: true, hasConsent: false })
  assert.ok(!embedded.compose(), 'embedded → no reminder')

  const consented = createSystemReminderRegistry()
  registerSkillShellConsentReminder(consented, { skillName: 'X', hasScripts: true, isEmbedded: false, hasConsent: true })
  assert.ok(!consented.compose(), 'consented → no reminder')
})
