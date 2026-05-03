const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const test = require('node:test')

const ROOT = resolve(__dirname, '..', '..')

test('agent:probe:vea-resume runs a DirectChat/TurnEngine closed-loop smoke and reports tool truth', () => {
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
  assert.equal(report.agentEntrypoint, 'ClaudeSdkOrchestrator.sendAndCollect')
  assert.equal(report.result.terminalReason, 'done')
  assert.ok(report.dispatchedTools.includes('skill_inspect_run_state'))
  assert.ok(report.dispatchedTools.includes('skill_video_expert_ai_analyze'))
  assert.equal(report.dispatchedTools.includes('skill_video_expert_pipeline'), false)
  assert.equal(report.assertions.aiAnalyzeDispatched, true)
  assert.equal(report.assertions.pipelineNotDispatched, true)
  assert.equal(report.assertions.toolPolicyRefreshed, true)
  assert.ok(report.logExcerpt.some((line) => line.includes('turn_frame_tool_policy_refreshed')))
})
