import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import type { ActionAuthorizationMode } from '../shared/action-authorization-mode'

test('chat input exposes and switches the three conversation authorization modes', { timeout: 15_000 }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousNode = globalThis.Node
  const previousHTMLElement = globalThis.HTMLElement
  const previousResizeObserver = globalThis.ResizeObserver
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'Node', { value: dom.window.Node, configurable: true })
  Object.defineProperty(globalThis, 'HTMLElement', { value: dom.window.HTMLElement, configurable: true })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: class { observe() {} disconnect() {} },
    configurable: true,
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: () => 1,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: () => undefined,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    value: true,
    configurable: true,
  })
  const htmlElementPrototype = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
  htmlElementPrototype.attachEvent ??= () => undefined
  htmlElementPrototype.detachEvent ??= () => undefined
  Object.defineProperty(dom.window, 'electronAPI', {
    value: { skills: { list: async () => ({ success: true, data: [] }) } },
    configurable: true,
  })
  const { default: ChatInput } = await import('../renderer/components/agent/ChatInput')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const changes: ActionAuthorizationMode[] = []
  let sends = 0
  let stops = 0
  let persistMode: (mode: ActionAuthorizationMode) => Promise<void> = async () => undefined
  function Harness({
    isChannelScope = false,
    isStreaming = false,
    lifecycleInputBlocked = false,
    stopPending = false,
    stopError = null,
    admissionReady = true,
    inputValue = '发送测试',
  }: {
    isChannelScope?: boolean
    isStreaming?: boolean
    lifecycleInputBlocked?: boolean
    stopPending?: boolean
    stopError?: string | null
    admissionReady?: boolean
    inputValue?: string
  }) {
    const [mode, setMode] = useState<ActionAuthorizationMode>('ask')
    return createElement(ChatInput, {
      inputValue,
      isStreaming,
      lifecycleInputBlocked,
      stopPending,
      stopError,
      attachmentsCount: 0,
      hasUserMessages: false,
      isDragOver: false,
      contextUsage: null,
      composerShellStyle: {},
      filePool: [],
      filePoolCount: 0,
      currentAgent: 'butler',
      currentAgentAvatar: 'R',
      currentAgentDisplayName: 'Ready',
      agents: [],
      isChannelScope,
      actionAuthorizationMode: mode,
      onInputChange() {},
      onSend() { sends += 1 },
      onStop() { stops += 1 },
      onPickFiles() {},
      onAgentSelect() {},
      async onActionAuthorizationModeChange(nextMode) {
        changes.push(nextMode)
        await persistMode(nextMode)
        setMode(nextMode)
      },
      onSkillReference() {},
      onReferenceSelect() {},
      renderAttachmentIcon: () => null,
      ModelSelector: () => null,
      admissionReady,
    })
  }

  try {
    await act(async () => root.render(createElement(Harness)))
    const trigger = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-mode="ask"]',
    )
    assert.ok(trigger)
    await act(async () => trigger.click())
    const menu = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-menu="true"]',
    )
    assert.equal(menu?.parentElement, dom.window.document.body, 'the selector must escape the clipped composer surface')
    assert.equal(menu?.style.position, 'fixed')
    assert.ok(menu?.classList.contains('ready-liquid-popover'), 'the selector must use Ready liquid glass')
    assert.deepEqual(
      [...dom.window.document.querySelectorAll('[data-ready-action-authorization-option]')]
        .map((node) => node.getAttribute('data-ready-action-authorization-option')),
      ['ask', 'auto', 'full'],
    )
    const auto = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-option="auto"]',
    )
    assert.ok(auto)
    await act(async () => auto.click())
    assert.deepEqual(changes, ['auto'])
    assert.ok(dom.window.document.querySelector('[data-ready-action-authorization-mode="auto"]'))
    const initialSendButton = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')
    const initialTextarea = dom.window.document.querySelector<HTMLTextAreaElement>('[data-ready-agent-input="true"]')
    act(() => initialSendButton?.click())
    act(() => {
      initialTextarea?.focus()
      initialTextarea?.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }))
    })
    assert.equal(sends, 2, 'idle composer must send by click and Enter')
    await act(async () => root.render(createElement(Harness, { isChannelScope: true })))
    assert.equal(
      dom.window.document.querySelector('[data-ready-action-authorization-mode]'),
      null,
    )

    await act(async () => root.render(createElement(Harness)))
    let resolvePersist: (() => void) | null = null
    persistMode = () => new Promise<void>((resolve) => { resolvePersist = resolve })
    const autoTrigger = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-mode="auto"]',
    )
    assert.ok(autoTrigger)
    await act(async () => autoTrigger.click())
    const ask = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-option="ask"]',
    )
    assert.ok(ask)
    act(() => ask.click())
    const textarea = dom.window.document.querySelector<HTMLTextAreaElement>('[data-ready-agent-input="true"]')
    const sendButton = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')
    assert.equal(textarea?.disabled, true)
    assert.equal(sendButton?.disabled, true)
    act(() => {
      sendButton?.click()
    })
    assert.equal(sends, 2, 'pending mode persistence must block sends')
    await act(async () => resolvePersist?.())
    assert.ok(dom.window.document.querySelector('[data-ready-action-authorization-mode="ask"]'))

    let rejectPersist: ((error: Error) => void) | null = null
    persistMode = () => new Promise<void>((_resolve, reject) => { rejectPersist = reject })
    const askTrigger = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-mode="ask"]',
    )
    assert.ok(askTrigger)
    await act(async () => askTrigger.click())
    const rejectedAuto = dom.window.document.querySelector<HTMLElement>(
      '[data-ready-action-authorization-option="auto"]',
    )
    assert.ok(rejectedAuto)
    act(() => rejectedAuto.click())
    assert.equal(textarea?.disabled, true)
    await act(async () => rejectPersist?.(new Error('persist failed')))
    assert.ok(dom.window.document.querySelector('[data-ready-action-authorization-mode="ask"]'))
    assert.equal(textarea?.disabled, false)
    act(() => sendButton?.click())
    assert.equal(sends, 3, 'failed persistence restores sending under the old mode')

    await act(async () => root.render(createElement(Harness, {
      isStreaming: true,
      lifecycleInputBlocked: true,
    })))
    const retryStopButton = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-stop="true"]')
    assert.equal(retryStopButton?.disabled, false)
    act(() => retryStopButton?.click())
    assert.equal(stops, 1, 'an interrupt-unknown run must keep the stop retry enabled')

    await act(async () => root.render(createElement(Harness, {
      isStreaming: true,
      lifecycleInputBlocked: true,
      stopPending: true,
      stopError: '停止失败，请重试',
    })))
    const stopButton = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-stop="true"]')
    assert.equal(stopButton?.disabled, true)
    assert.equal(stopButton?.getAttribute('aria-busy'), 'true')
    assert.equal(stopButton?.getAttribute('aria-label'), '正在停止')
    assert.equal(stopButton?.style.opacity, '0.62')
    assert.match(
      dom.window.document.querySelector('[data-ready-agent-stop-error="true"]')?.textContent || '',
      /停止失败，请重试/,
    )
    act(() => stopButton?.click())
    assert.equal(stops, 1, 'pending stop must not dispatch a duplicate click')

    await act(async () => root.render(createElement(Harness, { admissionReady: false })))
    const blockedSend = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')
    assert.equal(blockedSend?.disabled, true)
    assert.equal(blockedSend?.getAttribute('data-ready-agent-send-blocked'), '还没有可用的对话，请稍候或新建对话')
    assert.equal(blockedSend?.style.opacity, '0.38')
    act(() => blockedSend?.click())
    assert.equal(sends, 3, 'unready composer must not send')

    await act(async () => root.render(createElement(Harness)))
    const idleSend = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')
    assert.equal(idleSend?.disabled, false)
    assert.equal(idleSend?.getAttribute('data-ready-agent-send-blocked'), null)
    assert.equal(idleSend?.style.opacity, '1')

    await act(async () => root.render(createElement(Harness, { inputValue: '' })))
    const emptySend = dom.window.document.querySelector<HTMLButtonElement>('[data-ready-agent-send="true"]')
    assert.equal(emptySend?.disabled, true)
    assert.equal(emptySend?.getAttribute('data-ready-agent-send-blocked'), null)
    assert.equal(emptySend?.style.opacity, '1', 'empty composer must stay solid; only unready/unavailable fades')
  } finally {
    await act(async () => root.unmount())
    Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
    Object.defineProperty(globalThis, 'Node', { value: previousNode, configurable: true })
    Object.defineProperty(globalThis, 'HTMLElement', { value: previousHTMLElement, configurable: true })
    Object.defineProperty(globalThis, 'ResizeObserver', { value: previousResizeObserver, configurable: true })
    Object.defineProperty(globalThis, 'requestAnimationFrame', { value: previousRequestAnimationFrame, configurable: true })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: previousCancelAnimationFrame, configurable: true })
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: previousActEnvironment, configurable: true })
    dom.window.close()
  }
})
