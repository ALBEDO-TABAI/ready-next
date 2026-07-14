import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const keys = [
    'window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Element', 'Event',
    'CustomEvent', 'MouseEvent', 'PointerEvent', 'MutationObserver', 'requestAnimationFrame',
    'cancelAnimationFrame', 'navigator', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT',
  ] as const
  const previous = new Map<string, unknown>(keys.map((key) => [key, (globalThis as unknown as Record<string, unknown>)[key]]))
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLCanvasElement: dom.window.HTMLCanvasElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    PointerEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const contexts = new WeakMap<HTMLCanvasElement, Record<string, unknown>>()
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      let context = contexts.get(this)
      if (!context) {
        context = {
          canvas: this,
          setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {},
          lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
        }
        contexts.set(this, context)
      }
      return context
    },
  })
  Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLCanvasElement) {
      return { x: 0, y: 0, left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height, toJSON() {} }
    },
  })
  Object.defineProperties(dom.window.HTMLCanvasElement.prototype, {
    setPointerCapture: { configurable: true, value() {} },
    releasePointerCapture: { configurable: true, value() {} },
    hasPointerCapture: { configurable: true, value() { return false } },
  })
  return {
    dom,
    restore: () => {
      for (const key of keys) {
        const value = previous.get(key)
        if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      dom.window.close()
    },
  }
}

async function flush(delay = 0): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, delay)) })
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount())
}

test('document nodes reveal a content card, click through, and open the large graph workspace', async () => {
  const handle = installDom()
  try {
    const [{ default: GraphView }, { default: GraphCenterPanel }, { useWorkspace }, { useDocTabs }, modeModule] = await Promise.all([
      import('../renderer/components/graph/GraphView'),
      import('../renderer/components/layout/GraphCenterPanel'),
      import('../renderer/stores/useWorkspace'),
      import('../renderer/stores/useDocTabs'),
      import('../renderer/stores/useMode'),
    ])
    const { useMode } = modeModule
    const path = '/workspace/读书笔记.md'
    let previewReads = 0
    let openCallbacks = 0
    let requestedMode: string | null = null

    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        document: {
          getGraph: async () => ({
            success: true,
            data: {
              nodes: [{ id: 'doc:1', type: 'doc', label: '读书笔记.md', sourceType: 'document', path }],
              edges: [],
            },
          }),
          readFile: async () => {
            previewReads += 1
            return {
              success: true,
              data: { type: 'text', content: '# 《白痴》读书笔记\n\n第四部以一场被破坏的婚礼走向结局。' },
            }
          },
        },
      },
    })

    useWorkspace.setState({ workspaceRoot: '/workspace', selectedFile: null })
    useMode.setState({ workbenchMode: 'browser', splitMode: null })
    useDocTabs.setState({
      tabs: [{ id: 'doc-test', path: null, title: '新文档', content: '', isDirty: false }],
      activeTabId: 'doc-test',
      splitTabId: null,
      pendingReveal: null,
    })
    handle.dom.window.addEventListener('ready:workbench-mode-change-request', (event) => {
      requestedMode = (event as CustomEvent<{ mode: string }>).detail.mode
    })

    const container = handle.dom.window.document.getElementById('root')!
    const root = createRoot(container)
    await act(async () => {
      root.render(createElement(GraphView, {
        workspaceRoot: '/workspace',
        width: 640,
        height: 420,
        onDocumentOpen: () => { openCallbacks += 1 },
      }))
    })
    await flush()

    try {
      const canvas = container.querySelector<HTMLCanvasElement>('[data-knowledge-graph-canvas="true"]')
      assert.ok(canvas, 'document graph canvas should render')

      await act(async () => {
        canvas.dispatchEvent(new handle.dom.window.MouseEvent('pointermove', {
          bubbles: true,
          clientX: 320,
          clientY: 210,
        }))
      })
      await flush(180)

      const preview = container.querySelector('[data-graph-document-preview="true"]')
      assert.ok(preview, 'hovering a document node should show its preview card')
      assert.match(preview.textContent || '', /《白痴》读书笔记/)
      assert.match(preview.textContent || '', /被破坏的婚礼/)
      assert.equal(previewReads, 1)

      await act(async () => {
        canvas.dispatchEvent(new handle.dom.window.MouseEvent('click', {
          bubbles: true,
          clientX: 320,
          clientY: 210,
        }))
      })

      assert.equal(useWorkspace.getState().selectedFile, path)
      assert.equal(useDocTabs.getState().tabs.find((tab) => tab.path === path)?.path, path)
      assert.equal(requestedMode, 'document')
      assert.equal(openCallbacks, 1)
    } finally {
      await unmount(root)
    }

    let globalRequest: { centerPath?: string; depth?: number } | null = null
    const panelRoot = createRoot(container)
    await act(async () => {
      panelRoot.render(createElement(GraphCenterPanel, {
        onOpenGlobal: (request) => { globalRequest = request },
      }))
    })
    await flush()
    try {
      const globalButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '全局浏览')
      assert.ok(globalButton, 'graph panel should expose the global browse entry')
      await act(async () => globalButton.click())
      assert.deepEqual(globalRequest, { centerPath: undefined, depth: undefined })

      const focusButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === '聚焦当前')
      assert.ok(focusButton)
      await act(async () => focusButton.click())
      await act(async () => globalButton.click())
      assert.deepEqual(globalRequest, { centerPath: path, depth: 2 })

      await act(async () => {
        panelRoot.render(createElement(GraphCenterPanel, {
          onOpenGlobal: (request) => { globalRequest = request },
          globalBrowseOpen: true,
        }))
      })
      await flush()
      assert.equal(container.querySelector('[data-graph-view="true"]'), null)
      assert.match(container.textContent || '', /已在中央工作区打开/)
    } finally {
      await unmount(panelRoot)
    }
  } finally {
    handle.restore()
  }
})
