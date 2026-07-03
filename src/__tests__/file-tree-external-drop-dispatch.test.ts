import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __rssDragSessionAgeMs,
  beginRssItemDragSession,
  buildBrowserTabAnalysisItemId,
  dispatchFileTreeExternalDropAction,
  endRssItemDragSession,
  getActiveRssItemDragPayload,
  isLikelyVideoDropPayload,
  parseWebDownloadDragPayload,
  type BrowserTabDragPayload,
  type FileTreeDropTarget,
  type RSSItemDragPayload,
} from '../renderer/components/layout/fileTreeExternalDrop'

interface ClipCall {
  url: string
  title?: string
  target_hint?: string
  target_dir?: string
  client_task_id?: string
}

interface ClipCurrentCall {
  tab_id?: string | null
  target_hint?: string
  target_dir?: string
}

interface AnalysisCall {
  itemId: string
  action: 'copy' | 'visual'
  link: string
  title: string
  targetDir: string
  source?: string
  summary?: string
  publishedAt?: string
}

interface AnalysisJobData {
  id: string
  itemId: string
  action: 'copy' | 'visual'
  sourceUrl: string
  title: string
  targetDir: string
  outputDir: string
  reportPath: string | null
  status: 'queued' | 'paused' | 'running_script' | 'running_subagent' | 'success' | 'failed' | 'skipped'
  progress: number
  message: string | null
  error: string | null
  meta: Record<string, unknown> | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

interface ContentStudyCall {
  url: string
  title?: string
  target_hint?: string
  target_dir?: string
  client_task_id_clip?: string
  client_task_id_study?: string
}

interface ElectronAPIShape {
  browser: {
    clipCurrentTab: (args?: ClipCurrentCall) => Promise<{
      ok: boolean
      errorKind?: string
      errorDetail?: Record<string, unknown>
      copiedPath?: string
      savedPath?: string
      copyError?: { kind: string; message: string }
    }>
    clipDraggedTab: (args: ClipCall) => Promise<{ ok: boolean }>
    contentStudyDraggedTab: (args: ContentStudyCall) => Promise<{ ok: boolean; clipTaskId?: string; studyTaskId?: string }>
  }
  rss: { startItemAnalysis: (args: AnalysisCall) => Promise<{ success: boolean; data?: AnalysisJobData; error?: string }> }
}

interface ElectronAPIOverrides {
  browser?: Partial<ElectronAPIShape['browser']>
  rss?: Partial<ElectronAPIShape['rss']>
}

function installFakeApi(overrides?: ElectronAPIOverrides): {
  clipCalls: ClipCall[]
  clipCurrentCalls: ClipCurrentCall[]
  analysisCalls: AnalysisCall[]
  contentStudyCalls: ContentStudyCall[]
  restore: () => void
} {
  const clipCalls: ClipCall[] = []
  const clipCurrentCalls: ClipCurrentCall[] = []
  const analysisCalls: AnalysisCall[] = []
  const contentStudyCalls: ContentStudyCall[] = []
  const browser: ElectronAPIShape['browser'] = {
    clipCurrentTab: async (args) => {
      clipCurrentCalls.push(args || {})
      return { ok: true, copiedPath: '/workspace/notes/Example Page.md' }
    },
    clipDraggedTab: async (args) => {
      clipCalls.push(args)
      return { ok: true }
    },
    contentStudyDraggedTab: async (args) => {
      contentStudyCalls.push(args)
      return { ok: true, clipTaskId: args.client_task_id_clip, studyTaskId: args.client_task_id_study }
    },
    ...overrides?.browser,
  }
  const rss: ElectronAPIShape['rss'] = {
    startItemAnalysis: async (args) => {
      analysisCalls.push(args)
      const now = new Date(0).toISOString()
      return {
        success: true,
        data: {
          id: `job-${analysisCalls.length}`,
          itemId: args.itemId,
          action: args.action,
          sourceUrl: args.link,
          title: args.title,
          targetDir: args.targetDir,
          outputDir: `${args.targetDir}/analysis-output`,
          reportPath: null,
          status: 'queued',
          progress: 5,
          message: '已排队，等待执行',
          error: null,
          meta: null,
          createdAt: now,
          startedAt: null,
          updatedAt: now,
          finishedAt: null,
        },
      }
    },
    ...overrides?.rss,
  }
  const fake: ElectronAPIShape = {
    browser,
    rss,
  }
  const originalWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { electronAPI: fake }
  const originalAlert = (globalThis as { alert?: unknown }).alert
  ;(globalThis as { alert?: (msg: string) => void }).alert = () => {}
  return {
    clipCalls,
    clipCurrentCalls,
    analysisCalls,
    contentStudyCalls,
    restore: () => {
      ;(globalThis as { window?: unknown }).window = originalWindow
      ;(globalThis as { alert?: unknown }).alert = originalAlert
    },
  }
}

const insideDirTarget: FileTreeDropTarget = {
  kind: 'inside-directory',
  dirPath: '/workspace/notes',
  itemPath: '/workspace/notes',
  containerPath: '/workspace/notes',
}

const browserTab: BrowserTabDragPayload = {
  type: 'browser-tab',
  tabId: 'tab-abc',
  title: 'Example Page',
  name: 'Example Page',
  url: 'https://example.com/article',
}

const rssItem: RSSItemDragPayload = {
  type: 'rss-item',
  id: 'rss-xyz',
  name: 'Daily News',
  title: 'Daily News',
  link: 'https://feed.example.com/post/1',
  summary: 'A short summary',
  source: 'example-feed',
  publishedAt: '2026-05-01',
}

function makeDropData(values: Record<string, string>): Pick<DataTransfer, 'getData'> {
  return {
    getData: (type: string) => values[type] || '',
  }
}

test('web download drops extract downloadable media URLs and reject ordinary pages', () => {
  const imageFromUriList = parseWebDownloadDragPayload(makeDropData({
    'text/uri-list': '# dragged image\nhttps://cdn.example.com/path/photo.jpg?token=abc',
  }))
  assert.equal(imageFromUriList?.type, 'web-download-url')
  assert.equal(imageFromUriList?.url, 'https://cdn.example.com/path/photo.jpg?token=abc')
  assert.equal(imageFromUriList?.suggestedName, 'photo.jpg')

  const extensionlessImage = parseWebDownloadDragPayload(makeDropData({
    'text/html': '<img src="https://images.example.com/asset?id=123&amp;w=800">',
  }))
  assert.equal(extensionlessImage?.url, 'https://images.example.com/asset?id=123&w=800')

  const videoDownloadLink = parseWebDownloadDragPayload(makeDropData({
    'text/html': '<a href="https://cdn.example.com/video/clip.mp4?sig=1" download="clip.mp4">clip</a>',
  }))
  assert.equal(videoDownloadLink?.url, 'https://cdn.example.com/video/clip.mp4?sig=1')
  assert.equal(videoDownloadLink?.suggestedName, 'clip.mp4')

  const ordinaryPage = parseWebDownloadDragPayload(makeDropData({
    'text/plain': 'https://example.com/article',
  }))
  assert.equal(ordinaryPage, null)

  const blobImage = parseWebDownloadDragPayload(makeDropData({
    'text/html': '<img src="blob:https://example.com/temporary-id">',
  }))
  assert.equal(blobImage?.type, 'web-download-url')
  assert.match(blobImage?.unsupportedReason || '', /临时网页资源/)
})

test('video-only drop actions treat Xiaohongshu notes but not generic account pages as visual resources', () => {
  assert.equal(
    isLikelyVideoDropPayload({
      ...browserTab,
      url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06',
    }),
    false,
  )
  assert.equal(
    isLikelyVideoDropPayload({
      ...browserTab,
      url: 'https://www.xiaohongshu.com/user/profile/5e31b693000000000100bb06/6a0ae7700000000035038e72',
    }),
    true,
  )
  assert.equal(
    isLikelyVideoDropPayload({
      ...browserTab,
      url: 'https://xhslink.com/a/abc123',
    }),
    false,
  )
  assert.equal(
    isLikelyVideoDropPayload({
      ...browserTab,
      url: 'https://www.xiaohongshu.com/explore/665f5a23000000001e03a123?xsec_token=abc&xsec_source=pc_user',
    }),
    true,
  )
  assert.equal(isLikelyVideoDropPayload({ ...browserTab, url: 'https://www.bilibili.com/video/BV1h9Ln6DEJE/' }), true)
  assert.equal(isLikelyVideoDropPayload({ ...browserTab, url: 'https://example.com/video/foo' }), true)
  assert.equal(isLikelyVideoDropPayload({ ...browserTab, url: 'https://cdn.example.com/foo.mp4' }), true)
})

test('web-clip uses live BrowserView DOM for browser tabs and URL fetch for RSS items', async () => {
  const { clipCalls, clipCurrentCalls, analysisCalls, restore } = installFakeApi()
  const updates: Array<{ taskId: string; status?: string; copiedPath?: string }> = []
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'web-clip',
      target: insideDirTarget,
      onPlaceholderUpdate: (taskId, patch) => updates.push({ taskId, ...patch }),
    })
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'web-clip',
      target: insideDirTarget,
    })

    assert.equal(clipCurrentCalls.length, 1)
    assert.equal(clipCurrentCalls[0].tab_id, 'tab-abc')
    assert.equal(clipCurrentCalls[0].target_dir, '/workspace/notes')
    assert.equal(clipCalls.length, 1)
    assert.equal(analysisCalls.length, 0)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].status, 'completed')
    assert.equal(updates[0].copiedPath, '/workspace/notes/Example Page.md')
    assert.equal(clipCalls[0].url, 'https://feed.example.com/post/1')
    assert.equal(clipCalls[0].title, 'Daily News')
    assert.equal(clipCalls[0].target_dir, '/workspace/notes')
  } finally {
    restore()
  }
})

test('copy-analysis and visual-analysis route both sources to startItemAnalysis', async () => {
  const { clipCalls, analysisCalls, restore } = installFakeApi()
  const placeholders: Array<{ taskId: string; action: string; status: string; progress: number }> = []
  const updates: Array<{ taskId: string; status?: string; jobId?: string; progress?: number; outputDir?: string }> = []
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'copy-analysis',
      target: insideDirTarget,
      onAnalysisPlaceholderStart: (p) =>
        placeholders.push({ taskId: p.taskId, action: p.action, status: p.status, progress: p.progress }),
      onAnalysisPlaceholderUpdate: (taskId, patch) => updates.push({ taskId, ...patch }),
    })
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'visual-analysis',
      target: insideDirTarget,
      onAnalysisPlaceholderStart: (p) =>
        placeholders.push({ taskId: p.taskId, action: p.action, status: p.status, progress: p.progress }),
      onAnalysisPlaceholderUpdate: (taskId, patch) => updates.push({ taskId, ...patch }),
    })

    assert.equal(clipCalls.length, 0)
    assert.equal(analysisCalls.length, 2)
    assert.equal(analysisCalls[0].action, 'copy')
    assert.equal(analysisCalls[0].itemId, buildBrowserTabAnalysisItemId(browserTab.url))
    assert.equal(analysisCalls[0].source, 'browser-tab')
    assert.equal(analysisCalls[0].link, 'https://example.com/article')
    assert.equal(analysisCalls[0].targetDir, '/workspace/notes')
    assert.equal(analysisCalls[1].action, 'visual')
    assert.equal(analysisCalls[1].itemId, 'rss-xyz')
    assert.equal(analysisCalls[1].source, 'example-feed')
    assert.equal(analysisCalls[1].link, 'https://feed.example.com/post/1')
    assert.deepEqual(placeholders.map((p) => [p.action, p.status, p.progress]), [
      ['copy', 'queued', 3],
      ['visual', 'queued', 3],
    ])
    assert.equal(updates.length, 2)
    assert.equal(updates[0].jobId, 'job-1')
    assert.equal(updates[0].status, 'queued')
    assert.equal(updates[0].progress, 5)
    assert.equal(updates[1].jobId, 'job-2')
    assert.equal(updates[1].outputDir, '/workspace/notes/analysis-output')
  } finally {
    restore()
  }
})

test('browser tab analysis item id follows URL rather than transient tab id', async () => {
  const { analysisCalls, restore } = installFakeApi()
  try {
    await dispatchFileTreeExternalDropAction({
      payload: {
        ...browserTab,
        tabId: 'tab-reused',
        url: 'https://www.bilibili.com/video/BV1zBEr6AEnE/',
      },
      action: 'copy-analysis',
      target: insideDirTarget,
    })
    await dispatchFileTreeExternalDropAction({
      payload: {
        ...browserTab,
        tabId: 'tab-reused',
        url: 'https://www.bilibili.com/video/BV1shJP6TEEQ/',
      },
      action: 'copy-analysis',
      target: insideDirTarget,
    })

    assert.equal(analysisCalls.length, 2)
    assert.notEqual(analysisCalls[0].itemId, analysisCalls[1].itemId)
    assert.equal(analysisCalls[0].itemId, buildBrowserTabAnalysisItemId(analysisCalls[0].link))
    assert.equal(analysisCalls[1].itemId, buildBrowserTabAnalysisItemId(analysisCalls[1].link))
    assert.match(analysisCalls[0].itemId, /^[0-9a-f]{8}-btab$/)
    assert.match(analysisCalls[0].itemId.slice(0, 8), /^[0-9a-f]{8}$/)
  } finally {
    restore()
  }
})

test('analysis placeholder is marked failed when startItemAnalysis rejects', async () => {
  const updates: Array<{ taskId: string; status?: string; errorMessage?: string }> = []
  const { restore } = installFakeApi({
    rss: {
      startItemAnalysis: async () => ({ success: false, error: 'not a video' }),
    },
  })
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'visual-analysis',
      target: insideDirTarget,
      onAnalysisPlaceholderUpdate: (taskId, patch) => updates.push({ taskId, ...patch }),
    })
    assert.equal(updates.length, 1)
    assert.equal(updates[0].status, 'failed')
    assert.equal(updates[0].errorMessage, 'not a video')
  } finally {
    restore()
  }
})

test('content-study calls contentStudyDraggedTab with both task ids and does not alert', async () => {
  let alertCount = 0
  const { clipCalls, analysisCalls, contentStudyCalls, restore } = installFakeApi()
  ;(globalThis as { alert?: (msg: string) => void }).alert = () => {
    alertCount += 1
  }
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'content-study',
      target: insideDirTarget,
    })
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'content-study',
      target: insideDirTarget,
    })

    assert.equal(clipCalls.length, 0)
    assert.equal(analysisCalls.length, 0)
    assert.equal(alertCount, 0)
    assert.equal(contentStudyCalls.length, 2)
    assert.equal(contentStudyCalls[0].url, 'https://example.com/article')
    assert.equal(contentStudyCalls[0].target_dir, '/workspace/notes')
    assert.match(contentStudyCalls[0].client_task_id_clip ?? '', /^client-.*-clip$/)
    assert.match(contentStudyCalls[0].client_task_id_study ?? '', /^client-.*-study$/)
    assert.equal(contentStudyCalls[1].url, 'https://feed.example.com/post/1')
  } finally {
    restore()
  }
})

test('content-study emits two placeholders (clip + study) before the IPC ack', async () => {
  const { restore } = installFakeApi()
  const clipPlaceholders: Array<{ taskId: string; status: string }> = []
  const studyPlaceholders: Array<{ taskId: string; status: string }> = []
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'content-study',
      target: insideDirTarget,
      onPlaceholderStart: (p) => clipPlaceholders.push({ taskId: p.taskId, status: p.status }),
      onStudyPlaceholderStart: (p) => studyPlaceholders.push({ taskId: p.taskId, status: p.status }),
    })
    assert.equal(clipPlaceholders.length, 1)
    assert.equal(studyPlaceholders.length, 1)
    assert.match(clipPlaceholders[0].taskId, /-clip$/)
    assert.match(studyPlaceholders[0].taskId, /-study$/)
    assert.notEqual(clipPlaceholders[0].taskId, studyPlaceholders[0].taskId)
  } finally {
    restore()
  }
})

test('content-study marks both placeholders failed when IPC ack rejects', async () => {
  const clipUpdates: Array<{ taskId: string; status?: string; errorMessage?: string }> = []
  const studyUpdates: Array<{ taskId: string; status?: string; errorMessage?: string }> = []
  const { restore } = installFakeApi({
    browser: {
      clipDraggedTab: async () => ({ ok: true }),
      contentStudyDraggedTab: async () =>
        ({ ok: false, errorDetail: { message: 'bad url' } } as unknown as { ok: boolean }),
    },
  })
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'content-study',
      target: insideDirTarget,
      onPlaceholderUpdate: (taskId, patch) => clipUpdates.push({ taskId, ...patch }),
      onStudyPlaceholderUpdate: (taskId, patch) => studyUpdates.push({ taskId, ...patch }),
    })
    assert.equal(clipUpdates.length, 1)
    assert.equal(studyUpdates.length, 1)
    assert.equal(clipUpdates[0].status, 'failed')
    assert.equal(studyUpdates[0].status, 'failed')
    assert.equal(clipUpdates[0].errorMessage, 'bad url')
    assert.equal(studyUpdates[0].errorMessage, 'bad url')
  } finally {
    restore()
  }
})

test('web-clip emits a running placeholder before the IPC ack', async () => {
  const { restore } = installFakeApi()
  const placeholders: Array<{ taskId: string; status: string }> = []
  try {
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'web-clip',
      target: insideDirTarget,
      onPlaceholderStart: (p) => placeholders.push({ taskId: p.taskId, status: p.status }),
    })
    assert.equal(placeholders.length, 1)
    assert.match(placeholders[0].taskId, /^client-/)
    assert.equal(placeholders[0].status, 'running')
  } finally {
    restore()
  }
})

test('web-clip placeholder is marked failed when IPC ack rejects', async () => {
  const updates: Array<{ taskId: string; status?: string; errorMessage?: string }> = []
  const { restore } = installFakeApi({
    browser: {
      clipCurrentTab: async () => ({ ok: true }),
      clipDraggedTab: async () => ({ ok: false, errorDetail: { message: 'bad url' } } as unknown as { ok: boolean }),
      contentStudyDraggedTab: async () => ({ ok: true }),
    },
  })
  try {
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'web-clip',
      target: insideDirTarget,
      onPlaceholderUpdate: (taskId, patch) => updates.push({ taskId, ...patch }),
    })
    assert.equal(updates.length, 1)
    assert.equal(updates[0].status, 'failed')
    assert.equal(updates[0].errorMessage, 'bad url')
  } finally {
    restore()
  }
})

test('browser-tab web-clip placeholder is marked failed when live tab clip cannot write target folder', async () => {
  const updates: Array<{ taskId: string; status?: string; errorMessage?: string; copiedPath?: string }> = []
  const { restore } = installFakeApi({
    browser: {
      clipCurrentTab: async () => ({
        ok: true,
        savedPath: '/tmp/outputs/obsidian-web-clip/xhs.md',
        copyError: { kind: 'invalid_target', message: 'target_dir must be absolute' },
      }),
      clipDraggedTab: async () => ({ ok: true }),
      contentStudyDraggedTab: async () => ({ ok: true }),
    },
  })
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'web-clip',
      target: insideDirTarget,
      onPlaceholderUpdate: (taskId, patch) => updates.push({ taskId, ...patch }),
    })
    assert.equal(updates.length, 1)
    assert.equal(updates[0].status, 'failed')
    assert.equal(updates[0].copiedPath, '/tmp/outputs/obsidian-web-clip/xhs.md')
    assert.match(updates[0].errorMessage || '', /target_dir must be absolute/)
  } finally {
    restore()
  }
})

test('rss item drag session persists payload across dragover-safe phases (parity with browser tab session)', () => {
  endRssItemDragSession()
  assert.strictEqual(getActiveRssItemDragPayload(), null)

  beginRssItemDragSession({
    type: 'rss-item',
    id: 'rss-session-1',
    name: 'Headline',
    title: 'Headline',
    link: 'https://feed.example.com/post/42',
    summary: 'a summary',
    source: 'example',
    publishedAt: '2026-05-01',
  })

  const recovered = getActiveRssItemDragPayload()
  assert.deepStrictEqual(recovered, {
    type: 'rss-item',
    id: 'rss-session-1',
    name: 'Headline',
    title: 'Headline',
    link: 'https://feed.example.com/post/42',
    summary: 'a summary',
    source: 'example',
    publishedAt: '2026-05-01',
  })

  endRssItemDragSession()
  assert.strictEqual(getActiveRssItemDragPayload(), null)
})

test('RSS drag session auto-clears after 60s TTL (regression for unmounted-mid-drag leak surfacing on later drops)', () => {
  // Stub Date.now so we can simulate the TTL without sleeping.
  const realNow = Date.now
  let virtualNow = 5_000_000
  globalThis.Date.now = () => virtualNow

  try {
    endRssItemDragSession() // reset
    beginRssItemDragSession({
      type: 'rss-item',
      id: 'rss-stale',
      name: 'Stale Headline',
      title: 'Stale Headline',
      link: 'https://feed.example.com/post/stale',
    })

    // Within TTL → payload returned normally.
    virtualNow += 30_000
    assert.notStrictEqual(getActiveRssItemDragPayload(), null, 'within 60s: payload should be live')
    assert.equal(__rssDragSessionAgeMs(), 30_000)

    // Past TTL → payload must be cleared so a subsequent unrelated drop
    // (e.g. desktop file or new browser tab) does not pop the RSS menu.
    virtualNow += 31_000 // total age 61s
    assert.strictEqual(
      getActiveRssItemDragPayload(),
      null,
      'past 60s: payload must be auto-cleared so the fallback in FileTree.getExternalDropPayload does not surface stale RSS state',
    )
    assert.strictEqual(__rssDragSessionAgeMs(), null, 'internal record must be cleared after stale get')
  } finally {
    globalThis.Date.now = realNow
    endRssItemDragSession()
  }
})

test('insert-before target resolves to containerPath for targetDir', async () => {
  const { clipCurrentCalls, restore } = installFakeApi()
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'web-clip',
      target: {
        kind: 'insert-before',
        anchorPath: '/workspace/notes/draft.md',
        containerPath: '/workspace/notes',
      },
    })
    assert.equal(clipCurrentCalls.length, 1)
    assert.equal(clipCurrentCalls[0].target_dir, '/workspace/notes')
    assert.equal(clipCurrentCalls[0].target_hint, '/workspace/notes/draft.md')
  } finally {
    restore()
  }
})
