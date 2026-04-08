import { BrowserAppShortcutBridgeService } from '../main/modules/browser-engine/app-shortcut-service'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import { BrowserAutomationService } from '../main/modules/browser-engine/automation-service'
import { BrowserPreviewService } from '../main/modules/browser-engine/preview-service'
import { BrowserTabLifecycleService } from '../main/modules/browser-engine/tab-lifecycle-service'
import { BrowserTabMetaService } from '../main/modules/browser-engine/tab-meta-service'
import { BrowserTabShellService } from '../main/modules/browser-engine/tab-shell-service'
import { BrowserWindowOpenService } from '../main/modules/browser-engine/window-open-service'

function createMockView(options?: {
  canGoBack?: boolean
  canGoForward?: boolean
  executeJavaScript?: (code: string) => unknown
}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const onceListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const addListener = (
    target: Map<string, Array<(...args: unknown[]) => void>>,
    event: string,
    listener: (...args: unknown[]) => void,
  ) => {
    const handlers = target.get(event) ?? []
    handlers.push(listener)
    target.set(event, handlers)
  }
  const emit = (event: string, ...args: unknown[]) => {
    const persistentHandlers = listeners.get(event) ?? []
    const oneShotHandlers = onceListeners.get(event) ?? []
    onceListeners.delete(event)
    ;[...persistentHandlers, ...oneShotHandlers].forEach((handler) => handler(...args))
  }

  const state = {
    attached: false,
    lastLoadedUrl: '',
    goBackCalls: 0,
    goForwardCalls: 0,
    reloadCalls: 0,
    insertedTexts: [] as string[],
    mouseCommands: [] as unknown[],
    keyCommands: [] as unknown[],
    emit,
  }

  const view = {
    webContents: {
      loadURL: async (url: string) => {
        state.lastLoadedUrl = url
      },
      reload: () => {
        state.reloadCalls += 1
      },
      once: (event: string, listener: (...args: unknown[]) => void) => {
        addListener(onceListeners, event, listener)
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        addListener(listeners, event, listener)
      },
      setWindowOpenHandler: () => undefined,
      setUserAgent: () => undefined,
      close: () => undefined,
      executeJavaScript: async (code: string) => options?.executeJavaScript?.(code),
      capturePage: async () => ({
        toPNG: () => Buffer.from('mock-image'),
      }),
      debugger: {
        isAttached: () => state.attached,
        attach: () => {
          state.attached = true
        },
        sendCommand: async (command: string, payload?: Record<string, unknown>) => {
          if (command === 'Page.getLayoutMetrics') {
            return {
              visualViewport: {
                clientWidth: 1000,
                clientHeight: 500,
                pageX: 0,
                pageY: 0,
                scale: 1,
              },
            }
          }
          if (command === 'Input.insertText') {
            state.insertedTexts.push(String(payload?.text || ''))
            return {}
          }
          if (command === 'Input.dispatchMouseEvent') {
            state.mouseCommands.push(payload)
            return {}
          }
          if (command === 'Input.dispatchKeyEvent') {
            state.keyCommands.push(payload)
            return {}
          }
          return {}
        },
      },
      navigationHistory: {
        canGoBack: () => Boolean(options?.canGoBack),
        canGoForward: () => Boolean(options?.canGoForward),
        goBack: () => {
          state.goBackCalls += 1
        },
        goForward: () => {
          state.goForwardCalls += 1
        },
      },
    },
  }

  return { view: view as any, state }
}

describe('BrowserTabShellService', () => {
  it('delegates to createTab when there is no active tab during navigate', async () => {
    const tabs = new Map()
    const calls: string[] = []
    const service = new BrowserTabShellService({
      tabs,
      getActiveTabId: () => null,
      setActiveTabId: () => undefined,
      getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setViewBounds: () => undefined,
      isAllowedUrl: () => true,
      createTab: async (url: string) => {
        calls.push(url)
        return { success: true, tabId: 'tab-1' }
      },
      detachHost: () => undefined,
      showHost: () => undefined,
      applyBounds: () => undefined,
      hideHost: () => undefined,
      detachPreviewView: () => undefined,
      restoreActiveTabHost: () => undefined,
    })

    const result = await service.navigate(null, 'https://example.com')

    assert.deepStrictEqual(result, { success: true, tabId: 'tab-1' })
    assert.deepStrictEqual(calls, ['https://example.com'])
  })

  it('switches tabs by detaching old host and showing the new host', () => {
    const first = createMockView({ canGoBack: false, canGoForward: false })
    const second = createMockView({ canGoBack: true, canGoForward: true })
    const tabs = new Map([
      ['tab-1', { id: 'tab-1', url: 'https://a.com', title: 'A', domain: 'a.com', favicon: null, owner: 'manual', required: false, activity: 'idle', lastAuditedAt: null, view: first.view }],
      ['tab-2', { id: 'tab-2', url: 'https://b.com', title: 'B', domain: 'b.com', favicon: null, owner: 'agent', required: true, activity: 'running', lastAuditedAt: 123, view: second.view }],
    ])
    let activeTabId = 'tab-1'
    const events: string[] = []
    const service = new BrowserTabShellService({
      tabs: tabs as any,
      getActiveTabId: () => activeTabId,
      setActiveTabId: (tabId) => {
        activeTabId = tabId
      },
      getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setViewBounds: () => undefined,
      shouldPresentHosts: () => true,
      isAllowedUrl: () => true,
      createTab: async () => ({ success: true, tabId: 'tab-3' }),
      detachHost: () => {
        events.push('detach')
      },
      showHost: () => {
        events.push('show')
      },
      applyBounds: () => {
        events.push('apply')
      },
      hideHost: () => undefined,
      detachPreviewView: () => undefined,
      restoreActiveTabHost: () => undefined,
    })

    const result = service.switchTab('tab-2')

    assert.strictEqual(activeTabId, 'tab-2')
    assert.deepStrictEqual(events, ['detach', 'show', 'apply'])
    assert.strictEqual(result.success, true)
    assert.strictEqual(result.owner, 'agent')
    assert.strictEqual(result.required, true)
    assert.strictEqual(result.canGoBack, true)
    assert.strictEqual(result.canGoForward, true)
  })

  it('detaches every non-target host before showing the next tab', () => {
    const first = createMockView()
    const second = createMockView()
    const third = createMockView()
    const tabs = new Map([
      ['tab-1', { id: 'tab-1', url: 'https://a.com', title: 'A', domain: 'a.com', favicon: null, owner: 'manual', required: false, activity: 'idle', lastAuditedAt: null, view: first.view }],
      ['tab-2', { id: 'tab-2', url: 'https://b.com', title: 'B', domain: 'b.com', favicon: null, owner: 'manual', required: false, activity: 'idle', lastAuditedAt: null, view: second.view }],
      ['tab-3', { id: 'tab-3', url: 'https://c.com', title: 'C', domain: 'c.com', favicon: null, owner: 'manual', required: false, activity: 'idle', lastAuditedAt: null, view: third.view }],
    ])
    let activeTabId = 'tab-1'
    const detached: string[] = []
    const shown: string[] = []
    const service = new BrowserTabShellService({
      tabs: tabs as any,
      getActiveTabId: () => activeTabId,
      setActiveTabId: (tabId) => {
        activeTabId = tabId
      },
      getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setViewBounds: () => undefined,
      shouldPresentHosts: () => true,
      isAllowedUrl: () => true,
      createTab: async () => ({ success: true, tabId: 'tab-4' }),
      detachHost: (view) => {
        if (view === first.view) detached.push('tab-1')
        if (view === second.view) detached.push('tab-2')
        if (view === third.view) detached.push('tab-3')
      },
      showHost: (view) => {
        if (view === second.view) shown.push('tab-2')
      },
      applyBounds: () => undefined,
      hideHost: () => undefined,
      detachPreviewView: () => undefined,
      restoreActiveTabHost: () => undefined,
    })

    const result = service.switchTab('tab-2')

    assert.strictEqual(result.success, true)
    assert.strictEqual(activeTabId, 'tab-2')
    assert.deepStrictEqual(detached, ['tab-1', 'tab-3'])
    assert.deepStrictEqual(shown, ['tab-2'])
  })

  it('hides every attached tab host when browser surfaces are globally dismissed', () => {
    const first = createMockView()
    const second = createMockView()
    const tabs = new Map([
      ['tab-1', { id: 'tab-1', url: 'https://a.com', title: 'A', domain: 'a.com', favicon: null, owner: 'manual', required: false, activity: 'idle', lastAuditedAt: null, view: first.view }],
      ['tab-2', { id: 'tab-2', url: 'https://b.com', title: 'B', domain: 'b.com', favicon: null, owner: 'manual', required: false, activity: 'idle', lastAuditedAt: null, view: second.view }],
    ])
    const hidden: string[] = []
    let previewDetached = 0

    const service = new BrowserTabShellService({
      tabs: tabs as any,
      getActiveTabId: () => 'tab-1',
      setActiveTabId: () => undefined,
      getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setViewBounds: () => undefined,
      shouldPresentHosts: () => true,
      isAllowedUrl: () => true,
      createTab: async () => ({ success: true, tabId: 'tab-3' }),
      detachHost: () => undefined,
      showHost: () => undefined,
      applyBounds: () => undefined,
      hideHost: (view) => {
        if (view === first.view) hidden.push('tab-1')
        if (view === second.view) hidden.push('tab-2')
      },
      detachPreviewView: () => {
        previewDetached += 1
      },
      restoreActiveTabHost: () => undefined,
    })

    const result = service.hideAllHosts()

    assert.deepStrictEqual(result, { success: true })
    assert.deepStrictEqual(hidden, ['tab-1', 'tab-2'])
    assert.strictEqual(previewDetached, 1)
  })
})

describe('BrowserAutomationService', () => {
  it('maps normalized coordinates into viewport CSS pixels and clamps out-of-range input', async () => {
    const mock = createMockView({
      executeJavaScript: (code) => {
        if (code.includes('window.visualViewport')) {
          return { width: 1000, height: 500, pageX: 0, pageY: 0, scale: 1 }
        }
        return null
      },
    })

    const service = new BrowserAutomationService({
      resolveTabView: () => ({
        tabId: 'tab-1',
        tab: { id: 'tab-1', url: 'https://example.com', title: 'Example', view: mock.view },
        view: mock.view,
      }),
      createBrowserError: (_code, message) => new Error(message),
      getViewBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    })

    const mapped = await service.normalizedToCss('tab-1', -50, 2000)

    assert.deepStrictEqual(mapped, { x: 0, y: 499, width: 1000, height: 500 })
  })

  it('truncates extracted page text to the documented limit', async () => {
    const longText = 'x'.repeat(35_000)
    const mock = createMockView({
      executeJavaScript: (code) => {
        if (code === 'document.body.innerText') return longText
        return null
      },
    })

    const service = new BrowserAutomationService({
      resolveTabView: () => ({
        tabId: 'tab-1',
        tab: { id: 'tab-1', url: 'https://example.com', title: 'Example', view: mock.view },
        view: mock.view,
      }),
      createBrowserError: (_code, message) => new Error(message),
      getViewBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    })

    const text = await service.getPageContent('tab-1')

    assert.strictEqual(text.length, 30_000)
  })
})

describe('BrowserTabLifecycleService', () => {
  it('shows a newly created active tab immediately with current bounds instead of waiting for page load completion', async () => {
    const previous = createMockView()
    const next = createMockView()
    const tabs = new Map([
      ['tab-0', {
        id: 'tab-0',
        url: 'https://before.example',
        title: 'Before',
        domain: 'before.example',
        favicon: null,
        owner: 'manual',
        required: false,
        activity: 'idle',
        lastAuditedAt: null,
        view: previous.view,
      }],
    ])
    const events: string[] = []
    let activeTabId: string | null = 'tab-0'
    const service = new BrowserTabLifecycleService({
      tabs: tabs as any,
      getActiveTabId: () => activeTabId,
      setActiveTabId: (tabId) => {
        activeTabId = tabId
      },
      getNextTabId: () => 'tab-1',
      getViewBounds: () => ({ x: 12, y: 24, width: 960, height: 640 }),
      shouldPresentHosts: () => true,
      isAllowedUrl: () => true,
      extractDomain: (url) => new URL(url).hostname,
      createHost: () => next.view as any,
      applyBounds: () => {
        events.push('apply')
      },
      detachHost: (view) => {
        if (view === previous.view) events.push('detach-previous')
      },
      showHost: (_view, bounds) => {
        events.push(`show:${bounds.width}x${bounds.height}`)
      },
      sendToRenderer: () => undefined,
      emitTabMeta: () => undefined,
      logBrowserDiag: () => undefined,
      bindPopup: () => undefined,
      bindAppShortcutBridge: () => undefined,
      installContextMenu: () => undefined,
      handleWindowOpen: () => ({ action: 'deny' }),
      ensureDownloadSession: () => undefined,
      addHistoryEntry: () => undefined,
      browserUserAgent: 'test-agent',
      useMock: false,
    })

    const result = await service.createTab('https://example.com')

    assert.deepStrictEqual(result, { success: true, tabId: 'tab-1' })
    assert.strictEqual(activeTabId, 'tab-1')
    assert.strictEqual(next.state.lastLoadedUrl, 'https://example.com')
    assert.deepStrictEqual(events, ['apply', 'detach-previous', 'show:960x640'])
  })

  it('ignores subresource did-fail-load events when updating tab error state', async () => {
    const next = createMockView()
    const rendererEvents: Array<{ channel: string; data: unknown }> = []
    const diagMessages: string[] = []
    let activeTabId: string | null = null
    const service = new BrowserTabLifecycleService({
      tabs: new Map() as any,
      getActiveTabId: () => activeTabId,
      setActiveTabId: (tabId) => {
        activeTabId = tabId
      },
      getNextTabId: () => 'tab-1',
      getViewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      shouldPresentHosts: () => true,
      isAllowedUrl: () => true,
      extractDomain: (url) => new URL(url).hostname,
      createHost: () => next.view as any,
      applyBounds: () => undefined,
      detachHost: () => undefined,
      showHost: () => undefined,
      sendToRenderer: (channel, data) => {
        rendererEvents.push({ channel, data })
      },
      emitTabMeta: () => undefined,
      logBrowserDiag: (message) => {
        diagMessages.push(message)
      },
      bindPopup: () => undefined,
      bindAppShortcutBridge: () => undefined,
      installContextMenu: () => undefined,
      handleWindowOpen: () => ({ action: 'deny' }),
      ensureDownloadSession: () => undefined,
      addHistoryEntry: () => undefined,
      browserUserAgent: 'test-agent',
      useMock: false,
    })

    await service.createTab('https://example.com')
    next.state.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://cdn.example/script.js', false)

    assert.deepStrictEqual(rendererEvents.filter((event) => event.channel === 'browser:tabUpdate' && (event.data as { type?: string }).type === 'error'), [])
    assert.deepStrictEqual(diagMessages, [])
  })
})

describe('BrowserPreviewService', () => {
  it('registers the preview session for downloads before opening preview pages', async () => {
    const mock = createMockView()
    const downloadSessions: unknown[] = []
    const service = new BrowserPreviewService({
      useMock: false,
      browserUserAgent: 'ready-test',
      createHost: () => mock.view as any,
      showHost: () => undefined,
      hideHost: () => undefined,
      detachHost: () => undefined,
      applyPreviewBounds: () => undefined,
      getPreviewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setPreviewBounds: () => undefined,
      sendToRenderer: () => undefined,
      logBrowserDiag: () => undefined,
      bindPopup: () => undefined,
      installContextMenu: () => undefined,
      handleWindowOpen: () => ({ action: 'deny' }),
      hideActiveTab: () => false,
      restoreActiveTab: () => undefined,
      ensureDownloadSession: (targetSession: unknown) => {
        downloadSessions.push(targetSession)
      },
    } as any)

    await service.open('https://example.com')

    assert.deepStrictEqual(downloadSessions, [mock.view.webContents.session])
  })

  it('does not restore the active tab when preview did not hide a visible browser host', async () => {
    const mock = createMockView()
    const events: string[] = []
    const service = new BrowserPreviewService({
      useMock: false,
      browserUserAgent: 'ready-test',
      createHost: () => mock.view as any,
      showHost: () => {
        events.push('show')
      },
      hideHost: () => undefined,
      detachHost: () => {
        events.push('detach')
      },
      applyPreviewBounds: () => undefined,
      getPreviewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setPreviewBounds: () => undefined,
      sendToRenderer: () => undefined,
      logBrowserDiag: () => undefined,
      bindPopup: () => undefined,
      installContextMenu: () => undefined,
      handleWindowOpen: () => ({ action: 'deny' }),
      hideActiveTab: () => false,
      restoreActiveTab: () => {
        events.push('restore')
      },
    })

    await service.open('https://example.com')
    service.close()

    assert.deepStrictEqual(events, ['show', 'detach'])
  })

  it('restores the active tab after closing preview only when preview hid it', async () => {
    const mock = createMockView()
    const events: string[] = []
    const service = new BrowserPreviewService({
      useMock: false,
      browserUserAgent: 'ready-test',
      createHost: () => mock.view as any,
      showHost: () => undefined,
      hideHost: () => undefined,
      detachHost: () => undefined,
      applyPreviewBounds: () => undefined,
      getPreviewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setPreviewBounds: () => undefined,
      sendToRenderer: () => undefined,
      logBrowserDiag: () => undefined,
      bindPopup: () => undefined,
      installContextMenu: () => undefined,
      handleWindowOpen: () => ({ action: 'deny' }),
      hideActiveTab: () => true,
      restoreActiveTab: () => {
        events.push('restore')
      },
    })

    await service.open('https://example.com')
    service.close()

    assert.deepStrictEqual(events, ['restore'])
  })

  it('ignores subresource did-fail-load events when updating preview error state', async () => {
    const mock = createMockView()
    const updates: unknown[] = []
    const diagMessages: string[] = []
    const service = new BrowserPreviewService({
      useMock: false,
      browserUserAgent: 'ready-test',
      createHost: () => mock.view as any,
      showHost: () => undefined,
      hideHost: () => undefined,
      detachHost: () => undefined,
      applyPreviewBounds: () => undefined,
      getPreviewBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      setPreviewBounds: () => undefined,
      sendToRenderer: (_channel, data) => {
        updates.push(data)
      },
      logBrowserDiag: (message) => {
        diagMessages.push(message)
      },
      bindPopup: () => undefined,
      installContextMenu: () => undefined,
      handleWindowOpen: () => ({ action: 'deny' }),
      hideActiveTab: () => false,
      restoreActiveTab: () => undefined,
    })

    await service.open('https://example.com')
    const updateCountBeforeFailure = updates.length
    mock.state.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://cdn.example/script.js', false)

    assert.strictEqual(updates.length, updateCountBeforeFailure)
    assert.deepStrictEqual(diagMessages, [])
  })
})

describe('BrowserTabMetaService', () => {
  it('builds active tab payloads and emits meta updates through the renderer bridge', () => {
    const tabs = new Map([
      [
        'tab-1',
        {
          id: 'tab-1',
          url: 'https://example.com',
          title: 'Example',
          domain: 'example.com',
          favicon: 'https://example.com/favicon.ico',
          owner: 'agent',
          required: true,
          activity: 'running',
          lastAuditedAt: 123,
          loading: true,
          canGoBack: true,
          canGoForward: false,
          error: 'temporary failure',
        },
      ],
    ])
    const emitted: Array<{ channel: string; data: unknown }> = []
    const service = new BrowserTabMetaService({
      tabs,
      getActiveTabId: () => 'tab-1',
      sendToRenderer: (channel, data) => {
        emitted.push({ channel, data })
      },
    })

    const list = service.getTabList()
    service.emitTabMeta('tab-1')

    assert.deepStrictEqual(list, [
      {
        id: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        domain: 'example.com',
        favicon: 'https://example.com/favicon.ico',
        owner: 'agent',
        required: true,
        activity: 'running',
        lastAuditedAt: 123,
        active: true,
        loading: true,
        canGoBack: true,
        canGoForward: false,
        error: 'temporary failure',
      },
    ])
    assert.deepStrictEqual(emitted, [
      {
        channel: 'browser:tabUpdate',
        data: {
          type: 'meta',
          tabId: 'tab-1',
          id: 'tab-1',
          url: 'https://example.com',
          title: 'Example',
          domain: 'example.com',
          favicon: 'https://example.com/favicon.ico',
          owner: 'agent',
          required: true,
          activity: 'running',
          lastAuditedAt: 123,
          active: true,
          loading: true,
          canGoBack: true,
          canGoForward: false,
          error: 'temporary failure',
        },
      },
    ])
  })
})

describe('BrowserAppShortcutBridgeService', () => {
  it('detects supported shortcuts and forwards them to the renderer bridge', () => {
    const emitted: Array<{ channel: string; data: unknown }> = []
    const service = new BrowserAppShortcutBridgeService({
      sendToRenderer: (channel, data) => {
        emitted.push({ channel, data })
      },
    })

    const input = {
      type: 'keyDown',
      key: '1',
      meta: true,
      control: false,
      shift: false,
      alt: false,
    } as Electron.Input

    assert.strictEqual(service.isAppShortcutInput(input), true)
    service.dispatchAppShortcut(input)

    assert.deepStrictEqual(emitted, [
      {
        channel: 'app:shortcut',
        data: {
          key: '1',
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
      },
    ])
  })
})

describe('BrowserWindowOpenService', () => {
  it('routes regular popups through the renderer new-tab bridge when policy resolves to open-tab', () => {
    const events: string[] = []
    const notifications: unknown[] = []
    const service = new BrowserWindowOpenService({
      popupManager: {
        resolveWindowOpen: () => ({
          mode: 'open-tab',
          reason: 'default',
        }),
        notifyWindowOpenRequested: (payload: unknown) => {
          notifications.push(payload)
        },
      } as any,
      requestNewTab: (url: string) => {
        events.push(`request:${url}`)
      },
      logBrowserDiag: (message: string) => {
        events.push(`log:${message}`)
      },
      openExternal: (url: string) => {
        events.push(`external:${url}`)
      },
    })

    const result = service.handle(
      { url: 'https://example.com/popup' },
      'tab',
      42,
    )

    assert.deepStrictEqual(result, { action: 'deny' })
    assert.strictEqual(events[0].includes('source=tab mode=open-tab'), true)
    assert.deepStrictEqual(events[1], 'request:https://example.com/popup')
    assert.deepStrictEqual(notifications, [
      {
        sourceContentsId: 42,
        url: 'https://example.com/popup',
        mode: 'open-tab',
        reason: 'default',
      },
    ])
  })
})
