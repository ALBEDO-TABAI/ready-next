const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { setTimeout: delay } = require('node:timers/promises')

async function waitForReady(log, trigger, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(log)) {
      const lines = fs.readFileSync(log, 'utf8').split('\n')
      for (const line of lines.slice(0, -1)) {
        const event = JSON.parse(line)
        if (event.metric !== 'codex_sidecar_recovery_state' || event.trigger !== trigger) continue
        if (event.state === 'ready') return
        if (event.state === 'blocked' || event.state === 'exhausted') {
          throw new Error('Agent boot failed: ' + event.failureCode)
        }
      }
    }
    await delay(150)
  }
  throw new Error('Agent did not become ready after ' + trigger)
}

async function checkWindowsPackagedRecovery({ userDataDir, appPath, mainPid, timeoutMs }) {
  const log = path.join(userDataDir, 'temp', 'ready-test-logs', 'ready-agent-metrics.log')
  await waitForReady(log, 'initial_start', timeoutMs)
  const db = new DatabaseSync(path.join(userDataDir, 'ready.db'), { readOnly: true })
  try {
    const live = db.prepare('SELECT * FROM codex_sidecar_process_leases WHERE owner_main_pid = ?'
      + ' AND connection_opened_at IS NOT NULL AND closed_at IS NULL AND tree_zero_at IS NULL')
    const first = live.get(mainPid)
    assert.ok(first, 'the test window owns a connected Agent')
    const runtimeRoot = path.join(path.dirname(appPath), 'resources', 'codex-runtime')
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'))
    assert.equal(first.executable_path, path.join(runtimeRoot, manifest.targetTriple, 'codex.exe'))
    assert.equal(first.binary_sha256, manifest.binarySha256)
    // Hold the handle while checking the start time and image so a recycled PID cannot be killed.
    execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById([int]$env:READY_TEST_PID); "
        + '$null=$p.Handle; $identity="{0}:{1}" -f $p.Id,$p.StartTime.ToFileTimeUtc(); '
        + 'if ($identity -ne $env:READY_TEST_START -or $p.MainModule.FileName -ne $env:READY_TEST_IMAGE) '
        + '{ throw "test Agent identity changed" }; $p.Kill()',
    ], {
      windowsHide: true, timeout: 5000,
      env: { ...process.env, READY_TEST_PID: String(first.pid), READY_TEST_START: first.process_start_identity,
        READY_TEST_IMAGE: first.executable_path },
    })
    await waitForReady(log, 'unexpected_close', timeoutMs)
    const next = live.get(mainPid)
    assert.ok(next, 'the same window owns the replacement Agent')
    assert.notEqual(next.process_start_identity, first.process_start_identity)
    assert.notEqual(next.connection_epoch, first.connection_epoch)
    const prior = db.prepare('SELECT closed_at, tree_zero_evidence_digest FROM codex_sidecar_process_leases'
      + ' WHERE process_lease_id = ?').get(first.process_lease_id)
    assert.ok(prior.closed_at && prior.tree_zero_evidence_digest, 'the old process tree was settled')
    return { initialPid: first.pid, recoveredPid: next.pid, previousTreeSettled: true }
  } finally {
    db.close()
  }
}

module.exports = { checkWindowsPackagedRecovery }
