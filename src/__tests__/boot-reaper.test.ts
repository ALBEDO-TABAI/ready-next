/**
 * Boot-time orphan reaper tests. We import the pure `reapOrphansCore` (not
 * `reapOrphans`) to avoid pulling in `electron` from the test process.
 *
 * The core takes injectable seams for execFileSync, currentPid, platform, kill
 * and logger so we can simulate pgrep + ps output deterministically.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { reapOrphansCore } from '../main/modules/process-cleanup/boot-reaper-core'

interface ExecCall { file: string; args: readonly string[] }

function makeExec(plan: {
  pgrep?: Record<string, string | { error: Error }>
  ps?: Record<string, string | { error: Error }>
}) {
  const calls: ExecCall[] = []
  const exec = (file: string, args: readonly string[] = []): string => {
    calls.push({ file, args: [...args] })
    if (file === 'pgrep') {
      const pattern = args[1] // -f <pattern>
      const planEntry = plan.pgrep?.[pattern ?? '']
      if (planEntry === undefined) {
        // Default: no matches, simulate exit code 1.
        const err = new Error('Command failed: pgrep') as Error & { status?: number }
        err.status = 1
        throw err
      }
      if (typeof planEntry === 'object' && 'error' in planEntry) throw planEntry.error
      return planEntry as string
    }
    if (file === 'ps') {
      const pid = args[1] // -p <pid>
      const planEntry = plan.ps?.[pid ?? '']
      if (planEntry === undefined) throw new Error(`ps: no plan for pid=${pid}`)
      if (typeof planEntry === 'object' && 'error' in planEntry) throw planEntry.error
      return planEntry as string
    }
    throw new Error(`unexpected exec: ${file}`)
  }
  return { exec: exec as unknown as typeof import('node:child_process').execFileSync, calls }
}

const PUPPETEER_CACHE = '/Users/test/Library/Application Support/ready/puppeteer-cache'

test('skips on win32', () => {
  const { exec, calls } = makeExec({})
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'win32',
    currentPid: 12345,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  assert.equal(result.skipped, 'unsupported_platform')
  assert.deepEqual(result.reaped, [])
  assert.deepEqual(result.errors, [])
  assert.equal(calls.length, 0, 'no exec calls on unsupported platform')
  assert.equal(killed.length, 0)
})

test('returns empty when pgrep finds nothing for any pattern', () => {
  const { exec } = makeExec({}) // no pgrep entries → exit 1 default
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 12345,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  assert.deepEqual(result.reaped, [])
  assert.deepEqual(result.errors, [])
  assert.equal(killed.length, 0)
})

test('only kills processes whose ppid is 1 (truly orphaned)', () => {
  const { exec } = makeExec({
    pgrep: {
      'ready_sidecar/main.py': '1001\n1002\n1003\n',
    },
    ps: {
      '1001': '1\n',     // orphaned → kill
      '1002': '99999\n', // parent alive → skip
      '1003': '1\n',     // orphaned → kill
    },
  })
  const killed: Array<{ pid: number; signal: NodeJS.Signals | number }> = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 555,
    killProcess: (pid, signal) => killed.push({ pid, signal }),
    logger: () => {},
  })
  assert.deepEqual(killed, [
    { pid: 1001, signal: 'SIGKILL' },
    { pid: 1003, signal: 'SIGKILL' },
  ])
  assert.deepEqual(result.reaped, [
    { pid: 1001, pattern: 'ready_sidecar' },
    { pid: 1003, pattern: 'ready_sidecar' },
  ])
  assert.deepEqual(result.errors, [])
})

test('skips self pid even when pgrep matches it', () => {
  const myPid = 4242
  const { exec } = makeExec({
    pgrep: {
      'rsshub-worker.mjs': `${myPid}\n7777\n`,
    },
    ps: {
      // ps for myPid should NOT be called; if it is, we error.
      '7777': '1\n',
    },
  })
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: myPid,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  assert.deepEqual(killed, [7777])
  assert.deepEqual(result.reaped, [{ pid: 7777, pattern: 'rsshub_worker' }])
})

test('uses the puppeteerCachePath in the chrome pattern', () => {
  const cachePath = '/custom/cache/puppeteer-cache'
  const { exec, calls } = makeExec({
    pgrep: {
      [`${cachePath}/chrome`]: '8001\n',
    },
    ps: {
      '8001': '1\n',
    },
  })
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: cachePath,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 1,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  assert.deepEqual(killed, [8001])
  assert.deepEqual(result.reaped, [{ pid: 8001, pattern: 'puppeteer_chrome' }])
  // Verify the chrome pgrep call used the custom path
  const chromePgrep = calls.find((c) => c.file === 'pgrep' && c.args[1]?.includes('puppeteer-cache/chrome'))
  assert.ok(chromePgrep, 'expected pgrep called with custom puppeteer-cache path')
  assert.equal(chromePgrep!.args[1], `${cachePath}/chrome`)
})

test('kill failures land in errors but do not abort other patterns', () => {
  const { exec } = makeExec({
    pgrep: {
      'ready_sidecar/main.py': '1001\n',
      'rsshub-worker.mjs': '2002\n',
    },
    ps: {
      '1001': '1\n',
      '2002': '1\n',
    },
  })
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 1,
    killProcess: (pid) => {
      if (pid === 1001) throw new Error('EPERM')
      killed.push(pid)
    },
    logger: () => {},
  })
  assert.deepEqual(killed, [2002])
  assert.deepEqual(result.reaped, [{ pid: 2002, pattern: 'rsshub_worker' }])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /kill 1001 \(ready_sidecar\): EPERM/)
})

test('non-finite ppid is skipped', () => {
  const { exec } = makeExec({
    pgrep: {
      'ready_sidecar/main.py': '1001\n',
    },
    ps: {
      '1001': 'not-a-number\n',
    },
  })
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 1,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  assert.deepEqual(killed, [])
  assert.deepEqual(result.reaped, [])
})

test('pgrep unexpected error (non-exit-1) lands in errors', () => {
  const oddErr = new Error('pgrep: unexpected disaster') as Error & { status?: number }
  oddErr.status = 127 // command not found
  const { exec } = makeExec({
    pgrep: {
      'ready_sidecar/main.py': { error: oddErr },
      'rsshub-worker.mjs': '3001\n',
    },
    ps: {
      '3001': '1\n',
    },
  })
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 1,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  // sidecar pattern errored, but rsshub still ran and reaped 3001
  assert.deepEqual(killed, [3001])
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /pgrep ready_sidecar\/main\.py:/)
})

test('ps failure (process died between pgrep and ps) is silently skipped', () => {
  const { exec } = makeExec({
    pgrep: {
      'ready_sidecar/main.py': '1001\n2002\n',
    },
    ps: {
      '1001': { error: new Error('ps: no such process') },
      '2002': '1\n',
    },
  })
  const killed: number[] = []
  const result = reapOrphansCore({
    puppeteerCachePath: PUPPETEER_CACHE,
    execFileSync: exec,
    platform: 'darwin',
    currentPid: 1,
    killProcess: (pid) => killed.push(pid),
    logger: () => {},
  })
  assert.deepEqual(killed, [2002])
  assert.deepEqual(result.reaped, [{ pid: 2002, pattern: 'ready_sidecar' }])
  assert.deepEqual(result.errors, [])
})
