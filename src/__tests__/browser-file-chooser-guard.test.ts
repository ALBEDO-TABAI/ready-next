import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserCdpSessionService } from '../main/modules/browser-engine/cdp-session-service'
import { BrowserFileChooserGuard } from '../main/modules/browser-engine/file-chooser-guard'
import { consumePendingBrowserSitePermissionNotices } from '../main/modules/browser-engine/browser-permission-policy'
import type { BrowserHostView } from '../main/modules/browser-engine/host-types'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-file-chooser-guard declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-file-chooser-guard transitive sqlite load')
})

// D16（真机第十一轮实锚，XHS 发布页「+」上传）：agent 点击拉起原生文件
// 选择器会挂起整个工具环。合同（真 BrowserCdpSessionService + 假 debugger
// 宿主执行）：
//   1. arm → Page.enable + Page.setInterceptFileChooserDialog(enabled:true)，幂等；
//   2. Page.fileChooserOpened 事件 → file_chooser_intercepted 注记入队（带改道指引）；
//   3. disarmAll → enabled:false + 事件退订，armedTabIds 清空。

type DebuggerListener = (event: unknown, method: string, params?: Record<string, unknown>) => void

function makeFakeHost() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  const listeners = new Set<DebuggerListener>()
  let attached = false
  const view = {
    webContents: {
      getURL: () => 'https://creator.xiaohongshu.com/publish/publish',
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true
        },
        sendCommand: async (method: string, params?: Record<string, unknown>) => {
          commands.push({ method, params })
          return {}
        },
        on: (_event: string, listener: DebuggerListener) => {
          listeners.add(listener)
        },
        removeListener: (_event: string, listener: DebuggerListener) => {
          listeners.delete(listener)
        },
      },
    },
  } as unknown as BrowserHostView
  return {
    commands,
    listeners,
    emit: (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener(null, method, params)
    },
    host: {
      resolveTabView: (tabId: string | null) => ({
        tabId: tabId || 'tab-active',
        tab: { id: tabId || 'tab-active' },
        view,
      }),
      createBrowserError: (_code: string, message: string) => new Error(message),
    },
  }
}

test('arm enables interception idempotently and fileChooserOpened queues a reroute notice', async () => {
  consumePendingBrowserSitePermissionNotices()
  const fake = makeFakeHost()
  const cdp = new BrowserCdpSessionService(fake.host)
  const logLines: string[] = []
  const guard = new BrowserFileChooserGuard({
    cdp,
    resolveTabUrl: () => 'https://creator.xiaohongshu.com/publish/publish',
    log: (m) => logLines.push(m),
  })

  await guard.arm('tab-7')
  await guard.arm('tab-7')
  assert.deepStrictEqual(guard.armedTabIds, ['tab-7'])
  const interceptCalls = fake.commands.filter((c) => c.method === 'Page.setInterceptFileChooserDialog')
  assert.strictEqual(interceptCalls.length, 1, 'idempotent arm must enable interception exactly once')
  assert.deepStrictEqual(interceptCalls[0]?.params, { enabled: true })
  assert.ok(fake.commands.some((c) => c.method === 'Page.enable'), 'Page domain must be retained')

  fake.emit('Page.fileChooserOpened', { frameId: 'f1', mode: 'selectSingle' })
  const notices = consumePendingBrowserSitePermissionNotices()
  assert.strictEqual(notices.length, 1)
  assert.strictEqual(notices[0]?.kind, 'file_chooser_intercepted')
  assert.strictEqual(notices[0]?.origin, 'https://creator.xiaohongshu.com/publish/publish')
  assert.ok(notices[0]?.guidance.includes('browser_upload_scope_attachment'))
})

test('disarmAll disables interception, unsubscribes, and clears armed tabs', async () => {
  consumePendingBrowserSitePermissionNotices()
  const fake = makeFakeHost()
  const cdp = new BrowserCdpSessionService(fake.host)
  const guard = new BrowserFileChooserGuard({ cdp })

  await guard.arm('tab-7')
  await guard.disarmAll()

  assert.deepStrictEqual(guard.armedTabIds, [])
  const disableCall = fake.commands.find(
    (c) => c.method === 'Page.setInterceptFileChooserDialog' && c.params?.enabled === false,
  )
  assert.ok(disableCall, 'disarm must disable interception')
  assert.ok(fake.commands.some((c) => c.method === 'Page.disable'), 'Page domain retain must be released')

  fake.emit('Page.fileChooserOpened', { frameId: 'f1', mode: 'selectSingle' })
  assert.deepStrictEqual(consumePendingBrowserSitePermissionNotices(), [], 'events after disarm must not queue notices')

  // re-arm after disarm works（下一次写租约周期）
  await guard.arm('tab-7')
  assert.deepStrictEqual(guard.armedTabIds, ['tab-7'])
})

test('arm failure degrades silently (DevTools attach conflict)', async () => {
  const fake = makeFakeHost()
  const host = {
    ...fake.host,
    resolveTabView: () => {
      throw new Error('no such tab')
    },
  }
  const cdp = new BrowserCdpSessionService(host)
  const logLines: string[] = []
  const guard = new BrowserFileChooserGuard({ cdp, log: (m) => logLines.push(m) })
  await guard.arm('tab-x')
  assert.deepStrictEqual(guard.armedTabIds, [])
  assert.ok(logLines.some((l) => l.includes('attach failed')))
})
