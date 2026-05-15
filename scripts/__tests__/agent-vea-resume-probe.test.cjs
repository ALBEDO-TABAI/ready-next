const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const ROOT = resolve(__dirname, '..', '..')

test('agent:probe:vea-resume runs a Ready Agent SDK closed-loop smoke and reports tool truth', () => {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  assert.equal(
    packageJson.scripts['agent:probe:vea-resume'],
    'npx tsx@^4.19.2 scripts/agent-vea-resume-probe.ts',
  )

  const result = spawnSync('npm', ['run', '-s', 'agent:probe:vea-resume', '--', '--fixture', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  })

  assert.equal(result.status, 0, `probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  const report = JSON.parse(result.stdout)

  assert.equal(report.success, true)
  assert.equal(report.scenario, 'vea_resume_score_batches')
  assert.equal(report.agentEntrypoint, 'ReadyAgentOrchestrator.sendAndCollect')
  // Stage N (Phase 1.2) — VEA contract without childRunId now hits the
  // manifest fence; the turn closes via checkpoint, not legacy `done`.
  assert.ok(
    ['checkpoint_budget', 'checkpoint_user_input', 'checkpoint_background'].includes(report.result.terminalReason),
    `expected a checkpoint terminal reason, got ${report.result.terminalReason}`,
  )
  // ai_analyze MUST NOT be dispatched (manifest fence blocks both the
  // typed-action allowlist entry AND parent-force synthesis).
  assert.equal(report.dispatchedTools.includes('skill_video_expert_pipeline'), false)
  assert.equal(report.dispatchedTools.includes('skill_video_expert_ai_analyze'), false)
  assert.equal(report.assertions.aiAnalyzeDispatched, false)
  assert.equal(report.assertions.pipelineNotDispatched, true)
  assert.equal(report.assertions.sdkCheckpointRecovered, true)
  assert.equal(report.assertions.veaTypedActionsExcludedFromAllowed, true)
  // The model's allowedToolNames snapshots must never include VEA typed
  // actions (defense-in-depth: the manifest fence at the synthesis site
  // is mirrored by exclusion from preferredToolNames upstream).
})
