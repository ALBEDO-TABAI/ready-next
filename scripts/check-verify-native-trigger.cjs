#!/usr/bin/env node
/**
 * Stage U PR U8.6.1 — `verify:native` trigger gate (C-8 / D4-4).
 *
 * Decides from PR diff whether `npm run verify:native` evidence is
 * required and refuses the PR if missing. See CLAUDE.md §2/§6.
 *
 * Trigger paths: src/main/modules/{database.ts,database/**,repositories/**,
 * migrations.ts,settings-engine/**}; package.json {better-sqlite3} any
 * change; {electron,electron-builder} major change.
 *
 * Diff source: GITHUB_BASE_REF+GITHUB_HEAD_REF → origin/main...HEAD → HEAD~1...HEAD.
 *
 * Evidence (MVP): env READY_VERIFY_NATIVE_OK=1, or
 *   test-results/verify-native-<short-sha>.json fresher than 24h.
 *
 * Non-CI (no CI env) defaults to ok even if triggered — enforcement is CI-only.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const TRIGGER_DIRS = ['src/main/modules/database/', 'src/main/modules/repositories/', 'src/main/modules/settings-engine/']
const TRIGGER_FILES = ['src/main/modules/database.ts', 'src/main/modules/migrations.ts']
const TRIGGER_PKG_KEYS = ['better-sqlite3', 'electron', 'electron-builder']
const FRESH_MS = 24 * 60 * 60 * 1000

function runGit(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } catch { return null }
}

function splitLines(text) { return text.split('\n').map((l) => l.trim()).filter(Boolean) }

function diffNames(cwd, env) {
  const base = env.GITHUB_BASE_REF
  const head = env.GITHUB_HEAD_REF
  if (base && head) {
    const out = runGit(['diff', '--name-only', `origin/${base}...origin/${head}`], cwd)
      ?? runGit(['diff', '--name-only', `origin/${base}...HEAD`], cwd)
    if (out !== null) return { source: 'github-actions', files: splitLines(out) }
  }
  const m = runGit(['diff', '--name-only', 'origin/main...HEAD'], cwd)
  if (m !== null) return { source: 'origin/main', files: splitLines(m) }
  const h = runGit(['diff', '--name-only', 'HEAD~1...HEAD'], cwd)
  if (h !== null) return { source: 'HEAD~1', files: splitLines(h) }
  return { source: 'none', files: [] }
}

function fileHits(rel) {
  const n = rel.split(path.sep).join('/')
  return TRIGGER_FILES.includes(n) || TRIGGER_DIRS.some((p) => n.startsWith(p))
}

function majorOf(spec) { const m = spec ? String(spec).match(/(\d+)\./) : null; return m ? m[1] : null }

function pkgHits(cwd, files) {
  if (!files.includes('package.json')) return false
  let head; try { head = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) } catch { return true }
  const raw = runGit(['show', 'HEAD~1:package.json'], cwd)
  if (!raw) return true
  let base; try { base = JSON.parse(raw) } catch { return true }
  for (const key of TRIGGER_PKG_KEYS) {
    const before = base.dependencies?.[key] ?? base.devDependencies?.[key] ?? null
    const after = head.dependencies?.[key] ?? head.devDependencies?.[key] ?? null
    if (before === after) continue
    if (key === 'better-sqlite3') return true
    if (majorOf(before) !== majorOf(after)) return true
  }
  return false
}

function computeTriggered(cwd, files) {
  const hits = files.filter(fileHits)
  if (hits.length) return { triggered: true, reasons: hits }
  if (pkgHits(cwd, files)) return { triggered: true, reasons: ['package.json (better-sqlite3/electron/electron-builder)'] }
  return { triggered: false, reasons: [] }
}

function findArtifact(cwd, now) {
  const dir = path.join(cwd, 'test-results')
  if (!fs.existsSync(dir)) return null
  const sha = runGit(['rev-parse', '--short', 'HEAD'], cwd)?.trim()
  if (!sha) return null
  const target = path.join(dir, `verify-native-${sha}.json`)
  if (!fs.existsSync(target)) return null
  const ageMs = now - fs.statSync(target).mtimeMs
  return { ok: ageMs <= FRESH_MS, path: target, ageMs }
}

function checkVerifyNativeTrigger({ cwd = REPO, env = process.env, now = Date.now(), filesOverride = null } = {}) {
  const diff = filesOverride ? { source: 'override', files: filesOverride } : diffNames(cwd, env)
  const { triggered, reasons } = computeTriggered(cwd, diff.files)
  if (!triggered) return { ok: true, triggered: false, diffSource: diff.source, reasons: [], notes: ['diff does not touch verify:native trigger surface'] }
  const isCI = String(env.CI ?? '').toLowerCase() === 'true' || env.CI === '1'
  if (!isCI) return { ok: true, triggered: true, diffSource: diff.source, reasons, notes: ['non-CI environment; enforcement deferred to CI'] }
  if (env.READY_VERIFY_NATIVE_OK === '1') return { ok: true, triggered: true, diffSource: diff.source, reasons, notes: ['evidence: READY_VERIFY_NATIVE_OK=1'] }
  const artifact = findArtifact(cwd, now)
  if (artifact?.ok) return { ok: true, triggered: true, diffSource: diff.source, reasons, notes: [`evidence: ${path.relative(cwd, artifact.path)} (age ${Math.round(artifact.ageMs / 1000)}s)`] }
  const sha = runGit(['rev-parse', '--short', 'HEAD'], cwd)?.trim() ?? '<short-sha>'
  const missing = [
    'set READY_VERIFY_NATIVE_OK=1 after running `npm run verify:native`',
    `or write test-results/verify-native-${sha}.json within ${FRESH_MS / 3600000}h`,
  ]
  if (artifact && !artifact.ok) missing.push(`(found stale artifact ${path.relative(cwd, artifact.path)}, age ${Math.round(artifact.ageMs / 1000)}s)`)
  return { ok: false, triggered: true, diffSource: diff.source, reasons, missing }
}

function main() {
  const r = checkVerifyNativeTrigger()
  if (r.ok) {
    console.log(`[check-verify-native-trigger] OK — ${r.triggered ? r.notes.join('; ') : 'diff does not require verify:native'}`)
    return 0
  }
  console.error('[check-verify-native-trigger] FAIL — diff touches SQLite/native surface, evidence of `npm run verify:native` missing.')
  console.error(`  diff source: ${r.diffSource}`)
  console.error(`  triggered by: ${r.reasons.join(', ')}`)
  for (const line of r.missing) console.error(`  fix: ${line}`)
  return 1
}

if (require.main === module) process.exit(main())

module.exports = { checkVerifyNativeTrigger }
