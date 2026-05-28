'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
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

function sha256(root, rel) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(root, rel)))
    .digest('hex')
}

function bytes(root, rel) {
  return fs.statSync(path.join(root, rel)).size
}

function addMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString()
}

function initGitBaseline(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'ready-tests@example.invalid'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Ready Tests'], { cwd: root })
  write(root, '.gitkeep', '')
  execFileSync('git', ['add', '.gitkeep'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' })
  return {
    sha: execFileSync('git', ['log', '-1', '--format=%H'], { cwd: root }).toString().trim(),
    date: execFileSync('git', ['log', '-1', '--format=%cI'], { cwd: root }).toString().trim(),
  }
}

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
  11: 'agent-only',
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

function writePassingDogfoodSurface(root, dogfoodDir, id, gitInfo) {
  const padded = String(id).padStart(2, '0')
  const slug = `surface-${padded}-test`
  const surface = `Surface ${id}`
  const artifactDir = `${dogfoodDir}/evidence/${slug}`
  const screenRel = `${artifactDir}/screen.png`
  const logRel = `${artifactDir}/app.log`
  const headRel = `${artifactDir}/head-capture.txt`
  const manifestRel = `${artifactDir}/manifest.json`
  const operatorClass = SURFACE_OPERATOR_CLASS[id]
  const windowStart = gitInfo.date
  const windowEnd = addMs(gitInfo.date, 10_000)

  write(root, screenRel, `screen ${id}\n`)
  write(root, logRel, `${windowStart} surface ${id}\n${windowEnd} surface ${id}\n`)
  write(
    root,
    headRel,
    [
      `build_commit=${gitInfo.sha}`,
      `captured_at=${gitInfo.date}`,
      'git_status_porcelain=0',
      '',
    ].join('\n'),
  )

  const artifacts = [
    {
      type: 'screencap',
      path: 'screen.png',
      bytes: bytes(root, screenRel),
      sha256: sha256(root, screenRel),
    },
    {
      type: 'log',
      path: 'app.log',
      bytes: bytes(root, logRel),
      sha256: sha256(root, logRel),
      log_earliest_timestamp: windowStart,
      log_latest_timestamp: windowEnd,
    },
    {
      type: 'head-capture',
      path: 'head-capture.txt',
      bytes: bytes(root, headRel),
      sha256: sha256(root, headRel),
    },
  ]

  const spotcheckLines = []
  if (operatorClass !== 'agent-only') {
    const spotRel = `${artifactDir}/spotcheck.txt`
    write(root, spotRel, `spotcheck ${id}\n`)
    artifacts.push({
      type: 'spotcheck',
      path: 'spotcheck.txt',
      bytes: bytes(root, spotRel),
      sha256: sha256(root, spotRel),
    })
    spotcheckLines.push(
      'bai_spotcheck:',
      '  performed_by: 白',
      `  performed_at: ${gitInfo.date}`,
      `  spotcheck_evidence: evidence/${slug}/spotcheck.txt`,
      `  spotcheck_sha256: ${sha256(root, spotRel)}`,
      '  spotcheck_signoff_text: looks good',
    )
  }

  write(
    root,
    manifestRel,
    `${JSON.stringify({
      surface_id: id,
      surface,
      build_commit: gitInfo.sha,
      operator: 'Codex',
      hardware: 'test-runner',
      captured_at: gitInfo.date,
      artifacts,
    }, null, 2)}\n`,
  )

  const surfaceSpecific = []
  if (id === 10) surfaceSpecific.push('HTTP 402 was covered.')
  if (id === 13) {
    surfaceSpecific.push('### Sub-flow 13.a', '### Sub-flow 13.b', '### Sub-flow 13.c', '### Sub-flow 13.d', '### Sub-flow 13.e')
  }

  write(
    root,
    path.join(dogfoodDir, `${slug}.md`),
    [
      '---',
      `surface: ${surface}`,
      `surface_id: ${id}`,
      'date: 2026-05-28',
      'operator: Codex',
      `operator_class: ${operatorClass}`,
      'hardware: test-runner',
      `build_commit: ${gitInfo.sha}`,
      `build_commit_captured_at: ${gitInfo.date}`,
      'status: pass',
      `artifact_manifest: evidence/${slug}/manifest.json`,
      ...spotcheckLines,
      '---',
      '',
      `# ${surface}`,
      '',
      '## Reproduction steps',
      'Run the surface.',
      '',
      '## Expected result',
      'The surface works.',
      '',
      '## Observed result',
      'The surface worked.',
      '',
      '## Evidence artifacts',
      `See evidence/${slug}/manifest.json.`,
      '',
      '## Timestamp alignment',
      `Reproduction window: ${windowStart} → ${windowEnd}`,
      '',
      '## Pass/fail rationale',
      'status: pass',
      ...surfaceSpecific,
      '',
    ].join('\n'),
  )
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
  const dogfoodDir = 'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood'
  const gitInfo = initGitBaseline(root)
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
    JSON.stringify({
      required_status_checks: {
        strict: true,
        contexts: [
          'Ready merge gates / merge',
          'Ready Windows packaged smoke / windows-packaged-smoke',
        ],
        checks: [
          { context: 'Ready merge gates / merge' },
          { context: 'Ready Windows packaged smoke / windows-packaged-smoke' },
        ],
      },
    }),
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
      '- Required check: Ready Windows packaged smoke / windows-packaged-smoke',
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
  for (let id = 1; id <= 20; id += 1) {
    writePassingDogfoodSurface(root, dogfoodDir, id, gitInfo)
  }
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

  assert.equal(result.ok, true, result.errors.join('\n'))
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

  assert.equal(result.ok, true, result.errors.join('\n'))
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
  assert.match(result.errors.join('\n'), /missing pass evidence for required merge and Windows smoke status checks/)
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

  assert.equal(result.ok, true, result.errors.join('\n'))
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
  assert.match(result.errors.join('\n'), /missing pass evidence for required merge and Windows smoke status checks/)
  assert.match(result.errors.join('\n'), /missing pass evidence for macOS and Windows packaged smokes/)
  assert.match(result.errors.join('\n'), /dogfood directory missing/)
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

  assert.equal(result.ok, true, result.errors.join('\n'))
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
  assert.match(result.errors.join('\n'), /missing pass evidence for required merge and Windows smoke status checks/)
})

test('rejects branch protection prose without API evidence for required checks', () => {
  const root = makeRoot()
  writePassingFixture(root)
  write(root, 'docs/superpowers/audits/2026-05-24-stage-z-closeout/branch-protection-api.json', '{}')

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing pass evidence for required merge and Windows smoke status checks/)
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

test('allows deferred out-of-scope remote live evidence when Stage Z documents are otherwise complete', () => {
  const root = makeRoot()
  writePassingFixture(root)
  const surface11Rel =
    'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-11-test.md'
  write(
    root,
    surface11Rel,
    fs
      .readFileSync(path.join(root, surface11Rel), 'utf8')
      .replace(
        'status: pass',
        [
          'status: deferred-with-owner',
          'deferred_owner: 白',
          'deferred_reason: Remote channel surfaces are out of scope for this release goal.',
        ].join('\n'),
      ),
  )

  const result = main({ root })

  assert.equal(result.ok, true)
  assert.match(result.notes.join('\n'), /release live evidence: 19\/19 in-scope surfaces pass; out-of-scope remote surfaces: 11/)
})
