import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { taskProjectionToTaskCardRun } from '../renderer/components/agent/task-card-from-projection'
import { TaskCard } from '../renderer/components/agent/chat-panel/task/TaskCard'

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Event: (globalThis as { Event?: typeof Event }).Event,
    MouseEvent: (globalThis as { MouseEvent?: typeof MouseEvent }).MouseEvent,
    Element: (globalThis as { Element?: typeof Element }).Element,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
  }

  function setGlobal<K extends keyof typeof previous>(key: K, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }

  setGlobal('window', dom.window)
  setGlobal('document', dom.window.document)
  setGlobal('HTMLElement', dom.window.HTMLElement)
  setGlobal('Node', dom.window.Node)
  setGlobal('Event', dom.window.Event)
  setGlobal('MouseEvent', dom.window.MouseEvent)
  setGlobal('Element', dom.window.Element)
  setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 0
  })
  setGlobal('cancelAnimationFrame', () => undefined)
  setGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))

  return {
    dom,
    restore: () => {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const previousValue = previous[key]
        if (previousValue === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key as string]
        } else {
          Object.defineProperty(globalThis, key, {
            value: previousValue,
            configurable: true,
            writable: true,
          })
        }
      }
      try { dom.window.close() } catch { /* silent-catch: jsdom close best-effort */ }
    },
  }
}

const domHandle = installDomGlobals()
process.on('exit', () => {
  try { domHandle.restore() } catch { /* silent-catch: best-effort restore */ }
})

function mount(element: ReactElement): { container: HTMLElement; root: Root; unmount: () => void } {
  const host = globalThis.document.getElementById('root')
  if (!host) throw new Error('jsdom root element missing')
  host.innerHTML = ''
  const container = globalThis.document.createElement('div')
  host.appendChild(container)
  const root = createRoot(container)
  flushSync(() => {
    root.render(element)
  })
  return {
    container,
    root,
    unmount: () => {
      try { root.unmount() } catch { /* silent-catch: unmount best-effort */ }
      try { host.removeChild(container) } catch { /* silent-catch: detach best-effort */ }
    },
  }
}

test('TaskCard renders only exact child-run continue action for suspended child runs', () => {
  const continueChildCalls: Array<[string, string]> = []
  const resumeCalls: string[] = []
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-1',
    taskId: 'skill-child:child-1',
    phase: 'checkpoint',
    terminalReason: undefined,
    title: '视频分析会话',
    taskTitle: '继续视频分析',
    taskSummary: '等待继续生成报告',
    steps: [],
    currentStepId: null,
    waitingFor: 'agent_result',
    resumableActions: ['continue', 'cancel'],
    recentArtifacts: [],
    taskContinuation: {
      taskId: 'skill-child:child-1',
      childRunId: 'child-1',
      skillId: 'video-expert-analyzer',
      action: 'continue',
    },
    progress: null,
    memoryCapture: null,
    taskType: 'continuation',
    interactionState: 'suspended',
    canResume: true,
    blockedReason: null,
    error: null,
    updatedAt: '2026-05-27T00:00:00.000Z',
    toolTrace: [],
  })

  const rendered = mount(createElement(TaskCard, {
    run,
    taskKey: 'scope-1:child-1',
    expanded: true,
    onContinueChildRun: (scopeId, childRunId) => {
      continueChildCalls.push([scopeId, childRunId])
    },
    onResumeRun: (scopeId) => {
      resumeCalls.push(scopeId)
    },
  }))

  try {
    const buttons = Array.from(rendered.container.querySelectorAll('button'))
    const labels = buttons.map((button) => button.textContent?.trim() || '')
    assert.equal(labels.includes('继续运行'), false)
    const continueButton = buttons.find((button) => {
      const label = button.textContent?.trim() || ''
      return label === '继续处理' || label === '继续生成报告'
    })
    assert.ok(continueButton, `expected exact child-run continue button, saw ${JSON.stringify(labels)}`)
    continueButton.click()
    assert.deepEqual(continueChildCalls, [['scope-1', 'child-1']])
    assert.deepEqual(resumeCalls, [])
  } finally {
    rendered.unmount()
  }
})

test('TaskCard hides interaction badge for terminal failed runs', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-1',
    taskId: 'task-failed',
    status: 'failed',
    phase: 'done',
    terminalReason: 'adjudication_degraded',
    title: '文档任务失败',
    taskTitle: '文档任务失败',
    taskSummary: '文档已经修改但保存目标不明确',
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['retry'],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    memoryCapture: null,
    taskType: 'multi_step_task',
    interactionState: 'suspended',
    canResume: false,
    blockedReason: null,
    error: 'adjudication_degraded',
    updatedAt: '2026-06-17T00:00:00.000Z',
    toolTrace: [],
  })

  const rendered = mount(createElement(TaskCard, {
    run,
    taskKey: 'scope-1:task-failed',
    expanded: true,
  }))

  try {
    assert.equal(rendered.container.textContent?.includes('已暂停'), false)
    assert.match(rendered.container.textContent || '', /文档任务失败/)
  } finally {
    rendered.unmount()
  }
})

test('TaskCard does not render supplement actions for blocked_config terminal runs', () => {
  const run = taskProjectionToTaskCardRun({
    scopeId: 'scope-blocked-config',
    taskId: 'task-blocked-config',
    status: 'failed',
    phase: 'done',
    terminalReason: 'blocked_config',
    title: '图片请求失败',
    taskTitle: '图片请求失败',
    taskSummary: '当前模型或配置不支持这次请求，请切换模型、修复设置或移除不支持的附件后重新发送。',
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: [],
    recentArtifacts: [],
    taskContinuation: null,
    progress: null,
    memoryCapture: null,
    taskType: 'short_task',
    interactionState: 'suspended',
    canResume: false,
    blockedReason: '当前模型或配置不支持这次请求，请切换模型、修复设置或移除不支持的附件后重新发送。',
    error: 'blocked_config',
    updatedAt: '2026-06-21T10:04:28.238Z',
    toolTrace: [],
  })

  const rendered = mount(createElement(TaskCard, {
    run,
    taskKey: 'scope-blocked-config:task-blocked-config',
    expanded: true,
  }))

  try {
    const text = rendered.container.textContent || ''
    const labels = Array.from(rendered.container.querySelectorAll('button'))
      .map((button) => button.textContent?.trim() || '')
    assert.match(text, /失败/)
    assert.match(text, /当前模型或配置不支持/)
    assert.equal(text.includes('等补充'), false)
    assert.equal(labels.includes('补充后继续'), false)
    assert.equal(labels.includes('继续运行'), false)
    assert.equal(labels.includes('重试'), false)
  } finally {
    rendered.unmount()
  }
})
