#!/usr/bin/env node
/**
 * Stage U PR U8.3 — Settings legacy key retirement gate (N-8).
 *
 * The legacy DB keys `web_search_tavily_key` and `web_fetch_jina_key`
 * are retired. After Stage U8.3 lands, the only allowed reader is the
 * one-shot `migrateLegacyKeysOnce()` helper inside
 * `src/main/modules/settings-engine/external-service-store.ts`. Every
 * other read path must use the new external-service profile shape.
 *
 * Forbidden anywhere in `src/main/modules/settings-engine/` or
 * `src/main/modules/repositories/`:
 *   - Identifiers `legacyTavilyKey`, `legacyJinaKey`
 *   - String literals `'web_search_tavily_key'`, `'web_fetch_jina_key'`,
 *     `LEGACY_TAVILY_KEY_SETTING`, `LEGACY_JINA_KEY_SETTING`
 *
 * Allowed (whitelisted) callsites:
 *   - The gate file itself
 *   - The U8.3 test files
 *   - `external-service-store.ts` (the only place that holds the
 *     migration helper + emergency restore path)
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOTS = [
  'src/main/modules/settings-engine',
  'src/main/modules/repositories',
]
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.cjs', '.mjs'])

const FILE_ALLOWLIST = [
  /^scripts\/check-settings-no-legacy-key-read\.cjs$/,
  /^src\/__tests__\/settings-legacy-key-/,
  /^src\/__tests__\/settings-no-legacy-key-/,
  /^src\/__tests__\/settings-emergency-/,
  /^src\/main\/modules\/settings-engine\/external-service-store\.ts$/,
]

const FORBIDDEN = [
  /\blegacyTavilyKey\b/,
  /\blegacyJinaKey\b/,
  /['"]web_search_tavily_key['"]/,
  /['"]web_fetch_jina_key['"]/,
  /\bLEGACY_TAVILY_KEY_SETTING\b/,
  /\bLEGACY_JINA_KEY_SETTING\b/,
]

function isAllowed(rel) {
  return FILE_ALLOWLIST.some((rx) => rx.test(rel))
}

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
      if (isAllowed(rel)) continue
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
  console.error('[check-settings-no-legacy-key-read] FAIL — legacy Tavily/Jina key access is retired (Stage U8.3 / N-8).')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkSettingsNoLegacyKeyRead }
