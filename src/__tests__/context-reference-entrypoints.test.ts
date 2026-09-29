import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  buildSlashSkillInsertion,
  filterSlashSkills,
  type SkillMenuItem,
} from '../renderer/modules/agent/slash-skill-selection'
import {
  READY_FOCUS_CHAT_INPUT_EVENT,
  addDocumentQuoteReference,
  addReadyContextReferenceToAgentInput,
  createSkillReferenceAttachment,
  showBrowserTabContextMenu,
  showReferenceToInputMenu,
} from '../renderer/modules/agent/chat-input-bridge'
import { useAgent } from '../renderer/stores/useAgent'
import { useWorkspace } from '../renderer/stores/useWorkspace'

type TestWindow = Window & {
  electronAPI?: {
    ui?: {
      showNativeContextMenu?: (options: unknown) => Promise<{ success: boolean; selectedId?: string | null }>
    }
    browser?: {
      getTabContext?: (tabId: string) => Promise<{
        success: boolean
        data?: {
          title?: string
          url?: string
          heading?: string
          selection?: string
          excerpt?: string
          capturedAt?: number
        }
      }>
    }
  }
}

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' })
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousCustomEvent = globalThis.CustomEvent
  const previousEvent = globalThis.Event
  const previousKeyboardEvent = globalThis.KeyboardEvent

  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'CustomEvent', { value: dom.window.CustomEvent, configurable: true })
  Object.defineProperty(globalThis, 'Event', { value: dom.window.Event, configurable: true })
  Object.defineProperty(globalThis, 'KeyboardEvent', { value: dom.window.KeyboardEvent, configurable: true })

  return {
    dom,
    restore: () => {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { window?: Window }).window
      }
      if (previousDocument) {
        Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { document?: Document }).document
      }
      if (previousCustomEvent) {
        Object.defineProperty(globalThis, 'CustomEvent', { value: previousCustomEvent, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { CustomEvent?: typeof CustomEvent }).CustomEvent
      }
      if (previousEvent) {
        Object.defineProperty(globalThis, 'Event', { value: previousEvent, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { Event?: typeof Event }).Event
      }
      if (previousKeyboardEvent) {
        Object.defineProperty(globalThis, 'KeyboardEvent', { value: previousKeyboardEvent, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent
      }
      dom.window.close()
    },
  }
}

test('reference menus expose the input-reference action and preserve close-tab', async () => {
  const { restore } = installDom()
  try {
    let menuRequest: unknown = null
    ;(window as TestWindow).electronAPI = {
      ui: {
        showNativeContextMenu: async (options: unknown) => {
          menuRequest = options
          return { success: true, selectedId: 'reference-to-input' }
        },
      },
    }

    assert.equal(await showReferenceToInputMenu({ x: 12, y: 34 }), true)
    assert.deepEqual(menuRequest, {
      x: 12,
      y: 34,
      items: [{ id: 'reference-to-input', label: '引用到输入框', iconText: '@' }],
    })

    ;(window as TestWindow).electronAPI = {
      ui: {
        showNativeContextMenu: async (options: unknown) => {
          menuRequest = options
          return { success: true, selectedId: 'close-tab' }
        },
      },
    }
    assert.equal(await showBrowserTabContextMenu({ x: 5, y: 6 }), 'close-tab')
    assert.deepEqual((menuRequest as { items: Array<{ id: string }> }).items.map((item) => item.id), [
      'reference-to-input',
      'close-tab',
    ])

    ;(window as TestWindow).electronAPI = {
      ui: {
        showNativeContextMenu: async () => ({ success: true, selectedId: 'other-item' }),
      },
    }
    assert.equal(await showReferenceToInputMenu({ x: 1, y: 2 }), false)
  } finally {
    restore()
  }
})

test('browser, draft document, calendar and skill references become identity-preserving attachments', async () => {
  const { restore } = installDom()
  try {
    useAgent.setState({ sessions: {}, attachments: [], filePool: [], inputValue: '' })
    useWorkspace.setState({ chatPanelVisible: false })
    let focusEvents = 0
    window.addEventListener(READY_FOCUS_CHAT_INPUT_EVENT, () => {
      focusEvents += 1
    })

    await addReadyContextReferenceToAgentInput({
      type: 'browser-tab',
      name: 'Fallback',
      tabId: 'tab-1',
    })
    await addReadyContextReferenceToAgentInput({
      type: 'doc-tab',
      name: 'Draft',
      tabId: 'doc-1',
      content: 'Draft body',
      dirty: true,
    })
    await addReadyContextReferenceToAgentInput({
      type: 'calendar-event',
      name: 'Launch',
      eventId: 'event-1',
      startTime: '2026-05-18T10:00:00.000Z',
      endTime: '2026-05-18T11:00:00.000Z',
      calendarId: 'work',
      description: 'Ship it',
    })
    await addReadyContextReferenceToAgentInput({
      type: 'skill-folder',
      name: 'Image Router',
      path: '/skills/image-analysis-router',
      skillId: 'image-analysis-router',
      description: 'Routes image tasks',
    })

    const attachments = useAgent.getState().attachments
    assert.equal(useWorkspace.getState().chatPanelVisible, true)
    assert.equal(focusEvents, 4)
    assert.equal(attachments.length, 4)
    assert.deepEqual(attachments.map((attachment) => attachment.source), [
      'browser-tab',
      'document-tab',
      'calendar-event',
      'skill-folder',
    ])
    assert.equal(attachments[0]?.browserTabId, 'tab-1')
    assert.equal(attachments[0]?.excerpt, undefined)
    assert.equal(attachments[1]?.selection, 'Draft body')
    assert.equal(attachments[2]?.eventId, 'event-1')
    assert.equal(attachments[3]?.skillId, 'image-analysis-router')
    assert.equal(attachments[3]?.skillFolderPath, '/skills/image-analysis-router')
  } finally {
    useAgent.setState({ sessions: {}, attachments: [], filePool: [], inputValue: '' })
    useWorkspace.setState({ chatPanelVisible: true })
    restore()
  }
})

test('file and folder references become local-path agent attachments and open the chat panel', async () => {
  const { restore } = installDom()
  try {
    useAgent.setState({ sessions: {}, attachments: [], filePool: [], inputValue: '' })
    useWorkspace.setState({ chatPanelVisible: false })
    let focusEvents = 0
    window.addEventListener(READY_FOCUS_CHAT_INPUT_EVENT, () => {
      focusEvents += 1
    })

    await addReadyContextReferenceToAgentInput({
      type: 'file',
      name: 'report.md',
      path: '/workspace/report.md',
      size: 2048,
    })
    await addReadyContextReferenceToAgentInput({
      type: 'file',
      name: 'assets',
      path: '/workspace/assets',
      isDirectory: true,
    })

    const attachments = useAgent.getState().attachments
    assert.equal(useWorkspace.getState().chatPanelVisible, true)
    assert.equal(focusEvents, 2)
    assert.equal(attachments.length, 2)
    assert.deepEqual(attachments.map((attachment) => attachment.source), ['file', 'file'])

    assert.equal(attachments[0]?.name, 'report.md')
    assert.equal(attachments[0]?.path, '/workspace/report.md')
    assert.equal(attachments[0]?.type, 'text')
    assert.equal(attachments[0]?.isDirectory, false)
    assert.equal(attachments[0]?.size, 2048)

    assert.equal(attachments[1]?.name, 'assets')
    assert.equal(attachments[1]?.path, '/workspace/assets')
    assert.equal(attachments[1]?.isDirectory, true)
    assert.equal(attachments[1]?.type, 'other')
  } finally {
    useAgent.setState({ sessions: {}, attachments: [], filePool: [], inputValue: '' })
    useWorkspace.setState({ chatPanelVisible: true })
    restore()
  }
})

test('document quote enters both the active composer and @ reference pool as user-selected text', () => {
  const { restore } = installDom()
  try {
    useAgent.setState({ sessions: {}, attachments: [], filePool: [], inputValue: '' })
    useWorkspace.setState({ chatPanelVisible: false })
    let focusEvents = 0
    window.addEventListener(READY_FOCUS_CHAT_INPUT_EVENT, () => {
      focusEvents += 1
    })

    addDocumentQuoteReference({
      title: '方案.md',
      path: '/workspace/方案.md',
      selection: '这一段需要 agent 能直接看到。',
      sectionTitle: '第二章',
      lineStart: 12,
      lineEnd: 14,
    })

    const state = useAgent.getState()
    assert.equal(useWorkspace.getState().chatPanelVisible, true)
    assert.equal(focusEvents, 1)
    assert.equal(state.attachments.length, 1)
    assert.equal(state.filePool.length, 1)
    assert.equal(state.attachments[0]?.source, 'document-quote')
    assert.equal(state.attachments[0]?.selection, '这一段需要 agent 能直接看到。')
    assert.equal(state.attachments[0]?.sectionTitle, '第二章')
    assert.equal(state.attachments[0]?.lineStart, 12)
    assert.equal(state.attachments[0]?.lineEnd, 14)
  } finally {
    useAgent.setState({ sessions: {}, attachments: [], filePool: [], inputValue: '' })
    useWorkspace.setState({ chatPanelVisible: true })
    restore()
  }
})

test('slash skill helpers rank matches and replace slash input with a skill reference', () => {
  const skills: SkillMenuItem[] = [
    {
      id: 'study-notes',
      name: 'Study Notes',
      description: 'Study note capture',
      installed: true,
      manifestValid: true,
    },
    {
      id: 'image-analysis-router',
      name: 'Image Router',
      description: 'Routes image tasks',
      installed: true,
      manifestValid: true,
      managedPath: '/skills/image-analysis-router',
      defaultAction: 'route',
    },
  ]

  assert.deepEqual(filterSlashSkills(skills, 'ima').map((skill) => skill.id), ['image-analysis-router'])
  assert.deepEqual(filterSlashSkills(skills, '').map((skill) => skill.id), ['image-analysis-router', 'study-notes'])
  assert.deepEqual(
    buildSlashSkillInsertion('请用 /ima', '请用 /ima'.length, 'Image Router'),
    { nextValue: '请用 @[Image Router]', cursorPosition: '请用 @[Image Router]'.length },
  )
  assert.equal(buildSlashSkillInsertion('没有斜杠', '没有斜杠'.length, 'Image Router'), null)
})

test('skill attachment falls back to a stable skill uri without a managed path', () => {
  const attachment = createSkillReferenceAttachment({
    type: 'skill-folder',
    name: 'Fast Note',
    skillId: 'fastnote',
    description: 'Capture notes',
  })
  assert.equal(attachment.source, 'skill-folder')
  assert.equal(attachment.path, 'skill://fastnote')
  assert.equal(attachment.skillFolderPath, 'skill://fastnote')
  assert.equal(attachment.excerpt, 'Capture notes')
})
