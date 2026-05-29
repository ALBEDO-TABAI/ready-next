import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { SkillsRuntimeManager } from '../main/modules/skills-runtime/runtime-manager'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { inferSkillRunStatusFromOutput } from '../main/modules/tools/skills-tools'
import {
  ASR_MODEL_PACK_MISSING_MARKER,
  MODELS_RUNTIME_SETTINGS_SECTION,
} from '../shared/model-pack-types'
import type { MissingRuntimeDependency } from '../shared/model-pack-types'

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

test('failed subtitle run carrying the missing-model marker yields the missing-dependency signal', () => {
  const { manager, cleanup } = makeManager()
  try {
    const toResult = (executed: Record<string, unknown>) => (manager as unknown as {
      toDirectRunResult: (...args: unknown[]) => {
        success: boolean
        error?: string
        stderr: string
        missingRuntimeDependency?: MissingRuntimeDependency
      }
    }).toDirectRunResult('video-expert-analyzer', 'video_expert_pipeline', executed)

    // Expert pipeline shape: marker printed straight to the subprocess stderr.
    const expertStderr = [
      'Traceback (most recent call last):',
      `${ASR_MODEL_PACK_MISSING_MARKER} {"feature": "video-subtitle-asr", "missing": ["asr", "punc"]}`,
      '❌ 缺少本地语音识别模型，请在 Ready「设置 › 模型与运行时」下载字幕识别模型后重试。',
      'RuntimeError: 缺少本地语音模型包: asr, punc',
    ].join('\n')
    const expert = toResult({
      success: false,
      stdout: '',
      stderr: expertStderr,
      command: ['python', 'scripts/ready_compat.py'],
      error: 'process exited with code 1',
    })

    assert.equal(expert.success, false)
    assert.ok(expert.missingRuntimeDependency, 'expected missing-dependency signal on the expert result')
    assert.equal(expert.missingRuntimeDependency.feature, 'video-subtitle-asr')
    assert.equal(expert.missingRuntimeDependency.settingsSection, MODELS_RUNTIME_SETTINGS_SECTION)
    assert.deepEqual(
      [...expert.missingRuntimeDependency.missingPacks].sort(),
      ['funasr-fallback-asr', 'funasr-punc-ctc'],
    )
    // The detailed subprocess error is preserved in stderr; the surfaced error
    // is rewritten to actionable guidance pointing at the download page.
    assert.match(expert.error || '', /模型与运行时/)
    assert.match(expert.stderr, /缺少本地语音模型包/)

    // Copy skill shape: structured failure result whose re-printed stderr also
    // carries the marker. Only the punctuation pack is missing here.
    const copy = toResult({
      success: true,
      stdout: '',
      stderr: `${ASR_MODEL_PACK_MISSING_MARKER} {"feature": "video-subtitle-asr", "missing": ["punc"]}`,
      command: ['python', 'scripts/ready_extract_subtitle.py'],
      structuredResult: {
        ok: false,
        status: 'failed',
        outputs: {},
        artifacts: [],
        logs: { stdout: '', stderr: '' },
        error: { message: '缺少本地语音模型包: punc' },
      },
    })
    assert.equal(copy.success, false)
    assert.ok(copy.missingRuntimeDependency)
    assert.deepEqual(copy.missingRuntimeDependency.missingPacks, ['funasr-punc-ctc'])
    assert.match(copy.error || '', /模型与运行时/)
  } finally {
    cleanup()
  }
})

test('successful run never carries a missing-dependency signal', () => {
  const { manager, cleanup } = makeManager()
  try {
    const result = (manager as unknown as {
      toDirectRunResult: (...args: unknown[]) => {
        success: boolean
        missingRuntimeDependency?: MissingRuntimeDependency
      }
    }).toDirectRunResult('video-copy-analyzer', 'video_copy_analyze', {
      success: true,
      // Even if the marker text leaks into a successful run's output, a success
      // must not be reinterpreted as a missing dependency.
      stdout: `noise ${ASR_MODEL_PACK_MISSING_MARKER} {"feature":"x","missing":["asr"]}`,
      stderr: '',
      command: ['python', 'scripts/ready_extract_subtitle.py'],
    })
    assert.equal(result.success, true)
    assert.equal(result.missingRuntimeDependency, undefined)
  } finally {
    cleanup()
  }
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
