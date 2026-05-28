#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const {
  main: checkReleaseLiveEvidence,
} = require('./check-release-live-evidence.cjs')

const ROOT = path.resolve(__dirname, '..')
const CI_REPORT_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/ci-report.md'
const RELEASE_HANDOFF_REL =
  'docs/superpowers/audits/2026-05-23-stage-y-closeout/release-handoff.md'
const WORKFLOW_REL = '.github/workflows/ready-merge-gates.yml'
const AUDITS_REL = 'docs/superpowers/audits'
const EXPECTED_MANUAL_IDS = Array.from({ length: 19 }, (_, i) => `M${i + 1}`)
const EXPECTED_AGENT_ACCEPTANCE_IDS = [
  ...Array.from({ length: 3 }, (_, i) => `A${i + 1}`),
  ...Array.from({ length: 3 }, (_, i) => `B${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `C${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `D${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `E${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 4 }, (_, i) => `G${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `H${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `I${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `J${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `K${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `L${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `M${i + 1}`),
]
const REQUIRED_BRANCH_PROTECTION_CHECKS = [
  'Ready merge gates / merge',
  'Ready Windows packaged smoke / windows-packaged-smoke',
]
const STAGE_Z_EVIDENCE_PATH_RE = /docs\/superpowers\/audits\/[^\s|)]+stage-z[^\s|)]*/gi
const EVIDENCE_PATH_RE =
  /\b(?:docs|test-results|screenshots|artifacts|logs)\/[^\s|)]+/gi
const PLACEHOLDER_RE = /<[^>]+>|\bpending\b|\btodo\b|\btbd\b|待补|待定/i
const AUTOMATED_ONLY_AGENT_ACCEPTANCE_RE =
  /\b(?:npm\s+run|node\s+--import|tsx|--test|verify:agent-acceptance-checklist|agent-acceptance-checklist(?:\.test)?|automated(?:[-\s]+)?test|自动测试)\b/i

function readRel(root, rel, errors) {
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) {
    errors.push(`missing required file: ${rel}`)
    return null
  }
  return fs.readFileSync(abs, 'utf8')
}

function sectionBetween(text, startPattern, nextPattern) {
  const start = text.search(startPattern)
  if (start === -1) return ''
  const tail = text.slice(start)
  const next = tail.slice(1).search(nextPattern)
  return next === -1 ? tail : tail.slice(0, next + 1)
}

function stageZDirectories(root) {
  const auditsAbs = path.join(root, AUDITS_REL)
  if (!fs.existsSync(auditsAbs)) return []
  const directories = []
  for (const entry of fs.readdirSync(auditsAbs)) {
    if (!/stage-z/i.test(entry)) continue
    const dir = path.join(auditsAbs, entry)
    if (!fs.statSync(dir).isDirectory()) continue
    directories.push(dir)
  }
  return directories.sort()
}

function stageZFileCandidates(root, fileNames) {
  const directories = stageZDirectories(root)
  const currentDir = directories[directories.length - 1]
  if (!currentDir) return []
  const candidates = []
  for (const fileName of fileNames) {
    const abs = path.join(currentDir, fileName)
    if (fs.existsSync(abs)) candidates.push(abs)
  }
  return candidates.sort()
}

function rel(root, abs) {
  return path.relative(root, abs).replaceAll('\\', '/')
}

function normalizeEvidencePathMatch(match) {
  return String(match || '').replace(/[`'"]+/g, '').replace(/[),.;:]+$/g, '')
}

function extractStageZEvidencePaths(evidence) {
  return Array.from(String(evidence || '').matchAll(STAGE_Z_EVIDENCE_PATH_RE))
    .map((match) => normalizeEvidencePathMatch(match[0]))
}

function extractEvidencePaths(evidence) {
  return Array.from(String(evidence || '').matchAll(EVIDENCE_PATH_RE))
    .map((match) => normalizeEvidencePathMatch(match[0]))
}

function existingEvidencePaths(root, evidence) {
  return extractEvidencePaths(evidence).filter((evidencePath) =>
    fs.existsSync(path.join(root, evidencePath)),
  )
}

function existingLabeledEvidencePaths(root, text, labelPattern) {
  const paths = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!labelPattern.test(line)) continue
    paths.push(...existingEvidencePaths(root, line))
  }
  return paths
}

function hasPlaceholder(text) {
  return PLACEHOLDER_RE.test(String(text || ''))
}

function requireConcreteEvidencePath(root, context, evidence, errors) {
  if (hasPlaceholder(evidence)) {
    errors.push(`${context} evidence is missing or still a placeholder`)
    return []
  }
  const existingPaths = existingEvidencePaths(root, evidence)
  if (existingPaths.length === 0) {
    errors.push(`${context} evidence must reference an existing proof artifact`)
  }
  return existingPaths
}

function validateProofRecord(root, proofPath, id, kind) {
  const errors = []
  const relPath = proofPath.replaceAll('\\', '/')
  const text = fs.readFileSync(path.join(root, proofPath), 'utf8')
  if (hasPlaceholder(text)) {
    errors.push(`${relPath}: ${id} proof record still contains placeholder text`)
  }
  if (!new RegExp(`(?:item|id|manual|case)\\s*[:：]\\s*${id}\\b`, 'i').test(text)) {
    errors.push(`${relPath}: ${id} proof record must identify the checked item`)
  }
  if (!/(?:status|result|结果)\s*[:：]\s*pass/i.test(text)) {
    errors.push(`${relPath}: ${id} proof record must include status: pass`)
  }
  if (!/(?:evidence|artifact|screenshot|log|observed|result|证据|截图|日志|结果)\s*[:：]/i.test(text)) {
    errors.push(`${relPath}: ${id} proof record must include concrete evidence or result details`)
  }
  if (kind === 'simulated-human') {
    if (!/(?:operator|操作者)\s*[:：]\s*codex/i.test(text)) {
      errors.push(`${relPath}: ${id} proof record must name Codex as operator`)
    }
    if (!/(?:mode|模式)\s*[:：]\s*simulated[- ]human/i.test(text)) {
      errors.push(`${relPath}: ${id} proof record must mark mode: simulated-human`)
    }
  }
  return errors
}

function validateCiReport(text, errors) {
  const section = sectionBetween(text, /^## §3 First remote run URL/m, /^## /m)
  if (!section) {
    errors.push(`${CI_REPORT_REL}: missing §3 first remote run section`)
    return
  }
  if (!/https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/.test(section)) {
    errors.push(`${CI_REPORT_REL}: §3 requires a real GitHub Actions run URL`)
  }
  if (/\bpending\b/i.test(section)) {
    errors.push(`${CI_REPORT_REL}: §3 still contains pending first-remote-run language`)
  }
}

function validateDeepGatesWorkflow(text, errors) {
  const section = sectionBetween(text, /^\s{2}deep-gates:/m, /^\s{2}[a-zA-Z0-9_-]+:/m)
  if (!section) {
    errors.push(`${WORKFLOW_REL}: missing deep-gates job`)
    return
  }
  const ifMatch = section.match(/^\s*if:\s*(.+)\s*$/m)
  if (!ifMatch) return
  const condition = ifMatch[1].trim()
  if (/^false\s*(?:#.*)?$/i.test(condition)) {
    errors.push(`${WORKFLOW_REL}: deep-gates is still disabled with if: false`)
    return
  }
  if (/^true\s*(?:#.*)?$/i.test(condition)) return
  if (!/github\.event_name\s*==\s*['"]push['"]/.test(condition)) {
    errors.push(`${WORKFLOW_REL}: deep-gates if condition must allow push events`)
  }
}

function sourceManualIds(text) {
  const section = sectionBetween(text, /^## Section 3 — Manual release-engineer checklist/m, /^## Section 4/m)
  return new Set(
    section
      .split(/\r?\n/)
      .map((line) => line.match(/^\|\s*(M\d+)\s*\|/))
      .filter(Boolean)
      .map((match) => match[1]),
  )
}

function parseExecutedManualRows(text) {
  const rows = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(M\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/)
    if (!m) continue
    const id = m[1]
    const status = m[2].trim().toLowerCase()
    const evidence = m[3].trim()
    if (['pass', 'retired', 'not-applicable', 'n/a'].includes(status)) {
      rows.set(id, { status, evidence })
    }
  }
  return rows
}

function parseExecutedAgentAcceptanceRows(text) {
  const rows = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([A-M]\d+)\s*\|\s*([^|]+)\|\s*([^|]+)\|/)
    if (!m) continue
    rows.set(m[1], {
      status: m[2].trim().toLowerCase(),
      evidence: m[3].trim(),
    })
  }
  return rows
}

function validateExecutedManualChecklist(root, checklistAbs) {
  const errors = []
  const relPath = rel(root, checklistAbs)
  const rows = parseExecutedManualRows(fs.readFileSync(checklistAbs, 'utf8'))
  for (const id of EXPECTED_MANUAL_IDS) {
    const row = rows.get(id)
    if (!row) {
      errors.push(`${relPath}: missing executed ${id} row`)
      continue
    }
    if (row.status === 'pass') {
      const proofPaths = requireConcreteEvidencePath(root, `${relPath}: ${id}`, row.evidence, errors)
      for (const proofPath of proofPaths) {
        errors.push(...validateProofRecord(root, proofPath, id, 'manual'))
      }
      continue
    }
    if (!row.evidence || hasPlaceholder(row.evidence)) {
      errors.push(`${relPath}: ${id} retired/not-applicable evidence is missing or still a placeholder`)
      continue
    }
    if (!/(?:reason|rationale|not applicable|no longer applicable|retired because|原因|理由)/i.test(row.evidence)) {
      errors.push(`${relPath}: ${id} retired/not-applicable row must include a concrete reason`)
    }
  }
  return errors
}

function validateExecutedSimulatedHumanAcceptance(root, acceptanceAbs) {
  const errors = []
  const relPath = rel(root, acceptanceAbs)
  const text = fs.readFileSync(acceptanceAbs, 'utf8')
  if (!/(?:simulated[- ]human|模拟人类)/i.test(text)) {
    errors.push(`${relPath}: missing simulated-human operation marker`)
  }
  if (!/(?:operator|操作者)\s*[:：]\s*codex/i.test(text)) {
    errors.push(`${relPath}: missing Codex operator marker`)
  }
  const rows = parseExecutedAgentAcceptanceRows(text)
  for (const id of EXPECTED_AGENT_ACCEPTANCE_IDS) {
    const row = rows.get(id)
    if (!row) {
      errors.push(`${relPath}: missing simulated-human ${id} row`)
      continue
    }
    if (row.status !== 'pass') {
      errors.push(`${relPath}: ${id} status must be pass, got ${row.status || '(missing)'}`)
    }
    if (!row.evidence || hasPlaceholder(row.evidence)) {
      errors.push(`${relPath}: ${id} evidence is missing or still a placeholder`)
      continue
    }
    const evidencePaths = extractStageZEvidencePaths(row.evidence)
    if (evidencePaths.length === 0) {
      if (AUTOMATED_ONLY_AGENT_ACCEPTANCE_RE.test(row.evidence)) {
        errors.push(
          `${relPath}: ${id} evidence cannot be only automated test output; Stage Z requires a Codex-operated simulated-human operation record`,
        )
      }
      errors.push(
        `${relPath}: ${id} evidence must point to a Stage Z operation record under docs/superpowers/audits/*stage-z*/`,
      )
      continue
    }
    const existingPath = evidencePaths.find((evidencePath) =>
      fs.existsSync(path.join(root, evidencePath)),
    )
    if (!existingPath) {
      errors.push(
        `${relPath}: ${id} evidence must reference an existing Stage Z operation record`,
      )
      continue
    }
    errors.push(...validateProofRecord(root, existingPath, id, 'simulated-human'))
  }
  return errors
}

function validateManualChecklist(root, releaseHandoffText, errors, notes) {
  const sourceIds = sourceManualIds(releaseHandoffText)
  for (const id of EXPECTED_MANUAL_IDS) {
    if (!sourceIds.has(id)) {
      errors.push(`${RELEASE_HANDOFF_REL}: source manual checklist missing ${id}`)
    }
  }

  const candidates = stageZFileCandidates(root, [
    'release-manual-checklist.md',
    'manual-release-checklist.md',
    'release-readiness.md',
  ])
  if (candidates.length === 0) {
    errors.push(
      `${AUDITS_REL}/*stage-z*/release-manual-checklist.md: missing executed Stage Z manual checklist`,
    )
    return
  }

  const candidateResults = candidates.map((abs) => ({
    abs,
    errors: validateExecutedManualChecklist(root, abs),
  }))
  const passingCandidate = candidateResults.find((candidate) => candidate.errors.length === 0)
  if (passingCandidate) {
    notes.push(`manual checklist: ${rel(root, passingCandidate.abs)}`)
    return
  }

  const latestCandidate = candidateResults[candidateResults.length - 1]
  notes.push(`manual checklist checked: ${rel(root, latestCandidate.abs)}`)
  errors.push(
    `${AUDITS_REL}/*stage-z*/release-manual-checklist.md: no complete executed Stage Z manual checklist found among ${candidateResults.length} candidate(s)`,
  )
  errors.push(...latestCandidate.errors)
}

function validateSimulatedHumanAcceptance(root, errors, notes) {
  const candidates = stageZFileCandidates(root, [
    'simulated-human-agent-acceptance.md',
    'agent-acceptance-simulated-human.md',
    'release-readiness.md',
  ])
  if (candidates.length === 0) {
    errors.push(
      `${AUDITS_REL}/*stage-z*/simulated-human-agent-acceptance.md: missing Codex-operated simulated-human agent acceptance evidence`,
    )
    return
  }

  const candidateResults = candidates.map((abs) => ({
    abs,
    errors: validateExecutedSimulatedHumanAcceptance(root, abs),
  }))
  const passingCandidate = candidateResults.find((candidate) => candidate.errors.length === 0)
  if (passingCandidate) {
    notes.push(`simulated-human agent acceptance: ${rel(root, passingCandidate.abs)}`)
    return
  }

  const latestCandidate = candidateResults[candidateResults.length - 1]
  notes.push(`simulated-human agent acceptance checked: ${rel(root, latestCandidate.abs)}`)
  errors.push(
    `${AUDITS_REL}/*stage-z*/simulated-human-agent-acceptance.md: no complete Codex-operated simulated-human agent acceptance evidence found among ${candidateResults.length} candidate(s)`,
  )
  errors.push(...latestCandidate.errors)
}

function branchProtectionContexts(payload) {
  const checks = payload?.required_status_checks
  if (Array.isArray(checks)) return checks.map(String)
  if (!checks || typeof checks !== 'object') return []
  const contexts = Array.isArray(checks.contexts) ? checks.contexts : []
  const appChecks = Array.isArray(checks.checks)
    ? checks.checks.map((check) => check?.context).filter(Boolean)
    : []
  return [...contexts, ...appChecks].map(String)
}

function hasValidBranchProtectionApi(root, evidencePaths) {
  for (const evidencePath of evidencePaths) {
    if (!/branch-protection-api\.json$/.test(evidencePath)) continue
    try {
      const payload = JSON.parse(fs.readFileSync(path.join(root, evidencePath), 'utf8'))
      const contexts = new Set(branchProtectionContexts(payload))
      const strict = payload?.required_status_checks?.strict === true
      if (strict && REQUIRED_BRANCH_PROTECTION_CHECKS.every((check) => contexts.has(check))) {
        return true
      }
    } catch {
      // Invalid API JSON is not usable proof.
    }
  }
  return false
}

function validateBranchProtection(root, errors, notes) {
  const candidates = stageZFileCandidates(root, [
    'branch-protection.md',
    'ci-policy.md',
    'release-readiness.md',
  ])
  const matched = candidates.find((abs) => {
    const text = fs.readFileSync(abs, 'utf8')
    const evidencePaths = existingEvidencePaths(root, text)
    return (
      /(?:status|branch_protection_status)\s*:\s*pass/i.test(text) &&
      REQUIRED_BRANCH_PROTECTION_CHECKS.every((check) => text.includes(check)) &&
      /Require branches to be up to date/i.test(text) &&
      !hasPlaceholder(text) &&
      hasValidBranchProtectionApi(root, evidencePaths)
    )
  })
  if (!matched) {
    errors.push(
      `${AUDITS_REL}/*stage-z*/branch-protection.md: missing pass evidence for required merge and Windows smoke status checks + up-to-date branch protection`,
    )
    return
  }
  notes.push(`branch protection: ${rel(root, matched)}`)
}

function validatePlatformParity(root, errors, notes) {
  const candidates = stageZFileCandidates(root, [
    'platform-parity.md',
    'release-platform-smoke.md',
    'release-readiness.md',
  ])
  const matched = candidates.find((abs) => {
    const text = fs.readFileSync(abs, 'utf8')
    const macPaths = existingLabeledEvidencePaths(root, text, /macOS evidence\s*[:：]/i)
    const windowsPaths = existingLabeledEvidencePaths(root, text, /Windows evidence\s*[:：]/i)
    const distinctPaths = new Set([...macPaths, ...windowsPaths])
    return (
      /macOS packaged smoke\s*:\s*pass/i.test(text) &&
      /Windows packaged smoke\s*:\s*pass/i.test(text) &&
      !hasPlaceholder(text) &&
      macPaths.length > 0 &&
      windowsPaths.length > 0 &&
      distinctPaths.size >= 2
    )
  })
  if (!matched) {
    errors.push(
      `${AUDITS_REL}/*stage-z*/platform-parity.md: missing pass evidence for macOS and Windows packaged smokes`,
    )
    return
  }
  notes.push(`platform parity: ${rel(root, matched)}`)
}

function validateLiveSurfaceEvidence(root, errors, notes) {
  const liveResult = checkReleaseLiveEvidence({ root })
  if (!liveResult.ok) {
    errors.push(
      `release live evidence is not complete: ${liveResult.passCount}/${liveResult.total} surfaces pass`,
    )
    errors.push(...liveResult.errors)
    return
  }
  notes.push(`release live evidence: ${liveResult.passCount}/${liveResult.total} surfaces pass`)
}

function main({ root = ROOT } = {}) {
  const errors = []
  const notes = []
  const ciReport = readRel(root, CI_REPORT_REL, errors)
  const releaseHandoff = readRel(root, RELEASE_HANDOFF_REL, errors)
  const workflow = readRel(root, WORKFLOW_REL, errors)

  if (ciReport) validateCiReport(ciReport, errors)
  if (workflow) validateDeepGatesWorkflow(workflow, errors)
  if (releaseHandoff) validateManualChecklist(root, releaseHandoff, errors, notes)
  validateSimulatedHumanAcceptance(root, errors, notes)
  validateBranchProtection(root, errors, notes)
  validatePlatformParity(root, errors, notes)
  validateLiveSurfaceEvidence(root, errors, notes)

  return { ok: errors.length === 0, errors, notes }
}

if (require.main === module) {
  const result = main()
  if (result.ok) {
    console.log('[check-release-stage-z-readiness] OK')
    for (const note of result.notes) console.log('  ' + note)
    process.exit(0)
  }

  console.error('[check-release-stage-z-readiness] FAIL:')
  for (const error of result.errors) console.error('  - ' + error)
  if (result.notes.length > 0) {
    console.error('  (observed evidence:)')
    for (const note of result.notes) console.error('    ' + note)
  }
  process.exit(1)
}

module.exports = {
  CI_REPORT_REL,
  RELEASE_HANDOFF_REL,
  WORKFLOW_REL,
  EXPECTED_AGENT_ACCEPTANCE_IDS,
  EXPECTED_MANUAL_IDS,
  main,
  parseExecutedAgentAcceptanceRows,
  parseExecutedManualRows,
  validateExecutedManualChecklist,
  validateExecutedSimulatedHumanAcceptance,
}
