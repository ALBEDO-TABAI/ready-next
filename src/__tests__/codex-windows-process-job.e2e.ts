import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { createCodexProcessPorts } from '../main/modules/agent-control/codex-runtime/codex-process-platform'

test('Windows binds only its own tree and removes descendants when the Agent crashes', {
  skip: process.platform !== 'win32', timeout: 20_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'Ready 工作目录 '))
  const children: ChildProcess[] = []
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const closed = once(child, 'close')
      child.kill()
      await closed
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 8 })
  })
  const executable = join(dir, 'codex.exe')
  // The controlled child can report its own environment. It uses the same launcher as the real Codex E2E.
  copyFileSync(process.execPath, executable)
  copyFileSync(resolve('build/codex/x86_64-pc-windows-msvc/ready-codex-job.exe'), join(dir, 'ready-codex-job.exe'))
  const { inspector, spawnPort } = createCodexProcessPorts(executable, resolve('.'))
  const [main] = await inspector.list()
  assert.equal(main.pid, process.pid)
  assert.equal(main.executablePath, realpathSync.native(process.execPath))
  assert.match(main.processStartIdentity, /^\d+:\d+$/)
  const lease = {
    processLeaseId: randomUUID(), sidecarSpawnInstanceId: randomUUID(), connectionEpoch: randomUUID(),
    isolatedStateDir: dir, ownerMainPid: process.pid, executablePath: executable, processGroupId: null,
  }
  const priorCanary = process.env.READY_E2_HOST_SECRET_CANARY
  process.env.READY_E2_HOST_SECRET_CANARY = 'must-stay-in-parent'
  t.after(() => {
    if (priorCanary === undefined) delete process.env.READY_E2_HOST_SECRET_CANARY
    else process.env.READY_E2_HOST_SECRET_CANARY = priorCanary
  })
  const foreign = spawn(executable, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  children.push(foreign)
  const fixture = [
    "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'],",
    "{ stdio: 'ignore', windowsHide: true });",
    'console.log(JSON.stringify({ pid: process.pid, grandchild: child.pid, state: process.env.READY_CODEX_STATE_DIR,',
    "canary: 'READY_E2_HOST_SECRET_CANARY' in process.env }));",
  ].join('\n')
  const { process: launcher, pid: launcherPid } = spawnPort.spawn({
    executablePath: executable, argv: ['-e', fixture], cwd: dir, env: {
      READY_CODEX_PROCESS_LEASE_ID: lease.processLeaseId, READY_CODEX_SIDECAR_SPAWN_INSTANCE_ID: lease.sidecarSpawnInstanceId,
      READY_CODEX_CONNECTION_EPOCH: lease.connectionEpoch, READY_CODEX_STATE_DIR: dir,
    },
  })
  const closed = once(launcher, 'close')
  children.push(launcher)
  const lines = createInterface({ input: launcher.stdout })
  const first = await lines[Symbol.asyncIterator]().next()
  lines.close()
  assert.ok(!first.done, 'the child reported its own process identity')
  const observed = JSON.parse(first.value)
  assert.equal(observed.canary, false)
  assert.equal(observed.state, dir)
  const rows = await inspector.list(lease)
  const root = rows.find((row) => row.pid === observed.pid)
  assert.ok(root?.executableSha256)
  assert.equal(root.parentPid, launcherPid)
  assert.equal(root.processGroupId, launcherPid)
  assert.equal(rows.find((row) => row.pid === observed.grandchild)?.processGroupId, launcherPid)
  assert.equal(rows.some((row) => row.pid === foreign.pid), false)
  for (const key of ['processLeaseId', 'sidecarSpawnInstanceId', 'connectionEpoch', 'isolatedStateDir'] as const) {
    const wrongLease = { ...lease, [key]: lease[key] + '-other' }
    assert.deepEqual((await inspector.list(wrongLease)).map((row) => row.pid), [process.pid])
    await inspector.terminateOwnedJob!(wrongLease)
  }
  process.kill(root.pid)
  await closed
  assert.deepEqual((await inspector.list(lease)).map((row) => row.pid), [process.pid])
  assert.throws(() => process.kill(observed.grandchild, 0), { code: 'ESRCH' })
  assert.ok(foreign.pid && process.kill(foreign.pid, 0))
  appendFileSync(join(dir, 'ready-codex-job.exe'), 'changed')
  assert.throws(() => spawnPort.spawn({ executablePath: executable, argv: [], cwd: dir, env: {} }), /windows_job_digest_mismatch/)
})
