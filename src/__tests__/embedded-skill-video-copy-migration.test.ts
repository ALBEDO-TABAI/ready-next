/**
 * B Phase 2 / 3 — video-copy-analyzer hybrid reference + retained internal action.
 *
 * Hybrid migration parallel to lets-go-rss (Phase 3 PR2): the manifest is now
 * `execution.mode: 'advisory'` with a `read_skill` reference action AND a
 * retained `video_copy_analyze` python action kept at `visibility: 'internal'`
 * because production code still calls it directly:
 *   - `src/main/modules/rss-engine/item-analysis-manager.ts::runCopyFlow`
 *     calls `runtime.runSkill({ skillId: 'video-copy-analyzer',
 *     action: 'video_copy_analyze', params: { input, outputDir, language } })`
 *     for every RSS item that looks like a video link.
 *
 * Why `internal` (not `public`): the action stays hidden by default, but the
 * host may expose it when the Video Copy Analyzer reference hint is armed.
 *
 * Per user steer: the test does NOT assert specific shell commands inside
 * SKILL.md — how the agent chooses to invoke bundled scripts is the model's
 * decision, not something to freeze in a contract here.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import { SkillContextOrchestrator } from '../main/modules/agent-control/skills/skill-context-orchestrator'
import {
  _resetLastReferenceSkillHintsForTests,
  getLastReferenceSkill,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { completeVideoCopyAnalyzeResult } from '../main/modules/tools/video-copy-deliverable-postprocess'
import { __skillsToolsInternalsForTests } from '../main/modules/tools/skills-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const __dirname = dirname(fileURLToPath(import.meta.url))
// src/__tests__ → repo root → assets/embedded-skills/video-copy-analyzer
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'video-copy-analyzer')

function findPython39(): string | null {
  const candidates = [
    process.env.READY_TEST_PYTHON_39,
    'python3.9',
    'python3',
  ].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, [
      '-c',
      'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 9) else 10)',
    ], { encoding: 'utf-8' })
    if (probe.status === 0) return candidate
  }
  return null
}

function validCopyReport(body = '叙事结构完整，传播潜力明确，可做多个方向。'): string {
  return [
    '## 一、TextContent Analysis 视角',
    body,
    '## 二、Viral-Abstract-Script 视角',
    body,
    '## 三、Brainstorming 视角',
    body,
  ].join('\n')
}

function validStructuredTranscript(body = '已有完整结构化文字稿内容，已经覆盖主线表达。'): string {
  return [
    '# demo 结构化文字稿',
    '',
    '## 一、完整口播',
    '',
    body,
  ].join('\n')
}

test('manifest compiles to advisory with read_skill default + retained internal video_copy_analyze action', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  assert.equal(def.executionMode, 'advisory', 'execution mode must be advisory post-migration')
  assert.equal(def.workflow, undefined, 'no workflow object should be compiled')
  assert.equal(def.defaultAction, 'read_skill', 'defaultAction points at the reference entry')

  // 1 reference + 1 retained internal python = 2 actions total
  assert.equal(def.actions.length, 2, 'read_skill + video_copy_analyze (internal, for item-analysis-manager)')

  const readSkill = def.actions.find((a) => a.name === 'read_skill')
  assert.ok(readSkill, 'read_skill present')
  assert.equal(readSkill!.runtime, 'reference')
  assert.equal(readSkill!.visibility, 'internal', 'LLM should not see a dynamic skill_<id>_read_skill tool')

  const copyAnalyze = def.actions.find((a) => a.name === 'video_copy_analyze')
  assert.ok(copyAnalyze, 'video_copy_analyze action retained for production caller')
  assert.equal(copyAnalyze!.runtime, 'python')
  assert.equal(copyAnalyze!.visibility, 'internal', 'hidden unless the Video Copy Analyzer hint is armed')
  assert.equal(copyAnalyze!.inputMode, 'json', 'json payload mode (--payload-json)')
  assert.equal(copyAnalyze!.entry, 'scripts/ready_extract_subtitle.py')
  assert.deepEqual(def.hostRequirements?.expose_when_hint_armed, ['video_copy_analyze'])
  assert.equal(def.hostRequirements?.default_action_timeout_ms, 3_600_000)
})

test('video_copy_analyze action contract matches item-analysis-manager call site', () => {
  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const action = def.actions.find((a) => a.name === 'video_copy_analyze')
  assert.ok(action, 'video_copy_analyze present')

  // Params actually sent by item-analysis-manager.ts::runCopyFlow.
  // If item-analysis-manager grows a new param, this test will surface the
  // missing manifest declaration (or the unused manifest entry).
  const callSiteParams = ['input', 'outputDir', 'language']
  for (const name of callSiteParams) {
    const param = action!.params.find((p) => p.name === name)
    assert.ok(param, `param "${name}" declared (used by item-analysis-manager)`)
  }

  // input is the only required param — everything else has runtime defaults.
  const inputParam = action!.params.find((p) => p.name === 'input')!
  assert.equal(inputParam.required, true, 'input is required (URL or path)')
  for (const name of ['outputDir', 'language']) {
    const p = action!.params.find((x) => x.name === name)!
    assert.equal(p.required, false, `${name} optional (manager passes a value but script has defaults)`)
  }

  assert.equal(action!.params.some((p) => p.name === 'model'), false, 'Whisper model param must not be exposed')
  // language values must include 'auto' (the literal value at the call site).
  const langParam = action!.params.find((p) => p.name === 'language')!
  assert.ok(langParam.enum?.includes('auto'), `language enum must include "auto" (passed by item-analysis-manager)`)
})

test('video_copy_analyze Ready entry uses FunASR-only transcription path', () => {
  const entry = readFileSync(join(SKILL_DIR, 'scripts', 'ready_extract_subtitle.py'), 'utf-8')
  const mainEntry = readFileSync(join(SKILL_DIR, 'main.py'), 'utf-8')
  const legacyTranscribeEntry = readFileSync(join(SKILL_DIR, 'scripts', 'transcribe_audio.py'), 'utf-8')
  const legacySubtitleEntry = readFileSync(join(SKILL_DIR, 'scripts', 'extract_subtitle.py'), 'utf-8')
  const requirements = readFileSync(join(SKILL_DIR, 'requirements.txt'), 'utf-8')
  const readmeDocs = [
    readFileSync(join(SKILL_DIR, 'README.md'), 'utf-8'),
    readFileSync(join(SKILL_DIR, 'README.zh-CN.md'), 'utf-8'),
  ].join('\n')

  assert.match(entry, /smart_subtitle_extraction/, 'Ready entry must preserve the smart subtitle extractor before ASR fallback')
  assert.match(entry, /extract_with_funasr/, 'Ready entry must keep FunASR for forced ASR mode')
  assert.doesNotMatch(entry, /transcribe_audio\.py/, 'Ready entry must not call the Whisper transcription script')
  assert.doesNotMatch(entry, /SKILL_DIR\s*\/\s*["']main\.py["']/, 'Ready entry must not shell through the legacy main.py flow')
  assert.match(mainEntry, /extract_with_funasr/, 'fallback main.py entry must also use the FunASR extractor')
  assert.doesNotMatch(mainEntry, /transcribe_audio\.py|Whisper|whisper模型/, 'fallback main.py entry must not expose the legacy Whisper path')
  assert.match(legacyTranscribeEntry, /extract_with_funasr/, 'compat transcription entry must delegate to FunASR')
  assert.match(legacySubtitleEntry, /extract_with_funasr/, 'compat subtitle entry must delegate to FunASR')
  assert.doesNotMatch(`${legacyTranscribeEntry}\n${legacySubtitleEntry}`, /import whisper|openai-whisper|load_model/, 'compat entries must not load the removed ASR stack')
  assert.doesNotMatch(requirements, /openai-whisper/, 'Ready runtime must not install Whisper for this skill')
  assert.doesNotMatch(readmeDocs, /Whisper|openai-whisper/, 'Ready embedded docs must not advertise the removed ASR path')
})

test('video_copy_analyze Ready entry preserves smart subtitle sources before FunASR fallback', (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-smart-subtitle-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const videoPath = join(outputDir, 'captioned.mp4')
  const resultPath = join(outputDir, 'result.json')
  writeFileSync(videoPath, 'fake video bytes', 'utf-8')
  const scriptPath = join(SKILL_DIR, 'scripts', 'ready_extract_subtitle.py')
  const python = process.env.PYTHON3 || 'python3'
  const code = `
import json
import os
import runpy
import sys
import types
from pathlib import Path

output_dir = ${JSON.stringify(outputDir)}
video_path = ${JSON.stringify(videoPath)}
result_path = ${JSON.stringify(resultPath)}
script_path = ${JSON.stringify(scriptPath)}
calls = []

main_module = types.ModuleType("main")
main_module.is_url = lambda value: str(value).startswith("http")
main_module.extract_video_id = lambda value: "not-used"
main_module.download_video = lambda source, target_dir: video_path

extractor_module = types.ModuleType("extract_subtitle_funasr")

def smart_subtitle_extraction(video, srt, video_url=""):
    calls.append(("smart", video, srt, video_url))
    Path(srt).write_text("1\\n00:00:00,000 --> 00:00:01,000\\ncaption text\\n\\n", encoding="utf-8")
    return True, "embedded"

def extract_with_funasr(video, srt):
    raise AssertionError("direct FunASR should not run in auto mode")

extractor_module.smart_subtitle_extraction = smart_subtitle_extraction
extractor_module.extract_with_funasr = extract_with_funasr
sys.modules["main"] = main_module
sys.modules["extract_subtitle_funasr"] = extractor_module
os.environ["READY_SKILL_RESULT_PATH"] = result_path
sys.argv = [
    "ready_extract_subtitle.py",
    "--payload-json",
    json.dumps({"input": video_path, "outputDir": output_dir}),
]

try:
    runpy.run_path(script_path, run_name="__main__")
except SystemExit as exc:
    if exc.code not in (0, None):
        raise

assert calls and calls[0][0] == "smart", calls
assert calls[0][3] == "", calls
`
  const run = spawnSync(python, ['-c', code], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(run.status, 0, [run.stderr, run.stdout].filter(Boolean).join('\n'))
  const result = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
    outputs: { subtitleEngine: string; asrEngine: string; transcriptPath: string }
  }
  assert.equal(result.outputs.subtitleEngine, 'embedded')
  assert.equal(result.outputs.asrEngine, 'funasr')
  assert.match(readFileSync(result.outputs.transcriptPath, 'utf-8'), /caption text/)
})

test('video_copy_analyze artifact list excludes status-only output values', (t) => {
  if (skipIfSqliteUnavailable(t, 'embedded-skill-video-copy-migration transitive sqlite guard')) return

  const artifacts = __skillsToolsInternalsForTests.buildSkillRunArtifacts({
    outputs: {
      outputDir: '/tmp/video-copy',
      transcriptPath: '/tmp/video-copy/demo_文字稿.md',
      subtitleEngine: 'funasr',
      forceSubtitleMode: 'funasr',
    },
  }, 'skill_video_copy_analyze')

  assert.deepEqual(
    artifacts.map((artifact) => artifact.meta?.outputKey),
    ['outputDir', 'transcriptPath'],
  )
  assert.equal(artifacts.some((artifact) => artifact.path === 'funasr'), false)
})

test('video_copy_analyze entry compiles under the bundled Python 3.9 runtime', (t) => {
  const python = findPython39()
  if (!python) {
    t.skip('Python 3.9 is not available in this test environment')
    return
  }
  const scriptPaths = [
    join(SKILL_DIR, 'main.py'),
    join(SKILL_DIR, 'scripts', 'ready_extract_subtitle.py'),
    join(SKILL_DIR, 'scripts', 'transcribe_audio.py'),
    join(SKILL_DIR, 'scripts', 'extract_subtitle.py'),
  ]
  const pycachePrefix = mkdtempSync(join(tmpdir(), 'ready-pycompile-'))
  try {
    const compiled = spawnSync(python, ['-m', 'py_compile', ...scriptPaths], {
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: pycachePrefix },
    })
    assert.equal(
      compiled.status,
      0,
      [compiled.stderr, compiled.stdout].filter(Boolean).join('\n'),
    )
  } finally {
    rmSync(pycachePrefix, { recursive: true, force: true })
  }
})

test('video_copy_analyze reuses cached files that belong to the requested video URL', (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-srt-reuse-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const videoId = 'abc123XYZ00'
  const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`
  const video1 = join(outputDir, `${videoId}.mp4`)
  const video2 = join(outputDir, 'video2.mp4')
  const video1Srt = join(outputDir, `${videoId}.srt`)
  const video2Srt = join(outputDir, 'video2.srt')
  const video1Transcript = join(outputDir, `${videoId}_文字稿.md`)
  const staleStructuredTranscript = join(outputDir, `${videoId}_结构化文字稿.md`)
  const staleOtherTranscript = join(outputDir, 'video2_文字稿.md')
  writeFileSync(video1, 'video1', 'utf-8')
  writeFileSync(video2, 'video2', 'utf-8')
  writeFileSync(video1Srt, '1\n00:00:00,000 --> 00:00:01,000\nvideo one\n', 'utf-8')
  writeFileSync(video2Srt, '1\n00:00:00,000 --> 00:00:01,000\nvideo two\n', 'utf-8')
  writeFileSync(staleStructuredTranscript, '# stale structure\n\nwrong structure\n', 'utf-8')
  writeFileSync(staleOtherTranscript, '# stale other\n\nwrong other\n', 'utf-8')
  const newer = new Date(Date.now() + 5000)
  utimesSync(video2, newer, newer)
  utimesSync(video2Srt, newer, newer)
  utimesSync(staleStructuredTranscript, newer, newer)
  utimesSync(staleOtherTranscript, newer, newer)
  const resultPath = join(outputDir, 'result.json')
  const python = process.env.PYTHON3 || 'python3'

  const run = spawnSync(python, [
    join(SKILL_DIR, 'scripts', 'ready_extract_subtitle.py'),
    '--payload-json',
    JSON.stringify({ input: sourceUrl, outputDir }),
  ], {
    encoding: 'utf-8',
    env: { ...process.env, READY_SKILL_RESULT_PATH: resultPath, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(run.status, 0, [run.stderr, run.stdout].filter(Boolean).join('\n'))
  const result = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
    outputs: { videoPath: string; srtPath: string; transcriptPath: string }
  }
  assert.equal(realpathSync(result.outputs.videoPath), realpathSync(video1))
  assert.equal(result.outputs.srtPath, video1Srt)
  assert.equal(result.outputs.transcriptPath, video1Transcript)
  const transcript = readFileSync(video1Transcript, 'utf-8')
  assert.match(transcript, /video one/)
  assert.doesNotMatch(transcript, /wrong structure|wrong other/)
})

test('video_copy_analyze does not reuse stale local subtitles after video replacement', (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-local-stale-srt-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const videoPath = join(outputDir, 'local-demo.mp4')
  const staleSrt = join(outputDir, 'local-demo.srt')
  const staleTranscript = join(outputDir, 'local-demo_文字稿.md')
  const resultPath = join(outputDir, 'result.json')
  writeFileSync(videoPath, 'new video bytes', 'utf-8')
  writeFileSync(staleSrt, '1\n00:00:00,000 --> 00:00:01,000\nstale subtitle\n', 'utf-8')
  writeFileSync(staleTranscript, '# stale transcript\n\nstale subtitle\n', 'utf-8')
  const oldTime = new Date(Date.now() - 20_000)
  const newTime = new Date(Date.now() + 20_000)
  utimesSync(staleSrt, oldTime, oldTime)
  utimesSync(staleTranscript, oldTime, oldTime)
  utimesSync(videoPath, newTime, newTime)
  const scriptPath = join(SKILL_DIR, 'scripts', 'ready_extract_subtitle.py')
  const python = process.env.PYTHON3 || 'python3'
  const code = `
import json
import os
import runpy
import sys
import types
from pathlib import Path

output_dir = ${JSON.stringify(outputDir)}
video_path = ${JSON.stringify(videoPath)}
stale_srt = ${JSON.stringify(staleSrt)}
result_path = ${JSON.stringify(resultPath)}
script_path = ${JSON.stringify(scriptPath)}
calls = []

main_module = types.ModuleType("main")
main_module.is_url = lambda value: str(value).startswith("http")
main_module.extract_video_id = lambda value: "not-used"
main_module.download_video = lambda source, target_dir: video_path

extractor_module = types.ModuleType("extract_subtitle_funasr")

def smart_subtitle_extraction(video, srt, video_url=""):
    calls.append(("smart", video, srt, video_url))
    assert srt != stale_srt, "stale SRT was reused"
    Path(srt).write_text("1\\n00:00:00,000 --> 00:00:01,000\\nfresh subtitle\\n\\n", encoding="utf-8")
    return True, "funasr"

def extract_with_funasr(video, srt):
    raise AssertionError("forced FunASR should not run in auto mode")

extractor_module.smart_subtitle_extraction = smart_subtitle_extraction
extractor_module.extract_with_funasr = extract_with_funasr
sys.modules["main"] = main_module
sys.modules["extract_subtitle_funasr"] = extractor_module
os.environ["READY_SKILL_RESULT_PATH"] = result_path
sys.argv = [
    "ready_extract_subtitle.py",
    "--payload-json",
    json.dumps({"input": video_path, "outputDir": output_dir}),
]

try:
    runpy.run_path(script_path, run_name="__main__")
except SystemExit as exc:
    if exc.code not in (0, None):
        raise

assert calls and calls[0][0] == "smart", calls
`
  const run = spawnSync(python, ['-c', code], {
    encoding: 'utf-8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })

  assert.equal(run.status, 0, [run.stderr, run.stdout].filter(Boolean).join('\n'))
  const result = JSON.parse(readFileSync(resultPath, 'utf-8')) as {
    outputs: { srtPath: string; transcriptPath: string }
  }
  assert.notEqual(result.outputs.srtPath, staleSrt)
  const transcript = readFileSync(result.outputs.transcriptPath, 'utf-8')
  assert.match(transcript, /fresh subtitle/)
  assert.doesNotMatch(transcript, /stale subtitle/)
})

test('video_copy_analyze postprocess writes analysis report and structured transcript', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-postprocess-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  writeFileSync(transcriptPath, '# 视频语音转录文字稿\n\n## 正文\n\n原始转录内容\n', 'utf-8')

  const result = await completeVideoCopyAnalyzeResult({
    result: {
      success: true,
      skillId: 'video-copy-analyzer',
      action: 'video_copy_analyze',
      stdout: 'transcript ready',
      stderr: '',
      outputDir,
      outputs: {
        outputDir,
        sourceInput: 'https://example.com/watch?v=demo',
        transcriptPath,
      },
      command: ['python', 'ready_extract_subtitle.py'],
      status: 'done',
      mode: 'direct',
    },
    args: {},
    builder: {
      async buildCopyDeliverables() {
        return {
          correctedTranscript: '# demo 校正文稿\n\n## 完整文稿\n\n校正文稿内容',
          report: [
            '## 一、TextContent Analysis 视角',
            '叙事结构完整。',
            '## 二、Viral-Abstract-Script 视角',
            '传播潜力明确。',
            '## 三、Brainstorming 视角',
            '可做多个方向。',
          ].join('\n'),
          structuredTranscript: '# demo 结构化文字稿\n\n## 一、开场\n\n校正文稿内容',
        }
      },
    },
  })

  assert.equal(result.success, true)
  assert.equal(result.outputs?.analysisReportPath, join(outputDir, 'demo_分析报告.md'))
  assert.equal(result.outputs?.structuredTranscriptPath, join(outputDir, 'demo_结构化文字稿.md'))
  assert.match(readFileSync(transcriptPath, 'utf-8'), /校正文稿内容/)
  assert.match(readFileSync(join(outputDir, 'demo_分析报告.md'), 'utf-8'), /Viral-Abstract-Script/)
  assert.match(readFileSync(join(outputDir, 'demo_结构化文字稿.md'), 'utf-8'), /结构化文字稿/)
})

test('video_copy_analyze postprocess reuses completed deliverables on retry', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-reuse-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  const analysisReportPath = join(outputDir, 'demo_分析报告.md')
  const structuredTranscriptPath = join(outputDir, 'demo_结构化文字稿.md')
  writeFileSync(transcriptPath, '# demo 文字稿\n\n已有文字稿\n', 'utf-8')
  writeFileSync(analysisReportPath, `# demo 文案分析报告\n\n${validCopyReport()}\n`, 'utf-8')
  writeFileSync(structuredTranscriptPath, `${validStructuredTranscript()}\n`, 'utf-8')
  let builderCalls = 0

  const result = await completeVideoCopyAnalyzeResult({
    result: {
      success: true,
      skillId: 'video-copy-analyzer',
      action: 'video_copy_analyze',
      stdout: 'transcript ready',
      stderr: '',
      outputDir,
      outputs: {
        outputDir,
        sourceInput: 'https://example.com/watch?v=demo',
        transcriptPath,
      },
      command: ['python', 'ready_extract_subtitle.py'],
      status: 'done',
      mode: 'direct',
    },
    args: {},
    builder: {
      async buildCopyDeliverables() {
        builderCalls += 1
        throw new Error('builder should not run when deliverables already exist')
      },
    },
  })

  assert.equal(result.success, true)
  assert.equal(builderCalls, 0)
  assert.equal(result.outputs?.analysisReportPath, analysisReportPath)
  assert.equal(result.outputs?.structuredTranscriptPath, structuredTranscriptPath)
})

test('video_copy_analyze postprocess regenerates incomplete cached deliverables', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-incomplete-reuse-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  const analysisReportPath = join(outputDir, 'demo_分析报告.md')
  const structuredTranscriptPath = join(outputDir, 'demo_结构化文字稿.md')
  writeFileSync(transcriptPath, '# demo 文字稿\n\n新的文字稿内容，需要完整文案分析。\n', 'utf-8')
  writeFileSync(analysisReportPath, '# demo 文案分析报告\n\n已有报告\n', 'utf-8')
  writeFileSync(structuredTranscriptPath, '# demo 结构化文字稿\n\n已有结构化文字稿\n', 'utf-8')
  let builderCalls = 0

  const result = await completeVideoCopyAnalyzeResult({
    result: {
      success: true,
      skillId: 'video-copy-analyzer',
      action: 'video_copy_analyze',
      stdout: 'transcript ready',
      stderr: '',
      outputDir,
      outputs: {
        outputDir,
        sourceInput: 'https://example.com/watch?v=demo',
        transcriptPath,
      },
      command: ['python', 'ready_extract_subtitle.py'],
      status: 'done',
      mode: 'direct',
    },
    args: {},
    builder: {
      async buildCopyDeliverables() {
        builderCalls += 1
        return {
          correctedTranscript: '# demo 校正文稿\n\n## 完整文稿\n\n新的校正文稿内容',
          report: validCopyReport('新生成报告内容完整覆盖三类分析视角。'),
          structuredTranscript: validStructuredTranscript('新的结构化文字稿内容已经重新整理。'),
        }
      },
    },
  })

  assert.equal(result.success, true)
  assert.equal(builderCalls, 1)
  assert.match(result.stdout, /已重新生成/)
  assert.match(readFileSync(analysisReportPath, 'utf-8'), /新生成报告内容/)
  assert.match(readFileSync(structuredTranscriptPath, 'utf-8'), /新的结构化文字稿内容/)
})

test('video_copy_analyze postprocess regenerates cached deliverables older than the transcript', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-stale-report-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  const analysisReportPath = join(outputDir, 'demo_分析报告.md')
  const structuredTranscriptPath = join(outputDir, 'demo_结构化文字稿.md')
  writeFileSync(transcriptPath, '# demo 文字稿\n\n新的文字稿内容，需要覆盖旧报告。\n', 'utf-8')
  writeFileSync(analysisReportPath, `# demo 文案分析报告\n\n${validCopyReport('旧报告内容虽然完整，但属于旧文字稿。')}\n`, 'utf-8')
  writeFileSync(structuredTranscriptPath, `${validStructuredTranscript('旧结构化文字稿虽然完整，但属于旧文字稿。')}\n`, 'utf-8')
  const oldTime = new Date(Date.now() - 20_000)
  const newTime = new Date(Date.now() + 20_000)
  utimesSync(analysisReportPath, oldTime, oldTime)
  utimesSync(structuredTranscriptPath, oldTime, oldTime)
  utimesSync(transcriptPath, newTime, newTime)
  let builderCalls = 0

  const result = await completeVideoCopyAnalyzeResult({
    result: {
      success: true,
      skillId: 'video-copy-analyzer',
      action: 'video_copy_analyze',
      stdout: 'transcript ready',
      stderr: '',
      outputDir,
      outputs: {
        outputDir,
        sourceInput: 'https://example.com/watch?v=demo',
        transcriptPath,
      },
      command: ['python', 'ready_extract_subtitle.py'],
      status: 'done',
      mode: 'direct',
    },
    args: {},
    builder: {
      async buildCopyDeliverables() {
        builderCalls += 1
        return {
          correctedTranscript: '# demo 校正文稿\n\n## 完整文稿\n\n新的校正文稿内容',
          report: validCopyReport('新报告按更新后的文字稿重新生成。'),
          structuredTranscript: validStructuredTranscript('新结构化文字稿按更新后的文字稿重新生成。'),
        }
      },
    },
  })

  assert.equal(result.success, true)
  assert.equal(builderCalls, 1)
  assert.match(readFileSync(analysisReportPath, 'utf-8'), /新报告按更新后的文字稿/)
  assert.match(readFileSync(structuredTranscriptPath, 'utf-8'), /新结构化文字稿按更新后的文字稿/)
})

test('skill.workflow.json has been removed from disk', () => {
  const workflowPath = join(SKILL_DIR, 'skill.workflow.json')
  assert.equal(existsSync(workflowPath), false, 'skill.workflow.json must not exist after migration')
})

test('SKILL.md frontmatter declares when-to-use per Claude Skill protocol', () => {
  const skillMd = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf-8')
  const frontmatterMatch = skillMd.match(/^---\n([\s\S]*?)\n---/)
  assert.ok(frontmatterMatch, 'SKILL.md must start with YAML frontmatter')
  const frontmatter = frontmatterMatch![1]
  assert.ok(/\bname:\s*video-copy-analyzer/.test(frontmatter), 'name field required')
  assert.ok(/\bdescription:/.test(frontmatter), 'description field required')
  assert.ok(/\bwhen-to-use:/.test(frontmatter), 'when-to-use field required for Claude Skill protocol')
  assert.doesNotMatch(skillMd, /whisper/i, 'agent-injected skill instructions must not mention the retired ASR path')
})

test('orchestrator inline-injects SKILL.md and arms the primitive-gating hint', async () => {
  _resetLastReferenceSkillHintsForTests()

  const def = compileSkillDefinition({ folderPath: SKILL_DIR, source: 'embedded' })
  const skillState: any = {
    id: 'video-copy-analyzer',
    name: 'Video Copy Analyzer',
    description: def.description,
    defaultAction: def.defaultAction,
    executionMode: def.executionMode,
    managedPath: SKILL_DIR,
    actions: def.actions.map((a) => ({
      name: a.name,
      visibility: a.visibility,
      runtime: a.runtime,
      params: a.params || [],
    })),
  }

  const orchestrator = new SkillContextOrchestrator({
    extractPrimaryUserInstruction: (raw) => raw,
    listSkills: () => [skillState],
    resolveSkillToolByAction: (_skillId, actionName) => ({
      name: actionName === 'read_skill'
        ? 'skill_video_copy_analyzer_read_skill'
        : `skill_video_copy_analyzer_${actionName}`,
      action: actionName,
      params: [],
    }) as any,
  })

  const session: any = { messages: [] }
  let toolCalls = 0
  await orchestrator.maybeInjectExplicitSkillContext({
    userText: '用 video-copy-analyzer 分析这个视频 https://example.com/video.mp4',
    session,
    sessionId: 'test-session-videocopy',
    emitOutput: () => {},
    emitToolAction: () => { toolCalls += 1 },
    executeTool: async () => {
      toolCalls += 1
      return { text: '', shape: 'text', data: null, projectionPatch: null, interactionHint: null }
    },
  })

  assert.equal(toolCalls, 0, 'direct-read path must not perform a tool_use round-trip')
  assert.equal(session.messages.length, 1, 'exactly one system-role injection')
  const injected = session.messages[0] as { role: string; content: string }
  assert.equal(injected.role, 'system')
  // Content should include both the skill-header guidance and a recognisable
  // slice of the skill's own text (frontmatter keywords are fine proxies).
  assert.ok(injected.content.includes('已加载技能'), 'injection header present')
  assert.ok(injected.content.includes('video-copy-analyzer'), 'skill name rendered')
  assert.ok(
    injected.content.includes('FunASR') || injected.content.includes('视频文案'),
    'SKILL.md body was inlined, not truncated out',
  )

  const hint = getLastReferenceSkill('test-session-videocopy')
  assert.equal(hint?.id, 'video-copy-analyzer', 'hint arms primitive gating for next turn')
})
