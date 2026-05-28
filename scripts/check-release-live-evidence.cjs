#!/usr/bin/env node
/**
 * Release live-evidence gate.
 *
 * Stage Y's dogfood gate accepts `deferred-with-owner` records because its
 * job is to prove the closeout bundle is complete. This gate is stricter:
 * a release candidate must have live pass evidence for every in-scope Stage Y
 * dogfood surface, so deferred records are a red light except for product
 * surfaces deliberately excluded from the current release goal.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  main: lintStageYDogfoodEvidence,
  parseFrontmatter,
  REQUIRED_BAI_SPOTCHECK_SUBFIELDS,
} = require('./check-stage-y-dogfood-evidence.cjs')

const ROOT = path.resolve(__dirname, '..')
const DOGFOOD_DIR_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood'
const EXPECTED_SURFACE_COUNT = 20
const EXPECTED_SURFACE_IDS = Array.from(
  { length: EXPECTED_SURFACE_COUNT },
  (_, i) => i + 1,
)
const OUT_OF_SCOPE_REMOTE_SURFACE_IDS = new Set([11])

function listSurfaceFiles(root = ROOT) {
  const dirAbs = path.join(root, DOGFOOD_DIR_REL)
  if (!fs.existsSync(dirAbs)) {
    return {
      ok: false,
      records: [],
      errors: [`dogfood directory missing: ${DOGFOOD_DIR_REL}`],
    }
  }

  const records = fs
    .readdirSync(dirAbs)
    .filter((name) => /^surface-\d+-.+\.md$/.test(name))
    .sort()
    .map((fileName) => {
      const abs = path.join(dirAbs, fileName)
      const { fm } = parseFrontmatter(fs.readFileSync(abs, 'utf8'))
      return { fileName, fm }
    })

  return { ok: true, records, errors: [] }
}

function surfaceIdFromFileName(fileName) {
  const m = fileName.match(/^surface-(\d+)-.+\.md$/)
  return m ? Number(m[1]) : null
}

function collectSurfaceIds(records, label, getId) {
  const byId = new Map()
  const invalid = []

  for (const record of records) {
    const id = getId(record)
    if (!Number.isInteger(id)) {
      invalid.push(record.fileName)
      continue
    }
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(record.fileName)
  }

  const expected = new Set(EXPECTED_SURFACE_IDS)
  const missing = EXPECTED_SURFACE_IDS.filter((id) => !byId.has(id))
  const duplicate = Array.from(byId.entries())
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => `${id} (${files.join(', ')})`)
  const outOfRange = Array.from(byId.keys()).filter((id) => !expected.has(id))

  return { invalid, missing, duplicate, outOfRange }
}

function validateSurfaceCoverage(records) {
  const errors = []
  const fileNameCoverage = collectSurfaceIds(records, 'filename', ({ fileName }) =>
    surfaceIdFromFileName(fileName),
  )
  const frontmatterCoverage = collectSurfaceIds(records, 'frontmatter', ({ fm }) =>
    fm ? Number(fm.surface_id) : null,
  )

  for (const [label, coverage] of [
    ['filename', fileNameCoverage],
    ['frontmatter surface_id', frontmatterCoverage],
  ]) {
    if (coverage.invalid.length > 0) {
      errors.push(`${label}: invalid surface id in ${coverage.invalid.join(', ')}`)
    }
    if (coverage.missing.length > 0) {
      errors.push(`${label}: missing surface id(s) ${coverage.missing.join(', ')}`)
    }
    if (coverage.duplicate.length > 0) {
      errors.push(`${label}: duplicate surface id(s) ${coverage.duplicate.join('; ')}`)
    }
    if (coverage.outOfRange.length > 0) {
      errors.push(`${label}: out-of-range surface id(s) ${coverage.outOfRange.join(', ')}`)
    }
  }

  return errors
}

function evaluateLiveEvidence(records) {
  const errors = []
  const statusCounts = new Map()
  let passCount = 0
  const outOfScopeSurfaceIds = new Set()

  for (const { fileName, fm } of records) {
    if (!fm) {
      errors.push(`${fileName}: missing or unparseable frontmatter`)
      continue
    }

    const surfaceId = Number.isInteger(Number(fm.surface_id))
      ? Number(fm.surface_id)
      : surfaceIdFromFileName(fileName)
    const status = fm.status || '(missing)'
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1)
    if (OUT_OF_SCOPE_REMOTE_SURFACE_IDS.has(surfaceId)) {
      if (status === 'deferred-with-owner' && fm.deferred_owner && fm.deferred_reason) {
        outOfScopeSurfaceIds.add(surfaceId)
      } else {
        errors.push(
          `${fileName}: out-of-scope remote surface must remain status=deferred-with-owner with owner and reason, got ${status}`,
        )
      }
      continue
    }
    if (status === 'pass') {
      passCount += 1
    } else {
      const owner = fm.deferred_owner ? ` owner=${fm.deferred_owner}` : ''
      errors.push(`${fileName}: release requires status=pass, got ${status}${owner}`)
      continue
    }

    if (fm.operator_class && fm.operator_class !== 'agent-only') {
      if (!fm.bai_spotcheck || typeof fm.bai_spotcheck !== 'object') {
        errors.push(`${fileName}: release pass requires bai_spotcheck block`)
        continue
      }
      for (const field of REQUIRED_BAI_SPOTCHECK_SUBFIELDS) {
        if (!fm.bai_spotcheck[field]) {
          errors.push(`${fileName}: bai_spotcheck missing ${field}`)
        }
      }
    }
  }

  if (records.length !== EXPECTED_SURFACE_COUNT) {
    errors.push(
      `release requires ${EXPECTED_SURFACE_COUNT} dogfood surfaces, found ${records.length}`,
    )
  }
  errors.push(...validateSurfaceCoverage(records))

  return {
    ok: errors.length === 0,
    errors,
    passCount,
    total: records.length - outOfScopeSurfaceIds.size,
    outOfScopeSurfaceIds: Array.from(outOfScopeSurfaceIds).sort((a, b) => a - b),
    statusCounts: Object.fromEntries(statusCounts),
  }
}

function main({ root = ROOT } = {}) {
  const evidenceLintResult = lintStageYDogfoodEvidence({ root })
  const listed = listSurfaceFiles(root)
  if (!listed.ok) {
    return {
      ok: false,
      errors: [...evidenceLintResult.errors, ...listed.errors],
      passCount: 0,
      total: 0,
      statusCounts: {},
    }
  }
  const liveResult = evaluateLiveEvidence(listed.records)
  return {
    ...liveResult,
    ok: evidenceLintResult.ok && liveResult.ok,
    errors: [...evidenceLintResult.errors, ...liveResult.errors],
  }
}

if (require.main === module) {
  const result = main()
  const statusSummary = Object.entries(result.statusCounts)
    .map(([status, count]) => `${status}=${count}`)
    .join(', ')

  if (result.ok) {
    console.log('[check-release-live-evidence] OK')
    console.log(`  in-scope live pass surfaces: ${result.passCount}/${result.total}`)
    if (result.outOfScopeSurfaceIds?.length) {
      console.log(`  out-of-scope remote surfaces: ${result.outOfScopeSurfaceIds.join(', ')}`)
    }
    process.exit(0)
  }

  console.error('[check-release-live-evidence] FAIL:')
  console.error(`  in-scope live pass surfaces: ${result.passCount}/${result.total}`)
  if (result.outOfScopeSurfaceIds?.length) {
    console.error(`  out-of-scope remote surfaces: ${result.outOfScopeSurfaceIds.join(', ')}`)
  }
  if (statusSummary) console.error(`  status summary: ${statusSummary}`)
  for (const e of result.errors.slice(0, 30)) console.error('  - ' + e)
  if (result.errors.length > 30) {
    console.error(`  - ... ${result.errors.length - 30} more issue(s)`)
  }
  process.exit(1)
}

module.exports = {
  DOGFOOD_DIR_REL,
  EXPECTED_SURFACE_COUNT,
  OUT_OF_SCOPE_REMOTE_SURFACE_IDS,
  evaluateLiveEvidence,
  listSurfaceFiles,
  main,
  validateSurfaceCoverage,
}
