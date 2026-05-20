import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { inferSkillRunStatusFromOutput } from '../main/modules/tools/skills-tools'

function makeManager(): { manager: SkillsRuntimeManager; cleanup: () => void } {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'skill-structured-result-'))
  return {
    manager: new SkillsRuntimeManager({
      runtimeRoot,
      startBackgroundTasks: false,
    }),
    cleanup: () => rmSync(runtimeRoot, { recursive: true, force: true }),
  }
}

test('structured result ok:false makes a zero-exit action fail', () => {
  const { manager, cleanup } = makeManager()
  try {
    const result = (manager as unknown as {
      toDirectRunResult: (...args: unknown[]) => {
        success: boolean
        status?: string
        error?: string
        stdout: string
        outputs?: Record<string, string>
      }
    }).toDirectRunResult('video-expert-analyzer', 'video_expert_pipeline', {
      success: true,
      stdout: 'process exited 0',
      stderr: '',
      command: ['python', 'scripts/ready_compat.py'],
      outputDir: '/tmp/vea/out',
      structuredResult: {
        ok: false,
        status: 'failed',
        outputs: { outputDir: '/tmp/vea/out' },
        artifacts: [],
        logs: { stdout: 'provider returned 401', stderr: '' },
        error: { message: 'provider_unauthorized_401' },
      },
    })

    assert.equal(result.success, false)
    assert.equal(result.error, 'provider_unauthorized_401')
    assert.match(result.stdout, /Output directory: \/tmp\/vea\/out/)
    assert.deepEqual(result.outputs, { outputDir: '/tmp/vea/out' })
  } finally {
    cleanup()
  }
})

test('skill shell status inference treats exit 0 with provider stderr as failed', () => {
  const output = createToolExecutionOutput('STDERR:\nprovider returned HTTP 401 unauthorized', {
    shape: 'json',
    data: {
      exitCode: 0,
      stdout: '',
      stderr: 'provider returned HTTP 401 unauthorized',
    },
  })

  assert.equal(inferSkillRunStatusFromOutput(output), 'error')
})

test('skill shell status inference allows exit 0 with benign stderr warnings', () => {
  const output = createToolExecutionOutput('STDERR:\nwarning: using cached metadata', {
    shape: 'json',
    data: {
      exitCode: 0,
      stdout: '',
      stderr: 'warning: using cached metadata',
    },
  })

  assert.equal(inferSkillRunStatusFromOutput(output), 'done')
})

test('skill shell status inference treats exit 0 status running as still running', () => {
  const output = createToolExecutionOutput('STDOUT:\nstatus: running', {
    shape: 'json',
    data: {
      exitCode: 0,
      stdout: 'status: running',
      stderr: '',
    },
  })

  assert.equal(inferSkillRunStatusFromOutput(output), 'running')
})

test('structured output directory is stable across resume after credentials are fixed', () => {
  const { manager, cleanup } = makeManager()
  try {
    const toResult = (structuredResult: unknown) => (manager as unknown as {
      toDirectRunResult: (...args: unknown[]) => {
        success: boolean
        outputDir?: string
        outputs?: Record<string, string>
      }
    }).toDirectRunResult('video-expert-analyzer', 'video_expert_pipeline', {
      success: true,
      stdout: '',
      stderr: '',
      command: ['python', 'scripts/ready_compat.py'],
      outputDir: '/tmp/vea/same-output',
      structuredResult,
    })

    const blocked = toResult({
      ok: false,
      status: 'failed',
      outputs: {
        outputDir: '/tmp/vea/same-output',
        runStatePath: '/tmp/vea/same-output/run_state.json',
      },
      artifacts: [],
      logs: { stdout: '', stderr: '' },
      error: { message: 'provider_missing' },
    })
    const resumed = toResult({
      ok: true,
      status: 'success',
      outputs: {
        outputDir: '/tmp/vea/same-output',
        runStatePath: '/tmp/vea/same-output/run_state.json',
        sceneScoresPath: '/tmp/vea/same-output/scene_scores.json',
      },
      artifacts: [],
      logs: { stdout: '', stderr: '' },
    })

    assert.equal(blocked.success, false)
    assert.equal(resumed.success, true)
    assert.equal(blocked.outputDir, resumed.outputDir)
    assert.equal(resumed.outputs?.runStatePath, '/tmp/vea/same-output/run_state.json')
    assert.equal(resumed.outputs?.sceneScoresPath, '/tmp/vea/same-output/scene_scores.json')
  } finally {
    cleanup()
  }
})
