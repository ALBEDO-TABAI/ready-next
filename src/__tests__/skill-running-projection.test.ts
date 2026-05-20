import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { buildLongSkillRunningProjection } from '../main/modules/agent-control/skills/skill-running-projection'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

test('long skill running projection includes run_state and intermediate artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const jobDir = join(root, 'job-1')
    mkdirSync(jobDir, { recursive: true })
    const runStatePath = join(jobDir, 'run_state.json')
    const sceneScoresPath = join(jobDir, 'scene_scores.json')
    const reportPath = join(jobDir, 'analysis_report.md')

    writeFileSync(runStatePath, JSON.stringify({
      status: 'running',
      current_step: 'score_batches',
      completed_steps: ['prepare'],
      waiting_for: 'scene scoring',
      updated_at: '2026-04-27T06:10:00.000Z',
    }), 'utf8')
    writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
    writeFileSync(reportPath, '# report\n', 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 65_000,
    })

    assert.match(String(projection.taskSummary), /score_batches/)
    assert.match(String(projection.taskSummary), /中间文件/)
    assert.match(String((projection.steps as Array<{ detail?: string }>)[0]?.detail), /scene scoring/)
    const artifacts = projection.recentArtifacts as Array<{ label: string; path?: string | null }>
    assert.ok(artifacts.some((artifact) => artifact.path === runStatePath && artifact.label === 'run_state.json'))
    assert.ok(artifacts.some((artifact) => artifact.path === sceneScoresPath && artifact.label === 'scene_scores.json'))
    assert.ok(artifacts.some((artifact) => artifact.path === reportPath && artifact.label === 'analysis_report.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection infers output directory from sceneScoresPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const sceneScoresPath = join(root, 'scene_scores.json')
    const runStatePath = join(root, 'run_state.json')
    writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
    writeFileSync(runStatePath, JSON.stringify({
      status: 'running',
      currentStep: 'merge_validate',
    }), 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_ai_analyze',
      toolInput: { sceneScoresPath },
      startedAt: 0,
      now: 5_000,
    })

    assert.match(String(projection.taskSummary), /merge_validate/)
    const artifacts = projection.recentArtifacts as Array<{ label: string; path?: string | null }>
    assert.ok(artifacts.some((artifact) => artifact.path === sceneScoresPath))
    assert.ok(artifacts.some((artifact) => artifact.path === runStatePath))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection does not select newest run_state without identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const targetDir = join(root, 'target-task')
    const otherDir = join(root, 'other-task')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    const targetRunState = join(targetDir, 'run_state.json')
    const otherRunState = join(otherDir, 'run_state.json')
    writeFileSync(targetRunState, JSON.stringify({
      task_id: 'target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf8')
    writeFileSync(otherRunState, JSON.stringify({
      task_id: 'other',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf8')
    utimesSync(targetRunState, new Date('2026-04-28T00:00:00.000Z'), new Date('2026-04-28T00:00:00.000Z'))
    utimesSync(otherRunState, new Date('2026-04-28T00:05:00.000Z'), new Date('2026-04-28T00:05:00.000Z'))

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 65_000,
    })

    assert.doesNotMatch(String(projection.taskSummary), /completed/)
    assert.match(String(projection.taskSummary), /多个 run_state/)
    assert.deepEqual(projection.resumableActions, ['none'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection selects matching run_state when task identity is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const targetDir = join(root, 'target-task')
    const otherDir = join(root, 'other-task')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(targetDir, 'run_state.json'), JSON.stringify({
      task_id: 'target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf8')
    writeFileSync(join(otherDir, 'run_state.json'), JSON.stringify({
      task_id: 'other',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root, taskId: 'target' },
      startedAt: 0,
      now: 65_000,
    })

    assert.match(String(projection.taskSummary), /score_batches/)
    assert.doesNotMatch(String(projection.taskSummary), /多个 run_state/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection selects child-owned run_state under a shared output root', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-child-'))
  try {
    const targetDir = join(root, 'target-task')
    const otherDir = join(root, 'other-task')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(targetDir, 'run_state.json'), JSON.stringify({
      child_run_id: 'vqfy70dlv',
      current_stage: 'prepare',
      total_scenes: 90,
      completed_scenes: 20,
      coverage_ratio: 0.2222,
      status: 'running',
    }), 'utf8')
    writeFileSync(join(otherDir, 'run_state.json'), JSON.stringify({
      child_run_id: 'other-child',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: {
        outputDir: root,
        __childRunContext: { childRunId: 'vqfy70dlv' },
      },
      startedAt: 0,
      now: 65_000,
    })

    assert.match(String(projection.taskSummary), /prepare/)
    assert.match(String(projection.taskSummary), /20\/90/)
    assert.doesNotMatch(String(projection.taskSummary), /多个 run_state/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection carries structured handoff progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-handoff-'))
  try {
    mkdirSync(join(root, 'audiovisual_handoff', 'body'), { recursive: true })
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      current_stage: 'finalize',
      total_scenes: 3,
      completed_scenes: 3,
      status: 'blocked',
    }), 'utf8')
    writeFileSync(join(root, 'scene_scores.json'), JSON.stringify({
      scenes: [],
      total_scenes: 3,
    }), 'utf8')
    writeFileSync(join(root, 'audiovisual_handoff', 'receipt.json'), JSON.stringify({
      tasks: {
        body: {
          status: 'pending',
          task: 'audiovisual_handoff/body/task.md',
          output: 'audiovisual_handoff/body/output.md',
        },
      },
    }), 'utf8')
    writeFileSync(join(root, 'audiovisual_handoff', 'body', 'task.md'), 'write body', 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 65_000,
    })

    const progress = projection.progress as { handoff?: { userMessage?: string; taskPath?: string } } | undefined
    assert.equal(progress?.handoff?.userMessage, '视听报告正文还需要继续生成。')
    assert.ok(String(progress?.handoff?.taskPath || '').endsWith('audiovisual_handoff/body/task.md'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection skips mismatched root run_state when task identity is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-'))
  try {
    const targetDir = join(root, 'target-task')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      task_id: 'other',
      current_stage: 'completed',
      status: 'completed',
    }), 'utf8')
    writeFileSync(join(targetDir, 'run_state.json'), JSON.stringify({
      task_id: 'target',
      current_stage: 'score_batches',
      status: 'running',
    }), 'utf8')

    const projection = buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root, taskId: 'target' },
      startedAt: 0,
      now: 65_000,
    })

    assert.match(String(projection.taskSummary), /score_batches/)
    assert.doesNotMatch(String(projection.taskSummary), /completed/)
    assert.doesNotMatch(String(projection.taskSummary), /多个 run_state/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection still shows a live confirmation before artifacts exist', () => {
  const projection = buildLongSkillRunningProjection({
    sessionId: 's1',
    toolName: 'skill_video_expert_pipeline',
    toolInput: {},
    startedAt: 0,
    now: 10_000,
  })

  assert.match(String(projection.taskSummary), /工具仍在运行/)
})

test('long skill running projection emits phase-specific metrics for partial stat and parse failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-metric-'))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const runStatePath = join(root, 'run_state.json')
    writeFileSync(runStatePath, '{not-json', 'utf8')

    buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: root },
      startedAt: 0,
      now: 10_000,
    })
    buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: join(root, 'missing') },
      startedAt: 0,
      now: 10_000,
    })

    const partials = events.filter((event) => event.metric === TOOL_ERROR_METRICS.skillProjectionPartial)
    assert.ok(partials.some((event) => event.phase === 'parse' && event.path === runStatePath && event.errorKind === 'SyntaxError'))
    assert.ok(partials.some((event) => event.phase === 'stat' && event.path === join(root, 'missing') && event.errorKind === 'ENOENT'))
  } finally {
    __setMetricSinkForTests(null)
    rmSync(root, { recursive: true, force: true })
  }
})

test('long skill running projection emits readdir phase when artifact traversal cannot read a directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-running-projection-readdir-'))
  const locked = join(root, 'locked')
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    buildLongSkillRunningProjection({
      sessionId: 's1',
      toolName: 'skill_video_expert_pipeline',
      toolInput: { outputDir: locked },
      startedAt: 0,
      now: 10_000,
    })

    const partials = events.filter((event) => event.metric === TOOL_ERROR_METRICS.skillProjectionPartial)
    assert.ok(partials.some((event) => event.phase === 'readdir' && event.path === locked && event.errorKind === 'EACCES'))
  } finally {
    __setMetricSinkForTests(null)
    chmodSync(locked, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
