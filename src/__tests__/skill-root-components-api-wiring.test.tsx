import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { AskUserQuestionsCard } from '../renderer/components/agent/AskUserQuestionsCard'
import SkillAskUserPrompt from '../renderer/components/skill/SkillAskUserPrompt'
import SkillInlinedToast from '../renderer/components/skill/SkillInlinedToast'
import { ToastHost } from '../renderer/components/ui'

type TestGlobal = typeof globalThis & Record<string, unknown>

function installDom() {
  const dom = new JSDOM('<!doctype html><div data-liquid-scroll-root="chat-messages"><div id="root"></div><div data-chat-bottom-overlay-spacer="true"></div></div>', {
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
	          onAskUserCleared: () => () => undefined,
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
	    const chatRoot = handle.dom.window.document.querySelector('[data-liquid-scroll-root="chat-messages"]') as HTMLElement | null
	    const anchor = handle.dom.window.document.querySelector('[data-skill-ask-user-anchor="true"]') as HTMLElement | null
	    const spacer = handle.dom.window.document.querySelector('[data-chat-bottom-overlay-spacer="true"]') as HTMLElement | null
	    assert.ok(prompt)
	    assert.ok(chatRoot?.contains(prompt), 'skill ask-user prompt should render inside the chat message stream')
	    assert.equal(prompt.parentElement, anchor, 'skill ask-user prompt should stay in its chat-owned anchor')
	    assert.equal(anchor?.parentElement, handle.rootElement)
	    assert.equal(handle.rootElement.parentElement, chatRoot)
	    assert.equal(handle.rootElement.nextElementSibling, spacer, 'chat-owned prompt sits before the composer spacer')
	    assert.equal(anchor?.getAttribute('aria-hidden'), null)
	    assert.notEqual(prompt.style.position, 'fixed')
    assert.equal(prompt.style.zIndex, '')
    assert.equal(prompt.style.width, '100%')
    assert.equal(prompt.style.maxWidth, '100%')
    assert.match(prompt.style.maxHeight, /calc\(100vh - 220px\)/)
    assert.equal(prompt.getAttribute('role'), 'group')
    const scrollBody = handle.dom.window.document.querySelector('[data-skill-ask-user-scroll-body="true"]') as HTMLElement | null
    assert.ok(scrollBody)
    assert.equal(scrollBody.style.overflowY, 'auto')

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

test('SkillAskUserPrompt reconciles a pending question when the IPC push is missed', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    let pending: Array<Record<string, unknown>> = []
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        skills: {
          listPendingAskUser: async () => pending,
          onAskUserQuestion: () => () => undefined,
          onAskUserCleared: () => () => undefined,
          submitAskUserAnswer: async () => ({ success: true }),
        },
      },
    })

    root = createRoot(handle.rootElement)
    await act(async () => {
      root?.render(createElement(SkillAskUserPrompt))
    })
    await flush()
    assert.doesNotMatch(handle.dom.window.document.body.textContent || '', /授权完成了吗/)

    pending = [{
      executionId: 'ask-late',
      sessionId: 'session-1',
      skillId: 'lark-cli',
      question: '授权完成了吗',
      options: ['已完成'],
      placeholder: null,
      askedAt: 2,
    }]
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 550))
    })

    assert.match(handle.dom.window.document.body.textContent || '', /授权完成了吗/)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})

test('SkillAskUserPrompt keeps long option lists scrollable and gives clicked options immediate feedback', async () => {
  const handle = installDom()
  let root: Root | null = null
  let releaseSubmit: (() => void) | null = null
  try {
    const options = Array.from({ length: 18 }, (_, index) => `选项 ${index + 1}`)
    Object.defineProperty(handle.dom.window, 'electronAPI', {
      configurable: true,
      value: {
        skills: {
          listPendingAskUser: async () => [{
            executionId: 'ask-long',
            sessionId: 'session-1',
            skillId: 'hfp-space-design',
            question: '请选择更贴近当前空间方案的触点、主推产品和目标优先级。',
            options,
            placeholder: null,
            askedAt: 1,
          }],
          onAskUserQuestion: () => () => undefined,
          onAskUserCleared: () => () => undefined,
          submitAskUserAnswer: async () => new Promise<{ success: boolean }>((resolve) => {
            releaseSubmit = () => resolve({ success: true })
          }),
        },
      },
    })

    root = createRoot(handle.rootElement)
    await act(async () => {
      root?.render(createElement(SkillAskUserPrompt))
    })
    await flush()

    const prompt = handle.dom.window.document.querySelector('[aria-label="Skill clarification"]') as HTMLElement | null
    const scrollBody = handle.dom.window.document.querySelector('[data-skill-ask-user-scroll-body="true"]') as HTMLElement | null
    assert.ok(prompt)
    assert.ok(scrollBody)
    assert.match(prompt.style.maxHeight, /calc\(100vh - 220px\)/)
    assert.equal(prompt.style.display, 'flex')
    assert.equal(scrollBody.style.overflowY, 'auto')

    const option = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent === '选项 12') as HTMLButtonElement | undefined
    assert.ok(option)
    await act(async () => {
      option.click()
      await Promise.resolve()
    })

    assert.equal(option.getAttribute('aria-pressed'), 'true')
    // The selected look is the option row's pressed state in skill-ask-user.css (tokens only), not an inline colour.
    assert.ok(option.classList.contains('skill-ask-user__option'))

    await act(async () => {
      releaseSubmit?.()
      await Promise.resolve()
    })
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
      // The note is one line of the shared toast (W1 §5): the host renders it.
      root?.render(createElement('div', null, createElement(SkillInlinedToast), createElement(ToastHost)))
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

test('AskUserQuestionsCard keeps multi-question answers in one paged card and submits once', async () => {
  const handle = installDom()
  let root: Root | null = null
  let submitted: Array<{ id: string; answer: string | string[] }> | null = null
  try {
    const card = {
      type: 'ask_user_questions' as const,
      cardId: 'auq-test',
      status: 'pending' as const,
      askedAt: '2026-06-26T00:00:00.000Z',
      questions: [
        { id: 'touchpoint', question: '触点类型？', kind: 'single_choice' as const, options: ['快闪店', '线下门店'], placeholder: null, required: true },
        { id: 'goal', question: '核心目标？', kind: 'single_choice' as const, options: ['试用', '成交'], placeholder: null, required: true },
      ],
    }

    root = createRoot(handle.rootElement)
    await act(async () => {
      root?.render(createElement(AskUserQuestionsCard, {
        card,
        onSubmit: async (_cardId: string, answers: Array<{ id: string; answer: string | string[] }>) => {
          submitted = answers
          return { success: true }
        },
        onCancel: async () => ({ success: true }),
      }))
    })
    await flush()

    assert.match(handle.dom.window.document.body.textContent || '', /Agent 反问 · 1\/2/)
    const firstOption = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent === '快闪店') as HTMLButtonElement | undefined
    assert.ok(firstOption)
    await act(async () => {
      firstOption.click()
      await Promise.resolve()
    })

    assert.match(handle.dom.window.document.body.textContent || '', /Agent 反问 · 1\/2/, 'single choice must not auto-advance')
    const submitButton = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent === '提交回答') as HTMLButtonElement | undefined
    assert.ok(submitButton)
    assert.equal(submitButton.disabled, true, 'submit remains disabled until all required questions are answered')

    const nextButton = handle.dom.window.document.querySelector('button[aria-label="下一题"]') as HTMLButtonElement | null
    assert.ok(nextButton)
    assert.equal(nextButton.disabled, false, 'next is available for browsing even before submit is enabled')
    await act(async () => {
      nextButton.click()
      await Promise.resolve()
    })
    assert.match(handle.dom.window.document.body.textContent || '', /Agent 反问 · 2\/2/)

    const secondOption = Array.from(handle.dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent === '成交') as HTMLButtonElement | undefined
    assert.ok(secondOption)
    await act(async () => {
      secondOption.click()
      await Promise.resolve()
    })
    assert.equal(submitButton.disabled, false)

    await act(async () => {
      submitButton.click()
      await Promise.resolve()
    })
    assert.deepEqual(submitted, [
      { id: 'touchpoint', answer: '快闪店' },
      { id: 'goal', answer: '成交' },
    ])
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})

test('submitted AskUserQuestionsCard is frameless and aligns its expanded answers', async () => {
  const handle = installDom()
  let root: Root | null = null
  try {
    root = createRoot(handle.rootElement)
    await act(async () => {
      root?.render(createElement(AskUserQuestionsCard, {
        card: {
          type: 'ask_user_questions' as const,
          cardId: 'auq-submitted-layout',
          status: 'submitted' as const,
          askedAt: '2026-07-23T00:00:00.000Z',
          questions: [
            {
              id: 'room',
              question: '请选择会议室',
              kind: 'single_choice' as const,
              options: ['保利世贸G座-1105-1'],
              placeholder: null,
              required: true,
            },
          ],
          answers: [{ id: 'room', answer: '保利世贸G座-1105-1' }],
        },
        onSubmit: async () => ({ success: true }),
        onCancel: async () => ({ success: true }),
      }))
    })
    await flush()

    const card = handle.dom.window.document.querySelector(
      '[data-ready-ask-user-card="submitted"]',
    ) as HTMLElement | null
    assert.ok(card)
    assert.equal(card.style.border, '')
    assert.equal(card.style.background, '')
    assert.equal(card.style.padding, '')
    assert.equal(card.style.width, '100%')
    assert.equal(card.style.boxSizing, 'border-box')

    const toggle = Array.from(card.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('展开')) as HTMLButtonElement | undefined
    assert.ok(toggle)
    await act(async () => {
      toggle.click()
      await Promise.resolve()
    })

    const summary = card.querySelector('[data-ready-ask-user-summary-list="true"]') as HTMLElement | null
    assert.ok(summary)
    assert.equal(summary.style.width, '100%')
    assert.equal(summary.style.paddingLeft, '22px')
    assert.equal(summary.style.listStyle, 'none')
    assert.ok(summary.classList.contains('ready-ask-user-summary-list'))
    assert.match(summary.textContent || '', /保利世贸G座-1105-1/)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    handle.restore()
  }
})
