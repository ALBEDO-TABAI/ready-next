import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

type Candidate = {
  candidateRelPath: string
  title: string
  description: string
  bodyPreview: string
  evidenceDates: string[]
  defaultSpecialistId: string
  defaultName: string
  defaultCharter: string
  defaultSeedRulesText: string
  defaultRoutingTriggers: string[]
  migrationCandidates: Array<{ relPath: string; title: string; description: string }>
}

type AgentRecord = {
  id: string
  name: string
  charter: string | null
  status: 'active' | 'retired' | 'merged'
  parentAgentId: string | null
  derivationReason: string | null
  mergedIntoAgentId: string | null
  createdAt: string
}

function candidate(): Candidate {
  return {
    candidateRelPath: 'knowledge/agent-candidate-xhs.md',
    title: '专项 agent 候选：小红书采集',
    description: '同类请求 3 次',
    bodyPreview: '- 2026-06-10 小红书\n- 2026-06-11 小红书\n- 2026-06-12 小红书',
    evidenceDates: ['2026-06-10', '2026-06-11', '2026-06-12'],
    defaultSpecialistId: 'xhs.collector',
    defaultName: '小红书采集专项 Agent',
    defaultCharter: '处理小红书采集',
    defaultSeedRulesText: '# 小红书采集专项 Agent\n- 只处理已确认的采集任务。',
    defaultRoutingTriggers: ['小红书'],
    migrationCandidates: [{ relPath: 'knowledge/xhs-note.md', title: '小红书经验', description: '经验' }],
  }
}

function agents(): AgentRecord[] {
  return [
    {
      id: 'butler',
      name: '主助理',
      charter: '入口',
      status: 'active',
      parentAgentId: null,
      derivationReason: null,
      mergedIntoAgentId: null,
      createdAt: '2026-06-13T00:00:00.000Z',
    },
    {
      id: 'writer',
      name: '写作专项',
      charter: '写作',
      status: 'active',
      parentAgentId: 'butler',
      derivationReason: 'knowledge/agent-candidate-writer.md',
      mergedIntoAgentId: null,
      createdAt: '2026-06-13T00:00:00.000Z',
    },
  ]
}

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
    CustomEvent: (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    confirm: (globalThis as { confirm?: typeof confirm }).confirm,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  }
  function setGlobal(key: string, value: unknown): void {
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
  setGlobal('CustomEvent', dom.window.CustomEvent)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('confirm', () => true)
  Object.defineProperty(dom.window, 'confirm', { value: () => true, configurable: true, writable: true })
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

async function unmount(root: Root): Promise<void> {
  await act(async () => {
    root.unmount()
  })
  await flush()
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const host = globalThis.document.getElementById('root')
  assert.ok(host)
  host.innerHTML = ''
  const container = globalThis.document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  await flush()
  return { root, container }
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button'))
    .find((item) => item.textContent?.includes(text)) as HTMLButtonElement | undefined
  assert.ok(button, `button not found: ${text}`)
  return button
}

test('AgentDerivationPanel confirms and rejects candidates through visible controls', async () => {
  const handle = installDom()
  try {
    const { default: AgentDerivationPanel } = await import('../renderer/components/personality/AgentDerivationPanel')
    let rows = [candidate()]
    let refreshEvents = 0
    const confirmCalls: unknown[] = []
    const rejectCalls: string[] = []
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        listDerivationCandidates: async () => ({ success: true, data: rows }),
        confirmDerivation: async (payload: unknown) => {
          confirmCalls.push(payload)
          rows = []
          return { success: true, data: { blueprintId: 'bp-xhs-collector' } }
        },
        rejectDerivation: async (relPath: string) => {
          rejectCalls.push(relPath)
          rows = []
          return { success: true, data: rows }
        },
      },
    }
    handle.dom.window.addEventListener('ready:agent-registry-changed', () => { refreshEvents += 1 })

    const first = await mount(createElement(AgentDerivationPanel))
    try {
      assert.match(first.container.textContent || '', /小红书采集/)
      await act(async () => {
        findButton(first.container, '生成蓝图').click()
      })
      await flush()
      assert.equal(confirmCalls.length, 1)
      assert.equal(refreshEvents, 0, 'staging a blueprint must not refresh the registry panel')
      assert.match(first.container.textContent || '', /Agent System Studio/)
    } finally {
      await unmount(first.root)
    }

    rows = [candidate()]
    const second = await mount(createElement(AgentDerivationPanel))
    try {
      await act(async () => {
        findButton(second.container, '驳回').click()
      })
      await flush()
      assert.deepEqual(rejectCalls, ['knowledge/agent-candidate-xhs.md'])
      assert.match(second.container.textContent || '', /暂无可派生候选/)
    } finally {
      await unmount(second.root)
    }
  } finally {
    handle.restore()
  }
})

test('AgentDerivationPanel does not point needs_clarification blueprints to confirm-create', async () => {
  const handle = installDom()
  try {
    const { default: AgentDerivationPanel } = await import('../renderer/components/personality/AgentDerivationPanel')
    let rows = [candidate()]
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        listDerivationCandidates: async () => ({ success: true, data: rows }),
        confirmDerivation: async () => {
          rows = []
          return {
            success: true,
            data: {
              blueprintId: 'bp-xhs-collector',
              status: 'needs_clarification',
              clarification: {
                nextTool: 'ask_user_questions',
                questions: [{ id: 'nonGoals', question: '这个专项 agent 明确不该做哪些事？' }],
              },
            },
          }
        },
      },
    }

    const mounted = await mount(createElement(AgentDerivationPanel))
    try {
      await act(async () => {
        findButton(mounted.container, '生成蓝图').click()
      })
      await flush()
      const text = mounted.container.textContent || ''
      assert.match(text, /需补齐信息/)
      assert.doesNotMatch(text, /确认创建/)
    } finally {
      await unmount(mounted.root)
    }
  } finally {
    handle.restore()
  }
})

test('AgentRegistryPanel fails loudly on knowledge read errors and refreshes after derivation', async () => {
  const handle = installDom()
  try {
    const { default: AgentRegistryPanel } = await import('../renderer/components/personality/AgentRegistryPanel')
    let listCalls = 0
    const updatePayloads: unknown[] = []
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        listRegistry: async () => {
          listCalls += 1
          return { success: true, data: agents() }
        },
        listRegistryKnowledge: async () => ({
          success: true,
          data: [{ relPath: 'agents/writer/knowledge/style.md', title: '风格', description: 'd', status: 'active' }],
        }),
        updateRegistryStatus: async (payload: unknown) => {
          updatePayloads.push(payload)
          return { success: true, data: agents()[1] }
        },
      },
    }

    const ok = await mount(createElement(AgentRegistryPanel))
    try {
      assert.match(ok.container.textContent || '', /写作专项/)
      await act(async () => {
        handle.dom.window.dispatchEvent(new handle.dom.window.CustomEvent('ready:agent-registry-changed'))
      })
      await flush()
      assert.equal(listCalls, 2, 'registry panel should refresh after a derivation succeeds')
      await act(async () => {
        findButton(ok.container, '合并').click()
      })
      await flush()
      assert.equal((updatePayloads[0] as { mergedIntoAgentId?: string }).mergedIntoAgentId, 'butler')
    } finally {
      await unmount(ok.root)
    }

    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        listRegistry: async () => ({ success: true, data: agents() }),
        listRegistryKnowledge: async () => ({ success: false, error: '知识卡读取失败' }),
        updateRegistryStatus: async () => ({ success: true, data: agents()[1] }),
      },
    }
    const failed = await mount(createElement(AgentRegistryPanel))
    try {
      assert.match(failed.container.textContent || '', /知识卡读取失败/)
      assert.equal(Array.from(failed.container.querySelectorAll('button')).some((button) => button.textContent?.includes('合并')), false)
    } finally {
      await unmount(failed.root)
    }
  } finally {
    handle.restore()
  }
})
