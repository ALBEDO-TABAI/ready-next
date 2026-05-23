#!/usr/bin/env node
/**
 * Stage Y dogfood-evidence lint gate.
 *
 * Implements the per-file lint bullets from plan §9.2.3 against
 * every `docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/<surface-slug>.md`.
 *
 * Coverage:
 *
 *   §9.2.1 Capture-HEAD rule:
 *     - `evidence/<surface-slug>-head-capture.txt` artifact present
 *       and listed in the manifest with `type: head-capture`.
 *     - SHA-256 of the head-capture.txt file matches the manifest
 *       entry's `sha256` field.
 *     - head-capture.txt has exactly 3 declared lines (build_commit,
 *       captured_at, git_status_porcelain) and git_status_porcelain
 *       count is `0` (clean tree at capture time).
 *     - `build_commit` resolves via `git cat-file -e <sha>^{commit}`.
 *     - `captured_at` (manifest) is >= `build_commit_captured_at`
 *       (frontmatter) and not more than 1 minute in the future.
 *
 *   §9.2.2 Reproduction-window strict overlap:
 *     - For each `type: log` artifact: both
 *       `log_earliest_timestamp` and `log_latest_timestamp` fall
 *       within `[reproduction_window.start - 30s,
 *       reproduction_window.end + 30s]`.
 *     - The body's `## Timestamp alignment` section parses cleanly.
 *
 *   §9.2.3 Body + frontmatter + manifest invariants:
 *     - All required frontmatter fields present.
 *     - `status` ∈ {pass, fail, deferred-with-owner}; deferred-with-owner
 *       requires both `deferred_owner` and `deferred_reason`.
 *     - `operator_class` matches the §9.4 row's class for the
 *       surface_id (this gate enforces the schema; the operator-vs-class
 *       cross-table is hard-coded below).
 *     - If `operator_class != agent-only`: `bai_spotcheck` block
 *       present + 5 sub-fields populated; spotcheck artifact SHA-256
 *       checks; `performed_at` within [captured_at, +72h] or with
 *       matching build_commit fallback.
 *     - Surface 13: 5 named sub-flow markers `### Sub-flow 13.{a-e}`.
 *     - Surface 10: body contains HTTP 402 mention.
 *     - Body has 6 required sections.
 *     - Manifest JSON is valid; its `surface_id`/`surface`/
 *       `build_commit`/`operator`/`hardware` match frontmatter.
 *     - Each manifest artifact: file exists, size matches `bytes`,
 *       SHA-256 matches `sha256`.
 *     - Committer-date validation: `git log -1 --format=%cI
 *       <build_commit>` equals frontmatter `build_commit_captured_at`
 *       (0-second tolerance); on mismatch the gate emits the
 *       operator-actionable error message from plan §9.2.3
 *       (codex r6 SF-D).
 *     - `evidence-checksums.txt` companion file present beside
 *       `evidence-checksum-manifest.json` when the latter exists
 *       (closeout-level, not per-surface).
 *
 * Initial state (Y0.0): the `dogfood/` directory is empty (only
 * `.gitkeep`); this gate is EXPECTED to exit non-zero at Y0.0 with
 * an informative "no dogfood files found" message. It MUST NOT
 * crash on the empty scaffold.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const DOGFOOD_DIR_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood'

// §9.4 operator-class table. Keys are surface_id (1..20); value
// is one of agent-only | agent-with-bai-spotcheck | bai-only.
// 9 surfaces are mandatory-spotcheck per r3 codex r2 ruling:
// 2, 3, 7, 10, 13, 16, 17, 18, 19.
const SURFACE_OPERATOR_CLASS = {
  1: 'agent-only',
  2: 'agent-with-bai-spotcheck',
  3: 'agent-with-bai-spotcheck',
  4: 'agent-only',
  5: 'agent-only',
  6: 'agent-only',
  7: 'agent-with-bai-spotcheck',
  8: 'agent-only',
  9: 'agent-only',
  10: 'agent-with-bai-spotcheck',
  11: 'agent-only', // §9.4 marks "agent OR 白 — no mandatory spot-check"
  12: 'agent-only',
  13: 'agent-with-bai-spotcheck',
  14: 'agent-only',
  15: 'agent-only',
  16: 'agent-with-bai-spotcheck',
  17: 'agent-with-bai-spotcheck',
  18: 'agent-with-bai-spotcheck',
  19: 'agent-with-bai-spotcheck',
  20: 'agent-only',
}

const REQUIRED_FRONTMATTER_KEYS = [
  'surface',
  'surface_id',
  'date',
  'operator',
  'operator_class',
  'hardware',
  'build_commit',
  'build_commit_captured_at',
  'status',
  'artifact_manifest',
]

const REQUIRED_BODY_SECTIONS = [
  '## Reproduction steps',
  '## Expected result',
  '## Observed result',
  '## Evidence artifacts',
  '## Timestamp alignment',
  '## Pass/fail rationale',
]

const REQUIRED_BAI_SPOTCHECK_SUBFIELDS = [
  'performed_by',
  'performed_at',
  'spotcheck_evidence',
  'spotcheck_sha256',
  'spotcheck_signoff_text',
]

function sha256OfFile(absPath) {
  const buf = fs.readFileSync(absPath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function gitCommitterDate(root, sha) {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '-1', '--format=%cI', sha],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
      .toString()
      .trim()
    return out
  } catch {
    return null
  }
}

function gitCommitExists(root, sha) {
  try {
    execFileSync('git', ['-C', root, 'cat-file', '-e', `${sha}^{commit}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

function parseFrontmatter(text) {
  // Naive YAML frontmatter parser: only handles `key: value` and
  // 2-space-indented sub-keys for the bai_spotcheck block. Returns
  // { fm, body } where fm is a plain object (sub-blocks become
  // nested objects) and body is the remaining markdown.
  if (!text.startsWith('---\n')) {
    return { fm: null, body: text }
  }
  const end = text.indexOf('\n---', 4)
  if (end === -1) return { fm: null, body: text }
  const fmText = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n/, '')
  const fm = {}
  let currentBlockKey = null
  for (const rawLine of fmText.split('\n')) {
    if (!rawLine.trim()) {
      currentBlockKey = null
      continue
    }
    if (rawLine.startsWith('  ') && currentBlockKey) {
      // sub-field
      const m = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
      if (m) {
        fm[currentBlockKey][m[1]] = stripValue(m[2])
      }
      continue
    }
    const m = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const value = stripValue(m[2])
    if (value === '') {
      // Treat as start of a nested block.
      fm[key] = {}
      currentBlockKey = key
    } else {
      fm[key] = value
      currentBlockKey = null
    }
  }
  return { fm, body }
}

function stripValue(v) {
  // Strip optional surrounding quotes + comment tail.
  let out = v
  const commentIdx = out.indexOf('#')
  if (commentIdx >= 0) {
    // Naive: drop everything after `#` unless inside quotes; we do
    // not try to handle quoted-hash cases for this lint.
    out = out.slice(0, commentIdx).trim()
  }
  out = out.trim()
  if (
    (out.startsWith('"') && out.endsWith('"')) ||
    (out.startsWith("'") && out.endsWith("'"))
  ) {
    out = out.slice(1, -1)
  }
  return out
}

function parseReproductionWindow(body) {
  // §9.2.2 expects the `## Timestamp alignment` section to contain
  // a line like:
  //   Reproduction window: <ISO 8601 start> → <ISO 8601 end>.
  const idx = body.indexOf('## Timestamp alignment')
  if (idx === -1) return null
  const tail = body.slice(idx)
  const m = tail.match(
    /Reproduction window:\s*([0-9TZ:.+\-]+)\s*(?:→|->|–|-)\s*([0-9TZ:.+\-]+)/,
  )
  if (!m) return null
  const startMs = Date.parse(m[1])
  const endMs = Date.parse(m[2])
  if (isNaN(startMs) || isNaN(endMs)) return null
  return { start: startMs, end: endMs, startIso: m[1], endIso: m[2] }
}

function lintOneSurfaceFile(absMdPath, surfaceFileBase, errors, root) {
  const localErrors = []
  const text = fs.readFileSync(absMdPath, 'utf8')
  const { fm, body } = parseFrontmatter(text)
  if (!fm) {
    localErrors.push(`${surfaceFileBase}: missing or unparseable frontmatter`)
    return localErrors
  }

  // Required keys.
  for (const k of REQUIRED_FRONTMATTER_KEYS) {
    if (!(k in fm)) {
      localErrors.push(`${surfaceFileBase}: frontmatter missing key "${k}"`)
    }
  }

  // status enum.
  const validStatus = new Set(['pass', 'fail', 'deferred-with-owner'])
  if (fm.status && !validStatus.has(fm.status)) {
    localErrors.push(
      `${surfaceFileBase}: status="${fm.status}" not in {pass, fail, deferred-with-owner}`,
    )
  }
  if (fm.status === 'deferred-with-owner') {
    if (!fm.deferred_owner) {
      localErrors.push(
        `${surfaceFileBase}: status=deferred-with-owner requires deferred_owner`,
      )
    }
    if (!fm.deferred_reason) {
      localErrors.push(
        `${surfaceFileBase}: status=deferred-with-owner requires deferred_reason`,
      )
    }
  }

  // operator_class matches §9.4 class for surface_id.
  const surfaceId = Number(fm.surface_id)
  if (
    fm.surface_id &&
    SURFACE_OPERATOR_CLASS[surfaceId] !== undefined &&
    fm.operator_class &&
    fm.operator_class !== SURFACE_OPERATOR_CLASS[surfaceId]
  ) {
    localErrors.push(
      `${surfaceFileBase}: operator_class="${fm.operator_class}" does not match §9.4 class "${SURFACE_OPERATOR_CLASS[surfaceId]}" for surface_id=${surfaceId}`,
    )
  }

  // 白 spot-check requirement.
  const requiresSpotcheck =
    fm.operator_class && fm.operator_class !== 'agent-only'
  if (requiresSpotcheck) {
    if (!fm.bai_spotcheck || typeof fm.bai_spotcheck !== 'object') {
      localErrors.push(
        `${surfaceFileBase}: operator_class=${fm.operator_class} requires bai_spotcheck block`,
      )
    } else {
      for (const k of REQUIRED_BAI_SPOTCHECK_SUBFIELDS) {
        if (!fm.bai_spotcheck[k]) {
          localErrors.push(
            `${surfaceFileBase}: bai_spotcheck missing sub-field "${k}"`,
          )
        }
      }
      // 72h window check (§9.2.3 codex r3 should-fix #1).
      if (fm.bai_spotcheck.performed_at && fm.build_commit_captured_at) {
        const performedMs = Date.parse(fm.bai_spotcheck.performed_at)
        const baselineMs = Date.parse(fm.build_commit_captured_at)
        if (!isNaN(performedMs) && !isNaN(baselineMs)) {
          const deltaH = (performedMs - baselineMs) / (1000 * 60 * 60)
          if (deltaH > 72 || deltaH < 0) {
            // If exceeded, the spotcheck must have its own head-capture
            // proving build_commit match — we can't verify that
            // without inspecting the spotcheck artifact, so we
            // require the operator to file the surface as `fail`
            // unless they manually inline the fallback proof.
            localErrors.push(
              `${surfaceFileBase}: bai_spotcheck.performed_at is ${deltaH.toFixed(1)}h from build_commit_captured_at (window: 0–72h); requires same-build_commit fallback evidence`,
            )
          }
        }
      }
      // SHA-256 match for spotcheck_evidence.
      if (fm.bai_spotcheck.spotcheck_evidence && fm.bai_spotcheck.spotcheck_sha256) {
        const evAbs = path.resolve(
          path.dirname(absMdPath),
          fm.bai_spotcheck.spotcheck_evidence,
        )
        if (!fs.existsSync(evAbs)) {
          localErrors.push(
            `${surfaceFileBase}: bai_spotcheck.spotcheck_evidence not on disk: ${fm.bai_spotcheck.spotcheck_evidence}`,
          )
        } else {
          const actual = sha256OfFile(evAbs)
          if (actual !== fm.bai_spotcheck.spotcheck_sha256) {
            localErrors.push(
              `${surfaceFileBase}: bai_spotcheck.spotcheck_sha256 mismatch (expected ${fm.bai_spotcheck.spotcheck_sha256}, got ${actual})`,
            )
          }
        }
      }
    }
  }

  // Required body sections.
  for (const section of REQUIRED_BODY_SECTIONS) {
    if (!body.includes(section)) {
      localErrors.push(`${surfaceFileBase}: body missing section "${section}"`)
    }
  }

  // Surface 13: 5 sub-flow markers.
  if (surfaceId === 13) {
    for (const sub of ['a', 'b', 'c', 'd', 'e']) {
      const marker = `### Sub-flow 13.${sub}`
      if (!body.includes(marker)) {
        localErrors.push(
          `${surfaceFileBase}: surface 13 missing required sub-flow marker "${marker}" (§9.2.3 codex r3 should-fix #2)`,
        )
      }
    }
  }

  // Surface 10: HTTP 402 explicit coverage.
  if (surfaceId === 10) {
    if (!/HTTP\s*402|402\b/.test(body)) {
      localErrors.push(
        `${surfaceFileBase}: surface 10 body must explicitly cover HTTP 402 scenario (§9.2.3)`,
      )
    }
  }

  // Pass/fail requires both screencap and log artifact (§9.2.3).
  // This is enforced via the manifest below.

  // Manifest validation (§9.2.3).
  if (!fm.artifact_manifest) {
    return localErrors
  }
  const manifestAbs = path.resolve(path.dirname(absMdPath), fm.artifact_manifest)
  if (!fs.existsSync(manifestAbs)) {
    localErrors.push(
      `${surfaceFileBase}: artifact_manifest path does not resolve on disk: ${fm.artifact_manifest}`,
    )
    return localErrors
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'))
  } catch (e) {
    localErrors.push(`${surfaceFileBase}: manifest JSON invalid: ${e.message}`)
    return localErrors
  }
  for (const [fmKey, mfKey] of [
    ['surface_id', 'surface_id'],
    ['surface', 'surface'],
    ['build_commit', 'build_commit'],
    ['operator', 'operator'],
    ['hardware', 'hardware'],
  ]) {
    const fmVal = String(fm[fmKey] ?? '')
    const mfVal = String(manifest[mfKey] ?? '')
    if (fmVal !== mfVal) {
      localErrors.push(
        `${surfaceFileBase}: frontmatter ${fmKey}="${fmVal}" does not match manifest ${mfKey}="${mfVal}"`,
      )
    }
  }

  // Per-artifact checks.
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  let hasScreencap = false
  let hasLog = false
  let hasHeadCapture = false
  let headCaptureArtifact = null
  for (const art of artifacts) {
    if (!art.path) {
      localErrors.push(`${surfaceFileBase}: manifest artifact missing path`)
      continue
    }
    const artAbs = path.resolve(path.dirname(manifestAbs), art.path)
    if (!fs.existsSync(artAbs)) {
      localErrors.push(
        `${surfaceFileBase}: artifact missing on disk: ${art.path}`,
      )
      continue
    }
    const stat = fs.statSync(artAbs)
    if (art.bytes !== undefined && stat.size !== art.bytes) {
      localErrors.push(
        `${surfaceFileBase}: artifact ${art.path} bytes mismatch (manifest=${art.bytes}, disk=${stat.size})`,
      )
    }
    const actualSha = sha256OfFile(artAbs)
    if (art.sha256 && actualSha !== art.sha256) {
      localErrors.push(
        `${surfaceFileBase}: artifact ${art.path} sha256 mismatch (manifest=${art.sha256}, disk=${actualSha})`,
      )
    }
    if (art.type === 'screencap') hasScreencap = true
    if (art.type === 'log') {
      hasLog = true
      // §9.2.2 strict overlap.
      const window = parseReproductionWindow(body)
      if (!window) {
        localErrors.push(
          `${surfaceFileBase}: log artifact present but reproduction window unparseable in body`,
        )
      } else if (art.log_earliest_timestamp && art.log_latest_timestamp) {
        const earliestMs = Date.parse(art.log_earliest_timestamp)
        const latestMs = Date.parse(art.log_latest_timestamp)
        const lo = window.start - 30 * 1000
        const hi = window.end + 30 * 1000
        if (
          isNaN(earliestMs) ||
          isNaN(latestMs) ||
          earliestMs < lo ||
          latestMs > hi
        ) {
          localErrors.push(
            `${surfaceFileBase}: log artifact ${art.path} timestamps outside reproduction window ±30s (window=[${window.startIso}, ${window.endIso}], log=[${art.log_earliest_timestamp}, ${art.log_latest_timestamp}])`,
          )
        }
      } else {
        localErrors.push(
          `${surfaceFileBase}: log artifact ${art.path} missing log_earliest_timestamp / log_latest_timestamp (§9.2.2)`,
        )
      }
    }
    if (art.type === 'head-capture') {
      hasHeadCapture = true
      headCaptureArtifact = art
    }
  }

  // §9.2.1 head-capture rule.
  if (!hasHeadCapture) {
    localErrors.push(
      `${surfaceFileBase}: manifest must contain a "type: head-capture" artifact (§9.2.1)`,
    )
  } else if (headCaptureArtifact) {
    const hcAbs = path.resolve(
      path.dirname(manifestAbs),
      headCaptureArtifact.path,
    )
    const hcText = fs.readFileSync(hcAbs, 'utf8')
    const lines = hcText.trim().split(/\r?\n/)
    const expectedKeys = ['build_commit', 'captured_at', 'git_status_porcelain']
    for (const key of expectedKeys) {
      if (!lines.some((l) => l.startsWith(`${key}=`))) {
        localErrors.push(
          `${surfaceFileBase}: head-capture.txt missing line "${key}=..." (§9.2.1)`,
        )
      }
    }
    const porcelainLine = lines.find((l) => l.startsWith('git_status_porcelain='))
    if (porcelainLine) {
      const v = porcelainLine.split('=', 2)[1]?.trim()
      if (v !== '0') {
        localErrors.push(
          `${surfaceFileBase}: head-capture.txt git_status_porcelain="${v}" — must be 0 (clean tree at capture time per §9.2.1)`,
        )
      }
    }
    const hcCommitLine = lines.find((l) => l.startsWith('build_commit='))
    if (hcCommitLine && fm.build_commit) {
      const hcCommit = hcCommitLine.split('=', 2)[1]?.trim()
      if (hcCommit !== fm.build_commit) {
        localErrors.push(
          `${surfaceFileBase}: head-capture.txt build_commit="${hcCommit}" does not match frontmatter build_commit="${fm.build_commit}"`,
        )
      }
    }
  }

  // §9.2.1 build_commit must exist in repo.
  if (fm.build_commit && !gitCommitExists(root, fm.build_commit)) {
    localErrors.push(
      `${surfaceFileBase}: build_commit ${fm.build_commit} not present in repo (git cat-file -e failed)`,
    )
  }

  // §9.2.3 codex r5 should-fix #3 + r6 SF-D — committer-date check.
  if (fm.build_commit && fm.build_commit_captured_at) {
    const gitDate = gitCommitterDate(root, fm.build_commit)
    if (gitDate && gitDate !== fm.build_commit_captured_at) {
      localErrors.push(
        `build_commit_captured_at mismatch for ${surfaceFileBase}. Expected (from git log -1 --format=%cI ${fm.build_commit}): ${gitDate}. Got (frontmatter): ${fm.build_commit_captured_at}. Copy the expected value verbatim into the frontmatter.`,
      )
    }
  }

  // §9.2.1 captured_at sanity vs build_commit_captured_at.
  if (manifest.captured_at && fm.build_commit_captured_at) {
    const capMs = Date.parse(manifest.captured_at)
    const baseMs = Date.parse(fm.build_commit_captured_at)
    const nowMs = Date.now()
    if (!isNaN(capMs) && !isNaN(baseMs) && capMs < baseMs) {
      localErrors.push(
        `${surfaceFileBase}: manifest captured_at (${manifest.captured_at}) is earlier than build_commit_captured_at (${fm.build_commit_captured_at})`,
      )
    }
    if (!isNaN(capMs) && capMs - nowMs > 60 * 1000) {
      localErrors.push(
        `${surfaceFileBase}: manifest captured_at (${manifest.captured_at}) is more than 1 minute in the future`,
      )
    }
  }

  // pass/fail requires both screencap + log per §9.2.3.
  if (fm.status === 'pass' || fm.status === 'fail') {
    if (!hasScreencap) {
      localErrors.push(
        `${surfaceFileBase}: status=${fm.status} requires at least one screencap artifact (§9.2.3)`,
      )
    }
    if (!hasLog) {
      localErrors.push(
        `${surfaceFileBase}: status=${fm.status} requires at least one log artifact (§9.2.3)`,
      )
    }
  }

  return localErrors
}

function main({ root = ROOT } = {}) {
  const errors = []
  const notes = []
  const dirAbs = path.join(root, DOGFOOD_DIR_REL)

  if (!fs.existsSync(dirAbs)) {
    errors.push(`dogfood directory missing: ${DOGFOOD_DIR_REL}`)
    return { ok: false, errors, notes }
  }

  // Surface-evidence files only — skip REPORT.md index, sub-plans,
  // and the .gitkeep placeholder.
  const allEntries = fs.readdirSync(dirAbs)
  const surfaceFiles = allEntries
    .filter((name) => name.endsWith('.md'))
    .filter((name) => name !== 'REPORT.md')

  if (surfaceFiles.length === 0) {
    errors.push(
      `no dogfood surface evidence files found under ${DOGFOOD_DIR_REL}/ (expected 20 per plan §9.1; got 0). At Y0.0 this is the intentional scaffold state — Y0.5 will populate this directory.`,
    )
    return { ok: false, errors, notes }
  }

  for (const fileName of surfaceFiles) {
    const abs = path.join(dirAbs, fileName)
    const fileErrors = lintOneSurfaceFile(abs, fileName, errors, root)
    errors.push(...fileErrors)
  }

  notes.push(`scanned ${surfaceFiles.length} surface file(s) in ${DOGFOOD_DIR_REL}/`)
  if (surfaceFiles.length < 20) {
    errors.push(
      `dogfood matrix coverage: ${surfaceFiles.length}/20 surface files present (plan §9.1 requires 20)`,
    )
  }

  // Closeout-level checksum bundle companion file check
  // (§9.2.3 last bullet + plan §19 row 12 P2 #1).
  const checksumJsonRel =
    'docs/superpowers/audits/2026-05-23-stage-y-closeout/evidence-checksum-manifest.json'
  const checksumTxtRel =
    'docs/superpowers/audits/2026-05-23-stage-y-closeout/evidence-checksums.txt'
  if (fs.existsSync(path.join(root, checksumJsonRel))) {
    if (!fs.existsSync(path.join(root, checksumTxtRel))) {
      errors.push(
        `${checksumJsonRel} exists but companion ${checksumTxtRel} missing (§9.2.3 + plan §19 row 12)`,
      )
    }
  }

  return { ok: errors.length === 0, errors, notes }
}

if (require.main === module) {
  const result = main()
  if (result.ok) {
    console.log('[check-stage-y-dogfood-evidence] OK')
    for (const n of result.notes) console.log('  ' + n)
    process.exit(0)
  }
  console.error('[check-stage-y-dogfood-evidence] FAIL:')
  for (const e of result.errors) console.error('  - ' + e)
  if (result.notes.length) {
    console.error('  (informational notes:)')
    for (const n of result.notes) console.error('    ' + n)
  }
  process.exit(1)
}

module.exports = {
  main,
  SURFACE_OPERATOR_CLASS,
  REQUIRED_FRONTMATTER_KEYS,
  REQUIRED_BODY_SECTIONS,
  REQUIRED_BAI_SPOTCHECK_SUBFIELDS,
  parseFrontmatter,
  parseReproductionWindow,
}
