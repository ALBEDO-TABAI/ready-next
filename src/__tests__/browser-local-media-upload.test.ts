import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterBrowserLocalMediaUploadPaths,
  getBrowserLocalMediaUploadExt,
  isBrowserLocalMediaUploadFile,
} from '../shared/browser-local-media-upload'
import {
  startBrowserLocalMediaNativeFileDrag,
} from '../renderer/modules/browser/localMediaDragBridge'
import { useMode } from '../renderer/stores/useMode'

test('browser local media upload accepts image and video files only', () => {
  assert.equal(isBrowserLocalMediaUploadFile({ path: '/tmp/a.png' }), true)
  assert.equal(isBrowserLocalMediaUploadFile({ path: '/tmp/b.MOV' }), true)
  assert.equal(isBrowserLocalMediaUploadFile({ path: '/tmp/c.pdf' }), false)
  assert.equal(isBrowserLocalMediaUploadFile({ path: '/tmp/folder' }), false)
})

test('browser local media upload normalizes explicit and inferred extensions', () => {
  assert.equal(getBrowserLocalMediaUploadExt({ path: '/tmp/no-extension', ext: '.webp' }), 'webp')
  assert.equal(getBrowserLocalMediaUploadExt({ path: '/tmp/video.final.mp4' }), 'mp4')
})

test('browser local media upload filters duplicates while preserving order', () => {
  assert.deepEqual(filterBrowserLocalMediaUploadPaths([
    { path: '/tmp/a.png' },
    { path: '/tmp/a.png' },
    { path: '/tmp/readme.md' },
    { path: '/tmp/b.webm' },
  ]), ['/tmp/a.png', '/tmp/b.webm'])
})

test('browser local media drag bridge starts native file drag when browser is visible', () => {
  const previousWindow = (globalThis as { window?: unknown }).window
  const eventTarget = new EventTarget() as EventTarget & {
    electronAPI?: { startNativeFileDrag?: (paths: string[]) => void }
  }
  const startedPaths: string[][] = []
  eventTarget.electronAPI = {
    startNativeFileDrag: (paths: string[]) => {
      startedPaths.push(paths)
    },
  }
  ;(globalThis as { window?: unknown }).window = eventTarget
  const previousMode = useMode.getState()
  const previousWorkbenchMode = previousMode.workbenchMode
  const previousSplitMode = previousMode.splitMode
  previousMode.setWorkbenchMode('browser')
  previousMode.setSplitMode(null)
  const payload = JSON.stringify({
    type: 'file',
    path: '/tmp/upload.jpg',
    name: 'upload.jpg',
    ext: 'jpg',
    isDirectory: false,
  })
  let prevented = false

  try {
    const didStart = startBrowserLocalMediaNativeFileDrag({
      dataTransfer: {
        getData: (format: string) => format === 'application/x-ready-drag' ? payload : '',
        files: [],
      } as unknown as DataTransfer,
      preventDefault: () => {
        prevented = true
      },
    })

    assert.equal(didStart, true)
    assert.equal(prevented, true)
    assert.deepEqual(startedPaths, [['/tmp/upload.jpg']])
  } finally {
    useMode.getState().setWorkbenchMode(previousWorkbenchMode)
    useMode.getState().setSplitMode(previousSplitMode)
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
})
