import assert from 'node:assert/strict'
import test from 'node:test'

import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import type { BrowserNetworkEventRecord } from '../main/modules/browser-engine/network-observer-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function parseToolOutput(out: unknown): Record<string, unknown> {
  if (typeof out === 'string') return JSON.parse(out) as Record<string, unknown>
  if (out && typeof out === 'object') {
    const value = out as { data?: unknown; text?: unknown }
    if (value.data !== undefined && value.data !== null) return value.data as Record<string, unknown>
    if (typeof value.text === 'string') return JSON.parse(value.text) as Record<string, unknown>
  }
  return JSON.parse(String(out)) as Record<string, unknown>
}

test('browser_resources returns deduped candidates with safe download headers', async (t) => {
  if (skipIfSqliteUnavailable(t, 'browser-inspect-resources-tool transitive sqlite load')) return
  const callOrder: string[] = []
  const networkEvents: BrowserNetworkEventRecord[] = [
    {
      requestId: 'r1',
      url: 'https://v.douyinvod.com/video/tos/cn/example?mime_type=video_mp4',
      method: 'GET',
      status: 200,
      mimeType: 'video/mp4',
      resourceType: 'Media',
    },
  ]
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'Video', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'Video', active: true }],
    startNetworkObserver: async () => {
      callOrder.push('observe')
      return {
        events: () => networkEvents,
        getResponseBody: async () => ({ body: '{}', base64Encoded: false }),
        stop: async () => {
          callOrder.push('stop')
        },
      }
    },
    navigate: async () => {
      callOrder.push('navigate')
      return { success: true }
    },
    executeJS: async () => {
      callOrder.push('probe')
      return {
        url: 'https://www.douyin.com/video/7650355790565395731',
        resources: [
          {
            url: 'https://v.douyinvod.com/video/tos/cn/example?mime_type=video_mp4',
            kind: 'video',
            source: 'performance',
            mimeType: 'video/mp4',
            evidence: ['performance.resource'],
          },
          {
            url: 'https://www.example.com/poster.webp',
            kind: 'image',
            source: 'dom',
            mimeType: 'image/webp',
            evidence: ['video.poster'],
          },
        ],
      }
    },
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_resources',
    {
      url: 'https://www.douyin.com/video/7650355790565395731',
      kinds: ['video'],
      wait_ms: 0,
      max_candidates: 5,
    },
    controller,
  )
  const parsed = parseToolOutput(out)
  const candidates = parsed.candidates as Array<Record<string, unknown>>

  assert.deepEqual(callOrder, ['observe', 'navigate', 'probe', 'stop'])
  assert.equal(parsed.ok, true)
  assert.equal(parsed.candidateCount, 1)
  assert.equal(candidates[0].kind, 'video')
  assert.equal(candidates[0].source, 'network')
  assert.equal(candidates[0].url, 'https://v.douyinvod.com/video/tos/cn/example?mime_type=video_mp4')
  assert.deepEqual(candidates[0].downloadHeaders, {
    Accept: 'video/webm,video/ogg,video/*;q=0.9,audio/*;q=0.8,*/*;q=0.8',
    Referer: 'https://www.douyin.com/video/7650355790565395731',
  })
})

test('browser_download uses current-tab resource inspection before external parsing', async () => {
  const networkEvents: BrowserNetworkEventRecord[] = [
    {
      requestId: 'r1',
      url: 'https://v.douyinvod.com/video/tos/cn/current-tab?mime_type=video_mp4',
      method: 'GET',
      status: 200,
      mimeType: 'video/mp4',
      resourceType: 'Media',
    },
  ]
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'Video', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'Video', active: true }],
    startNetworkObserver: async () => ({
      events: () => networkEvents,
      getResponseBody: async () => ({ body: '{}', base64Encoded: false }),
      stop: async () => undefined,
    }),
    executeJS: async () => ({
      url: 'https://www.douyin.com/video/7650355790565395731',
      resources: [],
    }),
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_download',
    {
      mode: 'resolve',
      page_url: 'https://www.douyin.com/video/7650355790565395731',
      tab_id: 'tab-1',
    },
    controller,
  )
  const parsed = parseToolOutput(out)
  const video = parsed.video as Record<string, unknown>

  assert.equal(parsed.ok, true)
  assert.equal(parsed.source, 'network')
  assert.equal(video.parseStatus, 'resolved')
  assert.equal(video.downloadUrl, 'https://v.douyinvod.com/video/tos/cn/current-tab?mime_type=video_mp4')
})

test('browser_resources extracts Douyin video candidates from detail API response bodies', async () => {
  const detailUrl = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7650355790565395731'
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'Video', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://www.douyin.com/video/7650355790565395731', title: 'Video', active: true }],
    startNetworkObserver: async () => ({
      events: () => [
        {
          requestId: 'detail-1',
          url: detailUrl,
          method: 'GET',
          status: 200,
          mimeType: 'application/json',
          resourceType: 'XHR',
        },
      ],
      getResponseBody: async () => ({
        base64Encoded: false,
        body: JSON.stringify({
          aweme_detail: {
            aweme_id: '7650355790565395731',
            video: {
              bit_rate: [
                {
                  is_h265: true,
                  bit_rate: 999999,
                  play_addr: { url_list: ['https://v.douyinvod.com/video/h265?mime_type=video_mp4'] },
                },
                {
                  is_h265: false,
                  bit_rate: 800000,
                  gear_name: 'normal_720p',
                  play_addr: { url_list: ['https://v.douyinvod.com/video/h264?mime_type=video_mp4'] },
                },
              ],
              play_addr: { url_list: ['https://other.example.com/fallback'] },
            },
          },
        }),
      }),
      stop: async () => undefined,
    }),
    executeJS: async () => ({
      url: 'https://www.douyin.com/video/7650355790565395731',
      resources: [],
    }),
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_resources',
    { tab_id: 'tab-1', kinds: ['video'], wait_ms: 0 },
    controller,
  )
  const parsed = parseToolOutput(out)
  const candidates = parsed.candidates as Array<Record<string, unknown>>

  assert.equal(parsed.ok, true)
  assert.equal(candidates[0].source, 'response_body')
  assert.equal(candidates[0].url, 'https://v.douyinvod.com/video/h264?mime_type=video_mp4')
  assert.deepEqual(candidates[0].evidence, ['douyin.detail_api', 'label:normal_720p', 'bitrate:800000'])
})

test('browser_resources classifies YouTube googlevideo playback URLs by query mime', async () => {
  const videoUrl = 'https://rr1---sn-googlevideo.com/videoplayback?expire=1&mime=video%2Fmp4&itag=18'
  const audioUrl = 'https://rr1---sn-googlevideo.com/videoplayback?expire=1&mime=audio%2Fmp4&itag=140'
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://www.youtube.com/shorts/vzqbgZjBsi4', title: 'Short', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://www.youtube.com/shorts/vzqbgZjBsi4', title: 'Short', active: true }],
    startNetworkObserver: async () => ({
      events: () => [
        {
          requestId: 'yt-video',
          url: videoUrl,
          method: 'GET',
          status: 206,
          mimeType: '',
          resourceType: 'Other',
        },
        {
          requestId: 'yt-audio',
          url: audioUrl,
          method: 'GET',
          status: 206,
          mimeType: '',
          resourceType: 'Other',
        },
      ],
      getResponseBody: async () => ({ body: '', base64Encoded: false }),
      stop: async () => undefined,
    }),
    executeJS: async () => ({
      url: 'https://www.youtube.com/shorts/vzqbgZjBsi4',
      resources: [],
    }),
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_resources',
    { tab_id: 'tab-1', kinds: ['video'], wait_ms: 0 },
    controller,
  )
  const parsed = parseToolOutput(out)
  const candidates = parsed.candidates as Array<Record<string, unknown>>

  assert.equal(parsed.ok, true)
  assert.equal(parsed.candidateCount, 1)
  assert.equal(candidates[0].kind, 'video')
  assert.equal(candidates[0].source, 'network')
  assert.equal(candidates[0].url, videoUrl)
})

test('browser_resources extracts YouTube player response candidates and prefers progressive video', async () => {
  const progressiveUrl = 'https://rr1---sn-googlevideo.com/videoplayback?expire=1&mime=video%2Fmp4&itag=18'
  const videoOnlyUrl = 'https://rr1---sn-googlevideo.com/videoplayback?expire=1&mime=video%2Fmp4&itag=137'
  const audioOnlyUrl = 'https://rr1---sn-googlevideo.com/videoplayback?expire=1&mime=audio%2Fmp4&itag=140'
  const playerUrl = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://www.youtube.com/shorts/vzqbgZjBsi4', title: 'Short', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://www.youtube.com/shorts/vzqbgZjBsi4', title: 'Short', active: true }],
    startNetworkObserver: async () => ({
      events: () => [
        {
          requestId: 'player-1',
          url: playerUrl,
          method: 'POST',
          status: 200,
          mimeType: 'application/json',
          resourceType: 'XHR',
        },
      ],
      getResponseBody: async () => ({
        base64Encoded: false,
        body: JSON.stringify({
          streamingData: {
            formats: [
              {
                itag: 18,
                url: progressiveUrl,
                mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"',
                height: 360,
                bitrate: 700000,
                qualityLabel: '360p',
                audioQuality: 'AUDIO_QUALITY_MEDIUM',
              },
            ],
            adaptiveFormats: [
              {
                itag: 137,
                url: videoOnlyUrl,
                mimeType: 'video/mp4; codecs="avc1.640028"',
                height: 1080,
                bitrate: 9000000,
                qualityLabel: '1080p',
              },
              {
                itag: 140,
                url: audioOnlyUrl,
                mimeType: 'audio/mp4; codecs="mp4a.40.2"',
                bitrate: 128000,
                audioQuality: 'AUDIO_QUALITY_MEDIUM',
              },
            ],
          },
        }),
      }),
      stop: async () => undefined,
    }),
    executeJS: async () => ({
      url: 'https://www.youtube.com/shorts/vzqbgZjBsi4',
      resources: [],
    }),
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_resources',
    { tab_id: 'tab-1', kinds: ['video'], wait_ms: 0, max_candidates: 5 },
    controller,
  )
  const parsed = parseToolOutput(out)
  const candidates = parsed.candidates as Array<Record<string, unknown>>

  assert.equal(parsed.ok, true)
  assert.equal(candidates[0].source, 'response_body')
  assert.equal(candidates[0].url, progressiveUrl)
  assert.deepEqual(candidates[0].evidence, [
    'youtube.player_response',
    'track:progressive',
    'itag:18',
    'quality:360p',
    'mime:video/mp4',
  ])
  assert.ok(candidates.some((candidate) => candidate.url === videoOnlyUrl))
  assert.equal(candidates.some((candidate) => candidate.url === audioOnlyUrl), false)
})

test('browser_resources gives generic discovery guidance when no candidate is loaded yet', async () => {
  const controller = {
    getActiveTab: () => ({ id: 'tab-1', url: 'https://www.youtube.com/shorts/vzqbgZjBsi4', title: 'Short', active: true }),
    getTabList: () => [{ id: 'tab-1', url: 'https://www.youtube.com/shorts/vzqbgZjBsi4', title: 'Short', active: true }],
    startNetworkObserver: async () => ({
      events: () => [],
      getResponseBody: async () => ({ body: '', base64Encoded: false }),
      stop: async () => undefined,
    }),
    executeJS: async () => ({
      url: 'https://www.youtube.com/shorts/vzqbgZjBsi4',
      resources: [],
    }),
  } as unknown as BrowserController

  const out = await executeBrowserTool(
    'browser_resources',
    { tab_id: 'tab-1', kinds: ['video'], wait_ms: 0 },
    controller,
  )
  const parsed = parseToolOutput(out)

  assert.equal(parsed.ok, false)
  assert.equal(parsed.errorCode, 'failed_no_candidate')
  assert.match(String(parsed.message || ''), /不要直接改用外部下载站/)
  assert.ok((parsed.nextActions as string[]).some((item) => item.includes('播放')))
  assert.ok((parsed.nextActions as string[]).some((item) => item.includes('完整 URL')))
})
