import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildComposedAgentInput } from '../renderer/modules/agent/messageComposer'
import { buildWidgetTargetUpdatePrompt, createDocumentWidgetTargetAttachment } from '../renderer/modules/agent/widget-target-attachment'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  useMode.setState({
    appMode: 'workbench',
    workbenchMode: 'browser',
    splitMode: null,
    workbenchSplitRatio: 50,
    readySubMode: 'browser',
  })
  useDocTabs.setState({
    tabs: [{ id: 'welcome', title: '未命名', path: null, content: '', isDirty: false }],
    activeTabId: 'welcome',
    splitTabId: null,
    documentSplitRatio: 50,
    pendingReveal: null,
  })
})

describe('document widget target context', () => {
  it('creates a compact widget update prompt for the chat input', () => {
    const prompt = buildWidgetTargetUpdatePrompt('stock_price_chart')
    assert.equal(prompt, '更新当前文档里的 stock_price_chart widget：')
  })

  it('creates a widget target attachment capsule', () => {
    const attachment = createDocumentWidgetTargetAttachment({
      documentTitle: '新文档.md',
      documentPath: '/Users/user/新文档.md',
      tabId: 'doc-1',
      widgetTitle: 'stock_price_chart',
      widgetId: 'widget_stock_price_chart',
      widgetCode: '<div>demo</div>',
      widgetMode: 'scripted',
    })

    assert.equal(attachment.source, 'document-widget-target')
    assert.equal(attachment.widgetTitle, 'stock_price_chart')
    assert.equal(attachment.documentTitle, '新文档.md')
    assert.equal(attachment.tabId, 'doc-1')
    assert.equal(attachment.widgetId, 'widget_stock_price_chart')
  })

  it('injects a structured widget update context block into composed agent input', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const attachment = createDocumentWidgetTargetAttachment({
      documentTitle: '新文档.md',
      documentPath: '/Users/user/新文档.md',
      tabId: 'doc-1',
      widgetTitle: 'stock_price_chart',
      widgetId: 'widget_stock_price_chart',
      widgetCode: '<div class="card">demo</div>',
      widgetMode: 'scripted',
    })

    const composed = await buildComposedAgentInput({
      content: '更新当前文档里的 stock_price_chart widget：把边框去掉',
      attachments: [attachment],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### Widget 更新上下文/)
    assert.match(String(composed), /目标 widget: stock_price_chart/)
    assert.match(String(composed), /标签页ID: doc-1/)
    assert.match(String(composed), /widgetId: widget_stock_price_chart/)
    assert.match(String(composed), /优先使用 document_update_widget/)
    assert.match(String(composed), /```show-widget/)
  })

  it('injects skill folder references without legacy slash commands', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const composed = await buildComposedAgentInput({
      content: '使用@[Video Expert Analyzer (VNext)]分析视频',
      attachments: [
        {
          id: 'skill-att-1',
          name: 'Video Expert Analyzer (VNext)',
          path: '/Users/user/Library/Application Support/ready/skill-runtime/skills/video-expert-analyzer',
          type: 'text',
          size: 0,
          ext: '.skill',
          source: 'skill-folder',
          skillId: 'video-expert-analyzer',
          skillFolderPath: '/Users/user/Library/Application Support/ready/skill-runtime/skills/video-expert-analyzer',
        },
      ],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### 技能目录引用/)
    assert.match(String(composed), /skillId: video-expert-analyzer/)
    assert.doesNotMatch(String(composed), /Library\/Application Support\/ready\/skill-runtime/)
    assert.match(String(composed), /不要把它当作普通 workspace 文件路径读取/)
    assert.doesNotMatch(String(composed), /\/skill video-expert-analyzer/)
  })

  it('does not duplicate an attached skill when the draft also mentions it', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const skillAttachment = {
      id: 'skill-att-1',
      name: 'Video Expert Analyzer (VNext)',
      path: '/Users/user/Library/Application Support/ready/skill-runtime/skills/video-expert-analyzer',
      type: 'text' as const,
      size: 0,
      ext: '.skill',
      source: 'skill-folder' as const,
      skillId: 'video-expert-analyzer',
      skillFolderPath: '/Users/user/Library/Application Support/ready/skill-runtime/skills/video-expert-analyzer',
    }

    const composed = await buildComposedAgentInput({
      content: '使用@[Video Expert Analyzer (VNext)]分析视频',
      attachments: [skillAttachment],
      filePool: [skillAttachment],
    })

    const text = String(composed)
    assert.equal((text.match(/### 技能目录引用/g) || []).length, 1)
    assert.doesNotMatch(text, /--- 引用技能目录:/)
    assert.doesNotMatch(text, /Library\/Application Support\/ready\/skill-runtime/)
  })

  it('injects skill pool mentions without exposing the local skill directory path', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const skillAttachment = {
      id: 'skill-att-2',
      name: 'okf-bundle',
      path: '/Users/user/Library/Application Support/ready/skill-runtime/custom-skills/okf-bundle',
      type: 'text' as const,
      size: 0,
      ext: '.skill',
      source: 'skill-folder' as const,
      skillId: 'okf-bundle',
      skillFolderPath: '/Users/user/Library/Application Support/ready/skill-runtime/custom-skills/okf-bundle',
    }

    const composed = await buildComposedAgentInput({
      content: '用@[okf-bundle]整理这些资料',
      attachments: [],
      filePool: [skillAttachment],
    })

    const text = String(composed)
    assert.match(text, /--- 引用技能目录: okf-bundle ---/)
    assert.match(text, /skillId: okf-bundle/)
    assert.match(text, /不要把它当作普通 workspace 文件路径读取/)
    assert.doesNotMatch(text, /Library\/Application Support\/ready\/skill-runtime/)
  })

  it('injects document tab and calendar event references into composed input', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const composed = await buildComposedAgentInput({
      content: '总结这两个引用',
      attachments: [
        {
          id: 'doc-tab-1',
          name: '会议纪要.md',
          path: '/tmp/会议纪要.md',
          type: 'text',
          size: 20,
          ext: '.md',
          source: 'document-tab',
          title: '会议纪要.md',
          documentTitle: '会议纪要.md',
          excerpt: '本周要确认浏览器引用和日程引用。',
          dirty: true,
        },
        {
          id: 'cal-1',
          name: '周会',
          path: 'calendar-event://event-1',
          type: 'text',
          size: 12,
          ext: '.calendar',
          source: 'calendar-event',
          title: '周会',
          eventId: 'event-1',
          startTime: '2026-05-18T09:00:00.000Z',
          endTime: '2026-05-18T10:00:00.000Z',
          calendarId: 'work',
          description: '同步 Ready 输入框引用能力。',
        },
      ],
      filePool: [],
    })

    const text = String(composed)
    assert.match(text, /--- 引用文件: 会议纪要\.md ---/)
    assert.match(text, /- 来源: 文档标签页/)
    assert.match(text, /本周要确认浏览器引用和日程引用/)
    assert.match(text, /### 日程事件引用/)
    assert.match(text, /- eventId: event-1/)
    assert.match(text, /同步 Ready 输入框引用能力/)
  })

  it('does not carry widget update context into unrelated plain questions', async () => {
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        settings: {
          getAIConfig: async () => ({ success: true, data: { provider: 'anthropic', baseUrl: 'https://api.example.com' } }),
        },
        chat: {
          readFileForAI: async () => ({ success: false, error: 'not used' }),
        },
      },
    }

    const attachment = createDocumentWidgetTargetAttachment({
      documentTitle: '新文档.md',
      documentPath: '/Users/user/新文档.md',
      tabId: 'doc-1',
      widgetTitle: 'stock_price_chart',
      widgetId: 'widget_stock_price_chart',
      widgetCode: '<div class="card">demo</div>',
      widgetMode: 'scripted',
    })

    const composed = await buildComposedAgentInput({
      content: '今天广州天气怎么样',
      attachments: [attachment],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /今天广州天气怎么样/)
    assert.doesNotMatch(String(composed), /### Widget 更新上下文/)
    assert.doesNotMatch(String(composed), /```show-widget/)
  })

  it('prefers active document content over generic environment text in document mode', async () => {
    useMode.getState().setWorkbenchMode('document')
    useDocTabs.setState({
      tabs: [
        {
          id: 'doc-1',
          title: '需求文档.md',
          path: '/tmp/需求文档.md',
          content: '这是当前文档的正文内容',
          isDirty: false,
        },
      ],
      activeTabId: 'doc-1',
      splitTabId: null,
      documentSplitRatio: 50,
      pendingReveal: null,
    })

    const composed = await buildComposedAgentInput({
      content: '总结当前文档',
      attachments: [],
      filePool: [],
    })

    assert.equal(typeof composed, 'string')
    assert.match(String(composed), /### 当前文档上下文/)
    assert.match(String(composed), /--- 文档摘要开始 ---/)
    assert.match(String(composed), /这是当前文档的正文内容/)
    assert.doesNotMatch(String(composed), /--- 文档内容开始 ---/)
    assert.doesNotMatch(String(composed), /## 环境信息\n- 当前模式: 文档模式/)
  })

  it('teaches the execution intent resolver to force document widget updates when the marker is present', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/main/modules/agent-control/execution-intent-resolver.ts'),
      'utf8',
    )

    assert.match(source, /const envelopeHasWidgetTarget = params\.requestEnvelope\.environmentHints\.hasWidgetTargetContext/)
    assert.match(source, /const hasWidgetTargetContext = envelopeHasWidgetTarget \|\| leaseStickyEligible/)
    assert.match(source, /const explicitWidgetCreateIntent = hasExplicitDocumentWidgetCreateIntent\(contextualUserInput\)/)
    assert.match(source, /hasWidgetTargetContext && !explicitWidgetCreateIntent[\s\S]*\? 'update'/)
    assert.match(source, /const allowDocumentTools = baseVisibilityPlan\.hasTools && \([\s\S]*params\.hasWidgetTargetContext[\s\S]*shouldForceDocumentToolCall\(params\.contextualUserInput\)/)
    assert.match(source, /forceDocumentTool:\s*allowDocumentTools && \([\s\S]*params\.hasWidgetTargetContext && !params\.explicitWidgetCreateIntent[\s\S]*shouldForceDocumentToolCall\(params\.contextualUserInput\)/)
  })
})
