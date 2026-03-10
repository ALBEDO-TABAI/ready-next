import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { executeDesignTool } from '../main/modules/tools/design-tools'
import { createDesignAgentHandler } from '../renderer/modules/design/design-agent-handler'
import { executeModuleToolAction, handleModuleToolAction } from '../renderer/modules/agent/moduleExecutor'
import { registerModuleAgentHandler } from '../renderer/utils/moduleAgentBridge'
import {
  DESIGN_CUSTOM_SHAPE_TYPES,
  allShapeUtils,
  allTools,
  designComponentCatalog,
  getComponentDefaults,
} from '../renderer/components/design/shapes'

type ShapeRecord = {
  id: string
  type: string
  x: number
  y: number
  props: Record<string, unknown>
  meta?: Record<string, unknown>
}

function hasUndefinedValue(record?: Record<string, unknown>): boolean {
  if (!record) return false
  return Object.values(record).some((value) => value === undefined)
}

class FakeDesignEditor {
  shapes = new Map<string, ShapeRecord>()
  selectedIds: string[] = []
  currentToolId = 'select'
  lastAlignCall: { ids: string[]; mode: string } | null = null
  lastDistributeCall: { ids: string[]; mode: string } | null = null
  lastUpdateBatch: Array<{ id: string; x?: number; y?: number }> = []
  lastZoomPadding = 0
  lastZOrderCall: { ids: string[]; mode: string } | null = null
  lastGroupCall: { ids: string[]; groupId: string } | null = null

  getViewportPageBounds() {
    return { x: 0, y: 0, w: 1200, h: 900 }
  }

  createShape(shape: ShapeRecord) {
    this.shapes.set(shape.id, {
      ...shape,
      props: { ...(shape.props || {}) },
      meta: { ...(shape.meta || {}) },
    })
  }

  setSelectedShapes(ids: string[]) {
    this.selectedIds = [...ids]
  }

  setCurrentTool(toolId: string) {
    this.currentToolId = toolId
  }

  getCurrentToolId() {
    return this.currentToolId
  }

  getSelectedShapeIds() {
    return [...this.selectedIds]
  }

  getCurrentPageShapeIds() {
    return Array.from(this.shapes.keys())
  }

  getShape(id: string) {
    return this.shapes.get(id) || null
  }

  getShapePageBounds(id: string) {
    const shape = this.shapes.get(id)
    if (!shape) return null
    return {
      x: shape.x,
      y: shape.y,
      w: typeof shape.props.w === 'number' ? Number(shape.props.w) : 240,
      h: typeof shape.props.h === 'number' ? Number(shape.props.h) : 80,
    }
  }

  updateShapes(patches: Array<{ id: string; type: string; x?: number; y?: number }>) {
    this.lastUpdateBatch = patches.map((item) => ({ id: item.id, x: item.x, y: item.y }))
    for (const patch of patches) {
      const current = this.shapes.get(patch.id)
      if (!current) continue
      this.shapes.set(patch.id, {
        ...current,
        x: typeof patch.x === 'number' ? patch.x : current.x,
        y: typeof patch.y === 'number' ? patch.y : current.y,
      })
    }
  }

  updateShape(patch: { id: string; type: string; x?: number; y?: number; props?: Record<string, unknown>; meta?: Record<string, unknown> }) {
    const current = this.shapes.get(patch.id)
    if (!current) return
    if (hasUndefinedValue(patch.props)) throw new Error('Shape props must not contain undefined')
    if (hasUndefinedValue(patch.meta)) throw new Error('Shape meta must not contain undefined')
    this.shapes.set(patch.id, {
      ...current,
      x: typeof patch.x === 'number' ? patch.x : current.x,
      y: typeof patch.y === 'number' ? patch.y : current.y,
      props: patch.props ? { ...current.props, ...patch.props } : current.props,
      meta: patch.meta ? { ...(current.meta || {}), ...patch.meta } : current.meta,
    })
  }

  deleteShapes(ids: string[]) {
    ids.forEach((id) => this.shapes.delete(id))
  }

  alignShapes(ids: string[], mode: string) {
    this.lastAlignCall = { ids: [...ids], mode }
  }

  distributeShapes(ids: string[], mode: string) {
    this.lastDistributeCall = { ids: [...ids], mode }
  }

  bringToFront(ids: string[]) {
    this.lastZOrderCall = { ids: [...ids], mode: 'front' }
  }

  sendToBack(ids: string[]) {
    this.lastZOrderCall = { ids: [...ids], mode: 'back' }
  }

  bringForward(ids: string[]) {
    this.lastZOrderCall = { ids: [...ids], mode: 'forward' }
  }

  sendBackward(ids: string[]) {
    this.lastZOrderCall = { ids: [...ids], mode: 'backward' }
  }

  groupShapes(ids: string[], options?: { groupId?: string }) {
    const bounds = ids
      .map((id) => this.getShapePageBounds(id))
      .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>
    const minX = Math.min(...bounds.map((item) => item.x))
    const minY = Math.min(...bounds.map((item) => item.y))
    const maxX = Math.max(...bounds.map((item) => item.x + item.w))
    const maxY = Math.max(...bounds.map((item) => item.y + item.h))
    const groupId = options?.groupId || `group-${Date.now()}`
    this.lastGroupCall = { ids: [...ids], groupId }
    this.createShape({
      id: groupId,
      type: 'group',
      x: minX,
      y: minY,
      props: {
        w: maxX - minX,
        h: maxY - minY,
        childIds: ids,
      },
    })
    this.setSelectedShapes([groupId])
  }

  zoomToSelectionIfOffscreen(padding: number) {
    this.lastZoomPadding = padding
  }

  getSnapshot() {
    return {
      document: {
        shapes: Object.fromEntries(this.shapes),
      },
    }
  }
}

after(() => {
  const handles = ((process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() || [])
  for (const handle of handles) {
    const candidate = handle as { constructor?: { name?: string }; close?: () => void }
    if (candidate.constructor?.name === 'MessagePort' && typeof candidate.close === 'function') {
      candidate.close()
    }
  }
})

function createWindowHarness() {
  const previousWindow = (globalThis as { window?: unknown }).window
  const fakeWindow = {}
  ;(globalThis as { window?: unknown }).window = fakeWindow
  return {
    restore() {
      ;(globalThis as { window?: unknown }).window = previousWindow
    },
  }
}

function createIntegrationHarness() {
  const editor = new FakeDesignEditor()
  const activeFileRef = { current: '/tmp/design-demo.tldr' }
  let dirty = false
  let scopeState: Record<string, unknown> | null = null
  const activatedModes: string[] = []

  const dispose = registerModuleAgentHandler('design', createDesignAgentHandler({
    editorRef: { current: editor as any },
    activeFileRef,
    isDirty: dirty,
    saveStatus: 'idle',
    loadDesignFileIntoEditor: async () => true,
    flushSave: async () => true,
    exportCurrentDesign: async () => '/tmp/export.png',
    markDirty: () => { dirty = true },
    markSaved: () => { dirty = false },
    selectWorkspaceFile: () => { /* noop */ },
    setActiveFile: () => { /* noop */ },
  }))

  const upsertScopeRunState = (_scopeId: string, updater: (previous: any) => any) => {
    scopeState = updater(scopeState)
  }

  return {
    editor,
    activeFileRef,
    get dirty() {
      return dirty
    },
    get scopeState() {
      return scopeState as any
    },
    activatedModes,
    upsertScopeRunState,
    activateWorkbenchMode(mode: 'browser' | 'document' | 'design' | 'video' | 'rss' | 'calendar') {
      activatedModes.push(mode)
    },
    dispose,
  }
}

async function runToolThroughAgent(
  toolName: string,
  args: Record<string, unknown>,
  harness: ReturnType<typeof createIntegrationHarness>,
  runId = 'run-design',
) {
  const emitted: Array<{ tool: string; args: Record<string, unknown> }> = []
  const raw = await executeDesignTool(toolName, args, {
    emitToolAction: (tool, payload) => {
      emitted.push({ tool, args: payload })
    },
  })

  if (emitted.length > 0) {
    const latest = emitted[emitted.length - 1]
    await handleModuleToolAction({
      scopeId: 'scope-design',
      agentName: 'designer',
      tool: latest.tool,
      args: latest.args,
      runId,
      activateWorkbenchMode: harness.activateWorkbenchMode.bind(harness),
      upsertScopeRunState: harness.upsertScopeRunState,
      getScopeRunState: () => harness.scopeState,
    })
  }

  return {
    raw,
    emitted,
    state: harness.scopeState,
  }
}

async function runToolThroughRequestResponse(
  toolName: string,
  args: Record<string, unknown>,
  harness: ReturnType<typeof createIntegrationHarness>,
  runId = 'run-design',
) {
  const raw = await executeDesignTool(toolName, args, {
    requestToolAction: async (tool, payload) => {
      const result = await executeModuleToolAction({
        scopeId: 'scope-design',
        agentName: 'designer',
        tool,
        args: payload,
        runId,
        activateWorkbenchMode: harness.activateWorkbenchMode.bind(harness),
        upsertScopeRunState: harness.upsertScopeRunState,
        getScopeRunState: () => harness.scopeState,
      })
      assert.equal(result.handled, true)
      return result.payload || {}
    },
  })

  return {
    raw,
    state: harness.scopeState,
  }
}

describe('design agent integration', () => {
  it('keeps custom shape catalog, utils and tools in sync', () => {
    assert.equal(designComponentCatalog.length, DESIGN_CUSTOM_SHAPE_TYPES.length)
    assert.equal(allShapeUtils.length, DESIGN_CUSTOM_SHAPE_TYPES.length)
    assert.equal(allTools.length, DESIGN_CUSTOM_SHAPE_TYPES.length)

    for (const type of DESIGN_CUSTOM_SHAPE_TYPES) {
      const defaults = getComponentDefaults(type) as Record<string, unknown>
      assert.equal(typeof defaults.w, 'number')
      assert.equal(typeof defaults.h, 'number')
      assert.ok(designComponentCatalog.some((item) => item.type === type))
    }
  })

  const componentCases: Array<{
    toolName: string
    expectedAction: string
    expectedType: string
    args: Record<string, unknown>
  }> = [
    { toolName: 'design_create_button', expectedAction: 'design.createButton', expectedType: 'ui-button', args: { label: 'Publish' } },
    { toolName: 'design_create_input', expectedAction: 'design.createInput', expectedType: 'ui-input', args: { label: 'Email', placeholder: 'name@company.com' } },
    { toolName: 'design_create_card', expectedAction: 'design.createCard', expectedType: 'ui-card', args: { title: 'Content Card' } },
    { toolName: 'design_create_text_block', expectedAction: 'design.createTextBlock', expectedType: 'ui-text-block', args: { content: 'Longer editorial summary block.' } },
    { toolName: 'design_create_image_placeholder', expectedAction: 'design.createImagePlaceholder', expectedType: 'ui-image-placeholder', args: { label: 'Hero', aspectRatio: '16:9' } },
    { toolName: 'design_create_page_header', expectedAction: 'design.createPageHeader', expectedType: 'ui-page-header', args: { title: 'Weekly Content Review' } },
    { toolName: 'design_create_section_block', expectedAction: 'design.createSectionBlock', expectedType: 'ui-section-block', args: { title: 'Section', columns: 2 } },
    { toolName: 'design_create_stat_card', expectedAction: 'design.createStatCard', expectedType: 'ui-stat-card', args: { value: '182.4K', label: 'Reach' } },
    { toolName: 'design_create_list_item', expectedAction: 'design.createListItem', expectedType: 'ui-list-item', args: { title: 'Checklist Row' } },
  ]

  for (const componentCase of componentCases) {
    it(`routes ${componentCase.toolName} through tool executor, module handler, and trace log`, async () => {
      const windowHarness = createWindowHarness()
      const harness = createIntegrationHarness()

      try {
        const result = await runToolThroughAgent(componentCase.toolName, componentCase.args, harness)
        const emitted = result.emitted[0]
        const createdShape = Array.from(harness.editor.shapes.values()).at(-1)

        assert.ok(emitted)
        assert.equal(emitted.tool, componentCase.expectedAction)
        assert.ok(result.raw.includes(componentCase.expectedAction))
        assert.equal(createdShape?.type, componentCase.expectedType)
        assert.equal(harness.activatedModes.at(-1), 'design')
        assert.equal(harness.dirty, true)
        assert.equal(harness.scopeState?.toolTrace?.length, 2)
        assert.match(String(harness.scopeState?.toolTrace?.[0]?.text || ''), /执行 design\./)
        assert.match(String(harness.scopeState?.toolTrace?.[1]?.text || ''), /已创建|已在画布上插入/)
      } finally {
        harness.dispose()
        windowHarness.restore()
      }
    })
  }

  it('supports arranging selected shapes through the agent tool trace pipeline', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_create_button', { label: 'One', x: 100, y: 100 }, harness)
      await runToolThroughAgent('design_create_button', { label: 'Two', x: 200, y: 180 }, harness)

      const ids = Array.from(harness.editor.shapes.keys())
      harness.editor.setSelectedShapes(ids)

      const result = await runToolThroughAgent('design_arrange_selection', { mode: 'stack-horizontal', gap: 24 }, harness)

      assert.ok(result.raw.includes('design.arrangeSelection'))
      assert.equal(harness.editor.lastUpdateBatch.length, 2)
      assert.equal(harness.scopeState?.toolTrace?.length, 6)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /水平堆叠/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('can compose a multi-level content layout skeleton through the agent path', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughAgent('design_compose_content_layout', { template: 'dashboard', title: 'Ops Dashboard' }, harness)
      const types = Array.from(harness.editor.shapes.values()).map((shape) => shape.type)

      assert.ok(result.raw.includes('design.composeContentLayout'))
      assert.ok(types.includes('ui-page-header'))
      assert.ok(types.includes('ui-stat-card'))
      assert.ok(types.includes('ui-section-block'))
      assert.ok(types.includes('ui-list-item'))
      assert.ok(types.length >= 6)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /内容排版骨架/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('can compose a social cover skeleton through the agent path', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughAgent('design_compose_social_cover', { platform: 'xiaohongshu', ratio: '9:16' }, harness)
      const types = Array.from(harness.editor.shapes.values()).map((shape) => shape.type)

      assert.ok(result.raw.includes('design.composeSocialCover'))
      assert.ok(types.filter((type) => type === 'ui-text-block').length >= 10)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /封面/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('supports a 16:9 social cover request through the agent path without falling back to portrait', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughAgent('design_compose_social_cover', {
        platform: 'generic',
        ratio: '16:9',
        sectionCount: 2,
      }, harness)
      const board = Array.from(harness.editor.shapes.values()).find((shape) => (
        Number(shape.props.w) === 960
        && Number(shape.props.h) === 540
      ))
      const portraitBoard = Array.from(harness.editor.shapes.values()).find((shape) => (
        Number(shape.props.w) === 540
        && Number(shape.props.h) === 960
      ))

      assert.ok(result.raw.includes('design.composeSocialCover'))
      assert.ok(board)
      assert.equal(portraitBoard, undefined)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /16:9/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('keeps 4:3 github covers in the requested ratio and does not inject a default button motif', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'generic',
        ratio: '4:3',
        sectionCount: 3,
        designDirectiveText: '生成一个横向 4:3 的 youtube 封面排版，github 风格，黑灰技术感，3 组信息，不要按钮，不要粗线',
        themeKeywords: ['youtube', 'github', '黑灰', '技术感'],
      }, harness)

      const shapes = Array.from(harness.editor.shapes.values())
      const board = shapes.find((shape) => (
        shape.meta?.readyRole === 'board'
        && Number(shape.props.w) === 720
        && Number(shape.props.h) === 540
      ))
      const button = shapes.find((shape) => shape.meta?.readyRole === 'cta-button')
      const footer = shapes.find((shape) => shape.meta?.readyRole === 'footer')

      assert.ok(board)
      assert.equal(button, undefined)
      assert.equal(Boolean(footer?.meta?.readyFillVisible), false)
      assert.equal(String(harness.scopeState?.designReviewSummary || '').includes('比例偏离目标'), false)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('accepts youtube as an explicit platform and preserves color + no-button constraints through the controller path', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_compose_social_cover', {
        platform: 'youtube',
        ratio: '4:3',
        sectionCount: 3,
        designDirectiveText: '生成一个横向 4:3 的 youtube 封面排版，github 风格，绿色主题，黑灰技术感，3 组信息，不要按钮，不要粗线',
        themeKeywords: ['youtube', 'github', '绿色主题', '黑灰技术感'],
      }, harness)

      const shapes = Array.from(harness.editor.shapes.values())
      const board = shapes.find((shape) => (
        shape.meta?.readyRole === 'board'
        && Number(shape.props.w) === 720
        && Number(shape.props.h) === 540
      ))
      const boardSurface = shapes.find((shape) => shape.meta?.readyRole === 'board-surface')
      const hasButton = shapes.some((shape) => shape.meta?.readyRole === 'cta-button')
      const hasWideDivider = shapes.some((shape) => (
        shape.meta?.readyRole === 'divider'
        && Number(shape.props.w || 0) >= 300
        && Number(shape.props.h || 0) >= 4
      ))

      assert.ok(board)
      assert.equal(hasButton, false)
      assert.equal(hasWideDivider, false)
      assert.equal(String(boardSurface?.meta?.readyFillColor || '').toLowerCase(), '#0d1712')
      assert.equal(String(harness.scopeState?.designReviewSummary || '').includes('比例偏离目标'), false)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('derives ratio, explicit dimensions, platform, section count and red palette directly from prompt text when tool args are sparse', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughRequestResponse('design_run_task_controller', {
        taskType: 'social-cover',
        designDirectiveText: '生成一个 1920x1080 的 youtube 封面排版，红色主题，加一点对色，有两级排版结构',
      }, harness)

      const payload = JSON.parse(result.raw) as Record<string, unknown>
      const requestSpec = payload.requestSpec as Record<string, unknown>
      const review = payload.review as Record<string, unknown>
      const shapes = Array.from(harness.editor.shapes.values())
      const board = shapes.find((shape) => (
        shape.meta?.readyRole === 'board'
        && Number(shape.props.w) === 1920
        && Number(shape.props.h) === 1080
      ))
      const boardSurface = shapes.find((shape) => shape.meta?.readyRole === 'board-surface')

      assert.ok(board)
      assert.equal(requestSpec.platform, 'youtube')
      assert.equal(requestSpec.ratio, '16:9')
      assert.equal(requestSpec.sectionCount, 2)
      assert.equal(String(boardSurface?.meta?.readyFillColor || '').toLowerCase(), '#fff5f4')
      assert.equal(String(payload.resolvedPlan?.styleSystem?.palette?.contrastAccent || ''), '#0F9C94')
      assert.equal(review.passed, true)
      assert.equal(Number((payload.mutationStats as Record<string, unknown>)?.repairRounds || 0), 0)
      assert.ok(Number((payload.mutationStats as Record<string, unknown>)?.executionBatches || 0) <= 4)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('ignores stale upstream split-feature/button hints when the prompt explicitly asks for a square restrained github cover', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughRequestResponse('design_run_task_controller', {
        taskType: 'social-cover',
        designDirectiveText: '生成一个 1:1 的 github 风格封面，黑灰技术感，不要按钮，不要粗线，只有标题和子标题、账号名三个信息',
        compositionFamily: 'split-feature',
        styleGuide: {
          ctaWeight: 'button',
          ornament: 'floating-pill',
          headlineAlign: 'left',
          sectionTone: 'solid',
          density: 'balanced',
        },
        layoutBlueprint: {
          skeleton: 'split',
          titlePlacement: 'top-left',
          emphasisPlacement: 'side-card',
          sectionFlow: 'grid',
          sectionEmphasis: 'last-highlight',
          ornamentMode: 'pill',
          footerStyle: 'pill',
          titleWidthRatio: 0.44,
          titleZoneRatio: 0.2,
          emphasisWeight: 0.24,
          sectionColumns: 2,
          asymmetry: 0.28,
        },
      }, harness)

      const payload = JSON.parse(result.raw) as Record<string, any>
      const shapes = Array.from(harness.editor.shapes.values())
      const board = shapes.find((shape) => (
        shape.meta?.readyRole === 'board'
        && Number(shape.props.w) === 540
        && Number(shape.props.h) === 540
      ))
      const hasButton = shapes.some((shape) => shape.meta?.readyRole === 'cta-button')
      const hasWideDivider = shapes.some((shape) => (
        shape.meta?.readyRole === 'divider'
        && Number(shape.props.w || 0) >= 220
        && Number(shape.props.h || 0) >= 4
      ))

      assert.ok(board)
      assert.equal(payload.requestSpec?.ratio, '1:1')
      assert.equal(payload.requestSpec?.sectionCount, 3)
      assert.equal(hasButton, false)
      assert.equal(hasWideDivider, false)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('treats sparse follow-up cover prompts as single-section side-meta layouts with larger type', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughRequestResponse('design_run_task_controller', {
        taskType: 'social-cover',
        designDirectiveText: '换一个版式，只有标题和标题旁边的附加信息，字要更大',
      }, harness)

      const payload = JSON.parse(result.raw) as Record<string, any>
      const resolvedPlan = payload.resolvedPlan as Record<string, any>

      assert.equal(payload.requestSpec?.sectionCount, 1)
      assert.equal(resolvedPlan?.semanticControls?.prefersSideMeta, true)
      assert.equal(resolvedPlan?.layoutBlueprint?.emphasisPlacement, 'side-card')
      assert.ok(Number(resolvedPlan?.styleSystem?.typographyTokens?.titleFontSize || 0) >= 36)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('runs the design task controller through observe-brief-scene-plan-compile-execute-verify-finalize and keeps one owned 9:16 board', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'xiaohongshu',
        ratio: '9:16',
        sectionCount: 4,
        themeKeywords: ['干货分享', '小红书'],
      }, harness)

      const traceTexts = (harness.scopeState?.toolTrace || []).map((item: { text?: string }) => String(item.text || ''))
      const boards = Array.from(harness.editor.shapes.values()).filter((shape) => (
        Number(shape.props.w) === 540
        && Number(shape.props.h) === 960
        && shape.meta?.readyRole === 'board'
      ))
      const ownedShape = Array.from(harness.editor.shapes.values()).find((shape) => shape.meta?.readyAgentRunId === 'run-design')

      assert.ok(result.raw.includes('design.runTaskController'))
      assert.equal(boards.length, 1)
      assert.ok(ownedShape)
      assert.equal(harness.scopeState?.designPhase, 'finalize')
      assert.ok(Array.isArray(harness.scopeState?.ownedNodeIds))
      assert.ok((harness.scopeState?.ownedNodeIds || []).length > 0)
      assert.match(String(harness.scopeState?.designReviewSummary || ''), /验收/)
      assert.ok(traceTexts.some((text) => text.includes('观察画布')))
      assert.ok(traceTexts.some((text) => text.includes('生成设计 brief')))
      assert.ok(traceTexts.some((text) => text.includes('生成场景蓝图')))
      assert.ok(traceTexts.some((text) => text.includes('编译执行程序')))
      assert.ok(traceTexts.some((text) => text.includes('截图验收')))
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('returns the real controller execution result instead of a placeholder when request/response bridge is used', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughRequestResponse('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'xiaohongshu',
        ratio: '9:16',
        sectionCount: 4,
        themeKeywords: ['干货分享', '小红书'],
      }, harness)
      const parsed = JSON.parse(result.raw) as Record<string, any>

      assert.equal(parsed.ratio, '9:16')
      assert.ok(parsed.status === 'success' || parsed.status === 'failed')
      assert.equal(parsed.status, parsed.review?.passed ? 'success' : 'failed')
      assert.ok(Array.isArray(parsed.ownedNodeIds))
      assert.ok(Number(parsed.mutationStats?.executionBatches || 0) >= 1)
      assert.ok(parsed.runCapture)
      assert.equal(parsed.runCapture?.review?.passed, parsed.review?.passed)
      assert.equal(parsed.runCapture?.resolvedPlan?.scenePlan?.ratio, '9:16')
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('surfaces request/response bridge failures as structured tool results', async () => {
    const raw = await executeDesignTool('design_run_task_controller', {
      taskType: 'social-cover',
      ratio: '9:16',
    }, {
      requestToolAction: async () => {
        throw new Error('renderer bridge failed')
      },
    })
    const parsed = JSON.parse(raw) as Record<string, any>

    assert.equal(parsed.status, 'failed')
    assert.match(String(parsed.message || ''), /renderer bridge failed/)
    assert.equal(parsed.review?.passed, false)
  })

  it('keeps centered, outlined, button-heavy style decisions when the controller writes through batch ops', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'generic',
        ratio: '3:4',
        sectionCount: 2,
        designDirectiveText: '重新建一个竖向 3:4 的画板，标题要居中，信息区做描边，黑灰技术风，多一点按钮感',
        themeKeywords: ['github', '黑灰', '按钮', '居中', '描边'],
        tone: 'technical-precise',
      }, harness)

      const shapes = Array.from(harness.editor.shapes.values())
      const title = shapes.find((shape) => shape.meta?.readyRole === 'title')
      const section = shapes.find((shape) => shape.meta?.readyRole === 'section')
      const ctaButton = shapes.find((shape) => shape.meta?.readyRole === 'cta-button')

      assert.equal(title?.meta?.readyTextAlign, 'middle')
      assert.equal(section?.meta?.readyStrokeVisible, true)
      assert.ok(Number(section?.meta?.readyStrokeWidth || 0) > 0)
      assert.ok(ctaButton)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('builds a more editorial centered scene plan for a poster-like xiaohongshu prompt', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'xiaohongshu',
        ratio: '9:16',
        sectionCount: 4,
        designDirectiveText: '在画板新建一个竖向 9:16 的小红书封面，暖色，封面感强一点，标题居中，排版要更像杂志感海报',
        themeKeywords: ['小红书', '暖色', '杂志感', '封面'],
        tone: 'editorial-warm',
      }, harness)

      const title = Array.from(harness.editor.shapes.values()).find((shape) => shape.meta?.readyRole === 'title')
      const traceTexts = (harness.scopeState?.toolTrace || []).map((item: { text?: string }) => String(item.text || ''))

      assert.equal(title?.meta?.readyTextAlign, 'middle')
      assert.ok(traceTexts.some((text) => text.includes('生成场景蓝图')))
      assert.ok(traceTexts.some((text) => text.includes('编译执行程序')))
      assert.ok(traceTexts.some((text) => /scene plan|staggered|poster|chip|floating-pill/i.test(text)))
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('streams design controller phase events without replaying duplicate tool events at the end', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'xiaohongshu',
        ratio: '9:16',
        sectionCount: 4,
        designDirectiveText: '在画板新建一个 9:16 封面，标题居中，杂志感海报风，暖色，不要太模板',
        themeKeywords: ['小红书', '暖色', '海报', '杂志感'],
      }, harness)

      const traceTexts = (harness.scopeState?.toolTrace || []).map((item: { text?: string }) => String(item.text || ''))
      const observeCount = traceTexts.filter((text) => text === '观察画布：读取编辑器状态、布局摘要和可用空白区。').length
      const finalizeCount = traceTexts.filter((text) => text === '截图验收：导出当前结果快照用于最终复核。').length

      assert.equal(observeCount, 1)
      assert.equal(finalizeCount, 1)
      assert.ok(traceTexts.some((text) => text.includes('复查并修正')))
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('reuses the current board for follow-up revision prompts instead of creating a new board beside it', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'generic',
        ratio: '9:16',
        sectionCount: 3,
        designDirectiveText: '做一个 github 风格的 9:16 封面，黑灰技术感，信息区描边，多一点按钮感',
        themeKeywords: ['github', '黑灰', '按钮', '描边'],
      }, harness, 'run-design-a')

      const firstBoards = Array.from(harness.editor.shapes.values()).filter((shape) => (
        shape.meta?.readyRole === 'board'
        && Number(shape.props.w) === 540
        && Number(shape.props.h) === 960
      ))
      const firstBoardId = String(harness.scopeState?.boardId || '')
      const firstBoard = firstBoards.find((shape) => shape.id === firstBoardId) || firstBoards[0]
      const firstBoardX = firstBoard?.x
      const firstBoardY = firstBoard?.y
      assert.equal(firstBoards.length, 1)
      assert.ok(firstBoard)
      assert.ok(harness.scopeState?.boardId)
      assert.equal(firstBoard?.id, firstBoardId)
      assert.ok(harness.scopeState?.scenePlanId)
      assert.ok(harness.scopeState?.styleSystem)

      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        designDirectiveText: '标题再偏左一点，不要按钮，底部轻一点，更克制一点。',
      }, harness)

      const boards = Array.from(harness.editor.shapes.values()).filter((shape) => shape.meta?.readyRole === 'board')
      const buttons = Array.from(harness.editor.shapes.values()).filter((shape) => shape.meta?.readyRole === 'cta-button')
      const traceTexts = (harness.scopeState?.toolTrace || []).map((item: { text?: string }) => String(item.text || ''))

      assert.equal(boards.length, 1)
      assert.equal(boards[0]?.x, firstBoardX)
      assert.equal(boards[0]?.y, firstBoardY)
      assert.equal(Number(boards[0]?.props.w || 0), 540)
      assert.equal(Number(boards[0]?.props.h || 0), 960)
      assert.equal(buttons.length, 0)
      assert.ok(traceTexts.some((text) => text.includes('沿用当前画板')))
      assert.ok(traceTexts.some((text) => text.includes('清理上一轮 owned nodes')))
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('creates a fresh board for explicit different-version requests and keeps the new owned nodes free of banned motifs', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'generic',
        ratio: '9:16',
        sectionCount: 3,
        designDirectiveText: '做一个 github 风格的 9:16 封面，黑灰技术感，信息区描边，多一点按钮感',
        themeKeywords: ['github', '黑灰', '按钮', '描边'],
      }, harness)

      const firstBoardId = String(harness.scopeState?.boardId || '')
      const firstScenePlanId = String(harness.scopeState?.scenePlanId || '')

      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        designDirectiveText: '再来一个不同版式的，但还是 9:16 github 风格封面，不要按钮，不要粗线，更克制一点。',
      }, harness, 'run-design-b')

      const boards = Array.from(harness.editor.shapes.values()).filter((shape) => shape.meta?.readyRole === 'board')
      const ownedIds = (harness.scopeState?.ownedNodeIds || []) as string[]
      const ownedShapes = ownedIds.map((id) => harness.editor.getShape(id)).filter(Boolean) as Array<any>
      const newBoardId = String(harness.scopeState?.boardId || '')

      assert.equal(boards.length, 2)
      assert.notEqual(newBoardId, firstBoardId)
      assert.notEqual(String(harness.scopeState?.scenePlanId || ''), firstScenePlanId)
      assert.equal(ownedShapes.some((shape) => shape?.meta?.readyRole === 'cta-button'), false)
      assert.equal(ownedShapes.some((shape) => (
        shape?.meta?.readyRole === 'divider'
        && Number(shape.props?.w || 0) >= 280
        && Number(shape.props?.h || 0) <= 16
      )), false)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('keeps all generated cover content inside the requested 9:16 board bounds', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_compose_social_cover', {
        platform: 'xiaohongshu',
        ratio: '9:16',
        sectionCount: 4,
        title: '你的主标题放这里\n突出反差、收益或结果\n建议控制在 2 到 3 行',
        contentSections: [
          { id: 'one', kind: 'numbered-item', title: '信息组 1 / 主题信息', body: '替换赛道、人群、场景、结果，让用户知道这页主要在讲什么。' },
          { id: 'two', kind: 'numbered-item', title: '信息组 2 / 核心卖点', body: '强调收益、方法、差异化表达，尽量保持一段话即可。' },
          { id: 'three', kind: 'numbered-item', title: '信息组 3 / 证明补充', body: '可以放案例、步骤、数据、对比或限制条件。' },
          { id: 'four', kind: 'numbered-item', title: '信息组 4 / 行动提示', body: '底部作为 CTA、日期、系列标识或轻行动引导。' },
        ],
      }, harness)

      const shapes = Array.from(harness.editor.shapes.values())
      const board = shapes.find((shape) => Number(shape.props.w) === 540 && Number(shape.props.h) === 960)

      assert.ok(board)
      const boardRight = Number(board?.x || 0) + Number(board?.props.w || 0)
      const boardBottom = Number(board?.y || 0) + Number(board?.props.h || 0)

      for (const shape of shapes) {
        if (shape.id === board?.id) continue
        const right = shape.x + Number(shape.props.w || 0)
        const bottom = shape.y + Number(shape.props.h || 0)
        assert.ok(shape.x >= Number(board?.x || 0), `shape ${shape.id} exceeds board on the left`)
        assert.ok(shape.y >= Number(board?.y || 0), `shape ${shape.id} exceeds board on the top`)
        assert.ok(right <= boardRight, `shape ${shape.id} exceeds board on the right`)
        assert.ok(bottom <= boardBottom, `shape ${shape.id} exceeds board on the bottom`)
      }

      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /版面审查/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('can create a non-stretched circle through the low-level geo tool', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughAgent('design_create_geo_shape', { shape: 'circle', w: 96, h: 48, label: '01' }, harness)
      const created = Array.from(harness.editor.shapes.values()).at(-1)

      assert.ok(result.raw.includes('design.createGeoShape'))
      assert.equal(created?.type, 'ui-text-block')
      assert.equal(created?.props.w, 96)
      assert.equal(created?.props.h, 96)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /几何元素/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('can inspect controller-owned nodes through the low-level ownership tool', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'xiaohongshu',
        ratio: '9:16',
      }, harness)

      const result = await runToolThroughAgent('design_list_owned_nodes', {
        runId: 'run-design',
      }, harness)

      assert.ok(result.raw.includes('design.listOwnedNodes'))
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /本轮 run/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('supports low-level measure, frame, update, z-order, group, guide and compare tools through the agent path', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const measure = await runToolThroughAgent('design_measure_text', {
        text: 'GitHub style cover',
        width: 240,
        fontSize: 18,
      }, harness)
      assert.ok(measure.raw.includes('design.measureText'))
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /文本测量/)

      await runToolThroughAgent('design_create_frame', {
        name: 'Hero Board',
        w: 540,
        h: 960,
        x: 40,
        y: 60,
      }, harness)
      const frame = Array.from(harness.editor.shapes.values()).find((shape) => shape.type === 'frame')
      assert.ok(frame)

      const textResult = await runToolThroughAgent('design_create_text', { text: 'Headline', x: 80, y: 120 }, harness)
      assert.ok(textResult.raw.includes('design.createText'))
      const textId = Array.from(harness.editor.shapes.keys()).find((id) => harness.editor.shapes.get(id)?.type === 'text')
      assert.ok(textId)

      const update = await runToolThroughAgent('design_update_nodes', {
        patches: [{ id: textId, x: 96, y: 132 }],
      }, harness)
      assert.ok(update.raw.includes('design.updateNodes'))
      assert.equal(harness.editor.getShape(textId!)?.x, 96)

      const zOrder = await runToolThroughAgent('design_set_z_order', {
        ids: [textId],
        mode: 'front',
      }, harness)
      assert.ok(zOrder.raw.includes('design.setZOrder'))
      assert.equal(harness.editor.lastZOrderCall?.mode, 'front')

      const geo = await runToolThroughAgent('design_create_geo_shape', {
        shape: 'circle',
        label: '01',
        x: 160,
        y: 220,
        w: 48,
        h: 48,
      }, harness)
      assert.ok(geo.raw.includes('design.createGeoShape'))
      const idsToGroup = Array.from(harness.editor.shapes.keys()).slice(-2)
      const group = await runToolThroughAgent('design_group_nodes', {
        ids: idsToGroup,
        name: 'Badge Group',
      }, harness)
      assert.ok(group.raw.includes('design.groupNodes'))
      assert.ok(harness.editor.lastGroupCall)

      const guides = await runToolThroughAgent('design_get_guides', { columns: 2 }, harness)
      assert.ok(guides.raw.includes('design.getGuides'))

      await runToolThroughAgent('design_run_task_controller', {
        taskType: 'social-cover',
        platform: 'generic',
        ratio: '3:4',
        designDirectiveText: '做一个 github 风格的 3:4 封面，技术感、描边信息区、不要粗线',
        themeKeywords: ['github', '黑灰', '描边'],
        sectionCount: 2,
      }, harness)
      const compare = await runToolThroughAgent('design_compare_screenshot', { runId: 'run-design' }, harness)
      assert.ok(compare.raw.includes('design.compareScreenshot'))
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /截图对比/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('can batch-create, select, and delete design elements through the low-level batch tool', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      const result = await runToolThroughAgent('design_batch_design', {
        ops: [
          { op: 'create', target: 'text', text: 'Headline', x: 120, y: 120 },
          { op: 'create', target: 'geo', shape: 'circle', label: '01', x: 200, y: 200, w: 48, h: 48 },
          { op: 'select', ids: [] },
        ],
      }, harness)

      assert.ok(result.raw.includes('design.batchDesign'))
      assert.equal(harness.editor.shapes.size, 2)

      await runToolThroughAgent('design_batch_design', {
        ops: [{ op: 'delete', ids: Array.from(harness.editor.shapes.keys()) }],
      }, harness)

      assert.equal(harness.editor.shapes.size, 0)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /批量设计操作/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('fails screenshot-backed verification when the result still looks like a rigid template', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      harness.editor.createShape({
        id: 'board-template',
        type: 'frame',
        x: 40,
        y: 40,
        props: { w: 540, h: 960 },
        meta: { readyAgentRunId: 'run-design', readyRole: 'board' },
      })
      harness.editor.createShape({
        id: 'badge-template',
        type: 'geo',
        x: 76,
        y: 84,
        props: { w: 118, h: 24 },
        meta: { readyAgentRunId: 'run-design', readyRole: 'badge' },
      })
      harness.editor.createShape({
        id: 'title-template',
        type: 'text',
        x: 76,
        y: 132,
        props: { w: 388, h: 112 },
        meta: {
          readyAgentRunId: 'run-design',
          readyRole: 'title',
          readyFillVisible: true,
          readyStrokeVisible: true,
          readyStrokeWidth: 1,
        },
      })
      for (let index = 0; index < 4; index += 1) {
        harness.editor.createShape({
          id: `section-template-${index}`,
          type: 'text',
          x: 76,
          y: 292 + index * 118,
          props: { w: 388, h: 84 },
          meta: {
            readyAgentRunId: 'run-design',
            readyRole: 'section',
            readyStrokeVisible: true,
            readyStrokeWidth: 1,
          },
        })
      }
      harness.editor.createShape({
        id: 'footer-template',
        type: 'geo',
        x: 76,
        y: 846,
        props: { w: 388, h: 18 },
        meta: { readyAgentRunId: 'run-design', readyRole: 'footer' },
      })

      await runToolThroughAgent('design_compare_screenshot', { runId: 'run-design' }, harness)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /风险点|模板/)

      await runToolThroughAgent('design_verify_layout', {
        runId: 'run-design',
        screenshotPath: '/tmp/export.png',
        layoutBudget: {
          boardWidth: 540,
          boardHeight: 960,
          paddingTop: 48,
        },
      }, harness)

      assert.match(String(harness.scopeState?.designReviewSummary || ''), /验收未通过/)
      assert.match(String(harness.scopeState?.designReviewSummary || ''), /模板感过强|固定套版/)
      assert.ok(Array.isArray(harness.scopeState?.reviewFailures))
      assert.ok(harness.scopeState?.reviewFailures?.includes('visual-rhythm'))
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('rejects batch updates that contain undefined props', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await assert.rejects(async () => {
        await runToolThroughAgent('design_batch_design', {
          ops: [{ op: 'create', target: 'component', component: 'ui-card', props: { title: undefined } }],
        }, harness)
      })
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('places a generated social cover to the right of existing canvas content by default', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      harness.editor.createShape({
        id: 'existing-frame',
        type: 'geo',
        x: 0,
        y: 0,
        props: { w: 800, h: 600 },
      } as any)

      await runToolThroughAgent('design_compose_social_cover', { platform: 'xiaohongshu', ratio: '9:16' }, harness)

      const createdBlocks = Array.from(harness.editor.shapes.values()).filter((shape) => shape.type === 'ui-text-block')
      const board = createdBlocks.find((shape) => Number(shape.props.w) === 540 && Number(shape.props.h) === 960)

      assert.ok(board)
      assert.equal(board?.x, 900)
      assert.equal(board?.y, 100)
      assert.ok(harness.editor.lastZoomPadding > 0)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /右侧空白区/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('changes the cover structure for a github-style 3:4 planner payload', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_compose_social_cover', {
        platform: 'generic',
        ratio: '3:4',
        compositionFamily: 'split-feature',
        sectionCount: 2,
        palette: {
          name: 'github-dark',
          background: '#0D1117',
          surface: '#161B22',
          primaryText: '#E6EDF3',
          secondaryText: '#8B949E',
          accent: '#2F81F7',
          accentSoft: '#1F2937',
        },
        contentSections: [
          { id: 'one', kind: 'headline', title: '核心结论', body: '一句话放结果、能力或判断。' },
          { id: 'two', kind: 'cta', title: '立即查看', body: '按钮化 CTA 收口。' },
        ],
        styleGuide: {
          ctaWeight: 'button',
          ornament: 'corner-plates',
          headlineAlign: 'left',
          sectionTone: 'solid',
          density: 'balanced',
        },
      }, harness)

      const board = Array.from(harness.editor.shapes.values()).find((shape) => Number(shape.props.w) === 540 && Number(shape.props.h) === 720)

      assert.ok(board)
      assert.match(String(harness.scopeState?.toolTrace?.at(-1)?.text || ''), /3:4/)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('does not force a CTA button or wide divider for a split-feature cover that explicitly avoids them', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()

    try {
      await runToolThroughAgent('design_compose_social_cover', {
        platform: 'generic',
        ratio: '3:4',
        compositionFamily: 'split-feature',
        designDirectiveText: '竖向 3:4 的摘要封面，极简一点，不要按钮，不要粗线，更像信息摘要卡',
        themeKeywords: ['摘要卡', '极简'],
        styleGuide: {
          headlineAlign: 'left',
          ornament: 'floating-pill',
          sectionTone: 'outline',
          ctaWeight: 'none',
          density: 'airy',
        },
        contentSections: [
          { id: 'one', kind: 'headline', title: '核心结论', body: '一句话说明主题、对象和结论。' },
          { id: 'two', kind: 'proof', title: '补充信息', body: '用一小段话补证据、方法或限制条件。' },
          { id: 'three', kind: 'supporting', title: '替换备注', body: '这里放可替换的轻备注，而不是 CTA 按钮。' },
        ],
      }, harness)

      const shapes = Array.from(harness.editor.shapes.values())
      const hasButton = shapes.some((shape) => shape.type === 'ui-button')
      const hasWideDivider = shapes.some((shape) => (
        shape.type === 'ui-text-block'
        && Number(shape.props.h || 0) <= 12
        && Number(shape.props.w || 0) >= 300
      ))

      assert.equal(hasButton, false)
      assert.equal(hasWideDivider, false)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('cancels a running design controller when the scope is marked cancelled', async () => {
    const windowHarness = createWindowHarness()
    const harness = createIntegrationHarness()
    const cancellationState = { phase: 'tool_running' }

    try {
      const pending = handleModuleToolAction({
        scopeId: 'scope-design',
        agentName: 'designer',
        tool: 'design.runTaskController',
        args: {
          taskType: 'social-cover',
          platform: 'xiaohongshu',
          ratio: '9:16',
          sectionCount: 4,
          designDirectiveText: '生成一个竖向 9:16 封面，标题居中，信息区四组，海报感更强一些',
        },
        runId: 'run-design',
        activateWorkbenchMode: harness.activateWorkbenchMode.bind(harness),
        upsertScopeRunState: harness.upsertScopeRunState,
        getScopeRunState: () => ({
          ...(harness.scopeState || {}),
          phase: cancellationState.phase,
        }) as any,
      })

      setTimeout(() => {
        cancellationState.phase = 'cancelled'
      }, 260)

      await pending

      const traceTexts = (harness.scopeState?.toolTrace || []).map((item: { text?: string }) => String(item.text || ''))
      assert.equal(harness.scopeState?.phase, 'cancelled')
      assert.ok(traceTexts.some((text) => /已停止当前设计执行|已停止当前运行/.test(text)))
      assert.equal(traceTexts.some((text) => text.includes('截图验收')), false)
    } finally {
      harness.dispose()
      windowHarness.restore()
    }
  })

  it('waits for the design editor to mount before executing a queued cover composition', async () => {
    const windowHarness = createWindowHarness()
    const editor = new FakeDesignEditor()
    const editorRef = { current: null as any }
    const activeFileRef = { current: '/tmp/design-demo.tldr' }
    let dirty = false
    let scopeState: Record<string, unknown> | null = null
    let actionPromise: Promise<void> | null = null

    const dispose = registerModuleAgentHandler('design', createDesignAgentHandler({
      editorRef,
      activeFileRef,
      isDirty: dirty,
      saveStatus: 'idle',
      loadDesignFileIntoEditor: async () => true,
      flushSave: async () => true,
      exportCurrentDesign: async () => '/tmp/export.png',
      markDirty: () => { dirty = true },
      markSaved: () => { dirty = false },
      selectWorkspaceFile: () => { /* noop */ },
      setActiveFile: () => { /* noop */ },
    }))

    const upsertScopeRunState = (_scopeId: string, updater: (previous: any) => any) => {
      scopeState = updater(scopeState)
    }

    try {
      const raw = await executeDesignTool('design_compose_social_cover', { platform: 'xiaohongshu', ratio: '9:16' }, {
        emitToolAction: (tool, args) => {
          actionPromise = (async () => {
            setTimeout(() => {
              editorRef.current = editor as any
            }, 80)

            await handleModuleToolAction({
              scopeId: 'scope-design',
              agentName: 'designer',
              tool,
              args,
              runId: 'run-design',
              activateWorkbenchMode: () => { /* noop */ },
              upsertScopeRunState,
            })
          })()
        },
      })

      if (actionPromise) {
        await actionPromise
      }

      assert.ok(raw.includes('design.composeSocialCover'))
      assert.ok(editor.shapes.size > 0)
      assert.equal(dirty, true)
      assert.match(String(scopeState?.toolTrace?.at(-1)?.text || ''), /封面|闭环生成|版面审查/)
    } finally {
      dispose()
      windowHarness.restore()
    }
  })
})
