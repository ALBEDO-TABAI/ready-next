import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import type { ReadyMemoryEntryView, ReadyMemoryView } from '../shared/ready-memory'
import { useAgent } from '../renderer/stores/useAgent'

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = new Map<string, PropertyDescriptor | undefined>()
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
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  return {
    dom,
    restore: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else delete (globalThis as unknown as Record<string, unknown>)[key]
      }
      dom.window.close()
    },
  }
}

function memoryView(overrides: Partial<ReadyMemoryView> = {}): ReadyMemoryView {
  return {
    useMemories: true,
    generateMemories: false,
    automaticGenerationAvailable: true,
    conversationId: null,
    contributeToMemories: null,
    entries: [],
    pendingGenerationJobs: 0,
    unresolvedGenerationJobs: 0,
    ...overrides,
  }
}

function manualEntry(overrides: Partial<ReadyMemoryEntryView> = {}): ReadyMemoryEntryView {
  return {
    entryId: 'memory-1',
    category: 'preference',
    content: '我喜欢简洁的中文回答',
    origin: 'manual',
    confidence: 1,
    pinned: false,
    status: 'active',
    expiresAt: null,
    sourceRefs: [],
    lastUsedAt: null,
    createdAt: '2026-08-20T08:00:00.000Z',
    updatedAt: '2026-08-20T08:00:00.000Z',
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.getElementById('root') as HTMLElement
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  await flush()
  return { root, container }
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    ;(element as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
    element.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function unmount(root: Root): Promise<void> {
  await act(async () => { root.unmount() })
  await flush()
}

test('自动整理未确认时不会开启，确认后带费用授权', async () => {
  const handle = installDom()
  const previousScopeId = useAgent.getState().currentScopeId
  try {
    const { ReadyMemorySettingsPanel } = await import('../renderer/pages/settings/ReadyMemorySettingsPanel')
    useAgent.setState({ currentScopeId: 'conversation-1' })
    let view = memoryView({ conversationId: 'conversation-1', contributeToMemories: true })
    const policyCalls: unknown[] = []
    let confirmations = 0
    handle.dom.window.confirm = () => {
      confirmations += 1
      return confirmations > 1
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        readReadyMemory: async () => ({ success: true, data: view }),
        setReadyMemoryGlobalPolicy: async (payload: { generateMemories?: boolean; useMemories?: boolean }) => {
          policyCalls.push(payload)
          view = memoryView({ ...view, ...payload })
          return { success: true, data: memoryView({
            useMemories: view.useMemories,
            generateMemories: view.generateMemories,
          }) }
        },
      },
    }

    const mounted = await mount(createElement(ReadyMemorySettingsPanel))
    const generateSwitch = mounted.container.querySelector('[role="switch"][aria-label="自动整理长期记忆"]')
    assert.ok(generateSwitch)

    await click(generateSwitch)
    assert.equal(policyCalls.length, 0)
    assert.equal(generateSwitch.getAttribute('aria-checked'), 'false')

    await click(generateSwitch)
    assert.deepEqual(policyCalls, [{ generateMemories: true, acknowledgeModelCost: true }])
    assert.equal(generateSwitch.getAttribute('aria-checked'), 'true')
    assert.match(mounted.container.textContent || '', /模型费用/)

    const useSwitch = mounted.container.querySelector('[role="switch"][aria-label="使用长期记忆"]')
    assert.ok(useSwitch)
    await click(useSwitch)
    assert.deepEqual(policyCalls.at(-1), { useMemories: false })
    assert.equal(mounted.container.querySelector(
      '[role="switch"][aria-label="允许当前对话用于整理"]',
    )?.getAttribute('aria-checked'), 'true')
    await unmount(mounted.root)
  } finally {
    useAgent.setState({ currentScopeId: previousScopeId })
    handle.restore()
  }
})

test('生产通道无法安全恢复时不会开放自动整理', async () => {
  const handle = installDom()
  const previousScopeId = useAgent.getState().currentScopeId
  try {
    const { ReadyMemorySettingsPanel } = await import('../renderer/pages/settings/ReadyMemorySettingsPanel')
    useAgent.setState({ currentScopeId: 'conversation-unavailable' })
    const view = memoryView({
      automaticGenerationAvailable: false,
      conversationId: 'conversation-unavailable',
      contributeToMemories: true,
      pendingGenerationJobs: 1,
      unresolvedGenerationJobs: 2,
    })
    let policyCalls = 0
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        readReadyMemory: async () => ({ success: true, data: view }),
        setReadyMemoryGlobalPolicy: async () => {
          policyCalls += 1
          return { success: true, data: view }
        },
      },
    }

    const mounted = await mount(createElement(ReadyMemorySettingsPanel))
    const generateSwitch = mounted.container.querySelector('[role="switch"][aria-label="自动整理长期记忆"]') as HTMLButtonElement
    assert.ok(generateSwitch)
    assert.equal(generateSwitch.disabled, true)
    assert.match(mounted.container.textContent || '', /无法安全找回中断的整理请求/)
    assert.match(mounted.container.textContent || '', /自动整理暂未开放/)
    assert.doesNotMatch(mounted.container.textContent || '', /确认费用后开启自动整理/)
    assert.match(mounted.container.textContent || '', /正在处理 1 项整理/)
    assert.match(mounted.container.textContent || '', /2 项只会查询原请求结果，不会重新提交/)
    await click(generateSwitch)
    assert.equal(policyCalls, 0)
    await unmount(mounted.root)
  } finally {
    useAgent.setState({ currentScopeId: previousScopeId })
    handle.restore()
  }
})

test('手动记忆可添加、编辑、固定和删除', async () => {
  const handle = installDom()
  const previousScopeId = useAgent.getState().currentScopeId
  try {
    const { ReadyMemorySettingsPanel } = await import('../renderer/pages/settings/ReadyMemorySettingsPanel')
    useAgent.setState({ currentScopeId: 'conversation-2' })
    let view = memoryView({ conversationId: 'conversation-2', contributeToMemories: true })
    const calls: Array<{ kind: string; payload: unknown }> = []
    handle.dom.window.confirm = () => true
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        readReadyMemory: async () => ({ success: true, data: view }),
        addReadyMemory: async (payload: { content: string }) => {
          calls.push({ kind: 'add', payload })
          view = memoryView({ ...view, entries: [manualEntry({ content: payload.content })] })
          return { success: true, data: memoryView({ entries: view.entries }) }
        },
        updateReadyMemory: async (payload: { entryId: string; content: string }) => {
          calls.push({ kind: 'update', payload })
          view = memoryView({ ...view, entries: [manualEntry({ content: payload.content })] })
          return { success: true, data: memoryView({ entries: view.entries }) }
        },
        pinReadyMemory: async (payload: { entryId: string; pinned: boolean }) => {
          calls.push({ kind: 'pin', payload })
          view = memoryView({ ...view, entries: [manualEntry({ content: view.entries[0].content, pinned: payload.pinned })] })
          return { success: true, data: memoryView({ entries: view.entries }) }
        },
        deleteReadyMemory: async (payload: { entryId: string }) => {
          calls.push({ kind: 'delete', payload })
          view = memoryView({ ...view, entries: [] })
          return { success: true, data: memoryView({ entries: [] }) }
        },
      },
    }

    const mounted = await mount(createElement(ReadyMemorySettingsPanel))
    const editor = mounted.container.querySelector('textarea[aria-label="记忆内容"]') as HTMLTextAreaElement
    assert.ok(editor)
    await typeInto(editor, '回答要简洁')
    const addButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '添加记忆')
    assert.ok(addButton)
    await click(addButton)
    assert.equal((calls[0].payload as { content: string }).content, '回答要简洁')
    assert.match(mounted.container.textContent || '', /手动添加/)
    assert.match(mounted.container.textContent || '', /更新于/)
    assert.match(mounted.container.textContent || '', /来源：手动添加/)
    const contributionSwitch = () => mounted.container.querySelector(
      '[role="switch"][aria-label="允许当前对话用于整理"]',
    )
    assert.equal(contributionSwitch()?.getAttribute('aria-checked'), 'true')

    const editButton = mounted.container.querySelector('[data-memory-action="edit"]')
    assert.ok(editButton)
    await click(editButton)
    const editInput = mounted.container.querySelector('textarea[aria-label="记忆内容"]') as HTMLTextAreaElement
    assert.equal(editInput.value, '回答要简洁')
    await typeInto(editInput, '回答要更简洁')
    const saveButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === '保存修改')
    assert.ok(saveButton)
    await click(saveButton)
    assert.equal((calls.find((call) => call.kind === 'update')?.payload as { content: string }).content, '回答要更简洁')
    assert.equal(contributionSwitch()?.getAttribute('aria-checked'), 'true')

    const pinButton = mounted.container.querySelector('[data-memory-action="pin"]')
    assert.ok(pinButton)
    await click(pinButton)
    assert.deepEqual(calls.find((call) => call.kind === 'pin')?.payload, { entryId: 'memory-1', pinned: true })
    assert.match(mounted.container.textContent || '', /已固定/)
    assert.equal(contributionSwitch()?.getAttribute('aria-checked'), 'true')

    const deleteButton = mounted.container.querySelector('[data-memory-action="delete"]')
    assert.ok(deleteButton)
    await click(deleteButton)
    assert.deepEqual(calls.find((call) => call.kind === 'delete')?.payload, { entryId: 'memory-1' })
    assert.match(mounted.container.textContent || '', /还没有长期记忆/)
    assert.equal(contributionSwitch()?.getAttribute('aria-checked'), 'true')
    await unmount(mounted.root)
  } finally {
    useAgent.setState({ currentScopeId: previousScopeId })
    handle.restore()
  }
})

test('全部忘记需要二次确认', async () => {
  const handle = installDom()
  const previousScopeId = useAgent.getState().currentScopeId
  try {
    const { ReadyMemorySettingsPanel } = await import('../renderer/pages/settings/ReadyMemorySettingsPanel')
    useAgent.setState({ currentScopeId: 'conversation-3' })
    let view = memoryView({
      conversationId: 'conversation-3', contributeToMemories: true, entries: [manualEntry()],
    })
    let resetCalls = 0
    let confirmations = 0
    handle.dom.window.confirm = () => {
      confirmations += 1
      return confirmations > 1
    }
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        readReadyMemory: async () => ({ success: true, data: view }),
        resetReadyMemory: async (payload: { confirm: true }) => {
          assert.deepEqual(payload, { confirm: true })
          resetCalls += 1
          view = memoryView({ ...view, entries: [] })
          return { success: true, data: memoryView({ entries: [] }) }
        },
      },
    }

    const mounted = await mount(createElement(ReadyMemorySettingsPanel))
    const resetButton = Array.from(mounted.container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('全部忘记'))
    assert.ok(resetButton)
    await click(resetButton)
    assert.equal(resetCalls, 0)
    await click(resetButton)
    assert.equal(resetCalls, 1)
    assert.match(mounted.container.textContent || '', /还没有长期记忆/)
    assert.equal(mounted.container.querySelector(
      '[role="switch"][aria-label="允许当前对话用于整理"]',
    )?.getAttribute('aria-checked'), 'true')
    await unmount(mounted.root)
  } finally {
    useAgent.setState({ currentScopeId: previousScopeId })
    handle.restore()
  }
})

test('没有当前本地对话时明确说明且不暴露贡献开关', async () => {
  const handle = installDom()
  const previousScopeId = useAgent.getState().currentScopeId
  try {
    const { ReadyMemorySettingsPanel } = await import('../renderer/pages/settings/ReadyMemorySettingsPanel')
    useAgent.setState({ currentScopeId: null })
    const readCalls: unknown[] = []
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        readReadyMemory: async (payload: unknown) => {
          readCalls.push(payload)
          return { success: true, data: memoryView() }
        },
      },
    }

    const mounted = await mount(createElement(ReadyMemorySettingsPanel))
    assert.deepEqual(readCalls, [{}])
    assert.match(mounted.container.textContent || '', /先打开一个本地对话/)
    assert.match(mounted.container.textContent || '', /未打开对话/)
    assert.equal(
      mounted.container.querySelector('[role="switch"][aria-label="允许当前对话用于整理"]'),
      null,
    )
    await unmount(mounted.root)
  } finally {
    useAgent.setState({ currentScopeId: previousScopeId })
    handle.restore()
  }
})

test('远程或临时对话不显示可点击的记忆贡献开关', async () => {
  const handle = installDom()
  const previousScopeId = useAgent.getState().currentScopeId
  try {
    const { ReadyMemorySettingsPanel } = await import('../renderer/pages/settings/ReadyMemorySettingsPanel')
    useAgent.setState({ currentScopeId: 'remote-conversation' })
    ;(handle.dom.window as Window & { electronAPI?: unknown }).electronAPI = {
      agent: {
        readReadyMemory: async () => ({
          success: true,
          data: memoryView({ conversationId: 'remote-conversation', contributeToMemories: null }),
        }),
      },
    }
    const mounted = await mount(createElement(ReadyMemorySettingsPanel))
    assert.equal(mounted.container.querySelector(
      '[role="switch"][aria-label="允许当前对话用于整理"]',
    ), null)
    assert.match(mounted.container.textContent || '', /远程、临时或已关闭的对话不会进入长期记忆整理/)
    assert.match(mounted.container.textContent || '', /当前对话不支持/)
    await unmount(mounted.root)
  } finally {
    useAgent.setState({ currentScopeId: previousScopeId })
    handle.restore()
  }
})
