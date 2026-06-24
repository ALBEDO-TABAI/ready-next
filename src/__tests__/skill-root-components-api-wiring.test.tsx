import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import SkillAskUserPrompt from '../renderer/components/skill/SkillAskUserPrompt'
import SkillInlinedToast from '../renderer/components/skill/SkillInlinedToast'

type TestGlobal = typeof globalThis & Record<string, unknown>

function installDom() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: 'http://localhost/workbench',
    pretendToBeVisual: true,
  })
  const testGlobal = globalThis as TestGlobal
  const previous = {
    window: testGlobal.window,
    document: testGlobal.document,
    navigator: testGlobal.navigator,
    requestAnimationFrame: testGlobal.requestAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: testGlobal.IS_REACT_ACT_ENVIRONMENT,
  }

  testGlobal.window = dom.window
  testGlobal.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
  })
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true
  testGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)

  return {
    dom,
    rootElement: dom.window.document.getElementById('root') as HTMLElement,
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (key === 'navigator') {
          Object.defineProperty(globalThis, key, {
            value,
            configurable: true,
          })
        } else if (value === undefined) {
          Reflect.deleteProperty(testGlobal, key)
        } else {
          testGlobal[key] = value
        }
      }
      dom.window.close()
    },
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

test('SkillAskUserPrompt hydrates pending skill questions from electronAPI.skills', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let submitted: { executionId: string; answer: string } | null = null
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        skills: {
          listPendingAskUser: async () => [{
            executionId: 'ask-1',
            sessionId: 'session-1',
            skillId: 'video-expert-analyzer',
            question: '请选择要继续的任务',
            options: ['任务 A', '任务 B'],
            placeholder: null,
            askedAt: 1,
          }],
          onAskUserQuestion: () => () => undefined,
          submitAskUserAnswer: async (payload: { executionId: string; answer: string }) => {
            submitted = payload
            return { success: true }
          },
        },
      },
    })

    root = createRoot(handle.rootElement)
    await act(async () => {
      root?.render(createElement(SkillAskUserPrompt))
    })
    await flush()

    assert.match(handle.dom.window.document.body.textContent || '', /请选择要继续的任务/)
    assert.match(handle.dom.window.document.body.textContent || '', /任务 A/)
    const prompt = handle.dom.window.document.querySelector('[aria-label="Skill clarification"]') as HTMLElement | null
    assert.ok(prompt)
    assert.equal(prompt.style.position, 'fixed')
    assert.equal(prompt.style.zIndex, '1500')
    assert.match(prompt.style.width, /min\(560px/)
    assert.equal(prompt.style.pointerEvents, 'auto')
    assert.equal(prompt.getAttribute('role'), 'dialog')

    const option = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent === '任务 A') as HTMLButtonElement | undefined
    assert.ok(option)
    await act(async () => {
      option.click()
      await Promise.resolve()
    })

    assert.deepEqual(submitted, { executionId: 'ask-1', answer: '任务 A' })
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})

test('SkillInlinedToast subscribes to skill inline events from electronAPI.skills', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let push: ((event: {
      sessionId: string | null
      skillId: string
      skillName: string
      source: 'direct_read' | 'tool_fallback'
      bytesInjected: number
      truncated: boolean
      at: number
    }) => void) | null = null
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        skills: {
          onSkillReferenceInlined: (handler: typeof push) => {
            push = handler
            return () => {
              push = null
            }
          },
        },
      },
    })

    root = createRoot(handle.rootElement)
    await act(async () => {
      root?.render(createElement(SkillInlinedToast))
    })
    await act(async () => {
      push?.({
        sessionId: 'session-1',
        skillId: 'video-expert-analyzer',
        skillName: 'Video Expert Analyzer',
        source: 'direct_read',
        bytesInjected: 2048,
        truncated: false,
        at: 1,
      })
    })

    assert.match(handle.dom.window.document.body.textContent || '', /已加载技能/)
    assert.match(handle.dom.window.document.body.textContent || '', /Video Expert Analyzer/)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})
