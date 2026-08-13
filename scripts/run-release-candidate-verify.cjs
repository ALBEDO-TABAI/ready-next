#!/usr/bin/env node
'use strict'

const RELEASE_CANDIDATE_COMMANDS = [
  { label: 'verify:release-structural-receipt', cmd: process.execPath, args: ['scripts/verify-release-structural-package.cjs', '--existing'] },
  { label: 'verify:release-live-evidence', cmd: process.execPath, args: ['scripts/check-release-live-evidence.cjs'] },
  { label: 'verify:release-stage-z-readiness', cmd: process.execPath, args: ['scripts/check-release-stage-z-readiness.cjs'] },
]

function runCommandSequence(commands, runner = require('node:child_process').spawnSync) {
  const failures = []
  let exitCode = 0

  for (const command of commands) {
    console.log(`\n[release-candidate] ${command.label}`)
    const result = runner(command.cmd, command.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      encoding: 'utf8',
      env: {
        HOME: process.env.HOME,
        LANG: process.env.LANG || 'C.UTF-8',
        LC_ALL: process.env.LC_ALL || 'C.UTF-8',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        TMPDIR: process.env.TMPDIR,
      },
    })
    if (result.error) {
      console.error(`[release-candidate] ${command.label} failed to start: ${result.error.message}`)
      failures.push({ label: command.label, exit: 1, reason: result.error.message })
      if (exitCode === 0) exitCode = 1
      continue
    }
    if (result.status !== 0 || result.signal) {
      const exit = typeof result.status === 'number' && result.status !== 0 ? result.status : 1
      const reason = result.signal ? `signal ${result.signal}` : `exit ${result.status}`
      console.error(`[release-candidate] ${command.label} failed with ${reason}`)
      failures.push({ label: command.label, exit, reason })
      if (exitCode === 0) exitCode = exit
    }
  }

  if (failures.length > 0) {
    console.error('\n[release-candidate] completed with failures:')
    for (const failure of failures) {
      console.error(`  - ${failure.label}: ${failure.reason}`)
    }
  }

  return exitCode
}

function runCandidateSequence(commands, {
  runner = require('node:child_process').spawnSync,
  identity = () => require('./release-package-identity.cjs').loadVerifiedStructuralReceipt(process.cwd()),
} = {}) {
  const before = identity()
  if (!before.ok) return 1
  const exit = runCommandSequence(commands, runner)
  if (exit !== 0) return exit
  const after = identity()
  if (!after.ok
    || before.receipt.receiptId !== after.receipt.receiptId
    || before.receipt.artifact.sha256 !== after.receipt.artifact.sha256
    || before.receipt.source.digest !== after.receipt.source.digest) {
    console.error('[release-candidate] package identity changed during candidate verification')
    return 1
  }
  return 0
}

function main() {
  return runCandidateSequence(RELEASE_CANDIDATE_COMMANDS)
}

if (require.main === module) {
  process.exit(main())
}

module.exports = {
  RELEASE_CANDIDATE_COMMANDS,
  runCandidateSequence,
  runCommandSequence,
}
