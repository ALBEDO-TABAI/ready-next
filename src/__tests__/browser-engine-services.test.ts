import { BrowserAppShortcutBridgeService } from '../main/modules/browser-engine/app-shortcut-service'
import assert from 'node:assert'
import { describe, it } from 'node:test'

import { BrowserAutomationService } from '../main/modules/browser-engine/automation-service'
import { BrowserPreviewService } from '../main/modules/browser-engine/preview-service'
import { BrowserTabMetaService } from '../main/modules/browser-engine/tab-meta-service'
import { BrowserTabShellService } from '../main/modules/browser-engine/tab-shell-service'
import { BrowserWindowOpenService } from '../main/modules/browser-engine/window-open-service'

function createMockView(options?: {
  canGoBack?: boolean
  canGoForward?: boolean
  executeJavaScript?: (code: string) => unknown
}) {
  const state = {
    attached: false,
    lastLoadedUrl: '',
    goBackCalls: 0,
    goForwardCalls: 0,
    reloadCalls: 0,
    insertedTexts: [] as string[],
    mouseCommands: [] as unknown[],
    keyCommands: [] as unknown[],
  }

  const view = {
    webContents: {
      loadURL: async (url: string) => {
        state.lastLoadedUrl = url
      },
      reload: () => {
        state.reloadCalls += 1
      },
      on: () => undefined,
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

describe('BrowserPreviewService', () => {
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
  it('opens regular popups in a new tab when policy resolves to open-tab', () => {
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
      createTab: async (url: string) => {
        events.push(`tab:${url}`)
        return { success: true, tabId: 'tab-9' }
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
