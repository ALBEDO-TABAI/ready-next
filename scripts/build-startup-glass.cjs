#!/usr/bin/env node
// Builds the startup splash's native glass layer (native/startup-glass → build/Release/ready_glass.node) for the
// installed Electron, on macOS only; elsewhere it does nothing and the splash draws its own glass (plan
// docs/superpowers/plans/2026-11-19-ready-next-startup-splash-implementation.md §6 W5). `--optional`: a failed build
// only warns (postinstall must not fail an install over the splash); without it the failure stops the caller (build).
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const optional = process.argv.includes('--optional')
if (process.platform !== 'darwin') {
  console.log('[startup-glass] skipped: the native glass is macOS only')
  process.exit(0)
}
try {
  const electron = require('electron/package.json').version
  execFileSync(process.execPath, [
    require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild',
    `--target=${electron}`, `--arch=${process.arch}`, '--loglevel=error', '--dist-url=https://electronjs.org/headers', `--devdir=${path.join(os.homedir(), '.electron-gyp')}`,
  ], { cwd: path.join(__dirname, '..', 'native', 'startup-glass'), stdio: ['ignore', 'ignore', 'inherit'] })
  console.log(`[startup-glass] built for Electron ${electron} (${process.arch})`)
} catch (error) {
  const message = `[startup-glass] build failed: ${error instanceof Error ? error.message : String(error)}`
  if (!optional) { console.error(message); process.exit(1) }
  console.warn(`${message}\n[startup-glass] the splash falls back to its drawn glass until \`npm run rebuild:native\` succeeds`)
}
