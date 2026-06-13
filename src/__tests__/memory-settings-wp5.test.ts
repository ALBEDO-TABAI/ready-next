import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { JSDOM } from 'jsdom'
import type {
  BeliefCardSettingsSnapshotData,
  MemoryEntry,
  MemoryQueryFilters,
  MemoryStats,
} from '../renderer/types/electron'

interface DomHandle {
  dom: JSDOM
  restore: () => void
}

function installDomGlobals(): DomHandle {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/settings?section=memory',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    HTMLInputElement: (globalThis as { HTMLInputElement?: typeof HTMLInputElement }).HTMLInputElement,
    HTMLSelectElement: (globalThis as { HTMLSelectElement?: typeof HTMLSelectElement }).HTMLSelectElement,
    HTMLTextAreaElement: (globalThis as { HTMLTextAreaElement?: typeof HTMLTextAreaElement }).HTMLTextAreaElement,
    SVGElement: (globalThis as { SVGElement?: typeof SVGElement }).SVGElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    Element: (globalThis as { Element?: typeof Element }).Element,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    matchMedia: (globalThis as { matchMedia?: (q: string) => MediaQueryList }).matchMedia,
    getComputedStyle: globalThis.getComputedStyle,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    localStorage: (globalThis as { localStorage?: Storage }).localStorage,
    alert: (globalThis as { alert?: (message?: unknown) => void }).alert,
    confirm: (globalThis as { confirm?: (message?: string) => boolean }).confirm,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }

  function setGlobal(key: string, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  const matchMedia = (_query: string) => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('HTMLInputElement', dom.window.HTMLInputElement)
  setGlobal('HTMLSelectElement', dom.window.HTMLSelectElement)
  setGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement)
  setGlobal('SVGElement', dom.window.SVGElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('Element', dom.window.Element)
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 0
  })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('matchMedia', matchMedia)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  setGlobal('navigator', dom.window.navigator)
  setGlobal('localStorage', dom.window.localStorage)
  setGlobal('alert', () => undefined)
  setGlobal('confirm', () => true)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(dom.window, 'matchMedia', { value: matchMedia, configurable: true, writable: true })

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
      try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
    },
  }
}

const sampleMemory: MemoryEntry = {
  id: 'memory-1',
  layer: 'l1',
  scopeId: 'conversation:demo',
  userId: 'default-user',
  sourceType: 'scope_memory',
  category: 'learning',
  title: '用户喜欢先看结论',
  summary: '回复时把结论放在第一句。',
  contentKey: 'internal-key-1',
  priority: 4,
  accessCount: 3,
  lastAccessedAt: 1_780_000_000,
  createdAt: 1_779_900_000,
  updatedAt: 1_779_950_000,
  expiresAt: null,
  archivedAt: null,
  tags: ['preference'],
  meta: { taskTitle: '设置页收口' },
}

const stats: MemoryStats = {
  totalMemories: 1,
  byLayer: { l0: 0, l1: 1, l2: 0 },
  byCategory: {
    summary: 0,
    learning: 1,
    trigger: 0,
    rule: 0,
    user_preference: 0,
    global_fact: 0,
    personality_trait: 0,
  },
  bySourceType: {
    resident_agent: 0,
    resident_user: 0,
    scope_memory: 1,
    trigger_rule: 0,
  },
  archivedCount: 0,
  avgAccessCount: 3,
}

const beliefSnapshot: BeliefCardSettingsSnapshotData = {
  knowledgeSystemEnabled: true,
  cards: [
    {
      relPath: 'knowledge/new-learning.md',
      scopeId: 'global',
      title: '系统新学到的东西',
      description: '回复要先给结论。',
      confidence: 'M',
      tag: 'knowledge',
      status: 'staged',
      created: '2026-06-13',
      source: null,
      stage: null,
      site: null,
      siteRiskLevel: null,
      siteRiskAuthority: null,
      isSiteCard: false,
      isRiskSuggestion: false,
      bodyPreview: '正文',
    },
    {
      relPath: 'knowledge/sites/xiaohongshu.com.md',
      scopeId: 'global',
      title: '小红书站点经验',
      description: '高风控站点。',
      confidence: 'H',
      tag: 'knowledge',
      status: 'active',
      created: '2026-06-13',
      source: null,
      stage: null,
      site: 'xiaohongshu.com',
      siteRiskLevel: 'high',
      siteRiskAuthority: 'code',
      isSiteCard: true,
      isRiskSuggestion: false,
      bodyPreview: '正文',
    },
  ],
  summary: {
    total: 2,
    staged: 1,
    active: 1,
    rejected: 0,
    invalid: 0,
    agentScoped: 0,
    siteCards: 1,
    highRiskSiteCards: 1,
    riskSuggestions: 0,
  },
  maintenance: {
    lifecycleRunning: true,
    lastLifecycleMaintenanceAt: '2026-06-13T12:00:00.000Z',
    llmRound: {
      lastRunAt: '2026-06-13T12:01:00.000Z',
      decision: 'skip',
      reason: 'no_signals',
      llmCalls: 0,
      applied: 0,
      rejected: 0,
      terminal: 'gated_skip',
    },
  },
}

interface MemoryHarness {
  queryCalls: MemoryQueryFilters[]
  statsCalls: number
  maintenanceCalls: number
  beliefCardListCalls: number
  beliefCardTransitions: Array<{ relPath: string; action: 'approve' | 'reject' }>
  knowledgeSwitches: boolean[]
  createFromConversationCalls: Array<{
    scopeId: string
    category: 'summary' | 'learning'
    title: string
    content: string
    tags?: string[]
    priority?: number
  }>
  deleteCalls: string[]
  alerts: string[]
}

function installElectronAPI(dom: JSDOM): MemoryHarness {
  const harness: MemoryHarness = {
    queryCalls: [],
    statsCalls: 0,
    maintenanceCalls: 0,
    beliefCardListCalls: 0,
    beliefCardTransitions: [],
    knowledgeSwitches: [],
    createFromConversationCalls: [],
    deleteCalls: [],
    alerts: [],
  }
  ;(dom.window as Window & { electronAPI?: unknown }).electronAPI = {
    memory: {
      query: async (filters: MemoryQueryFilters) => {
        harness.queryCalls.push({ ...filters })
        return { success: true, data: [sampleMemory] }
      },
      create: async (entry: Partial<MemoryEntry>) => ({ success: true, data: { ...sampleMemory, ...entry } }),
      update: async () => ({ success: true }),
      delete: async (id: string) => {
        harness.deleteCalls.push(id)
        return { success: true }
      },
      stats: async () => {
        harness.statsCalls += 1
        return { success: true, data: stats }
      },
      createFromConversation: async (payload: {
        scopeId: string
        category: 'summary' | 'learning'
        title: string
        content: string
        tags?: string[]
        priority?: number
      }) => {
        harness.createFromConversationCalls.push(payload)
        return { success: true, data: { memoryId: 'memory-2' } }
      },
    },
    memoryLifecycle: {
      status: async () => ({ success: true, data: { running: true, lastMaintenanceAt: null } }),
      runMaintenance: async () => {
        harness.maintenanceCalls += 1
        return {
          success: true,
          data: {
            archivedL1Count: 2,
            archivedL2Count: 3,
            prunedCount: 4,
            optimizedTriggers: 0,
            timestamp: new Date(0).toISOString(),
          },
        }
      },
    },
    memoryCards: {
      list: async () => {
        harness.beliefCardListCalls += 1
        return { success: true, data: beliefSnapshot }
      },
      transition: async (payload: { relPath: string; action: 'approve' | 'reject' }) => {
        harness.beliefCardTransitions.push(payload)
        return {
          success: true,
          data: {
            ...beliefSnapshot,
            cards: beliefSnapshot.cards.map((card) =>
              card.relPath === payload.relPath ? { ...card, status: payload.action === 'approve' ? 'active' as const : 'rejected' as const } : card,
            ),
            summary: { ...beliefSnapshot.summary, staged: 0, active: 2 },
          },
        }
      },
      setKnowledgeSystemEnabled: async (enabled: boolean) => {
        harness.knowledgeSwitches.push(enabled)
        return { success: true, data: { ...beliefSnapshot, knowledgeSystemEnabled: enabled } }
      },
    },
    trigger: {
      list: async () => ({ success: true, data: [] }),
      create: async () => ({ success: true, data: {} }),
      update: async () => ({ success: true }),
      createWithMemories: async () => ({ success: true, data: { triggerId: 'trigger-1' } }),
    },
  }
  ;(dom.window as Window & { alert?: (message?: unknown) => void }).alert = (message?: unknown) => {
    harness.alerts.push(String(message ?? ''))
  }
  Object.defineProperty(globalThis, 'alert', {
    value: (message?: unknown) => harness.alerts.push(String(message ?? '')),
    configurable: true,
    writable: true,
  })
  return harness
}

async function flushAsync(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

function setFormValue(
  dom: JSDOM,
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, cancelable: true, data: value }))
  element.dispatchEvent(new dom.window.Event('change', { bubbles: true, cancelable: true }))
}

async function mountMemorySettings(handle: DomHandle): Promise<{ root: Root; harness: MemoryHarness }> {
  const harness = installElectronAPI(handle.dom)
  const [{ createRoot }, SettingsModule] = await Promise.all([
    import('react-dom/client'),
    import('../renderer/pages/Settings'),
  ])
  const Settings = SettingsModule.default
  const root = createRoot(handle.dom.window.document.getElementById('root') as HTMLElement)
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/settings?section=memory'] },
        createElement(Settings, { initialSection: 'memory' }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await flushAsync()
  return { root, harness }
}

test('WP5 memory settings default view hides internal tools and re-queries when filters change', async () => {
  const handle = installDomGlobals()
  const { root, harness } = await mountMemorySettings(handle)
  try {
    const document = handle.dom.window.document
    assert.ok(document.body.textContent?.includes('最近记住了什么'))
    assert.ok(document.body.textContent?.includes('信念卡确认'), 'belief-card confirmation panel must render by default')
    assert.ok(document.body.textContent?.includes('知识系统总开关'), 'knowledge-system switch must be visible')
    assert.ok(document.body.textContent?.includes('系统新学到的东西'), 'staged belief cards must be visible')
    assert.ok(document.body.textContent?.includes('站点卡风险'), 'site-card risk summary must be visible')
    assert.ok(document.body.textContent?.includes('xiaohongshu.com'), 'high-risk site card domain must be visible')
    assert.equal(harness.beliefCardListCalls, 1)
    assert.ok(!document.body.textContent?.includes('Scope ID'), 'manual creator must stay out of the default memory view')
    assert.ok(!document.body.textContent?.includes('触发器管理'), 'trigger manager must stay inside the advanced section')
    assert.ok(!document.body.textContent?.includes('Child Runs'), 'active child runs debug must not render in memory settings')
    assert.ok(!document.body.textContent?.includes('internal-key-1'), 'content keys must stay hidden by default')

    const sourceSelect = document.querySelector('select') as HTMLSelectElement | null
    assert.ok(sourceSelect, 'source filter select must render')
    await act(async () => {
      sourceSelect.value = 'resident_user'
      sourceSelect.dispatchEvent(new handle.dom.window.Event('change', { bubbles: true }))
    })
    await flushAsync()

    assert.ok(harness.queryCalls.length >= 2, 'changing filters must trigger a fresh memory query')
    assert.equal(harness.queryCalls.at(-1)?.sourceType, 'resident_user')

    const confirmButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认'),
    ) as HTMLButtonElement | undefined
    assert.ok(confirmButton, 'staged card confirm button must render')
    await act(async () => { confirmButton.click() })
    await flushAsync()
    assert.deepEqual(harness.beliefCardTransitions, [{ relPath: 'knowledge/new-learning.md', action: 'approve' }])
  } finally {
    await act(async () => { root.unmount() })
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('WP5 memory maintenance reports real fields and refreshes list plus stats', async () => {
  const handle = installDomGlobals()
  const { root, harness } = await mountMemorySettings(handle)
  try {
    const document = handle.dom.window.document
    const beforeQueries = harness.queryCalls.length
    const beforeStats = harness.statsCalls
    const maintenanceButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('运行维护'),
    ) as HTMLButtonElement | undefined
    assert.ok(maintenanceButton, 'maintenance button must render')

    await act(async () => {
      maintenanceButton.click()
    })
    await flushAsync()

    assert.equal(harness.maintenanceCalls, 1)
    assert.ok(harness.queryCalls.length > beforeQueries, 'maintenance must refresh the memory list')
    assert.ok(harness.statsCalls > beforeStats, 'maintenance must refresh memory stats')
    assert.equal(harness.alerts.length, 1)
    assert.ok(harness.alerts[0].includes('2 / 3'), `expected L1/L2 archive counts in alert; got "${harness.alerts[0]}"`)
    assert.ok(!harness.alerts[0].includes('undefined'), `maintenance alert must not include undefined; got "${harness.alerts[0]}"`)
  } finally {
    await act(async () => { root.unmount() })
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})

test('WP5 memory create and delete refresh both memory list and stats through the parent section', async () => {
  const handle = installDomGlobals()
  const { root, harness } = await mountMemorySettings(handle)
  try {
    const document = handle.dom.window.document

    const beforeDeleteQueries = harness.queryCalls.length
    const beforeDeleteStats = harness.statsCalls
    const deleteButton = document.querySelector('button[aria-label="删除记忆"]') as HTMLButtonElement | null
    assert.ok(deleteButton, 'delete button must render in the default memory list')
    await act(async () => { deleteButton.click() })
    await flushAsync()
    assert.deepEqual(harness.deleteCalls, ['memory-1'])
    assert.ok(harness.queryCalls.length > beforeDeleteQueries, 'delete must refresh the memory list')
    assert.ok(harness.statsCalls > beforeDeleteStats, 'delete must refresh memory stats')

    const advancedButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('高级记忆工具'),
    ) as HTMLButtonElement | undefined
    assert.ok(advancedButton, 'advanced memory section toggle must render')
    await act(async () => { advancedButton.click() })
    await flushAsync()

    const textInputs = Array.from(document.querySelectorAll('input[type="text"]')) as HTMLInputElement[]
    const scopeInput = textInputs.find((input) => input.placeholder === '输入 Scope ID')
    const titleInput = textInputs.find((input) => input.placeholder === '记忆标题')
    const contentInput = document.querySelector('textarea') as HTMLTextAreaElement | null
    assert.ok(scopeInput, 'advanced creator must expose scope id only after expansion')
    assert.ok(titleInput, 'advanced creator title input must render')
    assert.ok(contentInput, 'advanced creator content input must render')

    const beforeCreateQueries = harness.queryCalls.length
    const beforeCreateStats = harness.statsCalls
    await act(async () => {
      setFormValue(handle.dom, scopeInput, 'conversation:demo')
      setFormValue(handle.dom, titleInput, '新的长期偏好')
      setFormValue(handle.dom, contentInput, '回复保持短句。')
    })
    const createButton = Array.from(document.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('创建记忆'),
    ) as HTMLButtonElement | undefined
    assert.ok(createButton, 'advanced creator submit button must render')
    await act(async () => { createButton.click() })
    await flushAsync()

    assert.equal(harness.createFromConversationCalls.length, 1)
    assert.equal(harness.createFromConversationCalls[0].scopeId, 'conversation:demo')
    assert.ok(harness.queryCalls.length > beforeCreateQueries, 'create must refresh the memory list')
    assert.ok(harness.statsCalls > beforeCreateStats, 'create must refresh memory stats')
  } finally {
    await act(async () => { root.unmount() })
    await new Promise((resolve) => setTimeout(resolve, 25))
    handle.restore()
  }
})
