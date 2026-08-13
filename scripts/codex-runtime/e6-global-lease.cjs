'use strict'

const { spawn } = require('node:child_process')
const {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
} = require('node:fs')
const { resolve } = require('node:path')

const E6_AUTHORITY_ROOT = resolve('/tmp', `ready-codex-e6-global-lease-${process.getuid()}`)
const LOCK_PATH = resolve(E6_AUTHORITY_ROOT, 'lease.lock')
const HOLDER_SOURCE = [
  "process.on('SIGINT', () => {})",
  "process.on('SIGTERM', () => {})",
  "process.stdout.write('READY\\n')",
  'process.stdin.resume()',
  'process.stdin.once(\'end\', () => process.exit(0))',
].join(';')

function validateLeaseRoot() {
  const stats = lstatSync(E6_AUTHORITY_ROOT)
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o700) {
    throw new Error('e6_global_lease_root_invalid')
  }
}

function ensureLeaseFile() {
  try {
    mkdirSync(E6_AUTHORITY_ROOT, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  validateLeaseRoot()
  try {
    const descriptor = openSync(LOCK_PATH, 'wx', 0o600)
    closeSync(descriptor)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stats = lstatSync(LOCK_PATH)
  if (!stats.isFile() || stats.isSymbolicLink()
    || stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o600) {
    throw new Error('e6_global_lease_file_invalid')
  }
}

function attemptAcquireE6GlobalLease() {
  return new Promise((resolveLease, rejectLease) => {
    const helper = spawn('/usr/bin/lockf', [
      '-k', '-t', '0', LOCK_PATH,
      process.execPath, '-e', HOLDER_SOURCE,
    ], {
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let settled = false
    let stdout = ''
    let stderr = ''
    const state = { releaseRequested: false }
    let rejectLost = null
    const lost = new Promise((resolveLost, rejectLeaseLost) => {
      void resolveLost
      rejectLost = rejectLeaseLost
    })
    void lost.catch(() => {})
    const reject = (error) => {
      if (settled) {
        if (!state.releaseRequested) rejectLost(error)
        return
      }
      settled = true
      try { helper.stdin.destroy() } catch {}
      rejectLease(error)
    }
    helper.stdout.on('data', (chunk) => {
      if (settled) return
      stdout += String(chunk)
      if (!stdout.split(/\r?\n/).includes('READY')) return
      settled = true
      const lease = { acquired: true, helper, lockPath: LOCK_PATH, lost }
      Object.defineProperty(lease, 'state', { value: state })
      resolveLease(lease)
    })
    helper.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk)
    })
    helper.once('error', reject)
    helper.once('exit', (code, signal) => {
      if (settled) {
        if (!state.releaseRequested) {
          rejectLost(new Error(
            `e6_global_lease_lost:${code ?? 'null'}:${signal ?? 'null'}`,
          ))
        }
        return
      }
      settled = true
      if (code === 75) {
        resolveLease({ acquired: false, code: 'e6_global_lease_busy' })
        return
      }
      rejectLease(new Error(
        `e6_global_lease_helper_failed:${code ?? 'null'}:${signal ?? 'null'}:${stderr.trim()}`,
      ))
    })
  })
}

async function acquireE6GlobalLease() {
  ensureLeaseFile()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const lease = await attemptAcquireE6GlobalLease()
    if (lease.acquired || attempt === 9) return lease
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
  throw new Error('e6_global_lease_acquisition_unreachable')
}

function releaseE6GlobalLease(lease) {
  if (!lease?.acquired) return Promise.resolve()
  const helper = lease.helper
  if (!lease.state) return Promise.reject(new Error('e6_global_lease_release_identity_invalid'))
  lease.state.releaseRequested = true
  if (helper.exitCode !== null || helper.signalCode !== null) {
    return Promise.reject(new Error('e6_global_lease_already_lost'))
  }
  return new Promise((resolveRelease, rejectRelease) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { helper.kill('SIGKILL') } catch {}
      rejectRelease(new Error('e6_global_lease_release_timeout'))
    }, 5_000)
    helper.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0 && signal === null) resolveRelease()
      else rejectRelease(new Error(
        `e6_global_lease_release_failed:${code ?? 'null'}:${signal ?? 'null'}`,
      ))
    })
    helper.stdin.end()
  })
}

module.exports = {
  E6_AUTHORITY_ROOT,
  acquireE6GlobalLease,
  releaseE6GlobalLease,
}
