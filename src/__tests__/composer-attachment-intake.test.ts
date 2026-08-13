import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { useAttachmentIntake, type AttachmentIntakeHandle } from '../renderer/components/agent/chat-panel/drag-drop/use-attachment-intake'
import { useAgent, type SessionSlice } from '../renderer/stores/useAgent'

const testDom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
const previousWindow = globalThis.window
const previousDocument = globalThis.document
Object.defineProperty(globalThis, 'window', { value: testDom.window, configurable: true })
Object.defineProperty(globalThis, 'document', { value: testDom.window.document, configurable: true })
process.on('exit', () => {
  if (previousWindow) {
    Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
  }
  if (previousDocument) {
    Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
  }
  testDom.window.close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function makeSession(conversationId: string, aliasGeneration: number): SessionSlice {
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
    conversationId,
    aliasGeneration,
    messageVisibilityEpoch: 0,
    inputValue: '',
  }
}

function setComposerSession(session: 'a' | 'b') {
  useAgent.setState({
    activeSessionId: `session-${session}`,
    sessionId: `session-${session}`,
    currentScopeId: `scope-${session}`,
    sessions: {
      'session-a': makeSession('scope-a', 1),
      'session-b': makeSession('scope-b', 1),
    },
    sessionOrder: ['session-a', 'session-b'],
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
  })
}

function makeDropEvent(input: {
  readyPayload?: Record<string, unknown>
  files?: File[]
}): ReactDragEvent {
  return {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    dataTransfer: {
      files: input.files || [],
      getData: (format: string) => format === 'application/x-ready-drag' && input.readyPayload
        ? JSON.stringify(input.readyPayload)
        : '',
    },
  } as unknown as ReactDragEvent
}

async function withMountedIntake(
  electronAPI: Record<string, unknown>,
  run: (handle: AttachmentIntakeHandle, focusCount: () => number) => Promise<void>,
) {
  Object.defineProperty(testDom.window, 'electronAPI', { value: electronAPI, configurable: true })

  let handle: AttachmentIntakeHandle | null = null
  let focuses = 0
  function Harness() {
    handle = useAttachmentIntake({
      addAttachments: useAgent.getState().addAttachments,
      setInputValue: useAgent.getState().setInputValue,
      setIsDragOver: () => undefined,
      focusInputWithResize: () => { focuses += 1 },
    })
    return null
  }

  const root = createRoot(testDom.window.document.getElementById('root') as HTMLElement)
  try {
    flushSync(() => root.render(createElement(Harness)))
    assert.ok(handle)
    await run(handle, () => focuses)
  } finally {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('late browser-tab context cannot attach to a different composer session', async () => {
  const context = deferred<{
    success: boolean
    data: { title: string; url: string; excerpt: string; capturedAt: number }
  }>()
  setComposerSession('a')

  await withMountedIntake({
    browser: { getTabContext: () => context.promise },
  }, async (handle, focusCount) => {
    await handle.handleDrop(makeDropEvent({
      readyPayload: {
        type: 'browser-tab',
        name: 'A tab',
        title: 'A tab',
        url: 'https://a.example',
        tabId: 'tab-a',
      },
    }))
    setComposerSession('b')
    context.resolve({
      success: true,
      data: {
        title: 'A resolved tab',
        url: 'https://a.example/resolved',
        excerpt: 'A only',
        capturedAt: 123,
      },
    })
    await context.promise
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.deepEqual(useAgent.getState().attachments, [])
    assert.deepEqual(useAgent.getState().filePool, [])
    assert.equal(focusCount(), 0)
  })
})

test('browser-tab context attaches normally while the originating composer stays current', async () => {
  const context = deferred<{
    success: boolean
    data: { title: string; url: string; excerpt: string; capturedAt: number }
  }>()
  setComposerSession('a')

  await withMountedIntake({
    browser: { getTabContext: () => context.promise },
  }, async (handle, focusCount) => {
    await handle.handleDrop(makeDropEvent({
      readyPayload: {
        type: 'browser-tab',
        name: 'A tab',
        title: 'A tab',
        url: 'https://a.example',
        tabId: 'tab-a',
      },
    }))
    context.resolve({
      success: true,
      data: {
        title: 'A resolved tab',
        url: 'https://a.example/resolved',
        excerpt: 'A only',
        capturedAt: 123,
      },
    })
    await context.promise
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(useAgent.getState().attachments.length, 1)
    assert.equal(useAgent.getState().attachments[0]?.title, 'A resolved tab')
    assert.equal(focusCount(), 1)
  })
})

test('late file stat cannot attach an operating-system drop to a different session', async () => {
  const stat = deferred<{ success: boolean; data: { isDirectory: boolean } }>()
  setComposerSession('a')

  await withMountedIntake({
    getFilePathFromDrop: () => '/tmp/a.txt',
    document: { stat: () => stat.promise },
  }, async (handle, focusCount) => {
    const drop = handle.handleDrop(makeDropEvent({
      files: [new window.File(['A'], 'a.txt', { type: 'text/plain' })],
    }))
    setComposerSession('b')
    stat.resolve({ success: true, data: { isDirectory: false } })
    await drop

    assert.deepEqual(useAgent.getState().attachments, [])
    assert.deepEqual(useAgent.getState().filePool, [])
    assert.equal(focusCount(), 0)
  })
})
