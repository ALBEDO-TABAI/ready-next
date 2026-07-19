#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const SHARED_REL = 'src/shared/browser-task-status.ts'
const IPC_REL = 'src/main/modules/browser-engine/ipc-supervision.ts'
const PERSISTENCE_REL = 'src/main/modules/browser-engine/task-persistence-service.ts'
const BROWSER_MODE_REL = 'src/renderer/pages/modes/BrowserMode.tsx'
const PANEL_REL = 'src/renderer/components/browser/AgentBrowserSupervisionPanel.tsx'
const EXPECTED_VISIBLE = ['queued', 'running', 'paused', 'waiting_human']

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function extractConstArray(text, name) {
  const match = text.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`))
  if (!match) return null
  return [...match[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((item) => item[1])
}

function extractFunctionBody(text, name) {
  let start = text.indexOf(`function ${name}`)
  if (start === -1) start = text.search(new RegExp(`\\b${name}\\s*\\(`))
  if (start === -1) return ''
  const brace = text.indexOf('{', start)
  if (brace === -1) return ''
  let depth = 0
  for (let index = brace; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(brace + 1, index)
    }
  }
  return ''
}

function sameValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function containsHandWrittenVisibilityRule(text) {
  return /task\.status\s*===\s*['"](queued|running|paused)['"][\s\S]{0,160}\|\|[\s\S]{0,160}task\.status\s*===\s*['"](queued|running|paused)['"]/.test(text)
}

function requireHelperUse(rel, text, errors, opts = {}) {
  if (!text.includes('isBrowserSupervisionVisibleTaskStatus(')) {
    errors.push(`supervision_visibility_helper_not_used:${rel}`)
  }
  if (opts.rejectHandWritten !== false && containsHandWrittenVisibilityRule(text)) {
    errors.push(`handwritten_supervision_visibility_rule:${rel}`)
  }
}

function checkPendingStartupList(text, errors) {
  const body = extractFunctionBody(text, 'listPendingTasks')
  if (!body) {
    errors.push(`missing_list_pending_tasks:${PERSISTENCE_REL}`)
    return
  }
  const match = body.match(/listTasks\(\s*\[([\s\S]*?)\]\s*\)/)
  if (!match) {
    errors.push('list_pending_tasks_missing_explicit_startup_statuses')
    return
  }
  const statuses = [...match[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)].map((item) => item[1])
  for (const status of ['queued', 'running', 'paused']) {
    if (!statuses.includes(status)) errors.push(`list_pending_tasks_missing_status:${status}`)
  }
  if (statuses.includes('waiting_human')) {
    errors.push('list_pending_tasks_must_not_auto_resume_waiting_human')
  }
}

function check({ root = ROOT } = {}) {
  const errors = []
  const files = new Map()

  for (const rel of [SHARED_REL, IPC_REL, PERSISTENCE_REL, BROWSER_MODE_REL, PANEL_REL]) {
    try {
      files.set(rel, stripComments(read(root, rel)))
    } catch (error) {
      errors.push(`missing_file:${rel}:${error.message}`)
    }
  }

  const shared = files.get(SHARED_REL) || ''
  const visibleStatuses = extractConstArray(shared, 'BROWSER_SUPERVISION_VISIBLE_TASK_STATUSES')
  if (!visibleStatuses) {
    errors.push(`missing_supervision_visible_statuses:${SHARED_REL}`)
  } else if (!sameValues(visibleStatuses, EXPECTED_VISIBLE)) {
    errors.push(`supervision_visible_statuses_changed:${visibleStatuses.join(',')}`)
  }
  if (!shared.includes('isBrowserSupervisionVisibleTaskStatus')) {
    errors.push(`missing_supervision_visible_helper:${SHARED_REL}`)
  }
  if (!shared.includes("status === 'waiting_human'") || !shared.includes("'等待确认'")) {
    errors.push(`missing_waiting_human_label:${SHARED_REL}`)
  }

  for (const rel of [IPC_REL, BROWSER_MODE_REL, PANEL_REL]) {
    requireHelperUse(rel, files.get(rel) || '', errors)
  }
  checkPendingStartupList(files.get(PERSISTENCE_REL) || '', errors)

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-browser-task-supervision-status-single-source] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-browser-task-supervision-status-single-source] OK')
}

module.exports = { check }
