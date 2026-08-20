#!/usr/bin/env node
/**
 * Settings legacy key retirement gate.
 *
 * Tavily and Jina credentials have one production truth: the external-service
 * profile backed by the Ready credential vault. Old database keys, migration
 * helpers and environment escape hatches must never return to production code.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOTS = [
  'src/main',
  'src/preload',
  'src/renderer',
  'src/shared',
]
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'])

const FORBIDDEN = [
  /\blegacyTavilyKey\b/,
  /\blegacyJinaKey\b/,
  /['"]web_search_tavily_key['"]/,
  /['"]web_fetch_jina_key['"]/,
  /['"]external_service_legacy_key_migration_done_v1['"]/,
  /['"]READY_SETTINGS_RESTORE_LEGACY_KEYS['"]/,
  /\bLEGACY_TAVILY_KEY_SETTING\b/,
  /\bLEGACY_JINA_KEY_SETTING\b/,
  /\bLEGACY_KEY_MIGRATION_DONE_SETTING\b/,
  /\bmigrateLegacyKeysOnce\b/,
  /\bmigrateLegacyKeysNow\b/,
]

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      yield* walk(full)
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      yield full
    }
  }
}

function checkSettingsNoLegacyKeyRead() {
  const violations = []
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root)
    if (!fs.existsSync(abs)) continue
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full)
      const source = fs.readFileSync(full, 'utf8')
      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        for (const pattern of FORBIDDEN) {
          if (pattern.test(lines[i])) {
            violations.push({
              file: rel,
              line: i + 1,
              pattern: pattern.toString(),
              code: lines[i].trim().slice(0, 160),
            })
          }
        }
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkSettingsNoLegacyKeyRead()
  if (ok) { console.log('[check-settings-no-legacy-key-read] OK'); return 0 }
  console.error('[check-settings-no-legacy-key-read] FAIL — retired Tavily/Jina credential paths returned to production code.')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkSettingsNoLegacyKeyRead }
