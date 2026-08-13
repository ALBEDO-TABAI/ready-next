import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { useAttachmentPreview } from '../renderer/components/agent/chat-panel/attachments-preview/use-attachment-preview'
import {
  useAgent,
  type AttachmentPreviewState,
  type ChatAttachment,
  type SessionSlice,
} from '../renderer/stores/useAgent'

const testDom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
const previousWindow = globalThis.window
const previousDocument = globalThis.document
Object.defineProperty(globalThis, 'window', { value: testDom.window, configurable: true })
Object.defineProperty(globalThis, 'document', { value: testDom.window.document, configurable: true })
process.on('exit', () => {
  if (previousWindow) Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
  if (previousDocument) Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
  testDom.window.close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function makeSession(scopeId: string): SessionSlice {
  return {
    messages: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    lifecyclePendingAction: null,
    lifecycleError: null,
    state: 'live',
    conversationId: scopeId,
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    inputValue: '',
  }
}

function setComposer(session: 'a' | 'b', revision: number) {
  useAgent.setState({
    activeSessionId: `session-${session}`,
    sessionId: `session-${session}`,
    currentScopeId: `scope-${session}`,
    sessions: {
      'session-a': makeSession('scope-a'),
      'session-b': makeSession('scope-b'),
    },
    sessionOrder: ['session-a', 'session-b'],
    composerAuthorityRevision: revision,
    activeAttachmentPreview: null,
  } as unknown as Parameters<typeof useAgent.setState>[0])
}

const attachment: ChatAttachment = {
  id: 'attachment-a',
  name: 'a.md',
  path: '/tmp/a.md',
  type: 'text',
  size: 12,
  ext: '.md',
  source: 'file',
}

async function runPreviewCase(input: {
  changeAuthority?: () => void
  expectedPreviews: number
  expectedLoading: boolean[]
}) {
  const read = deferred<{
    success: boolean
    data: { type: 'text'; content: string }
  }>()
  Object.defineProperty(testDom.window, 'electronAPI', {
    value: { chat: { readFileForAI: () => read.promise } },
    configurable: true,
  })

  const previews: AttachmentPreviewState[] = []
  const loading: boolean[] = []
  let openPreview: ((attachment: ChatAttachment) => Promise<void>) | null = null
  function Harness() {
    openPreview = useAttachmentPreview({
      setActiveAttachmentPreview: (preview) => {
        if (preview) previews.push(preview)
      },
      setAttachmentPreviewLoading: (value) => loading.push(value),
    })
    return null
  }

  const root = createRoot(testDom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => root.render(createElement(Harness)))
    assert.ok(openPreview)
    const pending = openPreview(attachment)
    input.changeAuthority?.()
    read.resolve({ success: true, data: { type: 'text', content: 'A body' } })
    await pending

    assert.equal(previews.length, input.expectedPreviews)
    if (previews[0]) assert.equal(previews[0].content, 'A body')
    assert.deepEqual(loading, input.expectedLoading)
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('late text preview cannot open in a different composer session', async () => {
  setComposer('a', 1)
  await runPreviewCase({
    changeAuthority: () => setComposer('b', 2),
    expectedPreviews: 0,
    expectedLoading: [true],
  })
})

test('late text preview cannot reopen after resetting the same scope', async () => {
  setComposer('a', 1)
  await runPreviewCase({
    changeAuthority: () => setComposer('a', 2),
    expectedPreviews: 0,
    expectedLoading: [true],
  })
})

test('text preview resolves normally while the composer authority stays current', async () => {
  setComposer('a', 1)
  await runPreviewCase({
    expectedPreviews: 1,
    expectedLoading: [true, false],
  })
})
