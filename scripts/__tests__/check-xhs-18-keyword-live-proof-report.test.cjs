'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const root = resolve(__dirname, '../..')
const validator = resolve(root, 'scripts/check-xhs-18-keyword-live-proof-report.cjs')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ready-xhs-validator-'))
  const metrics = join(dir, 'metrics.log'); writeFileSync(metrics, '')
  const profile = join(dir, 'profile'); mkdirSync(profile)
  const database = join(profile, 'ready.db'); writeFileSync(database, '')
  const keywords = Array.from({ length: 18 }, (_, index) => `keyword-${index + 1}`)
  const artifact = (path) => ({ path, exists: true, size: 100, sha256: 'hash',
    declares18of18: true, containsPartialClaim: false, keywordCoverage: keywords })
  const receipt = { verdict: 'accept', ownerRunId: 'run', workflowCloseoutSealDigest: 'seal' }
  return { dir, report: {
    ok: true,
    live: { ok: true },
    paths: { profilePath: profile, databasePath: database },
    handshake: { ok: true, nonce: 'nonce', manifestDigest: 'manifest', profilePath: profile,
      databasePath: database, metricsPath: metrics },
    profilePolicy: { dailyProfileReads: 0, dailyProfileWrites: 0,
      seedDatabaseShaBefore: 'seed', seedDatabaseShaAfter: 'seed' },
    provider: { provider: 'openai-compatible', baseUrl: 'https://novacode/v1' },
    prompt: { keywordCount: 18, keywords },
    finalRunId: 'run',
    projection: { status: 'completed', waiting_for: 'none', blocked_reason: null },
    browserChild: { status: 'completed', progress_completed: 18, progress_total: 18,
      finished_at: '2026-07-23T00:00:00.000Z' },
    runMeta: { status: 'done' },
    canonicalRows: [{ id: 'assistant:run', meta_json: JSON.stringify({ completionVerifierReceipt: receipt }) }],
    doneEvent: { canonicalMessageId: 'assistant:run', canonicalMessageDigest: 'digest' },
    visibleMessages: [{ id: 'assistant:run' }],
    artifacts: [artifact('/tmp/research.md'), artifact('/tmp/selection.md')],
    metrics: { sourcePath: metrics, counts: { owner_local_runner_session_rebased: 0,
      owner_local_session_source_cursor_mismatch: 0, renderer_done_without_canonical_terminal: 0,
      renderer_send_success_without_canonical_terminal: 0 }, runClose: [{ runId: 'run' }] },
  } }
}

function validate(value) {
  const reportPath = join(value.dir, 'report.json')
  writeFileSync(reportPath, JSON.stringify(value.report))
  return spawnSync(process.execPath, [validator, reportPath], { cwd: root, encoding: 'utf8' })
}

test('XHS validator accepts a complete 18-keyword report', () => {
  assert.equal(validate(fixture()).status, 0)
})

test('XHS validator rejects incomplete Browser child progress', () => {
  const value = fixture(); value.report.browserChild.progress_completed = 17
  assert.notEqual(validate(value).status, 0)
})

test('XHS validator rejects target-run integrity metrics', () => {
  const value = fixture(); value.report.metrics.counts.owner_local_session_source_cursor_mismatch = 1
  assert.notEqual(validate(value).status, 0)
})
