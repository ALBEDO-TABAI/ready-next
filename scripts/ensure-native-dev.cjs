#!/usr/bin/env node

const { spawnSync } = require('node:child_process')

function run(args) {
  const cli = process.env.npm_execpath
  return spawnSync(cli ? process.execPath : 'npm', cli ? [cli, ...args] : args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: !cli && process.platform === 'win32',
  })
}

const check = run(['run', 'native:check'])
if (check.status === 0) {
  process.exit(0)
}

console.warn('[native:dev] native check failed; rebuilding Electron native dependencies once...')
const rebuild = run(['run', 'rebuild:native'])
if (rebuild.status !== 0) {
  process.exit(rebuild.status || 1)
}

const verify = run(['run', 'native:check'])
process.exit(verify.status || 0)
