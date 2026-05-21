import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeYtDlpVideoInfo,
  resolveDirectFastCardVideo,
  resolveFastCardVideo,
} from '../main/modules/browser-engine/fastcard-video-resolver'
import type { BrowserFastCardVideoTarget } from '../shared/fastcard'

function makeTarget(patch: Partial<BrowserFastCardVideoTarget> = {}): BrowserFastCardVideoTarget {
  return {
    kind: 'video',
    pageUrl: 'https://example.com/watch/1',
    pageTitle: 'Example',
    domain: 'example.com',
    tabId: 'tab-1',
    capturedAt: 1,
    ...patch,
  }
}

test('direct page video source is resolved without external parser', () => {
  const video = resolveDirectFastCardVideo(makeTarget({
    videoUrl: 'https://cdn.example.com/video.mp4',
    posterUrl: 'https://cdn.example.com/poster.jpg',
    title: 'Inline video',
  }))
  assert.equal(video?.parseStatus, 'not_needed')
  assert.equal(video?.playableUrl, 'https://cdn.example.com/video.mp4')
  assert.equal(video?.posterUrl, 'https://cdn.example.com/poster.jpg')
})

test('yt-dlp json is normalized into FastCard video metadata', () => {
  const video = normalizeYtDlpVideoInfo({
    title: 'Clip',
    uploader: 'Author',
    extractor_key: 'YouTube',
    thumbnail: 'https://img.example.com/cover.jpg',
    duration: 42,
    requested_downloads: [{ url: 'https://media.example.com/clip.mp4' }],
  }, 'https://youtu.be/demo')

  assert.equal(video.parseStatus, 'resolved')
  assert.equal(video.title, 'Clip')
  assert.equal(video.author, 'Author')
  assert.equal(video.platform, 'YouTube')
  assert.equal(video.durationSeconds, 42)
  assert.equal(video.playableUrl, 'https://media.example.com/clip.mp4')
})

test('generic URL uses yt-dlp dump json and returns only metadata links', async () => {
  const result = await resolveFastCardVideo({ target: makeTarget({ pageUrl: 'https://video.example.com/watch/2' }) }, {
    runCommand: async (file, args) => {
      assert.equal(file, 'yt-dlp')
      assert.deepEqual(args.slice(0, 3), ['--dump-single-json', '--no-download', '--no-warnings'])
      return {
        stdout: JSON.stringify({
          title: 'Remote',
          url: 'https://media.example.com/remote.mp4',
          thumbnail: 'https://media.example.com/remote.jpg',
          extractor_key: 'Generic',
        }),
        stderr: '',
      }
    },
  })

  assert.equal(result.video.parseStatus, 'resolved')
  assert.equal(result.video.title, 'Remote')
  assert.equal(result.video.playableUrl, 'https://media.example.com/remote.mp4')
})

test('parser failure is kept as a visible FastCard video state', async () => {
  const result = await resolveFastCardVideo({ target: makeTarget({ pageUrl: 'https://video.example.com/watch/3' }) }, {
    runCommand: async () => {
      throw new Error('yt-dlp missing')
    },
  })

  assert.equal(result.video.parseStatus, 'failed')
  assert.equal(result.video.originalUrl, 'https://video.example.com/watch/3')
  assert.match(result.video.error || '', /yt-dlp missing/)
})
