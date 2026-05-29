import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const SKILL_DIR = join(process.cwd(), 'assets', 'embedded-skills', 'video-expert-analyzer')
const VIDEO_SKILL_DIRS = [
  SKILL_DIR,
  join(process.cwd(), 'assets', 'embedded-skills', 'video-copy-analyzer'),
]

test('video_expert_analyzer uses FunASR-only transcription in Ready runtime', () => {
  const extractor = readFileSync(join(SKILL_DIR, 'scripts', 'extract_subtitle_funasr.py'), 'utf-8')
  const requirements = readFileSync(join(SKILL_DIR, 'requirements.txt'), 'utf-8')
  const checkEnvironment = readFileSync(join(SKILL_DIR, 'scripts', 'check_environment.py'), 'utf-8')
  const docs = [
    readFileSync(join(SKILL_DIR, 'README.md'), 'utf-8'),
    readFileSync(join(SKILL_DIR, 'PROJECT.md'), 'utf-8'),
  ].join('\n')

  assert.match(extractor, /Fun-ASR-Nano-2512/, 'extractor must keep the FunASR Nano path')
  assert.match(extractor, /return extract_with_funasr\(video_path, output_srt\)/, 'smart ASR must route directly to FunASR')
  assert.doesNotMatch(extractor, /mlx_whisper|extract_with_whisper|whisper-large|MLX Whisper/i)
  assert.doesNotMatch(checkEnvironment, /mlx_whisper|mlx-whisper|MLX Whisper/i)
  assert.doesNotMatch(requirements, /mlx-whisper|openai-whisper/i)
  assert.doesNotMatch(docs, /mlx-whisper|MLX Whisper|Whisper Model/i)
})

test('both subtitle extractors adopt ct-punc-c by default with env-overridable model ids', () => {
  for (const skillDir of VIDEO_SKILL_DIRS) {
    const extractor = readFileSync(join(skillDir, 'scripts', 'extract_subtitle_funasr.py'), 'utf-8')

    // Fallback punctuation default is the smaller ct-punc-c (zh-cn vocab272727),
    // overridable via READY_FUNASR_PUNC_MODEL_ID for users who want the bilingual
    // large model.
    assert.match(
      extractor,
      /READY_FUNASR_PUNC_MODEL_ID["']\s*,\s*\n?\s*["']iic\/punc_ct-transformer_zh-cn-common-vocab272727-pytorch["']/,
      `${skillDir}: punc default must be ct-punc-c read from READY_FUNASR_PUNC_MODEL_ID`,
    )
    // The heavy bilingual-large punctuation model is no longer bundled or
    // referenced as a hard-coded default.
    assert.doesNotMatch(
      extractor,
      /punc_ct-transformer_cn-en-common-vocab471067-large/,
      `${skillDir}: bilingual-large punc id must not be hard-coded`,
    )
    // Fallback ASR id is env-overridable too.
    assert.match(
      extractor,
      /os\.environ\.get\(\s*\n?\s*["']READY_FUNASR_ASR_MODEL_ID["']/,
      `${skillDir}: ASR id must be read from READY_FUNASR_ASR_MODEL_ID`,
    )
  }
})

test('both subtitle extractors gate offline runs and emit the structured missing-pack marker', () => {
  for (const skillDir of VIDEO_SKILL_DIRS) {
    const extractor = readFileSync(join(skillDir, 'scripts', 'extract_subtitle_funasr.py'), 'utf-8')

    // In packaged (offline) mode the extractor must NOT silently fall through to
    // the network shorthands; it gates on READY_FUNASR_REQUIRE_LOCAL_MODELS and
    // emits the structured marker the main process detects.
    assert.match(extractor, /READY_FUNASR_REQUIRE_LOCAL_MODELS/, `${skillDir}: must gate on REQUIRE_LOCAL_MODELS`)
    assert.match(extractor, /__READY_ASR_MODEL_PACK_MISSING__/, `${skillDir}: must emit the missing-pack marker`)
    // The marker payload carries the missing roles so the host can map them to packs.
    assert.match(extractor, /"missing":\s*missing_roles/, `${skillDir}: marker payload must carry missing roles`)
  }
})

test('video skills report packaged runtime gaps instead of asking installed users to install dependencies', () => {
  const files: string[] = []
  for (const skillDir of VIDEO_SKILL_DIRS) {
    const scriptsDir = join(skillDir, 'scripts')
    const stack = [scriptsDir]
    while (stack.length > 0) {
      const current = stack.pop()
      assert.ok(current)
      for (const entry of readdirSync(current)) {
        const fullPath = join(current, entry)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
          stack.push(fullPath)
        } else if (entry.endsWith('.py')) {
          files.push(fullPath)
        }
      }
    }
  }

  const runtimeInstallPattern = /pip install|pip3 install|brew install|安装命令|下载 FFmpeg|首次运行需下载/i
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, 'utf-8'), runtimeInstallPattern, file)
  }
})
