#!/usr/bin/env node
/**
 * Stage R W1.3 — current-date system reminder registration gate.
 *
 * Asserts:
 *   - system-reminders/current-date-reminder.ts registers the reminder
 *     with topic 'current-date' and priority 90.
 *   - system-reminder-registry.ts ReminderTopic union contains
 *     'current-date'.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const errors = []

function read(rel) {
  try {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    errors.push(`cannot read ${rel}: ${e.message}`)
    return ''
  }
}

const reminder = read('src/main/modules/agent-control/system-reminders/current-date-reminder.ts')
if (reminder) {
  if (!/topic:\s*['"]current-date['"]/.test(reminder)) {
    errors.push("current-date-reminder.ts: missing `topic: 'current-date'`")
  }
  if (!/priority:\s*90\b/.test(reminder)) {
    errors.push('current-date-reminder.ts: missing `priority: 90`')
  }
}

const registry = read('src/main/modules/agent-control/system-reminder-registry.ts')
if (registry) {
  // Extract the ReminderTopic union and confirm 'current-date' appears.
  // Union may end at `;` or at the next top-level declaration (export ...).
  const unionMatch = registry.match(
    /export\s+type\s+ReminderTopic\s*=([\s\S]*?)(?:\n;|\nexport\s)/,
  )
  const unionBody = unionMatch ? unionMatch[1] : ''
  if (!/['"]current-date['"]/.test(unionBody)) {
    errors.push("system-reminder-registry.ts: ReminderTopic union must include 'current-date'")
  }
}

if (errors.length > 0) {
  console.error('[check-current-date-reminder-registered] FAIL:')
  errors.forEach((e) => console.error('  - ' + e))
  process.exit(1)
}
console.log('[check-current-date-reminder-registered] OK')
