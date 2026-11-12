import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { WEBMCP_SETTING_KEY, type WebMcpExperimentStatus } from '../../../shared/browser-webmcp'

let active = false

/** Called once, after the data isolation guard and before app ready. Never migrates or writes. */
export function readWebMcpStartupSetting(databasePath: string): boolean {
  if (!existsSync(databasePath)) return false
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) return false
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(WEBMCP_SETTING_KEY) as { value: string } | undefined
    return row?.value === 'true'
  } finally { db.close() }
}

export function configureWebMcpExperiment(enabled: boolean, commandLine: {
  getSwitchValue(name: string): string
  appendSwitch(name: string, value: string): void
}): void {
  active = enabled
  const features = commandLine.getSwitchValue('enable-blink-features').split(',').filter(value => value && value !== 'WebMCP')
  if (enabled) features.push('WebMCP')
  if (features.length || commandLine.getSwitchValue('enable-blink-features')) {
    commandLine.appendSwitch('enable-blink-features', features.join(','))
  }
}

export function isWebMcpExperimentActive(): boolean { return active }
export function webMcpExperimentStatus(saved: string | undefined): WebMcpExperimentStatus {
  const enabled = saved === 'true'
  return { enabled, active, restartRequired: enabled !== active }
}
