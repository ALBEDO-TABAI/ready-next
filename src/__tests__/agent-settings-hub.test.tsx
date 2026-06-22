import assert from 'node:assert/strict'
import test from 'node:test'
import { type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

// 行为测试：AgentSettingsHub（设置页「Agent」单入口容器）。
// 验证 §7.2 子导航 + §4.3「行为」子区自包含 IPC 读写 + §7.1 统一刷新订阅。
// 叶子面板（PersonalityEditor / AgentRegistryPanel 等）的内部行为由各自测试覆盖，
// 这里只断言容器自身逻辑：默认进「管理」、子导航切换、行为开关读写对应 IPC、刷新事件重挂管理区。

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    SVGElement: (globalThis as { SVGElement?: typeof SVGElement }).SVGElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Element: (globalThis as { Element?: typeof Element }).Element,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }
  const setGlobal = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('SVGElement', dom.window.SVGElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return {
    dom,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete (globalThis as unknown as Record<string, unknown>)[key]
        else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
      try { dom.window.close() } catch { /* best-effort */ }
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const host = globalThis.document.getElementById('root')
  assert.ok(host)
  host.innerHTML = ''
  const container = globalThis.document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  await flush()
  return { root, container }
}

async function clickButtonContaining(container: HTMLElement, label: string): Promise<HTMLButtonElement> {
  const button = Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.includes(label)) as HTMLButtonElement | undefined
  assert.ok(button, `expected button containing ${label}`)
  await act(async () => { button.click() })
  await flush()
  return button
}

interface ApiCalls {
  set: Array<{ method: string; value: unknown }>
  listRegistry: number
}

function installElectronApi(handle: { dom: JSDOM }, calls: ApiCalls, opts: {
  autoNarration: boolean
  prerouteMode: 'off' | 'suggest' | 'auto'
  knowledgeEnabled: boolean
}): void {
  const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
  const snapshot = () => ({ knowledgeSystemEnabled: opts.knowledgeEnabled, cards: [], summary: {}, maintenance: { lifecycleRunning: false, lastLifecycleMaintenanceAt: null, llmRound: null } })
  ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
    settings: {
      get: async () => ({ success: true, data: 'true' }),
      getAgentAutoNarrationContinuation: async () => ok(opts.autoNarration),
      setAgentAutoNarrationContinuation: async (value: boolean) => { calls.set.push({ method: 'narration', value }); return ok(value) },
      getAgentSessionPrerouteMode: async () => ok(opts.prerouteMode),
      setAgentSessionPrerouteMode: async (value: string) => { calls.set.push({ method: 'preroute', value }); return ok(value) },
    },
    memoryCards: {
      list: async () => ok(snapshot()),
      setKnowledgeSystemEnabled: async (enabled: boolean) => { calls.set.push({ method: 'knowledge', value: enabled }); return ok({ ...snapshot(), knowledgeSystemEnabled: enabled }) },
    },
    agentPersonality: {
      list: async () => ok([]),
      get: async () => ok(null),
    },
    agent: {
      listRegistry: async () => { calls.listRegistry += 1; return ok([]) },
      listRegistryKnowledge: async () => ok([]),
      listDerivationCandidates: async () => ok([]),
      getSystemStudioSnapshot: async () => ok({ stats: {}, agents: [], blueprints: [], routingCards: [], recentTraces: [] }),
    },
  }
}

test('AgentSettingsHub defaults to 管理 and exposes the three sub-views', async () => {
  const handle = installDom()
  try {
    const calls: ApiCalls = { set: [], listRegistry: 0 }
    installElectronApi(handle, calls, { autoNarration: true, prerouteMode: 'suggest', knowledgeEnabled: true })
    const { default: AgentSettingsHub } = await import('../renderer/components/agent-system/AgentSettingsHub')
    const { container } = await mount(<AgentSettingsHub />)

    const navLabels = Array.from(container.querySelectorAll('button'))
      .map((b) => b.textContent || '')
    assert.ok(navLabels.some((t) => t.includes('Agent 管理')), 'has 管理 sub-nav')
    assert.ok(navLabels.some((t) => t.includes('行为')), 'has 行为 sub-nav')
    assert.ok(navLabels.some((t) => t.includes('派生与系统')), 'has 派生与系统 sub-nav')

    // 默认进「管理」：AgentRegistryPanel 在 mount 时拉取 registry。
    assert.ok(calls.listRegistry >= 1, 'manage view mounted registry panel on first render')
  } finally {
    handle.restore()
  }
})

test('AgentSettingsHub 行为 controls read and write their own IPC', async () => {
  const handle = installDom()
  try {
    const calls: ApiCalls = { set: [], listRegistry: 0 }
    installElectronApi(handle, calls, { autoNarration: true, prerouteMode: 'suggest', knowledgeEnabled: false })
    const { default: AgentSettingsHub } = await import('../renderer/components/agent-system/AgentSettingsHub')
    const { container } = await mount(<AgentSettingsHub />)

    await clickButtonContaining(container, '行为')

    // 三个行为行渲染。
    const text = container.textContent || ''
    assert.ok(text.includes('后台任务自动播报'), 'narration row rendered')
    assert.ok(text.includes('新会话智能路由'), 'preroute row rendered')
    assert.ok(text.includes('知识系统总开关'), 'knowledge switch rendered')

    const checkboxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
    // 顺序：narration（来自 getter=true），knowledge（来自 list=false）。
    assert.equal(checkboxes.length, 2, 'two toggles in 行为')
    assert.equal(checkboxes[0].checked, true, 'narration reflects getter true')
    assert.equal(checkboxes[1].checked, false, 'knowledge reflects list false')

    // 关闭自动播报 → 调用 setter(false)。
    await act(async () => { checkboxes[0].click() })
    await flush()
    assert.deepEqual(calls.set.at(-1), { method: 'narration', value: false }, 'narration setter called')

    // 打开知识系统 → 调用 setter(true)。
    const knowledgeBox = (container.querySelectorAll('input[type="checkbox"]')[1]) as HTMLInputElement
    await act(async () => { knowledgeBox.click() })
    await flush()
    assert.deepEqual(calls.set.at(-1), { method: 'knowledge', value: true }, 'knowledge setter called')

    // 切换预路由 select → 调用 setter('auto')。
    const select = container.querySelector('select') as HTMLSelectElement
    assert.ok(select, 'preroute select present')
    assert.equal(select.value, 'suggest', 'preroute reflects getter')
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')
      descriptor?.set?.call(select, 'auto')
      const EventCtor = select.ownerDocument.defaultView?.Event ?? Event
      select.dispatchEvent(new EventCtor('change', { bubbles: true }))
    })
    await flush()
    assert.deepEqual(calls.set.at(-1), { method: 'preroute', value: 'auto' }, 'preroute setter called')
  } finally {
    handle.restore()
  }
})

test('AgentSettingsHub remounts 管理 on ready:agent-registry-changed', async () => {
  const handle = installDom()
  try {
    const calls: ApiCalls = { set: [], listRegistry: 0 }
    installElectronApi(handle, calls, { autoNarration: true, prerouteMode: 'suggest', knowledgeEnabled: true })
    const { default: AgentSettingsHub } = await import('../renderer/components/agent-system/AgentSettingsHub')
    await mount(<AgentSettingsHub />)
    const before = calls.listRegistry
    assert.ok(before >= 1, 'registry loaded on mount')

    // §7.1 统一刷新契约：广播事件应使管理区重挂并重新拉取 registry。
    await act(async () => {
      globalThis.window.dispatchEvent(new globalThis.window.Event('ready:agent-registry-changed'))
    })
    await flush()
    assert.ok(calls.listRegistry > before, 'registry re-fetched after refresh event')
  } finally {
    handle.restore()
  }
})
