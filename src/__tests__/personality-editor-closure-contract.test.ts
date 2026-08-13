import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

interface PersonalityRecord {
  id: string
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  createdAt: number
  updatedAt: number
}

interface PreviousGlobals {
  window: Window | undefined
  document: Document | undefined
  HTMLElement: typeof HTMLElement | undefined
  Node: typeof Node | undefined
  Element: typeof Element | undefined
  navigator: Navigator | undefined
  prompt: typeof prompt | undefined
  confirm: typeof confirm | undefined
  setTimeout: typeof setTimeout | undefined
  clearTimeout: typeof clearTimeout | undefined
  IS_REACT_ACT_ENVIRONMENT: unknown
}

let currentRoot: Root | null = null
let restoreGlobals: (() => void) | null = null

function installDom(): { root: Root; container: HTMLElement; dom: JSDOM } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const g = globalThis as unknown as Record<string, unknown>
  const previous: PreviousGlobals = {
    window: g.window as Window | undefined,
    document: g.document as Document | undefined,
    HTMLElement: g.HTMLElement as typeof HTMLElement | undefined,
    Node: g.Node as typeof Node | undefined,
    Element: g.Element as typeof Element | undefined,
    navigator: g.navigator as Navigator | undefined,
    prompt: g.prompt as typeof prompt | undefined,
    confirm: g.confirm as typeof confirm | undefined,
    setTimeout: g.setTimeout as typeof setTimeout | undefined,
    clearTimeout: g.clearTimeout as typeof clearTimeout | undefined,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  }

  function setGlobal(key: string, value: unknown): void {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Element', dom.window.Element)
  setGlobal('navigator', dom.window.navigator)
  setGlobal('setTimeout', (() => 0) as typeof setTimeout)
  setGlobal('clearTimeout', (() => undefined) as typeof clearTimeout)
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)

  const container = dom.window.document.getElementById('root')
  assert.ok(container)
  const root = createRoot(container)
  currentRoot = root
  restoreGlobals = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete (globalThis as unknown as Record<string, unknown>)[key]
      } else {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
      }
    }
    try { dom.window.close() } catch { /* best-effort */ }
  }
  return { root, container, dom }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    (item.textContent || '').includes(text),
  )
  assert.ok(button, `button not found: ${text}`)
  return button as HTMLButtonElement
}

function click(dom: JSDOM, button: HTMLButtonElement): void {
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

async function renderEditor(params: {
  personalities: PersonalityRecord[]
  create?: (payload: Record<string, unknown>) => Promise<unknown>
  update?: (agentName: string, payload: Record<string, unknown>) => Promise<unknown>
  delete?: (agentName: string) => Promise<unknown>
  reloadAgents?: () => Promise<void>
}): Promise<{ container: HTMLElement; dom: JSDOM }> {
  const { root, container, dom } = installDom()
  ;(dom.window as any).electronAPI = {
    agentPersonality: {
      list: async () => ({ success: true, data: params.personalities }),
      get: async (agentName: string) => ({
        success: true,
        data: params.personalities.find((item) => item.agentName === agentName),
      }),
      create: params.create || (async () => ({ success: true })),
      update: params.update || (async () => ({ success: true })),
      delete: params.delete || (async () => ({ success: true })),
    },
  }
  const { useAgent } = await import('../renderer/stores/useAgent')
  useAgent.setState({
    reloadAgents: params.reloadAgents || (async () => undefined),
  })
  const { default: PersonalityEditor } = await import('../renderer/components/personality/PersonalityEditor')
  await act(async () => {
    root.render(createElement(PersonalityEditor))
    await flush()
  })
  return { container, dom }
}

afterEach(async () => {
  if (currentRoot) {
    await act(async () => {
      currentRoot?.unmount()
      await flush()
    })
  }
  currentRoot = null
  restoreGlobals?.()
  restoreGlobals = null
})

describe('PersonalityEditor closure contract', () => {
  it('creates a historical personality archive without refreshing the chat switcher', async () => {
    const personalities: PersonalityRecord[] = []
    const createCalls: Record<string, unknown>[] = []
    let reloadCalls = 0
    const { container, dom } = await renderEditor({
      personalities,
      create: async (payload) => {
        createCalls.push(payload)
        const record: PersonalityRecord = {
          id: 'p-designer',
          agentName: String(payload.agentName),
          personalityText: String(payload.personalityText),
          createdAt: 1,
          updatedAt: 1,
        }
        personalities.push(record)
        return { success: true, data: record }
      },
      reloadAgents: async () => { reloadCalls += 1 },
    })

    await act(async () => {
      click(dom, findButton(container, '新建档案'))
      await flush()
    })
    assert.equal(createCalls.length, 0)
    assert.match(container.textContent || '', /Agent 标识/)

    await act(async () => {
      click(dom, findButton(container, '保存档案'))
      await flush()
    })

    assert.equal(createCalls.length, 1)
    assert.equal(createCalls[0].agentName, 'designer')
    assert.match(String(createCalls[0].personalityText), /不会改变当前 Codex/)
    assert.equal(reloadCalls, 0)
    assert.match(container.textContent || '', /历史人格资料已保存|designer/)
  })

  it('selects an existing personality and loads the matching fields', async () => {
    const personalities: PersonalityRecord[] = [
      {
        id: 'p-butler',
        agentName: 'butler',
        displayName: '管家',
        personalityText: 'butler personality',
        tone: 'friendly',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'p-designer',
        agentName: 'designer',
        displayName: '设计审稿师',
        personalityText: 'designer personality',
        tone: 'technical',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const { container, dom } = await renderEditor({ personalities })

    await act(async () => {
      await flush()
    })
    await act(async () => {
      click(dom, findButton(container, '设计审稿师'))
      await flush()
    })

    const agentName = container.querySelector('input[aria-label="Agent 标识"]') as HTMLInputElement | null
    const definition = container.querySelector('textarea[aria-label="人格定义"]') as HTMLTextAreaElement | null
    assert.equal(agentName?.value, 'designer')
    assert.equal(definition?.value, 'designer personality')
  })

  it('deletes a historical personality archive without refreshing the chat switcher', async () => {
    const personalities: PersonalityRecord[] = [
      {
        id: 'p-butler',
        agentName: 'butler',
        displayName: '管家',
        personalityText: 'old personality',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'p-designer',
        agentName: 'designer',
        displayName: '设计审稿师',
        personalityText: 'designer personality',
        createdAt: 1,
        updatedAt: 1,
      },
    ]
    const deleteCalls: string[] = []
    let reloadCalls = 0
    const { container, dom } = await renderEditor({
      personalities,
      delete: async (agentName) => {
        deleteCalls.push(agentName)
        const index = personalities.findIndex((item) => item.agentName === agentName)
        if (index >= 0) personalities.splice(index, 1)
        return { success: true }
      },
      reloadAgents: async () => { reloadCalls += 1 },
    })
    const confirmImpl = () => true
    Object.defineProperty(globalThis, 'confirm', { value: confirmImpl, configurable: true, writable: true })
    Object.defineProperty(dom.window, 'confirm', { value: confirmImpl, configurable: true, writable: true })

    await act(async () => {
      await flush()
    })
    await act(async () => {
      click(dom, findButton(container, '删除'))
      await flush()
    })

    assert.deepEqual(deleteCalls, ['butler'])
    assert.equal(reloadCalls, 0)
    assert.match(container.textContent || '', /历史人格资料已删除/)
    assert.match(container.textContent || '', /设计审稿师/)
  })

  it('shows save failure when update returns success false', async () => {
    const personalities: PersonalityRecord[] = [{
      id: 'p-butler',
      agentName: 'butler',
      displayName: '管家',
      personalityText: 'old personality',
      createdAt: 1,
      updatedAt: 1,
    }]
    let updateCalls = 0
    let reloadCalls = 0
    const { container, dom } = await renderEditor({
      personalities,
      update: async () => {
        updateCalls += 1
        return { success: false, error: 'update failed' }
      },
      reloadAgents: async () => { reloadCalls += 1 },
    })

    await act(async () => {
      await flush()
    })
    await act(async () => {
      click(dom, findButton(container, '保存档案'))
      await flush()
    })

    assert.equal(updateCalls, 1)
    assert.equal(reloadCalls, 0)
    assert.match(container.textContent || '', /保存失败：update failed/)
  })

  it('shows delete failure when delete returns success false', async () => {
    const personalities: PersonalityRecord[] = [{
      id: 'p-butler',
      agentName: 'butler',
      displayName: '管家',
      personalityText: 'old personality',
      createdAt: 1,
      updatedAt: 1,
    }]
    let deleteCalls = 0
    let reloadCalls = 0
    const { container, dom } = await renderEditor({
      personalities,
      delete: async () => {
        deleteCalls += 1
        return { success: false, error: 'delete failed' }
      },
      reloadAgents: async () => { reloadCalls += 1 },
    })
    const confirmImpl = () => true
    Object.defineProperty(globalThis, 'confirm', { value: confirmImpl, configurable: true, writable: true })
    Object.defineProperty(dom.window, 'confirm', { value: confirmImpl, configurable: true, writable: true })

    await act(async () => {
      await flush()
    })
    await act(async () => {
      click(dom, findButton(container, '删除'))
      await flush()
    })

    assert.equal(deleteCalls, 1)
    assert.equal(reloadCalls, 0)
    assert.match(container.textContent || '', /删除失败：delete failed/)
  })
})
