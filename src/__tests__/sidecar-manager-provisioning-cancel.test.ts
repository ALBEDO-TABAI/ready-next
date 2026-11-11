import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test, { type TestContext } from 'node:test'
import { buildSync } from 'esbuild'
import type { ExecFileOptions } from 'node:child_process'
import type { SidecarManager } from '../main/modules/agent-control/sidecar-manager'
import { RuntimeStartupSlot } from '../main/modules/claude-bridge/runtime-startup-slot'

// Bundle the real manager, replacing only OS/process/HTTP boundaries. No Python or sockets run.
const compiled = buildSync({
  entryPoints: ['src/main/modules/agent-control/sidecar-manager.ts'],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
}).outputFiles[0].text
const requireFromHere = createRequire(import.meta.url)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function within<T>(promise: Promise<T>): Promise<T> {
  const expired = deferred<never>()
  const deadline = setTimeout(() => expired.reject(new Error('did not settle within 2 seconds')), 2_000)
  try { return await Promise.race([promise, expired.promise]) } finally { clearTimeout(deadline) }
}

type Stage = 'version' | 'ssl' | 'venv' | 'bootstrap' | 'install' | 'modules' | 'port' | 'health' | null

function fixture(t: TestContext, blocked: Stage = null) {
  const root = mkdtempSync(join(tmpdir(), 'ready-sidecar-cancel-'))
  const runtime = join(root, 'agent-sidecar-runtime')
  const venv = join(runtime, 'python')
  const python = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  const state = join(runtime, '.install-state.json')
  const pkg = join(root, 'src', 'python', 'ready_sidecar')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'requirements.txt'), 'fake-dependency==1\n')
  const reached = deferred<void>()
  const lateHealth = deferred<Response>()
  const calls: Stage[] = []
  let aborts = 0
  let closed = 0
  let spawns = 0
  let kills = 0
  let portClosed = false
  let manager: SidecarManager
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill() { kills += 1; queueMicrotask(() => child.emit('exit', 0)); return true },
  })
  function makePython() { mkdirSync(dirname(python), { recursive: true }); writeFileSync(python, 'fixture') }
  const exec = (_file: string, args: string[], options: ExecFileOptions) => {
    const stage: Stage = args.includes('venv') ? 'venv' : args.includes('--upgrade') ? 'bootstrap'
      : args.includes('-r') ? 'install' : args.includes('--version') ? 'version'
        : args[1]?.includes('import ssl') ? 'ssl' : 'modules'
    calls.push(stage)
    if (stage === 'venv') makePython()
    const result = deferred<{ stdout: string; stderr: string }>()
    const proc = new EventEmitter()
    if (stage === blocked) {
      reached.resolve()
      options.signal?.addEventListener('abort', () => {
        aborts += 1
        assert.equal(options.killSignal, 'SIGKILL')
        result.reject(options.signal?.reason)
        // execFile rejects on abort before close. Cleanup must wait for close.
        setTimeout(() => { closed += 1; proc.emit('close') }, 20)
      }, { once: true })
    } else {
      queueMicrotask(() => {
        result.resolve({ stdout: stage === 'version' ? 'Python 3.12.1' : stage === 'ssl' ? 'OpenSSL 3.0.0' : '', stderr: '' })
        proc.emit('close')
      })
    }
    return Object.assign(result.promise, { child: proc })
  }
  const execFile = Object.assign(() => assert.fail('only promisified exec is expected'), { [promisify.custom]: exec })
  const modules = {
    electron: { app: { isPackaged: false, getPath: () => root, getAppPath: () => root, getVersion: () => 'test' } },
    child_process: { execFile, spawn: () => { spawns += 1; return child } },
    net: { createServer: () => {
      const server = Object.assign(new EventEmitter(), {
        listen(options: { signal: AbortSignal }, callback: () => void) {
          options.signal?.addEventListener('abort', () => { portClosed = true }, { once: true })
          if (blocked === 'port') reached.resolve()
          else queueMicrotask(callback)
        },
        address: () => ({ port: 54321 }),
        close(callback: () => void) { portClosed = true; callback() },
      })
      return server
    } },
  }
  const fakeFetch = async (_url: string, options: RequestInit) => {
    if (blocked === 'health') {
      reached.resolve()
      return new Promise<Response>((resolve, reject) => {
        options.signal?.addEventListener('abort', () => { aborts += 1; reject(options.signal?.reason) }, { once: true })
        void lateHealth.promise.then(resolve, reject)
      })
    }
    return new Response('{}')
  }
  const output: { exports?: { SidecarManager: typeof SidecarManager } } = {}
  const load = (id: string) => Object.hasOwn(modules, id) ? modules[id as keyof typeof modules] : requireFromHere(id)
  new Function('require', 'module', 'exports', 'fetch', compiled)(load, output, {}, fakeFetch)
  assert.ok(output.exports)
  manager = new output.exports.SidecarManager()
  t.after(async () => {
    blocked = null
    await manager.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return {
    manager, reached: reached.promise, calls, venv, state, makePython,
    release: () => { blocked = null },
    block: (stage: Stage) => { blocked = stage },
    lateHealth: () => lateHealth.resolve(new Response('{}')),
    counts: () => ({ aborts, closed, spawns, kills, portClosed }),
  }
}

for (const stage of ['venv', 'bootstrap'] as const) {
  test(`stop cancels ${stage}, drains the child and removes the incomplete venv`, async (t) => {
    const f = fixture(t, stage)
    const start = f.manager.start()
    await within(f.reached)
    assert.equal(existsSync(f.venv), true)
    const [, status] = await within(Promise.all([f.manager.stop(), start]))
    assert.equal(status.state, 'stopped')
    assert.equal(status.error, null)
    assert.deepEqual(f.counts(), { aborts: 1, closed: 1, spawns: 0, kills: 0, portClosed: true })
    assert.equal(f.manager.getStatus().state, 'stopped')
    assert.equal(f.manager.getStatus().error, null)
    assert.equal(existsSync(f.venv), false)
    assert.equal(existsSync(f.state), false)
    f.release()
    assert.equal((await within(f.manager.start())).state, 'running')
    assert.equal(f.calls.filter((call) => call === 'venv').length, 2)
  })
}

test('cancelled requirements install invalidates its receipt and installs again on restart', async (t) => {
  const f = fixture(t, 'install')
  f.makePython()
  writeFileSync(f.state, '{"digest":"old-dependencies"}')
  const start = f.manager.start()
  await within(f.reached)
  await within(Promise.all([f.manager.stop(), start]))
  assert.equal(existsSync(f.state), false)
  assert.equal(existsSync(f.venv), true)
  assert.equal(f.manager.getStatus().state, 'stopped')
  assert.equal(f.counts().aborts, 1)
  f.release()
  assert.equal((await within(f.manager.start())).state, 'running')
  assert.equal(f.calls.filter((call) => call === 'install').length, 2)
  assert.equal(existsSync(f.state), true)
})

for (const stage of ['version', 'ssl', 'modules', 'port'] as const) {
  test(`stop interrupts ${stage} without fallback or a later spawn`, async (t) => {
    const f = fixture(t, stage)
    if (stage === 'modules') {
      // First provision normally so the next startup reaches the installed-module probe.
      f.release()
      await within(f.manager.start())
      await f.manager.stop()
      f.block(stage)
    }
    const start = f.manager.start()
    await within(f.reached)
    const callsBeforeStop = f.calls.length
    await within(Promise.all([f.manager.stop(), start]))
    assert.equal(f.calls.length, callsBeforeStop)
    assert.equal(f.manager.getStatus().state, 'stopped')
    assert.equal(f.manager.getStatus().error, null)
    assert.equal(f.counts().spawns, stage === 'modules' ? 1 : 0)
    assert.equal(f.counts().portClosed, true)
  })
}

test('stop aborts health wait, kills the spawned process and ignores late health success', async (t) => {
  const f = fixture(t, 'health')
  const start = f.manager.start()
  await within(f.reached)
  await within(Promise.all([f.manager.stop(), start]))
  assert.equal(f.counts().aborts, 1)
  assert.equal(f.counts().kills, 1)
  f.lateHealth()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(f.manager.getStatus().state, 'stopped')
  assert.equal(f.manager.getStatus().error, null)
  assert.equal(f.manager.getStatus().lastHeartbeatAt, null)
})

test('normal startup is shared and an installed environment is reused', async (t) => {
  const f = fixture(t)
  const statuses = await within(Promise.all([f.manager.start(), f.manager.start()]))
  assert.ok(statuses.every((status) => status.state === 'running'))
  assert.equal(f.counts().spawns, 1)
  assert.equal(existsSync(f.state), true)
  await f.manager.stop()
  assert.equal((await within(f.manager.start())).state, 'running')
  assert.equal(f.calls.filter((call) => call === 'install').length, 1)
})

test('RuntimeStartupSlot drains a real manager cancelled during provisioning', async (t) => {
  const f = fixture(t, 'venv')
  const slot = new RuntimeStartupSlot({
    async start() { await f.manager.start() },
    async stop() { await f.manager.stop() },
  })
  const promotion = assert.rejects(slot.promote(), /agent_runtime_start_cancelled/)
  await within(f.reached)
  await within(slot.cancelAndDrain())
  await promotion
  assert.deepEqual(slot.snapshot(), { cancelled: true, settled: true })
  assert.equal(f.manager.getStatus().state, 'stopped')
  assert.equal(f.counts().spawns, 0)
  assert.equal(existsSync(f.venv), false)
})
