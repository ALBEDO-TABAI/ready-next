import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { selectRunStateCandidate } from '../main/modules/agent-control/task-projection/run-state-selection'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tools-runtime/tool-error-metrics'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..')
const READY_COMPAT = join(
  REPO_ROOT,
  'assets',
  'embedded-skills',
  'video-expert-analyzer',
  'scripts',
  'ready_compat.py',
)

test('run_state selection does not treat a blank legacy task id as expected task match', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-selection-'))
  try {
    const path = join(root, 'run_state.json')
    writeFileSync(path, JSON.stringify({ status: 'running' }), 'utf8')

    const selected = selectRunStateCandidate({
      rootDir: root,
      expectedTaskId: 'dst-expected',
    })

    assert.equal(selected.path, null)
    assert.equal(selected.ambiguous, false)
    assert.equal(selected.candidates.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run_state selection follows active_output_dir to the active child run_state', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-active-output-'))
  try {
    const activeDir = join(root, 'active-output')
    mkdirSync(activeDir)
    const activeRunState = join(activeDir, 'run_state.json')
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      task_id: 'dst-active',
      status: 'running',
      current_stage: 'prepare',
      active_output_dir: activeDir,
    }), 'utf8')
    writeFileSync(activeRunState, JSON.stringify({
      task_id: 'dst-active',
      status: 'running',
      current_stage: 'score_batches',
    }), 'utf8')

    const selected = selectRunStateCandidate({
      rootDir: root,
      expectedTaskId: 'dst-active',
    })

    assert.equal(selected.path, activeRunState)
    assert.equal(selected.candidates.length, 1)
    assert.equal(selected.candidates[0]?.currentStage, 'score_batches')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('JS and ready_compat agree on active_output_dir selection without delivery_report', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-python-parity-'))
  try {
    const activeDir = join(root, 'active-output')
    mkdirSync(activeDir)
    const activeRunState = join(activeDir, 'run_state.json')
    writeFileSync(join(root, 'scene_scores.json'), '{}', 'utf8')
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      task_id: 'dst-parity',
      status: 'running',
      active_output_dir: activeDir,
    }), 'utf8')
    writeFileSync(join(activeDir, 'scene_scores.json'), '{}', 'utf8')
    writeFileSync(activeRunState, JSON.stringify({
      task_id: 'dst-parity',
      status: 'running',
      current_stage: 'score_batches',
    }), 'utf8')

    const selected = selectRunStateCandidate({
      rootDir: root,
      expectedTaskId: 'dst-parity',
    })
    const harness = join(root, 'parity.py')
    writeFileSync(harness, [
      'import importlib.util',
      'from pathlib import Path',
      `spec = importlib.util.spec_from_file_location("ready_compat", ${JSON.stringify(READY_COMPAT)})`,
      'module = importlib.util.module_from_spec(spec)',
      'assert spec.loader is not None',
      'spec.loader.exec_module(module)',
      `found = module._find_video_output_dir(Path(${JSON.stringify(root)}), 0, "dst-parity")`,
      'print(found)',
      '',
    ].join('\n'), 'utf8')
    const pythonSelectedDir = execFileSync('python3', [harness], { encoding: 'utf8' }).trim()

    assert.equal(selected.path, activeRunState)
    assert.equal(pythonSelectedDir, realpathSync(activeDir))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run_state selection verifies explicit paths unless they are marked trusted', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-explicit-'))
  try {
    const path = join(root, 'run_state.json')
    writeFileSync(path, JSON.stringify({ task_id: 'other-task', status: 'running' }), 'utf8')

    const untrusted = selectRunStateCandidate({
      rootDir: root,
      explicitRunStatePath: path,
      expectedTaskId: 'dst-expected',
    })
    assert.equal(untrusted.path, null)

    const trusted = selectRunStateCandidate({
      rootDir: root,
      explicitRunStatePath: path,
      expectedTaskId: 'dst-expected',
      trustExplicitRunStatePath: true,
    } as Parameters<typeof selectRunStateCandidate>[0] & { trustExplicitRunStatePath: true })
    assert.equal(trusted.path, path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run_state selection accepts explicit legacy blank task id paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-explicit-blank-'))
  try {
    const path = join(root, 'run_state.json')
    writeFileSync(path, JSON.stringify({ status: 'running', current_stage: 'score_batches' }), 'utf8')

    const selected = selectRunStateCandidate({
      rootDir: root,
      explicitRunStatePath: path,
      expectedTaskId: 'dst-expected',
    })

    assert.equal(selected.path, path)
    assert.equal(selected.ambiguous, false)
    assert.equal(selected.candidates.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run_state selection uses childRunId to claim the active output under a shared root', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-child-id-'))
  try {
    const targetDir = join(root, 'target-output')
    const staleDir = join(root, 'stale-output')
    mkdirSync(targetDir)
    mkdirSync(staleDir)
    const targetRunState = join(targetDir, 'run_state.json')
    writeFileSync(join(root, 'run_state.json'), JSON.stringify({
      status: 'completed',
      current_stage: 'completed',
    }), 'utf8')
    writeFileSync(join(staleDir, 'run_state.json'), JSON.stringify({
      child_run_id: 'other-child',
      status: 'completed',
      current_stage: 'completed',
    }), 'utf8')
    writeFileSync(targetRunState, JSON.stringify({
      child_run_id: 'vqfy70dlv',
      status: 'running',
      current_stage: 'prepare',
      active_output_dir: targetDir,
    }), 'utf8')

    const selected = selectRunStateCandidate({
      rootDir: root,
      explicitRunStatePath: join(root, 'run_state.json'),
      expectedChildRunId: 'vqfy70dlv',
    })

    assert.equal(selected.path, targetRunState)
    assert.equal(selected.ambiguous, false)
    assert.equal(selected.candidates[0]?.childRunId, 'vqfy70dlv')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run_state selection emits a metric when directory traversal is skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-run-state-skipped-dir-'))
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    chmodSync(root, 0o000)
    const selected = selectRunStateCandidate({ rootDir: root })

    assert.equal(selected.path, null)
    const event = events.find((item) => item.metric === TOOL_ERROR_METRICS.runStateSelectionDirSkipped)
    assert.ok(event)
    assert.equal(event.dir, root)
    assert.equal(event.errorKind, 'EACCES')
  } finally {
    __setMetricSinkForTests(null)
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})
