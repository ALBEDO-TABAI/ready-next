#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const RUNTIME = 'src/main/modules/agent-control/runtime-core/runtime.ts'
const LEDGER = 'src/main/modules/agent-control/task-projection/projection-terminal-retry-ledger.ts'
const MIGRATIONS = 'src/main/modules/migrations.ts'

function findMethodBody(source, name) {
  const signature = new RegExp(`(?:^|\\n)\\s*(?:private\\s+)?(?:async\\s+)?${name}\\s*\\(`)
  const match = signature.exec(source)
  if (!match) return null
  const open = source.indexOf('{', match.index)
  if (open < 0) return null
  let depth = 0
  let quote = ''
  let escaped = false
  for (let index = open; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index)
    }
  }
  return null
}

function validateProjectionTerminalRetrySources({ runtime, ledger, migrations }) {
  const errors = []
  const recordBody = findMethodBody(runtime, 'recordScopeRunEvent') || ''
  const failureBody = findMethodBody(runtime, 'handleProjectionSyncFailure') || ''
  const scheduleBody = findMethodBody(runtime, 'scheduleTerminalProjectionSyncRetryDrain') || ''
  const drainBody = findMethodBody(runtime, 'drainTerminalProjectionSyncRetries') || ''
  const startBody = findMethodBody(runtime, 'start') || ''

  if (!runtime.includes('PendingProjectionSyncRepository')) {
    errors.push('runtime must import/use PendingProjectionSyncRepository')
  }
  if (!runtime.includes('private readonly pendingProjectionSyncs = new PendingProjectionSyncRepository(this.db)')) {
    errors.push('runtime must own pendingProjectionSyncs repository')
  }
  if (!recordBody.includes('syncTaskProjection(') || !recordBody.includes('handleProjectionSyncFailure(')) {
    errors.push('recordScopeRunEvent catch must delegate sync failures to handleProjectionSyncFailure')
  }
  if (!failureBody.includes("logAgentMetric('projection.sync_failed'")) {
    errors.push('failure path must preserve projection.sync_failed metric')
  }
  if (!failureBody.includes('isTerminalProjectionSyncPayload(summary)')) {
    errors.push('failure path must guard retry ledger to terminal summaries only')
  }
  if (!failureBody.includes('pendingProjectionSyncs.upsertPending')) {
    errors.push('terminal failure path must enqueue pendingProjectionSyncs.upsertPending')
  }
  if (!failureBody.includes("scheduleTerminalProjectionSyncRetryDrain('terminal_sync_failed')")) {
    errors.push('terminal failure path must schedule bounded retry drain')
  }
  if (!scheduleBody.includes('projectionSyncRetryDrainInFlight')) {
    errors.push('retry drain scheduler must guard in-flight drains')
  }
  if (!drainBody.includes('drainPendingProjectionSyncs') || !drainBody.includes('syncTaskProjection(')) {
    errors.push('retry drain must call drainPendingProjectionSyncs and retry syncTaskProjection')
  }
  if (!startBody.includes("scheduleTerminalProjectionSyncRetryDrain('startup')")) {
    errors.push('runtime startup must schedule one bounded terminal retry drain')
  }

  if (!ledger.includes('pending_projection_syncs')) {
    errors.push('ledger module must own pending_projection_syncs SQL')
  }
  if (!ledger.includes('terminalProjectionStatusFromSummary')) {
    errors.push('ledger module must expose terminalProjectionStatusFromSummary')
  }
  if (!ledger.includes('TERMINAL_PROJECTION_RETRY_MAX_ATTEMPTS')) {
    errors.push('ledger module must bound retry attempts')
  }
  if (!ledger.includes("name: 'projection.sync_exhausted'")) {
    errors.push('ledger drain must emit projection.sync_exhausted on exhausted rows')
  }
  if (!/return\s+null[\s\S]*blocked_external/.test(ledger) && ledger.includes("'blocked_external'")) {
    errors.push('blocked_external must not be treated as a terminal retry status')
  }
  if (!ledger.includes("'blocked_config'")) {
    errors.push('blocked_config must be retried as a failed terminal projection status')
  }

  if (!migrations.includes("name: '061_pending_projection_syncs'")) {
    errors.push('migration 061_pending_projection_syncs is missing')
  }
  if (!migrations.includes('CREATE TABLE IF NOT EXISTS pending_projection_syncs')) {
    errors.push('migration must create pending_projection_syncs table')
  }
  if (!migrations.includes('idx_pending_projection_syncs_due')) {
    errors.push('migration must create due index')
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const sources = {
    runtime: fs.readFileSync(path.join(ROOT, RUNTIME), 'utf8'),
    ledger: fs.readFileSync(path.join(ROOT, LEDGER), 'utf8'),
    migrations: fs.readFileSync(path.join(ROOT, MIGRATIONS), 'utf8'),
  }
  const result = validateProjectionTerminalRetrySources(sources)
  if (!result.ok) {
    console.error('[check-projection-terminal-retry-ledger] FAIL')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log('[check-projection-terminal-retry-ledger] OK')
}

if (require.main === module) {
  main()
}

module.exports = { findMethodBody, validateProjectionTerminalRetrySources }
