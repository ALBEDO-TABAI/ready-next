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
