const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')

function runValidator(report) {
  const dir = mkdtempSync(join(tmpdir(), 'ready-provider-report-validator-'))
  const path = join(dir, 'report.json')
  writeFileSync(path, JSON.stringify(report))
  return spawnSync(process.execPath, [
    'scripts/check-provider-confirmation-live-proof-report.cjs',
    path,
  ], { cwd: process.cwd(), encoding: 'utf8' })
}

function otherwisePassingReport() {
  return {
    ok: true,
    handshake: {
      ok: true,
      nonce: 'nonce',
      executablePath: '/tmp/Ready.app/Contents/MacOS/Ready',
      executableSha256: 'exec-sha',
      asarPath: '/tmp/Ready.app/Contents/Resources/app.asar',
      asarSha256: 'asar-sha',
      manifestDigest: 'manifest',
      profilePath: '/tmp/profile',
      databasePath: '/tmp/profile/ready.db',
      metricsPath: '/tmp/process/ready-agent-metrics.log',
      metricsFilePresent: true,
    },
    scopeId: 'scope-live',
    runId: 'run-live',
    taskId: 'task-live',
    sendResult: { success: true },
    canonical: { id: 'assistant:task-live:run-live:checkpoint:cp', digest: 'digest' },
    visibleMessages: [{ id: 'assistant:task-live:run-live:checkpoint:cp', digest: 'digest' }],
    confirmationCard: { requestId: 'request-live', buttons: ['allow', 'deny'], target: 'tab-live' },
    decisions: { allow: { accepted: true }, deny: { accepted: true } },
    metrics: {
      runId: 'run-live',
      sourcePath: '/tmp/process/ready-agent-metrics.log',
      renderer_done_without_canonical_terminal: 0,
      renderer_send_success_without_canonical_terminal: 0,
    },
    restart: {
      handshake: { ok: true, nonce: 'restart-nonce', profilePath: '/tmp/profile' },
      expired: true,
      pendingRequestCleared: true,
      oldButtonUnableToRelease: true,
    },
    live: { ok: true },
  }
}

test('report validator rejects live.ok=false even when summary checks look green', () => {
  const report = otherwisePassingReport()
  report.live.ok = false
  const result = runValidator(report)
  assert.notEqual(result.status, 0, `validator accepted false live proof: ${result.stdout}`)
})

test('report validator rejects empty visible messages and missing handshake', () => {
  const emptyMessages = otherwisePassingReport()
  emptyMessages.visibleMessages = []
  assert.notEqual(runValidator(emptyMessages).status, 0)

  const missingHandshake = otherwisePassingReport()
  delete missingHandshake.handshake
  assert.notEqual(runValidator(missingHandshake).status, 0)
})

test('report validator rejects missing metric file identity and incomplete DOM proof', () => {
  const missingMetrics = otherwisePassingReport()
  missingMetrics.handshake.metricsFilePresent = false
  assert.notEqual(runValidator(missingMetrics).status, 0)

  const missingDeny = otherwisePassingReport()
  missingDeny.confirmationCard.buttons = ['allow']
  assert.notEqual(runValidator(missingDeny).status, 0)
})

test('report validator requires an observed or successful send result', () => {
  const missingSend = otherwisePassingReport()
  missingSend.sendResult = null
  assert.notEqual(runValidator(missingSend).status, 0)

  const unobservedSend = otherwisePassingReport()
  unobservedSend.sendResult = { success: false }
  assert.notEqual(runValidator(unobservedSend).status, 0)
})

test('report validator rejects stale restart identity and unproven old-button invalidation', () => {
  const staleBoot = otherwisePassingReport()
  staleBoot.restart.handshake.nonce = staleBoot.handshake.nonce
  assert.notEqual(runValidator(staleBoot).status, 0)

  const oldButtonStillWorks = otherwisePassingReport()
  oldButtonStillWorks.restart.oldButtonUnableToRelease = false
  assert.notEqual(runValidator(oldButtonStillWorks).status, 0)
})
