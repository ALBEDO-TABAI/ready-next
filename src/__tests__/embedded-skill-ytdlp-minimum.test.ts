import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const MIN_YT_DLP = '2026.6.9'
const MIN_QUICKJS = '1.19.4'
const ROOT = process.cwd()

const FILES = [
  'assets/embedded-skills/video-expert-analyzer/requirements.txt',
  'assets/embedded-skills/video-expert-analyzer/pyproject.toml',
  'assets/embedded-skills/video-copy-analyzer/requirements.txt',
  'assets/embedded-skills/lets-go-rss/requirements.txt',
]

test('embedded video/RSS skills require the current yt-dlp minimum', () => {
  for (const file of FILES) {
    const text = readFileSync(join(ROOT, file), 'utf-8')
    assert.match(text, new RegExp(`yt-dlp>=${MIN_YT_DLP.replaceAll('.', '\\.')}`), `${file} must force Ready runtime dependency refresh`)
  }
})

test('embedded video download skills include a packaged JS runtime fallback for yt-dlp', () => {
  for (const file of [
    'assets/embedded-skills/video-expert-analyzer/requirements.txt',
    'assets/embedded-skills/video-expert-analyzer/pyproject.toml',
    'assets/embedded-skills/video-copy-analyzer/requirements.txt',
  ]) {
    const text = readFileSync(join(ROOT, file), 'utf-8')
    assert.match(text, new RegExp(`quickjs>=${MIN_QUICKJS.replaceAll('.', '\\.')}`), `${file} must not rely on shell Node PATH for YouTube challenge solving`)
  }
})
