import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import test from 'node:test'

test('pinned app-server returns content-free process diagnostics', { timeout: 20_000 }, async () => {
  const sourceLock = JSON.parse(readFileSync(
    join(process.cwd(), 'assets/codex-runtime/source-lock.json'),
    'utf8',
  )) as { targetTriple: string; codexVersion: string }
  assert.equal(sourceLock.codexVersion, '0.160.1')
  const binary = join(process.cwd(), 'build/codex', sourceLock.targetTriple, 'codex.exe')
  assert.equal(existsSync(binary), true)

  const root = mkdtempSync(join(tmpdir(), 'ready-codex-diagnostics-'))
  const home = join(root, 'home')
  const codexHome = join(root, 'codex-home')
  const stateDir = join(root, 'state')
  for (const directory of [home, codexHome, stateDir]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(join(codexHome, 'config.toml'), [
    'check_for_update_on_startup = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[features]',
    'goals = false',
    '',
  ].join('\n'))

  const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
    cwd: stateDir,
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: root,
      HOME: home,
      CODEX_HOME: codexHome,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const stderr: string[] = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const frame = JSON.parse(line) as {
      id?: number
      result?: unknown
      error?: unknown
    }
    if (typeof frame.id !== 'number') return
    const waiter = pending.get(frame.id)
    if (!waiter) return
    pending.delete(frame.id)
    if (frame.error) waiter.reject(new Error(JSON.stringify(frame.error)))
    else waiter.resolve(frame.result)
  })
  let rpcId = 0
  const request = (method: string, params: unknown): Promise<unknown> => {
    rpcId += 1
    return new Promise((resolve, reject) => {
      pending.set(rpcId, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ method, id: rpcId, params })}\n`)
    })
  }

  try {
    await request('initialize', {
      clientInfo: {
        name: 'ready_codex_diagnostics_test',
        title: 'Ready Codex Diagnostics Test',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const diagnostics = await request('server/diagnostics', {}) as {
      process: {
        id: number
        residentMemoryBytes?: number | null
        physicalFootprintBytes?: number | null
      }
      gauges: Array<{ name: string; value: number }>
    }
    assert.equal(diagnostics.process.id, child.pid)
    assert.ok(Number(diagnostics.process.residentMemoryBytes) > 0)
    if (process.platform !== 'win32' || diagnostics.process.physicalFootprintBytes != null) {
      assert.ok(Number(diagnostics.process.physicalFootprintBytes) > 0)
    }
    assert.ok(Array.isArray(diagnostics.gauges))
    for (const gauge of diagnostics.gauges) {
      assert.deepEqual(Object.keys(gauge).sort(), ['name', 'value'])
      assert.equal(typeof gauge.name, 'string')
      assert.ok(Number.isSafeInteger(gauge.value) && gauge.value >= 0)
    }
    assert.deepEqual(Object.keys(diagnostics).sort(), ['gauges', 'process'])
    assert.deepEqual(Object.keys(diagnostics.process).sort(), [
      'id', ...('physicalFootprintBytes' in diagnostics.process ? ['physicalFootprintBytes'] : []), 'residentMemoryBytes',
    ])
  } finally {
    lines.close()
    child.kill('SIGTERM')
    await exit
    for (const waiter of pending.values()) {
      waiter.reject(new Error(`app_server_exited:${stderr.join('')}`))
    }
    pending.clear()
    rmSync(root, { recursive: true, force: true })
  }
})
