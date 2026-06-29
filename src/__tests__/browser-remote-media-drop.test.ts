import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

import {
  downloadRemoteMediaDropUrls,
  removeRemoteMediaDropFiles,
} from '../main/modules/browser-engine/remote-media-drop-cache'
import { buildLocalMediaDropBridgeScript } from '../main/modules/browser-engine/tab-lifecycle-service'
import {
  buildBrowserLocalMediaDropUrl,
  parseBrowserLocalMediaDropUrl,
} from '../shared/browser-local-media-drop'

test('browser local media drop payload preserves remote media urls', () => {
  const url = buildBrowserLocalMediaDropUrl({
    paths: ['/tmp/local.png'],
    urls: [
      'https://cdn.example.com/photo.jpg?size=large',
      'file:///tmp/not-remote.jpg',
      'not-a-url',
      'https://cdn.example.com/photo.jpg?size=large',
    ],
    x: 42,
    y: 84,
  })

  assert.deepEqual(parseBrowserLocalMediaDropUrl(url), {
    paths: ['/tmp/local.png'],
    urls: ['https://cdn.example.com/photo.jpg?size=large'],
    x: 42,
    y: 84,
  })
})

test('browser page drop bridge forwards remote image urls from dragged web content', () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const windowTarget = {
    location: {
      href: 'https://target.example/canvas',
    },
  }
  const context = vm.createContext({
    Array,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    URL,
    decodeURIComponent,
    document: {
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
        listeners.set(type, handler)
      },
    },
    encodeURIComponent,
    window: windowTarget,
  })

  vm.runInContext(buildLocalMediaDropBridgeScript(), context)
  const drop = listeners.get('drop')
  assert.equal(typeof drop, 'function')

  let prevented = false
  let stopped = false
  drop?.({
    clientX: 19,
    clientY: 31,
    dataTransfer: {
      types: ['text/uri-list', 'text/html'],
      getData: (format: string) => {
        if (format === 'text/uri-list') return '# dragged image\nhttps://i.example.com/pin.jpg?token=abc'
        if (format === 'text/html') return '<img src="https://i.example.com/from-html.webp">'
        return ''
      },
    },
    preventDefault: () => {
      prevented = true
    },
    stopPropagation: () => {
      stopped = true
    },
  })

  assert.equal(prevented, true)
  assert.equal(stopped, true)
  const parsed = parseBrowserLocalMediaDropUrl(windowTarget.location.href)
  assert.deepEqual(parsed, {
    paths: [],
    urls: [
      'https://i.example.com/pin.jpg?token=abc',
    ],
    x: 19,
    y: 31,
  })
})

test('browser page drop bridge ignores duplicate remote image drops briefly', () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const windowTarget = {
    location: {
      href: 'https://target.example/canvas',
    },
  }
  const context = vm.createContext({
    Array,
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    URL,
    decodeURIComponent,
    document: {
      addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
        listeners.set(type, handler)
      },
    },
    encodeURIComponent,
    window: windowTarget,
  })

  vm.runInContext(buildLocalMediaDropBridgeScript(), context)
  const drop = listeners.get('drop')
  assert.equal(typeof drop, 'function')

  const event = {
    clientX: 19,
    clientY: 31,
    dataTransfer: {
      types: ['text/uri-list'],
      getData: (format: string) => format === 'text/uri-list' ? 'https://i.example.com/pin.jpg' : '',
    },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  }

  drop?.(event)
  const firstHref = windowTarget.location.href
  windowTarget.location.href = 'https://target.example/not-rewritten'
  drop?.(event)

  assert.match(firstHref, /^ready-local-media-drop:/)
  assert.equal(windowTarget.location.href, 'https://target.example/not-rewritten')
})

test('remote media drop cache downloads supported media and rejects html pages', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/photo')) {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })
  }

  const result = await downloadRemoteMediaDropUrls([
    'https://cdn.example.com/photo',
    'https://cdn.example.com/page',
  ], { fetchImpl })

  try {
    assert.equal(result.files.length, 1)
    assert.match(result.files[0], /\.jpg$/)
    assert.deepEqual(await readFile(result.files[0]), Buffer.from([1, 2, 3]))
    assert.equal(result.failed.length, 1)
    assert.equal(result.failed[0].url, 'https://cdn.example.com/page')
  } finally {
    await removeRemoteMediaDropFiles(result.files)
  }
})
