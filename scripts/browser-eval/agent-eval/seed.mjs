// Seeds a throwaway attempt profile with the model settings of the eval profile the person
// chose. Only the three AI settings rows are copied, nothing else (no memories, channels, MCP).
// Runs inside the Electron attempt process (better-sqlite3 is built for Electron).
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const KEYS = ['ai_provider_workspace', 'ai_model_config', 'ai_saved_configs']

function modelSummary(rows) {
  const read = (key) => {
    try { return JSON.parse(rows.find((row) => row.key === key)?.value || 'null') } catch { return null }
  }
  const config = read('ai_model_config')
  const workspace = read('ai_provider_workspace')
  const pick = (value, names) => {
    if (!value || typeof value !== 'object') return null
    for (const name of names) if (typeof value[name] === 'string' && value[name]) return value[name]
    return null
  }
  return {
    provider: pick(config, ['provider', 'providerId', 'providerType'])
      || pick(workspace, ['activeProfileId', 'activeProviderId']),
    model: pick(config, ['model', 'modelId', 'defaultModel']),
  }
}

/** Create `targetPath` with only the AI settings rows of `sourcePath`; returns a key-free summary. */
export function seedProviderSettings(sourcePath, targetPath) {
  const Database = require('better-sqlite3')
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  let rows
  try {
    rows = source.prepare(
      `SELECT key, value, updated_at FROM settings WHERE key IN (${KEYS.map(() => '?').join(', ')})`
    ).all(
      ...KEYS
    )
  } finally {
    source.close()
  }
  if (rows.length === 0)
    throw new Error('eval profile has no AI settings rows; configure a model in that profile first')
  const target = new Database(targetPath)
  try {
    target.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
    const insert = target.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    for (const row of rows) insert.run(row.key, row.value, row.updated_at)
  } finally {
    target.close()
  }
  return { rows: rows.length, ...modelSummary(rows) }
}
