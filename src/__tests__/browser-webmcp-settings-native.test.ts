import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { configureWebMcpExperiment, readWebMcpStartupSetting, webMcpExperimentStatus } from '../main/modules/browser-engine/webmcp-experiment'
import { createGenericSettingIPCHandler } from '../main/modules/settings-engine/generic-setting-ipc-handler'
import { WEBMCP_SETTING_KEY, WEBMCP_STATUS_KEY } from '../shared/browser-webmcp'

test('WebMCP setting persists through existing writer and startup reads it without changing the database', (t) => {
  if (skipIfSqliteUnavailable(t, 'WebMCP startup setting')) return
  const dir = mkdtempSync(join(tmpdir(), 'wm-'))
  const path = join(dir, 'ready.db')
  try {
    assert.equal(readWebMcpStartupSetting(path), false)
    const db = new Database(path)
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    const writer = createGenericSettingIPCHandler({ repository: { setSetting: (key, value) => { db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, value) } } })
    assert.equal(readWebMcpStartupSetting(path), false)
    assert.equal(writer(null, { key: WEBMCP_SETTING_KEY, value: 'yes' }).success, false)
    assert.equal(writer(null, { key: WEBMCP_STATUS_KEY, value: 'true' }).success, false)
    assert.equal(writer(null, { key: WEBMCP_SETTING_KEY, value: 'true' }).success, true)
    const flags = new Map<string, string>([['enable-blink-features', 'Other']])
    const commandLine = { getSwitchValue: (name: string) => flags.get(name) || '', appendSwitch: (name: string, value: string) => { flags.set(name, value) } }
    configureWebMcpExperiment(readWebMcpStartupSetting(path), commandLine)
    assert.equal(flags.get('enable-blink-features'), 'Other,WebMCP')
    assert.deepEqual(webMcpExperimentStatus('false'), { enabled: false, active: true, restartRequired: true })
    assert.deepEqual(webMcpExperimentStatus('true'), { enabled: true, active: true, restartRequired: false })
    writer(null, { key: WEBMCP_SETTING_KEY, value: 'false' })
    configureWebMcpExperiment(readWebMcpStartupSetting(path), commandLine)
    assert.equal(flags.get('enable-blink-features'), 'Other')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 1)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
