#!/usr/bin/env node
/**
 * Stage U PR U0.4 — Phase smoke gate dispatcher.
 *
 * Reads the current PR's phase label (from GITHUB_PR_LABELS — JSON array,
 * object array, or comma-separated — or STAGE_U_PHASE_LABEL for local dev)
 * and invokes scripts/phase-smoke-runner.cjs --phase <n> for each
 * `phase:<0-8>` label. Exits non-zero iff any runner failed.
 *
 * Non-phase PRs are a no-op (exit 0). Wired into the verify chain so that
 * any phase-labeled PR cannot merge without the matching smoke passing.
 */

'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const RUNNER = path.join(REPO, 'scripts/phase-smoke-runner.cjs')
const PHASE_LABEL_REGEX = /^phase:([0-8])$/

function collectLabels(env = process.env) {
  const labels = new Set()
  const gh = env.GITHUB_PR_LABELS
  if (gh && gh.trim().length > 0) {
    let parsed = null
    try { parsed = JSON.parse(gh) } catch { /* delimited fallback */ }
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        const name = typeof e === 'string' ? e : e?.name
        if (typeof name === 'string' && name.length > 0) labels.add(name.trim())
      }
    } else {
      for (const part of gh.split(/[,\s]+/)) if (part.length > 0) labels.add(part.trim())
    }
  }
  const local = env.STAGE_U_PHASE_LABEL
  if (typeof local === 'string' && local.trim().length > 0) labels.add(local.trim())
  return [...labels]
}

function extractPhases(labels) {
  const phases = []
  for (const label of labels) {
    const m = PHASE_LABEL_REGEX.exec(label)
    if (m) phases.push(Number(m[1]))
  }
  return [...new Set(phases)].sort((a, b) => a - b)
}

function runRunnerForPhase(phase) {
  const result = spawnSync(process.execPath, [RUNNER, '--phase', String(phase)], {
    cwd: REPO, stdio: 'inherit', env: process.env,
  })
  if (result.error) {
    console.error(`[check-phase-smoke-gate] failed to spawn runner for phase ${phase}: ${result.error.message}`)
    return 1
  }
  return result.status == null ? 1 : result.status
}

function main(env = process.env) {
  const phases = extractPhases(collectLabels(env))
  if (phases.length === 0) {
    console.log('[check-phase-smoke-gate] no phase:<n> label detected — gate is a no-op for this PR.')
    return 0
  }
  console.log(`[check-phase-smoke-gate] detected phase labels: ${phases.map((p) => `phase:${p}`).join(', ')}`)
  let worst = 0
  for (const phase of phases) {
    const code = runRunnerForPhase(phase)
    if (code !== 0) worst = code
  }
  if (worst === 0) console.log('[check-phase-smoke-gate] OK — all phase smokes passed (or gracefully skipped).')
  else console.error('[check-phase-smoke-gate] FAIL — one or more phase smokes failed; see runner output above.')
  return worst
}

if (require.main === module) process.exit(main())

module.exports = { collectLabels, extractPhases, main, PHASE_LABEL_REGEX }
