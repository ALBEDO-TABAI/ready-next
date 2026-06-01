import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { useAgent } from '../renderer/stores/useAgent'

interface AgentPersonality {
  id: string
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  metaJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

type PersonalityPayload = {
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  metaJson?: Record<string, unknown>
}

type PersonalityUpdate = {
  displayName?: string
  personalityText?: string
  tone?: string
  metaJson?: Record<string, unknown>
}

interface PersonalityAPIStub {
  get: (agentName: string) => Promise<{ success: boolean; data?: AgentPersonality | null; error?: string }>
  list: () => Promise<{ success: boolean; data?: AgentPersonality[]; error?: string }>
  create: (payload: PersonalityPayload) => Promise<{ success: boolean; data?: AgentPersonality; error?: string }>
  update: (agentName: string, updates: PersonalityUpdate) => Promise<{ success: boolean; error?: string }>
  delete: (agentName: string) => Promise<{ success: boolean; error?: string }>
}

interface DomHandle {
  dom: JSDOM
  restore: () => void
}

function samplePersonality(overrides: Partial<AgentPersonality> = {}): AgentPersonality {
  return {
    id: 'persona-butler',
    agentName: 'butler',
    displayName: '管家',
    personalityText: '# 管家',
    tone: 'friendly',
    metaJson: { emoji: '🤖' },
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function installDomGlobals(): DomHandle {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    SVGElement: (globalThis as { SVGElement?: typeof SVGElement }).SVGElement,
    HTMLButtonElement: (globalThis as { HTMLButtonElement?: typeof HTMLButtonElement }).HTMLButtonElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Element: (globalThis as { Element?: typeof Element }).Element,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    prompt: (globalThis as { prompt?: (message?: string, defaultValue?: string) => string | null }).prompt,
    confirm: (globalThis as { confirm?: (message?: string) => boolean }).confirm,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }

  function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('SVGElement', dom.window.SVGElement)
  setGlobal('HTMLButtonElement', dom.window.HTMLButtonElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('confirm', () => true)
  setGlobal('setTimeout', (callback: TimerHandler) => {
    queueMicrotask(() => {
      if (typeof callback === 'function') callback()
    })
    return 0
  })
  setGlobal('clearTimeout', () => undefined)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key]
        } else {
          Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
        }
      }
      try { dom.window.close() } catch { /* best-effort */ }
    },
  }
}

function installPersonalityAPI(dom: JSDOM, api: PersonalityAPIStub): void {
  ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = {
    agentPersonality: api,
  }
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mountEditor(dom: JSDOM): Promise<{ root: Root; document: Document }> {
  const [{ createRoot }, { default: PersonalityEditor }] = await Promise.all([
    import('react-dom/client'),
    import('../renderer/components/personality/PersonalityEditor'),
  ])
  const host = dom.window.document.getElementById('root')
  assert.ok(host, 'test root must exist')
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(PersonalityEditor))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flushAsync()
  return { root, document: dom.window.document }
}

function findButton(document: Document, text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button'))
    .find((item) => item.textContent?.includes(text)) as HTMLButtonElement | undefined
  assert.ok(button, `button ${text} must render`)
  return button
}

test('useAgent.reloadAgents loads personalities into the chat switcher', async () => {
  const handle = installDomGlobals()
  installPersonalityAPI(handle.dom, {
    get: async () => ({ success: true, data: null }),
    list: async () => ({
      success: true,
      data: [
        samplePersonality({ agentName: 'designer', displayName: '设计师', metaJson: { emoji: '🎨' } }),
        samplePersonality({ agentName: 'analyst', displayName: '分析师', metaJson: { emoji: '📊' } }),
      ],
    }),
    create: async () => ({ success: true, data: samplePersonality() }),
    update: async () => ({ success: true }),
    delete: async () => ({ success: true }),
  })

  try {
    useAgent.setState({
      agents: [{ name: 'butler', displayName: '管家', avatar: '🤖', status: 'idle', selected: true }],
      currentAgent: 'butler',
    })
    await useAgent.getState().reloadAgents()

    const state = useAgent.getState()
    assert.equal(state.currentAgent, 'designer')
    assert.deepEqual(
      state.agents.map((agent) => [agent.name, agent.displayName, agent.avatar, agent.selected]),
      [
        ['designer', '设计师', '🎨', true],
        ['analyst', '分析师', '📊', false],
      ],
    )
  } finally {
    handle.restore()
  }
})

test('PersonalityEditor creates a persisted personality and refreshes the switcher', async () => {
  const handle = installDomGlobals()
  const created: PersonalityPayload[] = []
  let personalities = [samplePersonality()]
  installPersonalityAPI(handle.dom, {
    get: async (agentName) => ({
      success: true,
      data: personalities.find((item) => item.agentName === agentName) || null,
    }),
    list: async () => ({ success: true, data: personalities }),
    create: async (payload) => {
      created.push(payload)
      const next = samplePersonality({
        id: `persona-${payload.agentName}`,
        agentName: payload.agentName,
        displayName: payload.displayName,
        personalityText: payload.personalityText,
        tone: payload.tone,
        metaJson: payload.metaJson,
      })
      personalities = [...personalities, next]
      return { success: true, data: next }
    },
    update: async () => ({ success: true }),
    delete: async () => ({ success: true }),
  })

  const { root, document } = await mountEditor(handle.dom)
  try {
    await act(async () => {
      findButton(document, '新建人格').dispatchEvent(
        new handle.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushAsync()
    assert.equal(created.length, 0)

    await act(async () => {
      findButton(document, '保存人格').dispatchEvent(
        new handle.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushAsync()

    assert.equal(created.length, 1)
    assert.equal(created[0].agentName, 'designer')
    assert.equal(created[0].displayName, 'designer')
    assert.equal(created[0].metaJson?.emoji, '🤖')
    assert.match(created[0].personalityText, /# designer/)
    assert.ok(useAgent.getState().agents.some((agent) => agent.name === 'designer'))
  } finally {
    await act(async () => { root.unmount() })
    handle.restore()
  }
})

test('PersonalityEditor shows backend failure instead of fake save success', async () => {
  const handle = installDomGlobals()
  installPersonalityAPI(handle.dom, {
    get: async () => ({ success: true, data: samplePersonality() }),
    list: async () => ({ success: true, data: [samplePersonality()] }),
    create: async () => ({ success: true, data: samplePersonality() }),
    update: async () => ({ success: false, error: 'duplicate agent' }),
    delete: async () => ({ success: true }),
  })

  const { root, document } = await mountEditor(handle.dom)
  try {
    await act(async () => {
      findButton(document, '保存人格').dispatchEvent(
        new handle.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushAsync()

    const text = document.body.textContent || ''
    assert.match(text, /保存失败/)
    assert.match(text, /duplicate agent/)
    assert.doesNotMatch(text, /人格配置已保存/)
  } finally {
    await act(async () => { root.unmount() })
    handle.restore()
  }
})
