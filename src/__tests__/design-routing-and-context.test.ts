import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { buildComposedAgentInput } from '../renderer/modules/agent/messageComposer'
import { buildDesignIntentPlan } from '../main/modules/claude-bridge/design-intent-planner'
import { mergeDesignPlannerIntoToolInput } from '../main/modules/claude-bridge/design-tool-input'
import {
  shouldForceDesignToolCall,
  shouldForceDocumentToolCall,
  inferPreferredDesignTool,
  shouldAllowMultipleDesignArtifacts,
  shouldPreferFormatOnly,
} from '../main/modules/claude-bridge/tool-policy-heuristics'
import { getDesignOpenAITools } from '../main/modules/tools/design-tools'
import { hashDesignSnapshot } from '../renderer/modules/design/layout-digest'
import { useMode } from '../renderer/stores/useMode'
import { useDesignSession } from '../renderer/stores/useDesignSession'

function resetDesignContext() {
  useMode.setState((state) => ({
    ...state,
    appMode: 'workbench',
    workbenchMode: 'browser',
    splitMode: null,
  }))
  useDesignSession.getState().reset()
}

afterEach(() => {
  resetDesignContext()
  delete (globalThis as { window?: unknown }).window
})

describe('design routing and context', () => {
  it('injects active design context and design project references into composed agent input', async () => {
    resetDesignContext()
    useMode.getState().setWorkbenchMode('design')
    useDesignSession.getState().setActiveFile('/tmp/cover-layout.tldr')
    useDesignSession.getState().markDirty()
    useDesignSession.getState().setSnapshotMeta({
      snapshotHash: 'tldr-cover123',
      selectionSummary: '已选中 4 个元素',
      selectedElementCount: 4,
      selectionBounds: { x: 24, y: 40, w: 320, h: 480 },
      layoutDigest: {
        topLevelElementCount: 6,
        mainBounds: { x: 0, y: 0, w: 540, h: 960 },
        regions: [{ id: 'hero', type: 'ui-text-block', label: 'Hero', x: 0, y: 0, w: 540, h: 280 }],
        selectionSummary: '已选中 4 个元素',
        selectedElementCount: 4,
        selectionBounds: { x: 24, y: 40, w: 320, h: 480 },
        latestReviewSummary: '上次校验通过，未发现越界',
      },
      currentToolContext: 'select',
      latestReviewSummary: '上次校验通过，未发现越界',
      repairScope: 'selected',
    })

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

    const withActiveContext = await buildComposedAgentInput({
      content: '在画板新建一个竖向 9:16 的小红书封面版式',
      attachments: [],
      filePool: [],
    })
    assert.equal(typeof withActiveContext, 'string')
    assert.match(String(withActiveContext), /### 当前设计画布上下文/)
    assert.match(String(withActiveContext), /布局摘要JSON/)
    assert.match(String(withActiveContext), /优先调用 design_\* 工具/)

    const withDesignAttachment = await buildComposedAgentInput({
      content: '参考这个设计稿继续做封面',
      attachments: [{
        id: 'attach-design',
        name: 'cover-layout.tldr',
        path: 'design-project://cover-layout',
        type: 'text',
        size: 0,
        ext: '.tldr',
        source: 'design-project',
        dirty: true,
        saveStatus: 'idle',
        snapshotHash: 'tldr-cover123',
        selectionSummary: '已选中 4 个元素',
        selectedElementCount: 4,
        selectionBounds: { x: 24, y: 40, w: 320, h: 480 },
        currentToolContext: 'select',
        layoutDigest: {
          topLevelElementCount: 6,
          mainBounds: { x: 0, y: 0, w: 540, h: 960 },
          regions: [{ id: 'hero', type: 'ui-text-block', label: 'Hero', x: 0, y: 0, w: 540, h: 280 }],
          selectionSummary: '已选中 4 个元素',
          selectedElementCount: 4,
          selectionBounds: { x: 24, y: 40, w: 320, h: 480 },
          latestReviewSummary: '上次校验通过，未发现越界',
        },
        latestReviewSummary: '上次校验通过，未发现越界',
        repairScope: 'selected',
      }],
      filePool: [],
    })
    assert.equal(typeof withDesignAttachment, 'string')
    assert.match(String(withDesignAttachment), /### 当前设计画布上下文/)
    assert.match(String(withDesignAttachment), /大板块/)
    assert.match(String(withDesignAttachment), /设计画布引用，不是文档/)
  })

  it('forces design tools for cover layout requests instead of document formatting tools', () => {
    const prompt = '在画板新建一个竖向 9:16 的小红书封面版式，要有 4 组文案信息，给我一个排版很好的框架让我直接替换内容就行'

    assert.equal(shouldForceDesignToolCall(prompt), true)
    assert.equal(shouldForceDocumentToolCall(prompt), false)
    assert.equal(inferPreferredDesignTool(prompt), 'design_run_task_controller')
    assert.equal(shouldAllowMultipleDesignArtifacts(prompt), false)
    assert.equal(shouldPreferFormatOnly(prompt), false)

    const tools = getDesignOpenAITools() as Array<{ function?: { name?: string } }>

    const names = tools
      .map((tool) => tool.function?.name || '')
      .filter(Boolean)

    assert.ok(names.length > 0)
    assert.ok(names.every((name) => name.startsWith('design_')))
    assert.ok(names.includes('design_run_task_controller'))
  })

  it('still extracts the design instruction from bootstrapped scope context and doc context noise', () => {
    const prompt = [
      '## L1 会话上下文',
      '## 当前 Scope',
      '- 标题: ou_7d43ed7827aadeea10b1023d57f8ecac',
      '- 来源: channel',
      '- 线程: oc_781d9949106',
      '',
      '## 最近会话摘要',
      '用户: 帮我继续做设计画板',
      '助手: 我先看一下当前内容',
      '',
      '在画板新建一个竖向 9:16 的小红书封面版式，要有 4 组文案信息，给我一个排版很好的框架让我直接替换内容就行',
      '',
      '### 当前文档上下文',
      '- 标签: Draft',
      '- 文件: /tmp/demo.md',
    ].join('\n')

    assert.equal(shouldForceDesignToolCall(prompt), true)
    assert.equal(shouldForceDocumentToolCall(prompt), false)
    assert.equal(inferPreferredDesignTool(prompt), 'design_run_task_controller')
    assert.equal(shouldPreferFormatOnly(prompt), false)
  })

  it('detects when the user explicitly asks for multiple design variants', () => {
    const prompt = '在画板给我 3 个不同方向的小红书封面版本，做成 A/B/C 三套版式'
    assert.equal(shouldForceDesignToolCall(prompt), true)
    assert.equal(shouldAllowMultipleDesignArtifacts(prompt), true)
  })

  it('forces design tools for in-context revision prompts without requiring create verbs', () => {
    const prompt = [
      '### 当前设计画布上下文',
      '- 当前文件: /tmp/cover-layout.tldr',
      '- 布局摘要JSON: {"topLevelElementCount":8,"mainBounds":{"x":0,"y":0,"w":540,"h":960},"regions":[],"selectionSummary":"未选中元素"}',
      '',
      '标题再偏左一点，不要按钮，底部轻一点。',
    ].join('\n')

    assert.equal(shouldForceDesignToolCall(prompt), true)
    assert.equal(shouldForceDocumentToolCall(prompt), false)
    assert.equal(inferPreferredDesignTool(prompt), 'design_run_task_controller')
    assert.equal(shouldAllowMultipleDesignArtifacts(prompt), false)
  })

  it('forces design tools for follow-up cover prompts that say 再来一个 without explicit 画板 wording', () => {
    const shortCover = '再来一个竖向的youtube short 封面'
    const greenCover = '再来一个绿色主题的竖向 3:4 的封面，只有标题和子标题、账号名三个信息'
    const wideCover = '生成一个 1920x1080 的 youtube 封面排版，红色主题，加一点对色，有两级排版结构'
    const sparseFollowUp = '换一个版式，只有标题和标题旁边的附加信息，字要更大'

    assert.equal(shouldForceDesignToolCall(shortCover), true)
    assert.equal(inferPreferredDesignTool(shortCover), 'design_run_task_controller')

    assert.equal(shouldForceDesignToolCall(greenCover), true)
    assert.equal(inferPreferredDesignTool(greenCover), 'design_run_task_controller')

    assert.equal(shouldForceDesignToolCall(wideCover), true)
    assert.equal(inferPreferredDesignTool(wideCover), 'design_run_task_controller')

    assert.equal(shouldForceDesignToolCall(sparseFollowUp), true)
    assert.equal(inferPreferredDesignTool(sparseFollowUp), 'design_run_task_controller')
  })

  it('ignores pure viewport or camera noise when hashing design snapshots', () => {
    const base = {
      document: {
        shapes: {
          'shape:1': { id: 'shape:1', type: 'text', x: 10, y: 20, props: { text: 'Title' } },
        },
      },
      session: { currentPageId: 'page:1' },
      camera: { x: 0, y: 0, z: 1 },
    }
    const movedViewport = {
      document: {
        shapes: {
          'shape:1': { id: 'shape:1', type: 'text', x: 10, y: 20, props: { text: 'Title' } },
        },
      },
      session: { currentPageId: 'page:1' },
      camera: { x: 480, y: 240, z: 1.25 },
    }
    const changedDocument = {
      document: {
        shapes: {
          'shape:1': { id: 'shape:1', type: 'text', x: 10, y: 20, props: { text: 'Title updated' } },
        },
      },
      session: { currentPageId: 'page:1' },
      camera: { x: 480, y: 240, z: 1.25 },
    }

    assert.equal(
      hashDesignSnapshot(base as never),
      hashDesignSnapshot(movedViewport as never),
    )
    assert.notEqual(
      hashDesignSnapshot(base as never),
      hashDesignSnapshot(changedDocument as never),
    )
  })

  it('merges planner hard constraints into the primary design tool input', () => {
    const planner = buildDesignIntentPlan({
      rawUserText: '在画板新建一个竖向 9:16 的小红书封面版式，要有 4 组文案信息',
      primaryInstruction: '在画板新建一个竖向 9:16 的小红书封面版式，要有 4 组文案信息',
    })
    const merged = mergeDesignPlannerIntoToolInput('design_run_task_controller', {
      ratio: '3:4',
      sectionCount: 2,
      typography: { titleFontSize: 28 },
    }, {
      preferredDesignTool: 'design_run_task_controller',
      designPlanner: planner,
      forceDesignTool: true,
    })

    assert.equal(merged.ratio, '9:16')
    assert.equal(merged.sectionCount, 4)
    assert.equal(merged.platform, 'xiaohongshu')
    assert.equal(merged.typography.titleFontSize, 28)
    assert.equal(merged.board.height, 960)
    assert.equal(merged.repairScope, 'selected')
    assert.ok(merged.brief)
    assert.ok(merged.styleSystem)
    assert.ok(merged.scenePlan)
    assert.ok(merged.styleGuide)
    assert.ok(merged.layoutBlueprint)
    assert.ok(merged.layoutBudget)
  })
})
