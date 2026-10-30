import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import type { ClipboardEvent, DragEvent as ReactDragEvent } from 'react'
import { usePastedImages } from '../renderer/components/agent/chat-panel/use-pasted-images'
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
  run: (handle: AttachmentIntakeHandle & ReturnType<typeof usePastedImages>, focusCount: () => number) => Promise<void>,
) {
  Object.defineProperty(testDom.window, 'electronAPI', { value: electronAPI, configurable: true })

  let handle: (AttachmentIntakeHandle & ReturnType<typeof usePastedImages>) | null = null
  let focuses = 0
  function Harness() {
    handle = { ...useAttachmentIntake({
      addAttachments: useAgent.getState().addAttachments,
      setInputValue: useAgent.getState().setInputValue,
      setIsDragOver: () => undefined,
      focusInputWithResize: () => { focuses += 1 },
    }), ...usePastedImages() }
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

test('browser-tab drag rejects a presentation-only payload without an exact tab identity', async () => {
  setComposerSession('a')

  await withMountedIntake({
    browser: { getTabContext: () => { throw new Error('renderer snapshot must not be called') } },
  }, async (handle, focusCount) => {
    await handle.handleDrop(makeDropEvent({
      readyPayload: {
        type: 'browser-tab',
        name: 'A tab',
        title: 'A tab',
        url: 'https://a.example',
      },
    }))

    assert.deepEqual(useAgent.getState().attachments, [])
    assert.deepEqual(useAgent.getState().filePool, [])
    assert.equal(focusCount(), 0)
  })
})

test('browser-tab drag stores only the exact tab identity and never trusts a renderer snapshot', async () => {
  let rendererSnapshotCalls = 0
  setComposerSession('a')

  await withMountedIntake({
    browser: { getTabContext: () => { rendererSnapshotCalls += 1 } },
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

    assert.equal(useAgent.getState().attachments.length, 1)
    assert.equal(useAgent.getState().attachments[0]?.title, 'A tab')
    assert.equal(useAgent.getState().attachments[0]?.browserTabId, 'tab-a')
    assert.equal(rendererSnapshotCalls, 0)
    assert.equal(focusCount(), 1)
  })
})

test('calendar and unsaved document drags remain structured resources instead of composer text', async () => {
  setComposerSession('a')
  await withMountedIntake({}, async (handle, focusCount) => {
    await handle.handleDrop(makeDropEvent({
      readyPayload: {
        type: 'calendar-event',
        name: '评审会',
        eventId: 'event-1',
      },
    }))
    await handle.handleDrop(makeDropEvent({
      readyPayload: {
        type: 'doc-tab',
        name: '未命名草稿',
        tabId: 'doc-draft',
        selection: '尚未落盘的准确正文',
        dirty: true,
      },
    }))

    const state = useAgent.getState()
    assert.equal(state.inputValue, '')
    assert.deepEqual(state.attachments.map((item) => item.source), ['calendar-event', 'document-tab'])
    assert.equal(state.attachments[0]?.eventId, 'event-1')
    assert.equal(state.attachments[1]?.selection, '尚未落盘的准确正文')
    assert.equal(focusCount(), 2)
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

function pasteEvent(files: File[]) {
  let prevented = false
  const event = {
    clipboardData: { files },
    preventDefault: () => { prevented = true },
  } as unknown as ClipboardEvent<HTMLTextAreaElement>
  return { event, prevented: () => prevented }
}

test('paste imports all images as removable file attachments and leaves ordinary text to the browser', async () => {
  setComposerSession('a')
  useAgent.getState().setInputValue('保留草稿')
  const received: Uint8Array[] = []
  await withMountedIntake({
    chat: { savePastedImage: async (bytes: Uint8Array) => {
      received.push(bytes)
      return { success: true, data: { name: '粘贴图片.png', path: `/tmp/paste-${received.length}.png`, size: bytes.length, ext: '.png', type: 'image' } }
    } },
  }, async (handle) => {
    const plain = pasteEvent([])
    await handle.onPaste(plain.event)
    assert.equal(plain.prevented(), false)
    const images = pasteEvent([new File(['one'], 'image.png', { type: 'image/png' }), new File(['two'], 'image.jpg', { type: 'image/jpeg' })])
    await handle.onPaste(images.event)
    assert.equal(images.prevented(), true)
    assert.deepEqual(received.map((bytes) => Buffer.from(bytes).toString()), ['one', 'two'])
    assert.equal(useAgent.getState().inputValue, '保留草稿')
    assert.deepEqual(useAgent.getState().attachments.map((a) => [a.type, a.source, a.path]), [
      ['image', 'file', '/tmp/paste-1.png'], ['image', 'file', '/tmp/paste-2.png'],
    ])
    for (const a of useAgent.getState().attachments) useAgent.getState().removeAttachment(a.id)
    assert.equal(useAgent.getState().attachments.length, 0)
  })
})

test('failed or late image imports never add a broken attachment or cross conversations', async () => {
  setComposerSession('a')
  const result = deferred<{ success: boolean; data?: { name: string; path: string; size: number; ext: string } }>()
  let called = false
  await withMountedIntake({ chat: { savePastedImage: () => { called = true; return result.promise } } }, async (handle) => {
    const pending = handle.onPaste(pasteEvent([new File(['png'], 'image.png', { type: 'image/png' })]).event)
    while (!called) await new Promise((resolve) => setTimeout(resolve, 0))
    setComposerSession('b')
    result.resolve({ success: true, data: { name: 'image.png', path: '/tmp/late.png', size: 3, ext: '.png' } })
    await pending
    assert.deepEqual(useAgent.getState().attachments, [])
  })
  await withMountedIntake({ chat: { savePastedImage: async () => ({ success: false, error: '无法读取图片' }) } }, async (handle) => {
    await handle.onPaste(pasteEvent([new File(['broken'], 'image.png', { type: 'image/png' })]).event)
    assert.deepEqual(useAgent.getState().attachments, [])
  })
})

test('calendar drag uses the same ReadyRef identity as right-click including all-day instances and placeholders', async () => {
  for (const [eventId, allDay, path] of [
    ['one', false, 'ready://calendar/event/one'],
    ['one', true, 'ready://calendar/event/one'],
    ['series#1793318400', false, 'ready://calendar/event/series#occurrence=1793318400000'],
    ['series#1793318400', true, 'ready://calendar/event/series#occurrence=2026-10-30'],
    [undefined, false, ''],
  ] as const) {
    setComposerSession('a')
    await withMountedIntake({}, async handle => {
      await handle.handleDrop(makeDropEvent({ readyPayload: { type: 'calendar-event', name: 'Meeting', eventId, allDay } }))
      assert.equal(useAgent.getState().attachments[0]?.path, path)
      assert.equal(useAgent.getState().attachments[0]?.eventId, eventId)
      if (!eventId) assert.match(useAgent.getState().attachments[0].name, /无法定位/)
    })
  }
})
