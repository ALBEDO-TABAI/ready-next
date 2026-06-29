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

test('yt-dlp normalization prefers progressive formats over higher video-only formats', () => {
  const video = normalizeYtDlpVideoInfo({
    title: 'Short',
    extractor_key: 'YouTube',
    url: 'https://www.youtube.com/watch?v=vzqbgZjBsi4',
    formats: [
      {
        url: 'https://rr1---sn-googlevideo.com/videoplayback?mime=video%2Fmp4&itag=137',
        vcodec: 'avc1.640028',
        acodec: 'none',
        height: 1080,
        tbr: 9000,
      },
      {
        url: 'https://rr1---sn-googlevideo.com/videoplayback?mime=video%2Fmp4&itag=18',
        vcodec: 'avc1.42001E',
        acodec: 'mp4a.40.2',
        height: 360,
        tbr: 700,
      },
    ],
  }, 'https://www.youtube.com/shorts/vzqbgZjBsi4')

  assert.equal(video.parseStatus, 'resolved')
  assert.equal(video.playableUrl, 'https://rr1---sn-googlevideo.com/videoplayback?mime=video%2Fmp4&itag=18')
})

test('yt-dlp normalization does not report the source page as a resolved media URL', () => {
  const video = normalizeYtDlpVideoInfo({
    title: 'Short',
    extractor_key: 'YouTube',
    url: 'https://www.youtube.com/watch?v=vzqbgZjBsi4',
  }, 'https://www.youtube.com/shorts/vzqbgZjBsi4')

  assert.equal(video.parseStatus, 'failed')
  assert.equal(video.playableUrl, undefined)
  assert.match(video.error || '', /未返回可用链接/)
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

test('Xiaohongshu URL uses the embedded VEA downloader parser', async () => {
  const result = await resolveFastCardVideo({ target: makeTarget({ pageUrl: 'https://www.xiaohongshu.com/explore/69df5244000000001a02a0f8' }) }, {
    pythonCandidates: ['python3'],
    runCommand: async (file, args) => {
      assert.equal(file, 'python3')
      assert.equal(args[0], '-c')
      assert.match(args[1], /XiaohongshuDownloader/)
      assert.match(args[2], /xiaohongshu_downloader\.py$/)
      return {
        stdout: JSON.stringify({
          success: true,
          title: '小红书视频',
          uploader: 'Aoi葵',
          video_url: 'https://sns-video.xhscdn.com/video.mp4',
          cover_url: 'https://sns-webpic-qc.xhscdn.com/poster.webp',
        }),
        stderr: '',
      }
    },
  })

  assert.equal(result.video.parseStatus, 'resolved')
  assert.equal(result.video.platform, 'xiaohongshu')
  assert.equal(result.video.title, '小红书视频')
  assert.equal(result.video.author, 'Aoi葵')
  assert.equal(result.video.downloadUrl, 'https://sns-video.xhscdn.com/video.mp4')
  assert.equal(result.video.posterUrl, 'https://sns-webpic-qc.xhscdn.com/poster.webp')
})

test('resolver keeps every attempted Python failure visible', async () => {
  const result = await resolveFastCardVideo({ target: makeTarget({ pageUrl: 'https://www.xiaohongshu.com/explore/69df5244000000001a02a0f8' }) }, {
    pythonCandidates: ['python3', 'python'],
    runCommand: async (file) => {
      if (file === 'python3') {
        const error = new Error('command failed') as Error & { stderr?: string }
        error.stderr = 'ModuleNotFoundError: No module named requests'
        throw error
      }
      throw new Error('spawn python ENOENT')
    },
  })

  assert.equal(result.video.parseStatus, 'failed')
  assert.match(result.video.error || '', /python3/)
  assert.match(result.video.error || '', /ModuleNotFoundError/)
  assert.match(result.video.error || '', /python/)
  assert.match(result.video.error || '', /ENOENT/)
})

test('parser failure is kept as a visible FastCard video state', async () => {
  const result = await resolveFastCardVideo({ target: makeTarget({ pageUrl: 'https://video.example.com/watch/3' }) }, {
    pythonCandidates: ['python3'],
    runCommand: async () => {
      throw new Error('yt-dlp missing')
    },
  })

  assert.equal(result.video.parseStatus, 'failed')
  assert.equal(result.video.originalUrl, 'https://video.example.com/watch/3')
  assert.match(result.video.error || '', /yt-dlp missing/)
})
