import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, useState } from 'react'
import { JSDOM } from 'jsdom'

import type { ChatAttachment } from '../renderer/modules/agent/types'

const reference: ChatAttachment = {
  id: 'pool-1', name: 'brief.md', path: '/tmp/brief.md', type: 'text', size: 12, ext: 'md',
}

function installDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const names = ['window', 'document', 'Node', 'HTMLElement', 'ResizeObserver', 'requestAnimationFrame',
    'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
  const values: Record<(typeof names)[number], unknown> = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true })
  Object.defineProperty(dom.window, 'electronAPI', {
    value: { skills: { list: async () => ({ success: true, data: [] }) } },
    configurable: true,
  })
  // The composer reads the theme store, which follows the system color scheme at load.
  Object.defineProperty(dom.window, 'matchMedia', {
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }),
    configurable: true,
  })
  return {
    dom,
    restore() {
      names.forEach((name, index) => {
        const descriptor = previous[index]
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete (globalThis as Record<string, unknown>)[name]
      })
      dom.window.close()
    },
  }
}

test('the composer toolbar has no undo or @ shortcut button, keeps the context meter, and @ typed in the text opens references', { timeout: 15_000 }, async () => {
  const { dom, restore } = installDom()
  // react-dom decides at load whether the DOM supports input events, so it loads after the DOM exists.
  const { createRoot } = await import('react-dom/client')
  const { default: ChatInput } = await import('../renderer/components/agent/ChatInput')
  const root = createRoot(dom.window.document.getElementById('root')!)
  const selected: ChatAttachment[] = []
  const values: string[] = []
  function Harness() {
    const [inputValue, setInputValue] = useState('')
    return createElement(ChatInput, {
      inputValue,
      attachmentsCount: 0,
      hasUserMessages: true,
      isDragOver: false,
      contextUsage: null,
      composerShellStyle: {},
      filePool: [reference],
      filePoolCount: 1,
      currentAgent: 'butler',
      currentAgentAvatar: 'R',
      currentAgentDisplayName: 'Ready',
      agents: [],
      actionAuthorizationMode: 'ask',
      onInputChange(value: string) {
        values.push(value)
        setInputValue(value)
      },
      onSend() {},
      onStop() {},
      onPickFiles() {},
      onAgentSelect() {},
      async onActionAuthorizationModeChange() {},
      onSkillReference() {},
      onReferenceSelect(file: ChatAttachment) { selected.push(file) },
      renderAttachmentIcon: () => null,
      ModelSelector: () => null,
      admissionReady: true,
    })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const document = dom.window.document
    const labelled = (text: string) => [...document.querySelectorAll('[title], [aria-label]')]
      .filter((node) => node.getAttribute('title') === text || node.getAttribute('aria-label') === text)
    assert.deepEqual(labelled('撤回上一条消息'), [], 'no undo-last-message button')
    assert.deepEqual(labelled('引用文件或文件夹'), [], 'no @ reference shortcut button')
    assert.ok(document.querySelector('[data-agent-context-usage-meter="true"]'), 'the context usage meter stays in the toolbar')

    const textarea = document.querySelector<HTMLTextAreaElement>('[data-ready-agent-input="true"]')!
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(textarea, '看看 @br')
      textarea.setSelectionRange(6, 6)
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    const option = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('brief.md'))
    assert.ok(option, 'typing @ in the text opens the file reference menu')
    await act(async () => option.click())
    assert.deepEqual(selected, [reference])
    assert.equal(values.at(-1), '看看 @[brief.md]')
  } finally {
    await act(async () => root.unmount())
    restore()
  }
})
