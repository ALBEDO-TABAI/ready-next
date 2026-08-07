const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { parse } = require('yaml')

const {
  assetRoot,
  auditRoot,
  readJson,
  repoRoot
} = require('../codex-runtime/contract-lib.cjs')

const planPath = path.join(
  repoRoot,
  'docs/superpowers/plans/2026-08-06-cod-ready-codex-runtime-minimal-replacement-experiment.md'
)

function readPlanFrontmatter() {
  const raw = fs.readFileSync(planPath, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  assert.ok(match, 'codex runtime plan frontmatter missing')
  return parse(match[1])
}

function readCurrentPhaseReport(phase) {
  const suffix = `-codex-runtime-${phase.toLowerCase()}-report.json`
  const matches = fs.readdirSync(auditRoot).filter((name) => name.endsWith(suffix))
  assert.equal(matches.length, 1, `expected one canonical ${phase} phase report`)
  return readJson(path.join(auditRoot, matches[0]))
}

test('rolling Codex implementation status agrees with the plan and current phase report', () => {
  const status = readJson(path.join(assetRoot, 'implementation-status.json'))
  const plan = readPlanFrontmatter()
  const completed = plan.phase_progress?.completed
  assert.ok(Array.isArray(completed) && completed.length > 0, 'plan completed phases missing')
  const currentPhase = completed.at(-1)
  assert.match(currentPhase, /^E[1-9]$/, 'current completed phase must be an implementation phase')

  const report = readCurrentPhaseReport(currentPhase)
  assert.equal(report.phase, currentPhase)
  assert.equal(report.status, 'PASS')
  assert.equal(report.nextPhaseAllowed, true)
  assert.equal(status.currentPhase, currentPhase)
  assert.equal(status.phases[currentPhase], 'passed')
  assert.equal(status.nextPhaseAllowed, report.nextPhaseAllowed)
  assert.equal(status.productImplementationStarted, true)
  assert.equal(status.failureCode, null)
  assert.equal(plan.status, `experiment-${currentPhase.toLowerCase()}-passed`)
  assert.equal(plan.route_revision?.phase, currentPhase)
  assert.equal(plan.phase_progress?.next, report.nextPhase)
  assert.equal(plan.phase_progress?.next_phase_allowed, report.nextPhaseAllowed)

  assert.equal(status.phases.E0, 'failed', 'the original E0 route remains historical FAIL')
  const currentNumber = Number(currentPhase.slice(1))
  for (let phaseNumber = currentNumber + 1; phaseNumber <= 9; phaseNumber += 1) {
    assert.equal(status.phases[`E${phaseNumber}`], 'not_started')
  }
  assert.equal(
    status.finalVerdict,
    currentPhase === 'E9' ? 'PASS' : 'PENDING',
    'full experiment verdict stays pending until E9 passes'
  )
})
