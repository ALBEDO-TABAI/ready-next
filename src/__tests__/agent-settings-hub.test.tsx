import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost', pretendToBeVisual: true,
  })
  const prior = new Map<string, unknown>()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    prior.set(key, (globalThis as Record<string, unknown>)[key])
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore: () => {
      for (const [key, value] of prior) {
        if (value === undefined) delete (globalThis as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      dom.window.close()
    },
  }
}

test('Agent Settings exposes archive CRUD and audit without fake Codex controls', async () => {
  const handle = installDom()
  try {
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agentPersonality: {
        list: async () => ({ success: true, data: [] }),
        get: async () => ({ success: true, data: null }),
        create: async () => ({ success: true }),
        update: async () => ({ success: true }),
        delete: async () => ({ success: true }),
      },
      agent: {
        getSystemStudioSnapshot: async () => ({
          success: true,
          data: { generatedAt: '2026-08-12T00:00:00.000Z', agents: [] },
        }),
        confirmSystemStudioContentEdit: async () => ({ success: true }),
        rejectSystemStudioContentEdit: async () => ({ success: true }),
      },
    }
    const { default: AgentSettingsHub } = await import('../renderer/components/agent-system/AgentSettingsHub')
    const host = handle.dom.window.document.getElementById('root')
    assert.ok(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<AgentSettingsHub />)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const text = host.textContent || ''
    assert.match(text, /历史人格资料/)
    assert.match(text, /不会改变当前 Codex/)
    assert.match(text, /专项资料审计/)
    assert.doesNotMatch(text, /新会话智能路由|知识系统总开关|路由试算|确认创建|可转办|派生与系统/)
    assert.equal(host.querySelectorAll('select').length, 0)
    await act(async () => root.unmount())
  } finally {
    handle.restore()
  }
})
