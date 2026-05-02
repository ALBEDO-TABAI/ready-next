#!/usr/bin/env node

const { spawnSync } = require('node:child_process')

function fail(message, error) {
  console.error(`[native:check] ${message}`)
  if (error) console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
}

function runSqliteProbe() {
  if (!process.versions.electron) {
    fail('This check must run under the Electron runtime, not host Node.')
  }

  let db = null
  try {
    const mod = require('better-sqlite3')
    const Sqlite = mod.default || mod
    db = new Sqlite(':memory:')
    const row = db.prepare('SELECT 1 AS ok').get()
    if (!row || row.ok !== 1) {
      fail(`SQLite smoke query returned ${JSON.stringify(row)}`)
    }
    db.pragma('user_version', { simple: true })
    console.log(
      `[native:check] OK Electron ${process.versions.electron} Node ${process.versions.node} ABI ${process.versions.modules}`,
    )
  } catch (error) {
    fail(`better-sqlite3 failed under Electron ABI ${process.versions.modules || 'unknown'}`, error)
  } finally {
    try { if (db) db.close() } catch { /* ignore cleanup */ }
  }
}

function runElectronChild() {
  let electronBinary
  try {
    electronBinary = require('electron')
  } catch (error) {
    fail('Cannot resolve the electron binary from node_modules.', error)
  }

  const result = spawnSync(electronBinary, [__filename], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      READY_NATIVE_CHECK_CHILD: '1',
    },
    stdio: 'inherit',
  })

  if (result.error) {
    fail('Failed to launch Electron for native check.', result.error)
  }
  process.exit(result.status == null ? 1 : result.status)
}

if (process.env.READY_NATIVE_CHECK_CHILD === '1') {
  runSqliteProbe()
} else {
  runElectronChild()
}
