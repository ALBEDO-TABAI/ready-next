import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import type { ChatGptOAuthStatus } from '../shared/chatgpt-oauth'

function domHarness(api: unknown) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  Object.assign(dom.window, { electronAPI: api })
  let tick: () => Promise<void> = async () => {}
  dom.window.setInterval = ((callback: () => Promise<void>) => { tick = callback; return 1 }) as never
  dom.window.clearInterval = () => {}
  let root: Root
  const container = dom.window.document.getElementById('root')!
  return {
    container,
    mount: async (element: ReactElement) => { root = createRoot(container); await act(async () => { root.render(element) }) },
    unmount: async () => { await act(async () => root.unmount()) },
    tick: async () => { await act(async () => tick()) },
    button: (text: string) => [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text))!,
    close: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as Record<string, unknown>)[key]
      }
      dom.window.close()
    },
  }
}

test('OAuth remount shows Main progress, can reopen and cancel the same operation, and observes success', async () => {
  const calls: string[] = []
  let status: ChatGptOAuthStatus = { state: 'connecting', connected: false, running: false, models: [], baseUrl: 'http://127.0.0.1',
    operation: { id: 'login-1', phase: 'waiting_browser', canReopen: true, startedAt: Date.now() } }
  const h = domHarness({ settings: {
    getChatGptOAuthStatus: async () => ({ success: true, data: status }),
    reopenChatGptOAuth: async (id: string) => { calls.push(`reopen:${id}`); return { success: true } },
    cancelChatGptOAuth: async (id: string) => {
      calls.push(`cancel:${id}`); status = { ...status, state: 'signed_out', operation: undefined }; return { success: true, data: status }
    },
  } })
  try {
    const { ChatGptOAuthSettingsCard } = await import('../renderer/pages/settings/ChatGptOAuthSettingsCard')
    const element = createElement(ChatGptOAuthSettingsCard, { active: false, reasoningEffort: 'high', onReasoningEffortChange() {},
      onConnected() { calls.push('connected') }, onDisconnected() {} })
    await h.mount(element)
    assert.match(h.container.textContent!, /请在浏览器完成授权/)
    assert.equal(h.button('使用 ChatGPT 登录'), undefined)
    await h.unmount(); await h.mount(element)
    await act(async () => h.button('重新打开授权页面').click())
    await act(async () => h.button('取消登录').click())
    assert.deepEqual(calls, ['reopen:login-1', 'cancel:login-1'])
    assert.ok(h.button('使用 ChatGPT 登录'))
    status = { ...status, state: 'connecting', operation: { id: 'login-2', phase: 'saving_profile', canReopen: false, startedAt: Date.now() } }
    await h.tick()
    assert.match(h.container.textContent!, /正在保存连接设置/)
    status = { ...status, state: 'ready', operation: undefined, connected: true, running: true, models: ['fixture'] }
    await h.tick()
    assert.match(h.container.textContent!, /已连接.*可以开始对话/)
    assert.equal(calls.at(-1), 'connected')
    await h.unmount()
  } finally { h.close() }
})

test('WeChat page reentry restores its QR and cancellation removes it without starting another login', async () => {
  let status: Record<string, unknown> = { status: 'waiting', sessionKey: 'qr-1', qrcodeUrl: 'data:image/png;base64,fixture', message: '请扫码确认' }
  let stops = 0
  const h = domHarness({ agent: {
    getWechatLoginStatus: async () => ({ success: true, data: status }),
    setChannelEnabled: async () => { stops++; status = { status: 'idle' }; return { success: true } },
  } })
  try {
    const { WechatLoginControl } = await import('../renderer/components/settings/WechatLoginControl')
    const element = createElement(WechatLoginControl, { channelId: 'w', enabled: false, disabled: false, beforeStart: async () => {}, onChanged: async () => {} })
    await h.mount(element)
    assert.ok(h.container.querySelector('img[alt="微信绑定二维码"]'))
    assert.equal(h.button('绑定进行中').disabled, true)
    await h.unmount(); await h.mount(element)
    assert.ok(h.container.querySelector('img[alt="微信绑定二维码"]'))
    await act(async () => h.button('取消绑定').click())
    assert.equal(stops, 1)
    assert.equal(h.container.querySelector('img'), null)
    assert.equal(h.button('生成绑定二维码').disabled, false)
    status = { status: 'error', message: '二维码已过期，请重新生成。' }
    await h.tick()
    assert.match(h.container.textContent!, /二维码已过期/)
    assert.equal(h.button('生成绑定二维码').disabled, false)
    await h.unmount()
  } finally { h.close() }
})
