#!/usr/bin/env node
/**
 * Stage Y0.1 disposition-report validator per plan §6.5.
 * Validates docs/superpowers/audits/2026-05-23-stage-y-closeout/
 * y0-1-disposition-report.md against
 * y0-1-disposition-report-schema.json.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const REPORT_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report.md'
const SCHEMA_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-disposition-report-schema.json'

const VALID_DISPOSITION_PATHS = new Set([
  'a-fix',
  'a-rewrite',
  'b-replacement-gate',
  'b-retired-with-reason',
  'split',
])
const VALID_SUB_PATHS = new Set([
  'a-fix',
  'a-rewrite',
  'b-replacement-gate',
  'b-retired-with-reason',
])
const REQUIRED_GATE_IDS_PAIRED = [
  'check-sqlite-test-skip-pattern',
  'check-stage-r-verify-switch+check-stage-t-verify-switch',
  'check-testing-conventions-doc',
  'check-research-adapter-registered-in-host',
]
const REQUIRED_GATE_IDS_SPLIT = [
  'check-sqlite-test-skip-pattern',
  'check-stage-r-verify-switch',
  'check-stage-t-verify-switch',
  'check-testing-conventions-doc',
  'check-research-adapter-registered-in-host',
]

function gitCommitExists(sha) {
  if (!sha || typeof sha !== 'string') return false
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false
  try {
    execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${sha}^{commit}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

function extractRowsJson(reportText) {
  const match = reportText.match(/```json\s*\n([\s\S]*?)\n```/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch (e) {
    return { _parse_error: e.message }
  }
}

function main({ root = ROOT } = {}) {
  const errors = []
  const reportAbs = path.join(root, REPORT_REL)
  if (!fs.existsSync(reportAbs)) {
    errors.push(`disposition report missing: ${REPORT_REL}`)
    return { ok: false, errors }
  }
  const schemaAbs = path.join(root, SCHEMA_REL)
  if (!fs.existsSync(schemaAbs)) {
    errors.push(`schema missing: ${SCHEMA_REL}`)
    return { ok: false, errors }
  }
  const reportText = fs.readFileSync(reportAbs, 'utf8')
  const parsed = extractRowsJson(reportText)
  if (!parsed) {
    errors.push(`${REPORT_REL}: no JSON fenced code block with rows[] found`)
    return { ok: false, errors }
  }
  if (parsed._parse_error) {
    errors.push(`${REPORT_REL}: JSON parse error — ${parsed._parse_error}`)
    return { ok: false, errors }
  }
  if (!Array.isArray(parsed.rows)) {
    errors.push(`${REPORT_REL}: top-level "rows" array missing`)
    return { ok: false, errors }
  }
  const rows = parsed.rows
  const rowCount = rows.length
  if (rowCount !== 4 && rowCount !== 5) {
    errors.push(
      `${REPORT_REL}: expected 4 (paired) or 5 (split) rows, got ${rowCount}`,
    )
  }
  const seenIds = new Set()
  const idList = rows.map((r) => r.gate_id).filter(Boolean)
  for (const [i, r] of rows.entries()) {
    const prefix = `${REPORT_REL}: row[${i}]`
    if (!r.gate_id) {
      errors.push(`${prefix}: gate_id missing`)
      continue
    }
    if (seenIds.has(r.gate_id)) {
      errors.push(`${prefix}: gate_id "${r.gate_id}" duplicated`)
      continue
    }
    seenIds.add(r.gate_id)
    if (!r.outcome_commit) {
      errors.push(`${prefix} (${r.gate_id}): outcome_commit missing`)
    } else if (!gitCommitExists(r.outcome_commit)) {
      errors.push(
        `${prefix} (${r.gate_id}): outcome_commit "${r.outcome_commit}" not in repo`,
      )
    }
    if (!r.disposition_path) {
      errors.push(`${prefix} (${r.gate_id}): disposition_path missing`)
      continue
    }
    if (!VALID_DISPOSITION_PATHS.has(r.disposition_path)) {
      errors.push(
        `${prefix} (${r.gate_id}): disposition_path "${r.disposition_path}" not in valid set`,
      )
      continue
    }
    const isSplit = r.disposition_path === 'split'
    if (isSplit) {
      if (!r.disposition_path_r || !VALID_SUB_PATHS.has(r.disposition_path_r)) {
        errors.push(
          `${prefix} (${r.gate_id}): split row requires disposition_path_r ∈ valid set`,
        )
      }
      if (!r.disposition_path_t || !VALID_SUB_PATHS.has(r.disposition_path_t)) {
        errors.push(
          `${prefix} (${r.gate_id}): split row requires disposition_path_t ∈ valid set`,
        )
      }
      if (!r.rearmed_in_verify_chain || !r.rearmed_in_verify_chain.includes(';')) {
        errors.push(
          `${prefix} (${r.gate_id}): split row requires rearmed_in_verify_chain to contain ";"`,
        )
      }
    } else {
      if (r.disposition_path_r !== null && r.disposition_path_r !== undefined) {
        errors.push(
          `${prefix} (${r.gate_id}): non-split row requires disposition_path_r=null`,
        )
      }
      if (r.disposition_path_t !== null && r.disposition_path_t !== undefined) {
        errors.push(
          `${prefix} (${r.gate_id}): non-split row requires disposition_path_t=null`,
        )
      }
      if (
        r.rearmed_in_verify_chain &&
        typeof r.rearmed_in_verify_chain === 'string' &&
        r.rearmed_in_verify_chain.includes(';')
      ) {
        errors.push(
          `${prefix} (${r.gate_id}): non-split row's rearmed_in_verify_chain MUST NOT contain ";"`,
        )
      }
      if (
        r.replacement_gate_path &&
        typeof r.replacement_gate_path === 'string' &&
        r.replacement_gate_path.includes(';')
      ) {
        errors.push(
          `${prefix} (${r.gate_id}): non-split row's replacement_gate_path MUST NOT contain ";"`,
        )
      }
    }
    const allPaths = [
      r.disposition_path,
      ...(isSplit ? [r.disposition_path_r, r.disposition_path_t] : []),
    ].filter(Boolean)
    if (allPaths.includes('b-replacement-gate') && !r.replacement_gate_path) {
      errors.push(
        `${prefix} (${r.gate_id}): b-replacement-gate disposition requires replacement_gate_path`,
      )
    }
    if (allPaths.includes('b-retired-with-reason') && !r.retire_reason) {
      errors.push(
        `${prefix} (${r.gate_id}): b-retired-with-reason disposition requires retire_reason`,
      )
    }
    if (!r.rationale || typeof r.rationale !== 'string' || r.rationale.trim().length === 0) {
      errors.push(`${prefix} (${r.gate_id}): rationale missing or empty`)
    } else if (!/§6\.\d|§6\.x|plan §6/i.test(r.rationale)) {
      errors.push(
        `${prefix} (${r.gate_id}): rationale must cite at least one §6.x anchor`,
      )
    }
  }
  const expectedIds = rowCount === 5 ? REQUIRED_GATE_IDS_SPLIT : REQUIRED_GATE_IDS_PAIRED
  for (const expected of expectedIds) {
    if (!idList.includes(expected)) {
      errors.push(
        `${REPORT_REL}: required gate_id "${expected}" missing from rows[]`,
      )
    }
  }
  if (errors.length) return { ok: false, errors }
  console.log(
    `[check-y0-1-disposition-report] OK (${rowCount} rows; all gate_ids covered; all outcome_commits resolve; per-row schema valid)`,
  )
  return { ok: true, errors: [] }
}

if (require.main === module) {
  const result = main()
  if (!result.ok) {
    console.error('[check-y0-1-disposition-report] FAIL:')
    for (const e of result.errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  process.exit(0)
}

module.exports = { main }
