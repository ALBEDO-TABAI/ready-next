#!/usr/bin/env node
/**
 * Stage 6 deferred gate. TaskProjectionRecord.status must share the child-run
 * status vocabulary, and production projection writers must not write the old
 * projection-local terminal names (`done` / `cancelled`).
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function fail(kind, detail) {
  console.error(`check-task-projection-status-shared: ${kind}: ${detail}`)
  process.exit(1)
}

function functionBody(text, name) {
  const start = text.indexOf(`function ${name}`)
  if (start < 0) return null
  const open = text.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
  }
  return null
}

function assertNoOldTerminalReturns(rel, names) {
  const text = read(rel)
  for (const name of names) {
    const body = functionBody(text, name)
    if (!body) fail('function_missing', `${rel} missing ${name}`)
    if (/return\s+['"](done|cancelled)['"]/.test(body)) {
      fail('old_projection_return', `${rel} ${name} returns old projection terminal status`)
    }
  }
}

function main() {
  const wireRel = 'src/shared/ipc-contracts/task-projection.ts'
  const wire = read(wireRel)
  if (!/import\s+type\s+\{\s*SkillChildRunStatus\s*\}\s+from\s+['"]\.\.\/skill-child-run-status['"]/.test(wire)) {
    fail('wire_import_missing', `${wireRel} must import SkillChildRunStatus from the shared status module`)
  }
  if (!/export\s+type\s+TaskProjectionStatus\s*=\s*SkillChildRunStatus\b/.test(wire)) {
    fail('wire_alias_missing', 'TaskProjectionStatus must alias SkillChildRunStatus')
  }

  const shared = read('src/shared/skill-child-run-status.ts')
  for (const status of ['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked', 'completed', 'failed', 'killed']) {
    if (!shared.includes(`'${status}'`)) fail('shared_status_missing', `shared status module missing ${status}`)
  }

  const electron = read('src/renderer/types/electron.d.ts')
  const statusLine = electron.match(/type\s+TaskProjectionStatusData\s*=\s*([^\n]+)/)?.[1] || ''
  for (const status of ['recoverable_paused', 'budget_paused', 'completed', 'killed']) {
    if (!statusLine.includes(`'${status}'`)) fail('renderer_status_missing', `TaskProjectionStatusData missing ${status}`)
  }
  if (statusLine.includes("'done'") || statusLine.includes("'cancelled'")) {
    fail('renderer_old_status', 'TaskProjectionStatusData still includes done/cancelled')
  }

  const sync = read('src/main/modules/agent-control/task-projection/task-projection-sync.ts')
  const resolveStatus = functionBody(sync, 'resolveStatus')
  if (!resolveStatus) fail('function_missing', 'task-projection-sync.ts missing resolveStatus')
  if (!/return\s+['"]completed['"]/.test(resolveStatus) || !/return\s+['"]killed['"]/.test(resolveStatus)) {
    fail('sync_terminal_mapping_missing', 'resolveStatus must return completed/killed terminal statuses')
  }
  if (/return\s+['"](done|cancelled)['"]/.test(resolveStatus)) {
    fail('sync_old_terminal_mapping', 'resolveStatus still returns done/cancelled')
  }

  const reconciler = read('src/main/modules/agent-control/task-projection/task-projection-reconciler.ts')
  if (/status\s*:\s*['"](done|cancelled)['"]/.test(reconciler)) {
    fail('reconciler_old_status_write', 'task-projection-reconciler writes old projection terminal status')
  }

  assertNoOldTerminalReturns('src/main/modules/agent-control/skills/skill-child-runner.ts', [
    'childProjectionStatusForState',
  ])
  assertNoOldTerminalReturns('src/main/modules/agent-control/skills/skill-task-tracker.ts', [
    'lifecycleProjectionStatus',
    'eventProjectionStatus',
  ])

  const migrations = read('src/main/modules/migrations.ts')
  if (!/043_migrate_task_projection_status_to_child_status/.test(migrations)) {
    fail('migration_missing', 'migration 043 for task_projections.status is missing')
  }
  if (!/WHEN\s+'done'\s+THEN\s+'completed'/.test(migrations) || !/WHEN\s+'cancelled'\s+THEN\s+'killed'/.test(migrations)) {
    fail('migration_rewrite_missing', 'migration 043 must rewrite done/cancelled to completed/killed')
  }

  console.log('check-task-projection-status-shared: ok')
}

main()
