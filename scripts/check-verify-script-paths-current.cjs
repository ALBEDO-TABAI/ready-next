#!/usr/bin/env node
/**
 * Stage X1.5 meta-gate — prevent stale `src/...` paths in verify scripts.
 *
 * Every `scripts/check-*.cjs` (and `scripts/check-*.mjs`) is scanned for
 * string literals matching `'src/...'` that look like file paths
 * (extension required: .ts / .tsx / .js / .jsx / .mjs / .cjs / .mts / .cts).
 * Any path that does not resolve on disk fails the gate, unless the path is
 * listed in `scripts/check-verify-script-paths-allowlist.json` with all five
 * required fields and a future `expiresAt`.
 *
 * The intent is to catch the failure mode that motivated Stage X1: when
 * Stage U / V move-only refactors rename source files, the verify scripts
 * that hard-code those paths silently start failing in the chain segment
 * that runs them, while the chain prefix still succeeds. The meta-gate
 * surfaces drift at the first push rather than waiting for the chain to
 * reach the affected gate.
 *
 * Allowlist policy:
 *   - Each entry must have: path, reason, owner, expiresAt, addedBy.
 *   - `expiresAt` in the past => gate exits 2 (loader rejection, not drift).
 *   - Every active entry is printed at start so reviewers see what is
 *     silenced before reading scan output.
 *   - Only use for intentional fixture / snapshot / planned-rename cases;
 *     do NOT use to paper over real moved sources.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const VERIFY_SCRIPTS_DIR = __dirname
const ALLOWLIST_PATH = path.join(__dirname, 'check-verify-script-paths-allowlist.json')
const REPO_ROOT = path.resolve(__dirname, '..')

// Match string literals referencing src/... paths in .cjs/.mjs scripts.
// Examples we want to catch:
//   path.join(process.cwd(), 'src/main/modules/agent-control/...')
//   resolve('src/main/...')
//   const PATH = 'src/...'
//
// The trailing extension is intentionally restrictive (only TS/JS sources):
// other src/ references (e.g. directory paths, assets, snapshots) should not
// be caught by this gate.
const PATH_RE = /['"](src\/[\w./_-]+\.(?:tsx?|jsx?|mjs|cjs|mts|cts))['"]/g

const REQUIRED_FIELDS = ['path', 'reason', 'owner', 'expiresAt', 'addedBy']

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return []
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
  } catch (err) {
    console.error(`ALLOWLIST INVALID: cannot parse ${path.basename(ALLOWLIST_PATH)}: ${err.message}`)
    process.exit(2)
  }
  const entries = Array.isArray(raw && raw.entries) ? raw.entries : []
  const now = new Date()
  const valid = []
  for (const e of entries) {
    for (const required of REQUIRED_FIELDS) {
      if (!e || typeof e[required] !== 'string' || e[required].trim().length === 0) {
        console.error(`ALLOWLIST INVALID: entry missing required field "${required}":`, JSON.stringify(e))
        process.exit(2)
      }
    }
    const expires = new Date(e.expiresAt)
    if (Number.isNaN(expires.getTime())) {
      console.error(`ALLOWLIST INVALID: ${e.path} has unparseable expiresAt "${e.expiresAt}"`)
      process.exit(2)
    }
    if (expires < now) {
      console.error(`ALLOWLIST EXPIRED: ${e.path} expired ${e.expiresAt} (owner=${e.owner})`)
      process.exit(2)
    }
    valid.push(e)
  }
  return valid
}

function listVerifyScripts(dir) {
  const out = []
  for (const name of fs.readdirSync(dir)) {
    if (!/^check-.+\.(cjs|mjs)$/.test(name)) continue
    const abs = path.join(dir, name)
    const stat = fs.statSync(abs)
    if (stat.isFile()) out.push(abs)
  }
  return out.sort()
}

function checkVerifyScriptPaths({ root = REPO_ROOT, scriptsDir = VERIFY_SCRIPTS_DIR } = {}) {
  const allowlistEntries = loadAllowlist()
  const allowlist = new Set(allowlistEntries.map((e) => e.path))
  const drift = []
  for (const abs of listVerifyScripts(scriptsDir)) {
    const rel = path.relative(root, abs)
    const src = fs.readFileSync(abs, 'utf8')
    for (const m of src.matchAll(PATH_RE)) {
      const cited = m[1]
      if (allowlist.has(cited)) continue
      const fullCited = path.join(root, cited)
      if (!fs.existsSync(fullCited)) {
        drift.push({ script: rel, citedPath: cited })
      }
    }
  }
  return { allowlistEntries, drift }
}

function main() {
  const { allowlistEntries, drift } = checkVerifyScriptPaths()
  for (const e of allowlistEntries) {
    console.log(`ALLOWLIST: ${e.path} (owner=${e.owner}, expires=${e.expiresAt})`)
  }
  if (drift.length === 0) {
    console.log('[check-verify-script-paths-current] OK')
    return 0
  }
  console.error('[check-verify-script-paths-current] STALE PATHS:')
  for (const d of drift) {
    console.error(`  ${d.script} references ${d.citedPath} which does not exist`)
  }
  console.error('')
  console.error('Fix by updating the cited path to the current location, or')
  console.error('add an entry to scripts/check-verify-script-paths-allowlist.json')
  console.error('(only for intentional fixture / snapshot paths).')
  return 1
}

if (require.main === module) {
  process.exit(main())
}

module.exports = {
  checkVerifyScriptPaths,
  loadAllowlist,
  listVerifyScripts,
  REQUIRED_FIELDS,
  ALLOWLIST_PATH,
}
