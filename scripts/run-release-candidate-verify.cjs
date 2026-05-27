#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const RELEASE_CANDIDATE_COMMANDS = [
  { label: 'verify:release-live-evidence', cmd: npmBin, args: ['run', 'verify:release-live-evidence'] },
  { label: 'verify:release-stage-z-readiness', cmd: npmBin, args: ['run', 'verify:release-stage-z-readiness'] },
  { label: 'verify:native', cmd: npmBin, args: ['run', 'verify:native'] },
  { label: 'typecheck', cmd: npmBin, args: ['run', 'typecheck'] },
  { label: 'lint:check', cmd: npmBin, args: ['run', 'lint:check'] },
  { label: 'verify:lint-budget', cmd: npmBin, args: ['run', 'verify:lint-budget'] },
  { label: 'check-eslint-baseline', cmd: process.execPath, args: ['scripts/check-eslint-baseline.cjs'] },
  { label: 'verify:ipc-contract', cmd: npmBin, args: ['run', 'verify:ipc-contract'] },
  { label: 'verify:meta-paths', cmd: npmBin, args: ['run', 'verify:meta-paths'] },
  { label: 'verify:stage-x-known-regressions', cmd: npmBin, args: ['run', 'verify:stage-x-known-regressions'] },
  { label: 'verify:stage-y-known-regressions', cmd: npmBin, args: ['run', 'verify:stage-y-known-regressions'] },
  { label: 'verify:stage-y-p0-ledger', cmd: npmBin, args: ['run', 'verify:stage-y-p0-ledger'] },
  { label: 'verify:stage-y-dogfood-evidence', cmd: npmBin, args: ['run', 'verify:stage-y-dogfood-evidence'] },
  { label: 'verify:agent-acceptance-checklist', cmd: npmBin, args: ['run', 'verify:agent-acceptance-checklist'] },
  { label: 'test', cmd: npmBin, args: ['run', 'test'] },
  { label: 'build', cmd: npmBin, args: ['run', 'build'] },
]

function runCommandSequence(commands, runner = spawnSync) {
  const failures = []
  let exitCode = 0

  for (const command of commands) {
    console.log(`\n[release-candidate] ${command.label}`)
    const result = runner(command.cmd, command.args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      encoding: 'utf8',
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

function main() {
  return runCommandSequence(RELEASE_CANDIDATE_COMMANDS)
}

if (require.main === module) {
  process.exit(main())
}

module.exports = {
  RELEASE_CANDIDATE_COMMANDS,
  runCommandSequence,
}
