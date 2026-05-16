import assert from 'node:assert/strict'
import test from 'node:test'

import {
  beginRssItemDragSession,
  dispatchFileTreeExternalDropAction,
  endRssItemDragSession,
  getActiveRssItemDragPayload,
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

interface ElectronAPIShape {
  browser: { clipDraggedTab: (args: ClipCall) => Promise<{ ok: boolean }> }
  rss: { startItemAnalysis: (args: AnalysisCall) => Promise<{ success: boolean }> }
}

function installFakeApi(overrides?: Partial<ElectronAPIShape>): {
  clipCalls: ClipCall[]
  analysisCalls: AnalysisCall[]
  restore: () => void
} {
  const clipCalls: ClipCall[] = []
  const analysisCalls: AnalysisCall[] = []
  const fake: ElectronAPIShape = {
    browser: {
      clipDraggedTab: async (args) => {
        clipCalls.push(args)
        return { ok: true }
      },
    },
    rss: {
      startItemAnalysis: async (args) => {
        analysisCalls.push(args)
        return { success: true }
      },
    },
    ...overrides,
  }
  const originalWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = { electronAPI: fake }
  const originalAlert = (globalThis as { alert?: unknown }).alert
  ;(globalThis as { alert?: (msg: string) => void }).alert = () => {}
  return {
    clipCalls,
    analysisCalls,
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

test('web-clip routes both browser-tab and rss-item sources to clipDraggedTab', async () => {
  const { clipCalls, analysisCalls, restore } = installFakeApi()
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'web-clip',
      target: insideDirTarget,
    })
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'web-clip',
      target: insideDirTarget,
    })

    assert.equal(clipCalls.length, 2)
    assert.equal(analysisCalls.length, 0)
    assert.equal(clipCalls[0].url, 'https://example.com/article')
    assert.equal(clipCalls[0].title, 'Example Page')
    assert.equal(clipCalls[0].target_dir, '/workspace/notes')
    assert.equal(clipCalls[1].url, 'https://feed.example.com/post/1')
    assert.equal(clipCalls[1].title, 'Daily News')
    assert.equal(clipCalls[1].target_dir, '/workspace/notes')
  } finally {
    restore()
  }
})

test('copy-analysis and visual-analysis route both sources to startItemAnalysis', async () => {
  const { clipCalls, analysisCalls, restore } = installFakeApi()
  try {
    await dispatchFileTreeExternalDropAction({
      payload: browserTab,
      action: 'copy-analysis',
      target: insideDirTarget,
    })
    await dispatchFileTreeExternalDropAction({
      payload: rssItem,
      action: 'visual-analysis',
      target: insideDirTarget,
    })

    assert.equal(clipCalls.length, 0)
    assert.equal(analysisCalls.length, 2)
    assert.equal(analysisCalls[0].action, 'copy')
    assert.equal(analysisCalls[0].itemId, 'tab-abc')
    assert.equal(analysisCalls[0].source, 'browser-tab')
    assert.equal(analysisCalls[0].link, 'https://example.com/article')
    assert.equal(analysisCalls[0].targetDir, '/workspace/notes')
    assert.equal(analysisCalls[1].action, 'visual')
    assert.equal(analysisCalls[1].itemId, 'rss-xyz')
    assert.equal(analysisCalls[1].source, 'example-feed')
    assert.equal(analysisCalls[1].link, 'https://feed.example.com/post/1')
  } finally {
    restore()
  }
})

test('content-study placeholder triggers alert and does not call any IPC', async () => {
  let alertMessage = ''
  const { clipCalls, analysisCalls, restore } = installFakeApi()
  ;(globalThis as { alert?: (msg: string) => void }).alert = (msg) => {
    alertMessage = msg
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
    assert.match(alertMessage, /内容学习/)
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
      clipDraggedTab: async () => ({ ok: false, errorDetail: { message: 'bad url' } } as unknown as { ok: boolean }),
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
    assert.equal(updates[0].errorMessage, 'bad url')
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

test('insert-before target resolves to containerPath for targetDir', async () => {
  const { clipCalls, restore } = installFakeApi()
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
    assert.equal(clipCalls.length, 1)
    assert.equal(clipCalls[0].target_dir, '/workspace/notes')
    assert.equal(clipCalls[0].target_hint, '/workspace/notes/draft.md')
  } finally {
    restore()
  }
})
