#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(new URL('../', import.meta.url).pathname)
const outputPath = resolve(process.argv[2] || join(projectRoot, 'build/runtime-seeds/ai-settings.seed.json'))
const dbPath = resolve(
  process.argv[3] || join(homedir(), 'Library/Application Support/ready/ready.db')
)

if (!existsSync(dbPath)) {
  console.error(`Settings database not found: ${dbPath}`)
  process.exit(1)
}

const pythonScript = `
import json
import sqlite3
import sys

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
cur = conn.cursor()
rows = dict(cur.execute(
    "SELECT key, value FROM settings WHERE key IN ('ai_model_config', 'ai_saved_configs', 'ai_provider_workspace')"
).fetchall())
conn.close()
print(json.dumps(rows))
`

const pythonResult = spawnSync('python3', ['-c', pythonScript, dbPath], {
  encoding: 'utf8',
})

if (pythonResult.status !== 0) {
  console.error(pythonResult.stderr || 'Failed to read settings database via python3')
  process.exit(pythonResult.status || 1)
}

const rawSettings = JSON.parse(pythonResult.stdout || '{}')
const currentConfig = rawSettings.ai_model_config ? JSON.parse(rawSettings.ai_model_config) : null
const savedConfigs = rawSettings.ai_saved_configs ? JSON.parse(rawSettings.ai_saved_configs) : {}
const workspace = rawSettings.ai_provider_workspace ? JSON.parse(rawSettings.ai_provider_workspace) : null

const moonshotConfig = currentConfig?.provider === 'moonshot'
  ? currentConfig
  : (savedConfigs?.moonshot ?? null)

if (!moonshotConfig) {
  console.error('No Moonshot/Kimi config found in current settings')
  process.exit(1)
}

const seed = {
  ai_model_config: moonshotConfig,
  ai_saved_configs: {
    moonshot: moonshotConfig,
  },
  ...(workspace ? { ai_provider_workspace: workspace } : {}),
}

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8')

console.log(`Exported AI seed: ${outputPath}`)
console.log('Included providers: moonshot')
