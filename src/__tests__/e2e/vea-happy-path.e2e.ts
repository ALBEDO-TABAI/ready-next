import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  __resetSkillChildRunnerForTests,
  configureSkillChildRunner,
  startSkillChildRun,
  waitForSkillChildRunClose,
} from '../../main/modules/agent-control/skills/skill-child-runner'
import {
  __resetSkillChildDriversForTests,
  registerSkillChildDriver,
} from '../../main/modules/agent-control/skills/skill-child-drivers'
import { videoExpertChildDriver } from '../../main/modules/agent-control/video-expert-child-driver'

import {
  createVeaE2eHarness,
  fixtureVideoPath,
  hasFfmpeg,
  hasPySceneDetect,
} from './harness'

const E2E_ENABLED = process.env.READY_E2E === '1'
const TEST_NAME = 'VEA e2e: startSkillChildRun penetrates real ffmpeg before AI mock short-circuit'

if (!E2E_ENABLED) {
  test(TEST_NAME, { skip: 'set READY_E2E=1 to enable VEA e2e' }, () => {})
} else {
  test(TEST_NAME, async (t) => {
    if (!(await hasFfmpeg())) {
      t.skip('ffmpeg is not available on PATH')
      return
    }
    if (!(await hasPySceneDetect())) {
      t.skip('PySceneDetect is not available to python3')
      return
    }

    const fixtureStat = await stat(fixtureVideoPath)
    assert.ok(fixtureStat.size > 0, 'fixture mp4 must exist and be non-empty')
    assert.ok(fixtureStat.size < 2 * 1024 * 1024, 'fixture mp4 must stay under 2MB')

    const harness = await createVeaE2eHarness()
    t.after(async () => {
      await harness.cleanup()
      __resetSkillChildRunnerForTests()
      __resetSkillChildDriversForTests()
    })

    __resetSkillChildRunnerForTests()
    __resetSkillChildDriversForTests()
    registerSkillChildDriver(videoExpertChildDriver)
    configureSkillChildRunner({
      runtimeManager: harness.runtime.manager,
      repository: harness.repository,
      launchStuckGuardMs: 15_000,
      maxActionsPerRun: 6,
    })

    const launch = await startSkillChildRun({
      scopeId: 'vea-e2e-scope',
      sessionId: 'vea-e2e-session',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: {
        url: fixtureVideoPath,
        outputDir: harness.outputDir,
        sceneThreshold: 1,
        bestThreshold: 7.5,
      },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })

    assert.equal(launch.status, 'running')

    const close = await waitForSkillChildRunClose(launch.childRunId, { timeoutMs: 60_000 })
    assert.equal(close.kind, 'closed', 'close event must arrive before timeout')
    assert.notEqual(close.closeEvent.terminalReason, 'host_unavailable')

    assert.equal(harness.runtime.calls.length >= 1, true)

    const sceneOutput = harness.runtime.materialsOutput?.sceneClipPath
    assert.ok(sceneOutput, 'runtime must record real ffmpeg scene output')
    const sceneOutputStat = await stat(sceneOutput)
    assert.ok(sceneOutputStat.size > 0, 'true ffmpeg/scenedetect output must be non-empty')

    const eventLog = await readFile(launch.eventLogPath, 'utf8')
    const events = eventLog
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; action?: string })
    const actionStarts = events
      .filter((event) => event.type === 'action_started')
      .map((event) => event.action)
    assert.deepEqual(actionStarts.slice(0, 2), ['video_expert_pipeline', 'video_expert_ai_analyze'])

    const runStatePath = join(harness.outputDir, 'run_state.json')
    const runState = JSON.parse(await readFile(runStatePath, 'utf8')) as { current_stage?: string; status?: string }
    assert.equal(
      harness.runtime.materialsOutput?.sceneDetectionAdvancedBeforeAi,
      true,
      `plan must reach ffmpeg/scenedetect before AI short-circuit; run_state=${JSON.stringify(runState)}`,
    )
  })
}
