/** Bundled video-copy manifest and isolated Python execution contracts. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileSkillDefinition } from '../main/modules/skills-runtime/skill-compiler'
import { completeVideoCopyAnalyzeResult } from '../main/modules/tools/video-copy-deliverable-postprocess'
import { __skillsToolsInternalsForTests } from '../main/modules/tools/skills-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const __dirname = dirname(fileURLToPath(import.meta.url))
// src/__tests__ → repo root → assets/embedded-skills/video-copy-analyzer
const SKILL_DIR = join(__dirname, '..', '..', 'assets', 'embedded-skills', 'video-copy-analyzer')


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

test('video_copy_analyze downloader accepts Ready browser cookies and configured host cookies', () => {
  const entryPath = join(SKILL_DIR, 'main.py')
  const subtitleFetcherPath = join(SKILL_DIR, 'scripts', 'fetch_bilibili_subtitle.py')
  // eslint-disable-next-line ready/no-source-grep-test -- Packaging contract: this Python downloader is invoked by the retained internal action, and a live network video download belongs to app-level verification.
  const source = readFileSync(entryPath, 'utf-8')
  const subtitleFetcher = readFileSync(subtitleFetcherPath, 'utf-8')
  assert.match(source, /READY_VIDEO_COOKIE_FILE/, 'Ready-exported browser cookies must be accepted for arbitrary video hosts')
  assert.match(source, /BILIBILI_COOKIE_FILE/, 'configured Bilibili cookie files must remain a fallback')
  assert.match(source, /YOUTUBE_COOKIE_FILE/, 'legacy YouTube cookie env must remain a fallback')
  assert.match(source, /--js-runtimes/, 'yt-dlp JS runtime support must be enabled when available')
  assert.match(source, /quickjs/, 'Ready-packaged Python runtime must be usable when desktop PATH has no node')
  assert.match(source, /--ffmpeg-location/, 'yt-dlp must receive an explicit FFmpeg path in desktop app environments without shell PATH')
  assert.match(subtitleFetcher, /get_cookies_from_ready_cookie_file/, 'Bilibili subtitle API must reuse Ready-exported browser cookies before slow ASR fallback')
  const resolverBody = subtitleFetcher.slice(subtitleFetcher.indexOf('def get_bilibili_cookies'))
  assert.ok(
    resolverBody.indexOf('get_cookies_from_ready_cookie_file') < resolverBody.indexOf('get_cookies_via_ytdlp'),
    'Ready BrowserView cookies should be the first subtitle-cookie source',
  )
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

test('video_copy_analyze smart extractor prefers ASR before OCR fallback', () => {
  const extractor = readFileSync(join(SKILL_DIR, 'scripts', 'extract_subtitle_funasr.py'), 'utf-8')
  const asrStep = extractor.indexOf('步骤 2/3: 使用 FunASR 语音转录')
  const ocrStep = extractor.indexOf('步骤 3/3: ASR 失败，检测烧录字幕')

  assert.ok(asrStep > 0, 'auto mode should run ASR before OCR fallback')
  assert.ok(ocrStep > asrStep, 'OCR must only run after ASR fails')
  assert.match(extractor, /return len\(subtitles\) > 0/, 'empty OCR output must not be treated as a complete transcript')
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
    Path(srt).write_text("1\\n00:00:00,000 --> 00:00:01,000\\ncaption text\\nsecond caption\\n\\n", encoding="utf-8")
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
  const transcript = readFileSync(result.outputs.transcriptPath, 'utf-8')
  assert.match(transcript, /caption text second caption/)
  assert.doesNotMatch(transcript, /caption text\nsecond caption/)
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

const entryScriptPaths = [
  join(SKILL_DIR, 'main.py'),
  join(SKILL_DIR, 'scripts', 'ready_extract_subtitle.py'),
  join(SKILL_DIR, 'scripts', 'transcribe_audio.py'),
  join(SKILL_DIR, 'scripts', 'extract_subtitle.py'),
]

test('video_copy_analyze entry keeps Python 3.9-compatible syntax', () => {
  const parsed = spawnSync('python3', ['-c',
    'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8-sig"), filename=p, feature_version=(3, 9)) for p in sys.argv[1:]]',
    ...entryScriptPaths,
  ], { encoding: 'utf-8' })
  assert.equal(parsed.status, 0, [parsed.stderr, parsed.stdout].filter(Boolean).join('\n'))
})

test('video_copy_analyze entry compiles in an explicitly supplied Python 3.9 interpreter', {
  skip: !process.env.READY_TEST_PYTHON_39 && 'opt-in: set READY_TEST_PYTHON_39 to a Python 3.9 interpreter',
}, () => {
  const python = process.env.READY_TEST_PYTHON_39!
  const version = spawnSync(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 9)'], { encoding: 'utf-8' })
  assert.equal(version.status, 0, version.stderr || 'READY_TEST_PYTHON_39 must point to Python 3.9')
  const pycachePrefix = mkdtempSync(join(tmpdir(), 'ready-pycompile-'))
  try {
    const compiled = spawnSync(python, ['-m', 'py_compile', ...entryScriptPaths], {
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPYCACHEPREFIX: pycachePrefix },
    })
    assert.equal(compiled.status, 0, [compiled.stderr, compiled.stdout].filter(Boolean).join('\n'))
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

test('video_copy_analyze postprocess fails instead of writing fallback analysis report', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-fallback-report-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  writeFileSync(transcriptPath, '# demo 文字稿\n\n新的文字稿内容，需要完整文案分析。\n', 'utf-8')

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
          correctedTranscript: '# demo 校正文稿\n\n## 完整文稿\n\n新的校正文稿内容',
          report: [
            '## 一、TextContent Analysis 视角',
            '- AI 深度分析未返回完整结果，当前报告基于文字稿自动保底整理。',
            '## 二、Viral-Abstract-Script 视角',
            '- 当前为保底报告。',
            '## 三、Brainstorming 视角',
            '- 当前为保底报告。',
          ].join('\n'),
          structuredTranscript: validStructuredTranscript('新的结构化文字稿内容已经重新整理。'),
        }
      },
    },
  })

  assert.equal(result.success, false)
  assert.match(result.error || '', /未能生成符合技能合同/)
  assert.equal(existsSync(join(outputDir, 'demo_分析报告.md')), false)
  assert.equal(existsSync(join(outputDir, 'demo_结构化文字稿.md')), false)
})

test('video_copy_analyze postprocess regenerates line-per-sentence cached structured transcript', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-line-per-sentence-reuse-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  const analysisReportPath = join(outputDir, 'demo_分析报告.md')
  const structuredTranscriptPath = join(outputDir, 'demo_结构化文字稿.md')
  writeFileSync(transcriptPath, '# demo 文字稿\n\n新的文字稿内容，需要完整文案分析。\n', 'utf-8')
  writeFileSync(analysisReportPath, `# demo 文案分析报告\n\n${validCopyReport()}\n`, 'utf-8')
  writeFileSync(
    structuredTranscriptPath,
    [
      '# demo 结构化文字稿',
      '',
      '## 一、完整口播',
      '',
      '第一句，这是旧缓存里的一句话。',
      '',
      '第二句，它被错误地拆成独立段落。',
      '',
      '第三句，仍然是坏格式。',
      '',
      '第四句，阅读体验很差。',
      '',
      '第五句，不能继续复用。',
      '',
    ].join('\n'),
    'utf-8',
  )
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
  assert.match(readFileSync(structuredTranscriptPath, 'utf-8'), /新的结构化文字稿内容已经重新整理/)
})

test('video_copy_analyze postprocess regenerates cached structured transcript without sentence punctuation', async (t) => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-video-copy-unpunctuated-reuse-'))
  t.after(() => rmSync(outputDir, { recursive: true, force: true }))
  const transcriptPath = join(outputDir, 'demo_文字稿.md')
  const analysisReportPath = join(outputDir, 'demo_分析报告.md')
  const structuredTranscriptPath = join(outputDir, 'demo_结构化文字稿.md')
  writeFileSync(transcriptPath, '# demo 文字稿\n\n这是一段新的文字稿，需要生成带标点的结构化文案。\n', 'utf-8')
  writeFileSync(analysisReportPath, `# demo 文案分析报告\n\n${validCopyReport()}\n`, 'utf-8')
  writeFileSync(
    structuredTranscriptPath,
    [
      '# demo 结构化文字稿',
      '',
      '## 一、完整口播',
      '',
      '去年我读了一本书叫你一生的故事但后来被改编成了电影降临今天想说的不是小说而是书里面提到的费马原理它让我开始相信命运这个事情如果命运已经确定了那我的选择还有意义答案是有而且选择更加重要',
      '',
    ].join('\n'),
    'utf-8',
  )
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
          correctedTranscript: '# demo 校正文稿\n\n## 完整文稿\n\n新的校正文稿内容，已经补好标点。',
          report: validCopyReport('新生成报告内容完整覆盖三类分析视角。'),
          structuredTranscript: validStructuredTranscript('新的结构化文字稿内容，已经补好标点。'),
        }
      },
    },
  })

  assert.equal(result.success, true)
  assert.equal(builderCalls, 1)
  assert.match(result.stdout, /已重新生成/)
  assert.match(readFileSync(structuredTranscriptPath, 'utf-8'), /已经补好标点。/)
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
