import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('VideoFallbackService owns ffmpeg lookup and frame extraction helpers', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/video-fallback-service.ts')

  assert.match(source, /export class VideoFallbackService/)
  assert.match(source, /async buildVideoFrameFallbackMessages\(/)
  assert.match(source, /async extractFramesFromVideoBase64\(/)
  assert.match(source, /getFfmpegPath\(/)
  assert.match(source, /extensionFromVideoMediaType\(/)
})
