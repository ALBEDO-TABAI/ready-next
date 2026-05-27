'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  CI_REPORT_REL,
  EXPECTED_AGENT_ACCEPTANCE_IDS,
  EXPECTED_MANUAL_IDS,
  RELEASE_HANDOFF_REL,
  WORKFLOW_REL,
  main,
} = require('../check-release-stage-z-readiness.cjs')

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ready-stage-z-'))
}

function write(root, rel, text) {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function baseReleaseHandoff() {
  return [
    '# Handoff',
    '',
    '## Section 3 — Manual release-engineer checklist',
    '',
    '| # | Manual operation | Owner | Due | Evidence path |',
    '| ---: | --- | --- | --- | --- |',
    ...EXPECTED_MANUAL_IDS.map(
      (id) => `| ${id} | Operation ${id} | Stage Z | T-1 | docs/release/<release-tag>/${id}.md |`,
    ),
    '',
    '## Section 4 — Retired-with-reason rows',
    '',
  ].join('\n')
}

function writePassingFixture(root) {
  const zDir = 'docs/superpowers/audits/2026-05-24-stage-z-closeout'
  for (const id of EXPECTED_MANUAL_IDS) {
    write(
      root,
      path.join(zDir, 'manual', `${id}.md`),
      [
        `# ${id} manual release operation`,
        '',
        `item: ${id}`,
        'status: pass',
        'evidence: screenshot and command output captured in this record',
        'result: pass',
      ].join('\n'),
    )
  }
  for (const id of EXPECTED_AGENT_ACCEPTANCE_IDS) {
    write(
      root,
      path.join(zDir, 'agent-acceptance', `${id}.md`),
      [
        `# ${id} simulated-human operation record`,
        '',
        'operator: Codex',
        'mode: simulated-human',
        `item: ${id}`,
        'status: pass',
        'evidence: visible operation result captured by Codex',
        'result: pass',
      ].join('\n'),
    )
  }
  write(
    root,
    path.join(zDir, 'branch-protection-api.json'),
    '{"required_status_checks":["Ready merge gates / merge"],"strict":true}',
  )
  write(
    root,
    path.join(zDir, 'platform-macos-smoke.md'),
    'item: macOS packaged smoke\nstatus: pass\nevidence: launched packaged app and captured route smoke',
  )
  write(
    root,
    path.join(zDir, 'platform-windows-smoke.md'),
    'item: Windows packaged smoke\nstatus: pass\nevidence: launched packaged app and captured route smoke',
  )
  write(
    root,
    CI_REPORT_REL,
    [
      '# CI report',
      '',
      '## §3 First remote run URL (Y0.2.b)',
      '',
      '- Deep-gates decision: flipped to `if: github.event_name == \'push\'`.',
      '- First run URL: https://github.com/example/ready/actions/runs/123456789',
    ].join('\n'),
  )
  write(root, RELEASE_HANDOFF_REL, baseReleaseHandoff())
  write(
    root,
    WORKFLOW_REL,
    [
      'jobs:',
      '  merge:',
      '    runs-on: macos-latest',
      '  deep-gates:',
      "    if: github.event_name == 'push'",
      '    runs-on: macos-latest',
      '    steps: []',
    ].join('\n'),
  )
  write(
    root,
    path.join(zDir, 'release-manual-checklist.md'),
    [
      '# Manual checklist',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_MANUAL_IDS.map((id) => `| ${id} | pass | ${zDir}/manual/${id}.md |`),
    ].join('\n'),
  )
  write(
    root,
    path.join(zDir, 'branch-protection.md'),
    [
      'status: pass',
      '',
      '- Required check: Ready merge gates / merge',
      '- Require branches to be up to date before merging',
      `- Evidence: ${zDir}/branch-protection-api.json`,
    ].join('\n'),
  )
  write(
    root,
    path.join(zDir, 'platform-parity.md'),
    [
      'macOS packaged smoke: pass',
      `macOS evidence: ${zDir}/platform-macos-smoke.md`,
      'Windows packaged smoke: pass',
      `Windows evidence: ${zDir}/platform-windows-smoke.md`,
    ].join('\n'),
  )
  write(
    root,
    path.join(zDir, 'simulated-human-agent-acceptance.md'),
    [
      '# Codex simulated-human agent acceptance',
      '',
      'operator: Codex',
      'mode: simulated-human',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_AGENT_ACCEPTANCE_IDS.map((id) => `| ${id} | pass | ${zDir}/agent-acceptance/${id}.md |`),
    ].join('\n'),
  )
}

function writeUnresolvedFixture(root) {
  write(
    root,
    CI_REPORT_REL,
    [
      '# CI report',
      '',
      '## §3 First remote run URL (Y0.2.b)',
      '',
      '_(pending - populated at Y0.2.b)_',
    ].join('\n'),
  )
  write(root, RELEASE_HANDOFF_REL, baseReleaseHandoff())
  write(
    root,
    WORKFLOW_REL,
    [
      'jobs:',
      '  merge:',
      '    runs-on: macos-latest',
      '  deep-gates:',
      '    if: false',
      '    runs-on: macos-latest',
      '    steps: []',
    ].join('\n'),
  )
}

test('accepts complete Stage Z release-readiness evidence', () => {
  const root = makeRoot()
  writePassingFixture(root)

  const result = main({ root })

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('accepts a complete manual checklist when older candidates are incomplete', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-23-stage-z-closeout/release-readiness.md',
    [
      '# Older release readiness',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      '| M1 | pass | pending |',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, true)
  assert(
    result.notes.some((note) =>
      note.includes('2026-05-24-stage-z-closeout/release-manual-checklist.md'),
    ),
  )
})

test('rejects stale Stage Z pass evidence when the latest candidate is incomplete', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-25-stage-z-closeout/release-readiness.md',
    [
      '# Current release readiness',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      '| M1 | pass | docs/release/current/M1.md |',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing executed M2 row/)
  assert.match(result.errors.join('\n'), /Codex-operated simulated-human/)
  assert.match(result.errors.join('\n'), /missing pass evidence for required status check/)
  assert.match(result.errors.join('\n'), /missing pass evidence for macOS and Windows packaged smokes/)
  assert(
    result.notes.every((note) => !note.includes('2026-05-24-stage-z-closeout')),
    'older Stage Z evidence must not be accepted once a newer candidate exists',
  )
})

test('rejects stale first-remote placeholders even when a run URL is present', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    CI_REPORT_REL,
    [
      '# CI report',
      '',
      '## §3 First remote run URL (Y0.2.b)',
      '',
      '- First run URL: https://github.com/example/ready/actions/runs/123456789',
      '- Y0.2.b pending until release engineer confirms the run.',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /pending first-remote-run language/)
})

test('rejects deep-gates conditions that cannot run on push', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    WORKFLOW_REL,
    [
      'jobs:',
      '  merge:',
      '    runs-on: macos-latest',
      '  deep-gates:',
      "    if: github.event_name == 'pull_request'",
      '    runs-on: macos-latest',
      '    steps: []',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /deep-gates if condition must allow push events/)
})

test('accepts always-on deep-gates condition', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    WORKFLOW_REL,
    [
      'jobs:',
      '  merge:',
      '    runs-on: macos-latest',
      '  deep-gates:',
      '    if: true',
      '    runs-on: macos-latest',
      '    steps: []',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, true)
})

test('rejects CI reports that keep a pending placeholder after adding a run URL', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    CI_REPORT_REL,
    [
      '# CI report',
      '',
      '## §3 First remote run URL (Y0.2.b)',
      '',
      '- First run URL: https://github.com/example/ready/actions/runs/123456789',
      '',
      '_(pending - populated at Y0.2.b)_',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /pending first-remote-run language/)
})

test('rejects unresolved Stage Z handoff evidence without depending on the live workspace', () => {
  const root = makeRoot()
  writeUnresolvedFixture(root)

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /requires a real GitHub Actions run URL/)
  assert.match(result.errors.join('\n'), /deep-gates is still disabled/)
  assert.match(result.errors.join('\n'), /missing executed Stage Z manual checklist/)
  assert.match(result.errors.join('\n'), /missing Codex-operated simulated-human/)
  assert.match(result.errors.join('\n'), /missing pass evidence for required status check/)
  assert.match(result.errors.join('\n'), /missing pass evidence for macOS and Windows packaged smokes/)
})

test('rejects incomplete or placeholder manual checklist evidence', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/release-manual-checklist.md',
    [
      '# Manual checklist',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      '| M1 | pass | docs/release/<release-tag>/M1.md |',
      '| M2 | pass | pending |',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /M1 evidence is missing or still a placeholder/)
  assert.match(result.errors.join('\n'), /M2 evidence is missing or still a placeholder/)
  assert.match(result.errors.join('\n'), /missing executed M3 row/)
})

test('rejects incomplete or placeholder simulated-human agent acceptance evidence', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/simulated-human-agent-acceptance.md',
    [
      '# Codex simulated-human agent acceptance',
      '',
      'operator: Codex',
      'mode: simulated-human',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      '| A1 | pass | pending |',
      '| A2 | fail | docs/release/v1/agent-acceptance/A2.md |',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /A1 evidence is missing or still a placeholder/)
  assert.match(result.errors.join('\n'), /A2 status must be pass/)
  assert.match(result.errors.join('\n'), /missing simulated-human A3 row/)
})

test('rejects automated-only simulated-human agent acceptance evidence', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/simulated-human-agent-acceptance.md',
    [
      '# Codex simulated-human agent acceptance',
      '',
      'operator: Codex',
      'mode: simulated-human',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_AGENT_ACCEPTANCE_IDS.map((id) => `| ${id} | pass | npm run verify:agent-acceptance-checklist |`),
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /cannot be only automated test output/)
  assert.match(result.errors.join('\n'), /must point to a Stage Z operation record/)
})

test('rejects missing per-item Stage Z operation record files', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/simulated-human-agent-acceptance.md',
    [
      '# Codex simulated-human agent acceptance',
      '',
      'operator: Codex',
      'mode: simulated-human',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_AGENT_ACCEPTANCE_IDS.map((id) => `| ${id} | pass | docs/superpowers/audits/2026-05-24-stage-z-closeout/missing/${id}.md |`),
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /evidence must reference an existing Stage Z operation record/)
})

test('accepts Markdown-quoted Stage Z operation record paths', () => {
  const root = makeRoot()
  writePassingFixture(root)
  const zDir = 'docs/superpowers/audits/2026-05-24-stage-z-closeout'
  write(
    root,
    path.join(zDir, 'simulated-human-agent-acceptance.md'),
    [
      '# Codex simulated-human agent acceptance',
      '',
      'operator: Codex',
      'mode: simulated-human',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_AGENT_ACCEPTANCE_IDS.map((id) => `| ${id} | pass | \`${zDir}/agent-acceptance/${id}.md\` |`),
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, true)
})

test('rejects empty per-item Stage Z operation record files', () => {
  const root = makeRoot()
  writePassingFixture(root)
  const zDir = 'docs/superpowers/audits/2026-05-24-stage-z-closeout'
  for (const id of EXPECTED_AGENT_ACCEPTANCE_IDS) {
    write(root, path.join(zDir, 'agent-acceptance', `${id}.md`), '')
  }

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /proof record must identify the checked item/)
  assert.match(result.errors.join('\n'), /proof record must include status: pass/)
  assert.match(result.errors.join('\n'), /proof record must name Codex as operator/)
})

test('rejects manual checklist pass rows without existing proof records', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/release-manual-checklist.md',
    [
      '# Manual checklist',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_MANUAL_IDS.map((id) => `| ${id} | pass | docs/release/v1/${id}.md |`),
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /M1 evidence must reference an existing proof artifact/)
})

test('rejects retired manual checklist rows without a concrete reason', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/release-manual-checklist.md',
    [
      '# Manual checklist',
      '',
      '| ID | Status | Evidence |',
      '| --- | --- | --- |',
      ...EXPECTED_MANUAL_IDS.map((id) => `| ${id} | retired | not needed |`),
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /retired\/not-applicable row must include a concrete reason/)
})

test('rejects keyword-only branch protection evidence', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/branch-protection.md',
    [
      'status: pass',
      'Ready merge gates / merge',
      'Require branches to be up to date',
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing pass evidence for required status check/)
})

test('rejects keyword-only platform parity evidence', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(
    root,
    'docs/superpowers/audits/2026-05-24-stage-z-closeout/platform-parity.md',
    ['macOS packaged smoke: pass', 'Windows packaged smoke: pass'].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing pass evidence for macOS and Windows packaged smokes/)
})

test('rejects platform parity when macOS and Windows point to the same proof artifact', () => {
  const root = makeRoot()
  writePassingFixture(root)
  const zDir = 'docs/superpowers/audits/2026-05-24-stage-z-closeout'
  write(
    root,
    path.join(zDir, 'platform-parity.md'),
    [
      'macOS packaged smoke: pass',
      `macOS evidence: ${zDir}/platform-macos-smoke.md`,
      'Windows packaged smoke: pass',
      `Windows evidence: ${zDir}/platform-macos-smoke.md`,
    ].join('\n'),
  )

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing pass evidence for macOS and Windows packaged smokes/)
})
