#!/usr/bin/env node
/**
 * Stage U PR U8.2a — RSS platform rule single-source gate.
 *
 * Audit §2.3 / §3.7: platform-specific rules (`detectPlatform`,
 * `'<platform>.com'` domain literals, per-platform validate regex,
 * userId extractors) used to live in both `scrapers/index.ts` and
 * `browser-acquisition.ts`. When the two drift, detection matches a
 * platform but acquisition drops every candidate.
 *
 * U8.2a establishes the contract module at
 * `src/main/modules/rss-engine/platform-adapters/`. This gate fences
 * future rule additions to live there. It does NOT mass-relocate
 * existing rules — that is U8.2b's job. Today the gate enforces:
 *
 *   1. New `detectPlatform`-equivalent functions cannot be added
 *      anywhere except `platform-adapters/`. The existing
 *      `scrapers/index.ts#detectPlatform` is the sole legacy reader,
 *      whitelisted by file.
 *   2. The `PLATFORM_ADAPTER_REGISTRY` symbol must be defined in
 *      `platform-adapters/types.ts` (so callers always have a typed
 *      lookup target).
 *
 * Forbidden pattern (outside whitelist):
 *   - `function detectPlatform`, `export function detectPlatform`
 *   - `const detectPlatform = `
 *
 * Whitelist (read-only):
 *   - `src/main/modules/rss-engine/scrapers/index.ts` — legacy detect()
 *   - `src/main/modules/rss-engine/platform-adapters/**` — new home
 *   - `scripts/check-rss-platform-rule-single-source.cjs` — this file
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const SCAN_ROOTS = ['src/main/modules/rss-engine']
const SCAN_EXT = new Set(['.ts', '.tsx', '.cts', '.mts'])

const FILE_ALLOWLIST = [
  /^scripts\/check-rss-platform-rule-single-source\.cjs$/,
  /^src\/main\/modules\/rss-engine\/scrapers\/index\.ts$/,
  /^src\/main\/modules\/rss-engine\/platform-adapters\//,
]

const FORBIDDEN_PATTERNS = [
  /\bfunction\s+detectPlatform\b/,
  /\bexport\s+function\s+detectPlatform\b/,
  /\bconst\s+detectPlatform\s*=/,
]

function isAllowed(rel) {
  return FILE_ALLOWLIST.some((rx) => rx.test(rel))
}

function* walk(dir) {
  if (!fs.existsSync(dir)) return
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

function checkRssPlatformRuleSingleSource() {
  const violations = []
  for (const root of SCAN_ROOTS) {
    const abs = path.join(REPO, root)
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full)
      if (isAllowed(rel)) continue
      const source = fs.readFileSync(full, 'utf8')
      const lines = source.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        for (const pattern of FORBIDDEN_PATTERNS) {
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

  // Sanity: the registry must exist at the canonical home.
  const registryPath = path.join(REPO, 'src/main/modules/rss-engine/platform-adapters/types.ts')
  if (!fs.existsSync(registryPath)) {
    violations.push({
      file: 'src/main/modules/rss-engine/platform-adapters/types.ts',
      line: 0,
      pattern: 'missing PLATFORM_ADAPTER_REGISTRY home',
      code: 'platform-adapters/types.ts must exist and export PLATFORM_ADAPTER_REGISTRY',
    })
  } else {
    const source = fs.readFileSync(registryPath, 'utf8')
    if (!/\bPLATFORM_ADAPTER_REGISTRY\b/.test(source)) {
      violations.push({
        file: 'src/main/modules/rss-engine/platform-adapters/types.ts',
        line: 0,
        pattern: 'PLATFORM_ADAPTER_REGISTRY symbol missing',
        code: 'platform-adapters/types.ts must export the PLATFORM_ADAPTER_REGISTRY map',
      })
    }
  }

  return { ok: violations.length === 0, violations }
}

function main() {
  const { ok, violations } = checkRssPlatformRuleSingleSource()
  if (ok) { console.log('[check-rss-platform-rule-single-source] OK'); return 0 }
  console.error('[check-rss-platform-rule-single-source] FAIL — RSS platform rules must live in src/main/modules/rss-engine/platform-adapters/ (Stage U8.2a).')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.pattern}`)
    console.error(`    code: ${v.code}`)
  }
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkRssPlatformRuleSingleSource }
