'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const root = resolve(__dirname, '../..')
const validator = resolve(root, 'scripts/check-provider-transfer-live-proof-report.cjs')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ready-provider-transfer-validator-'))
  const metrics = join(dir, 'metrics.log')
  writeFileSync(metrics, '')
  const profile = join(dir, 'profile'); mkdirSync(profile)
  const database = join(profile, 'ready.db'); writeFileSync(database, '')
  return {
    dir,
    report: {
      ok: true,
      live: { ok: true },
      paths: { profilePath: profile, databasePath: database },
      handshake: { ok: true, nonce: 'nonce', executablePath: '/app/Ready', executableSha256: 'exe',
        asarPath: '/app/app.asar', asarSha256: 'asar', manifestDigest: 'manifest', profilePath: profile,
        databasePath: database, metricsPath: metrics },
      fixture: { toolBoundaryDelivered: true, requestCount: 3, requests: [
        { status: 200, kind: 'browser_tool_boundary' },
        { status: 502, kind: 'controlled_upstream_failure' },
        { status: 502, kind: 'controlled_upstream_failure' },
      ] },
      scopeId: 'scope', runId: 'run', taskId: 'task', sendResult: { observed: true },
      projection: { task_id: 'task', run_id: 'run', status: 'recoverable_paused', waiting_for: 'none',
        blocked_reason: 'browser_provider_transfer_checkpoint' },
      runMeta: { run_id: 'run', status: 'checkpoint' },
      canonical: { id: 'assistant:checkpoint:run', doneMessageId: 'assistant:checkpoint:run', doneDigest: 'digest' },
      visibleCanonical: [{ id: 'assistant:checkpoint:run' }], taskCards: [{ taskId: 'task' }],
      metrics: { sourcePath: metrics, counts: { owner_local_runner_session_rebased: 0,
        owner_local_session_source_cursor_mismatch: 0, renderer_done_without_canonical_terminal: 0,
        renderer_send_success_without_canonical_terminal: 0 } },
    },
  }
}

function validate(value) {
  const path = join(value.dir, 'report.json')
  writeFileSync(path, JSON.stringify(value.report))
  return spawnSync(process.execPath, [validator, path], { cwd: root, encoding: 'utf8' })
}

test('provider transfer validator accepts a complete fail-closed report', () => {
  assert.equal(validate(fixture()).status, 0)
})

test('provider transfer validator rejects missing 502 pipeline evidence', () => {
  const value = fixture(); value.report.fixture.requestCount = 0; value.report.fixture.requests = []
  assert.notEqual(validate(value).status, 0)
})

test('provider transfer validator rejects nonzero integrity metrics', () => {
  const value = fixture(); value.report.metrics.counts.owner_local_runner_session_rebased = 1
  assert.notEqual(validate(value).status, 0)
})
