import type { TLEditorSnapshot } from '@tldraw/editor'
import type { MutableRefObject } from 'react'
import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import {
  applyColorIntentToPalette,
  extractDesignSemanticControls,
  getDefaultSectionCountForRatio,
  getDesignRatioProfile,
  getDimensionsForDesignRatio,
  inferDesignPlatformFromText,
  inferDesignRatioFromDimensions,
  normalizeDesignRatio,
  normalizeDesignPlatform,
  parseDesignRatioFromText,
} from '../../../shared/design-agent'
import type {
  DesignBatchOp,
  DesignBoardPlan,
  DesignBrief,
  DesignControllerPhase,
  DesignCompositionFamily,
  DesignContentSection,
  DesignExecutionResult,
  DesignExecutionProgram,
  DesignExecutionProgramStage,
  DesignExecutionStep,
  DesignLayoutBudget,
  DesignLayoutBlueprint,
  DesignLayoutStrategyPlan,
  DesignObservation,
  DesignPalette,
  DesignPlatform,
  DesignPlacementStrategy,
  DesignRatio,
  DesignRequestSpec,
  DesignSemanticControls,
  DesignStylePreset,
  DesignTaskType,
  DesignRepairScope,
  DesignRepairPlan,
  DesignReviewIssue,
  DesignReviewReport,
  DesignResolvedPlan,
  DesignSceneNode,
  DesignScenePlan,
  DesignStyleSystem,
  DesignStyleGuide,
  DesignTypographyPlan,
  DesignMutationStats,
  DesignRunCapture,
  DesignWorkPlan,
} from '../../../shared/design-agent'
import { DESIGN_CUSTOM_SHAPE_TYPES, getComponentDefaults, type DesignCustomShapeType } from '../../components/design/shapes'
import type { ModuleAgentActionHandler } from '../../utils/moduleAgentBridge'
import { useDesignSession } from '../../stores/useDesignSession'
import {
  buildDesignLayoutDigest,
  collectPageShapeSummaries,
  findEmptyCanvasSpace,
  hashDesignSnapshot,
  waitForReadyEditor,
} from './layout-digest'

const PALETTES: Record<string, DesignPalette> = {
  'warm-editorial': {
    name: 'warm-editorial',
    background: '#FDF6F0',
    surface: '#FFF9F4',
    primaryText: '#2C2C2C',
    secondaryText: '#8C7B6B',
    accent: '#D4A574',
    accentSoft: '#E8D5C4',
    contrastAccent: '#5B8DEF',
  },
  'github-dark': {
    name: 'github-dark',
    background: '#0D1117',
    surface: '#161B22',
    primaryText: '#E6EDF3',
    secondaryText: '#8B949E',
    accent: '#2F81F7',
    accentSoft: '#1F2937',
    contrastAccent: '#FB8C00',
  },
  'clean-neutral': {
    name: 'clean-neutral',
    background: '#F8FAFC',
    surface: '#FFFFFF',
    primaryText: '#111827',
    secondaryText: '#6B7280',
    accent: '#2563EB',
    accentSoft: '#DBEAFE',
    contrastAccent: '#EA7A19',
  },
}

interface DesignControllerEvent {
  kind: 'call' | 'result'
  text: string
  designPhase?: DesignControllerPhase
  designTodo?: Array<{ id: string; title: string; status: 'pending' | 'running' | 'done' | 'error' }>
  designReviewSummary?: string | null
  ownedNodeIds?: string[]
  repairScope?: DesignRepairScope
}

type DesignProgressReporter = (event: DesignControllerEvent) => void

const READY_AGENT_RUN_ID = 'readyAgentRunId'
const READY_PLAN_STEP_ID = 'readyPlanStepId'
const READY_ROLE = 'readyRole'
const READY_REPAIR_SCOPE = 'readyRepairScope'

function getDesignProgressReporter(args: Record<string, unknown>): DesignProgressReporter | null {
  const candidate = (args as { __onProgress?: unknown }).__onProgress
  return typeof candidate === 'function' ? candidate as DesignProgressReporter : null
}

function getDesignCancelChecker(args: Record<string, unknown>): (() => boolean) | null {
  const candidate = (args as { __shouldCancel?: unknown }).__shouldCancel
  return typeof candidate === 'function' ? candidate as () => boolean : null
}

function createAbortError(): Error {
  const error = new Error('Operation aborted')
  error.name = 'AbortError'
  return error
}

function assertDesignNotCancelled(checker: (() => boolean) | null): void {
  if (checker?.()) throw createAbortError()
}

async function yieldControllerFrame(delayMs = 180, checker: (() => boolean) | null = null): Promise<void> {
  assertDesignNotCancelled(checker)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  assertDesignNotCancelled(checker)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function buildOwnershipMeta(params: {
  runId: string | null
  stepId?: string
  role?: string
  repairScope: DesignRepairScope
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  return omitUndefinedFields({
    [READY_AGENT_RUN_ID]: params.runId || undefined,
    [READY_PLAN_STEP_ID]: params.stepId,
    [READY_ROLE]: params.role,
    [READY_REPAIR_SCOPE]: params.repairScope,
    ...(params.extra || {}),
  })
}

function shapeMeta(shape: TLShape | null | undefined): Record<string, unknown> {
  const candidate = (shape as TLShape & { meta?: Record<string, unknown> } | null | undefined)?.meta
  return isPlainRecord(candidate) ? candidate : {}
}

function getShapeRole(shape: TLShape | null | undefined): string {
  const meta = shapeMeta(shape)
  return typeof meta[READY_ROLE] === 'string' ? String(meta[READY_ROLE]) : ''
}

function getShapeRunId(shape: TLShape | null | undefined): string | null {
  const meta = shapeMeta(shape)
  return typeof meta[READY_AGENT_RUN_ID] === 'string' ? String(meta[READY_AGENT_RUN_ID]) : null
}

function getPathBasename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function clampDimension(value: unknown, fallback: number, minimum: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(minimum, Math.round(numeric))
}

function omitUndefinedFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  )
}

function toSerializableValue(value: unknown): unknown {
  if (value === undefined) return null
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((item) => toSerializableValue(item))
  if (typeof value === 'function') return undefined
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, toSerializableValue(child)])
        .filter(([, child]) => child !== undefined),
    )
  }
  return String(value)
}

function containsUndefinedDeep(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.some((item) => containsUndefinedDeep(item))
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some((item) => containsUndefinedDeep(item))
}

function buildRichTextDoc(text: string) {
  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: text.trim()
        ? [{ type: 'text', text: text.trim() }]
        : [],
    }],
  }
}

function resolvePoint(editor: Editor, args: Record<string, unknown>, width: number, height: number): { x: number; y: number } {
  const viewport = editor.getViewportPageBounds()
  const x = Number.isFinite(Number(args.x)) ? Number(args.x) : viewport.x + viewport.w / 2 - width / 2
  const y = Number.isFinite(Number(args.y)) ? Number(args.y) : viewport.y + viewport.h / 2 - height / 2
  return { x, y }
}

function inferShapeSummaryLabel(shape: TLShape): string {
  const props = ((shape as unknown) as { props?: Record<string, unknown> }).props || {}
  const candidate = props.title ?? props.label ?? props.value ?? props.content
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 40) : shape.type
}

function createNativeText(editor: Editor, args: Record<string, unknown>) {
  const text = String(args.text || '').trim()
  if (!text) throw new Error('design.createText 缺少 text')
  const { x, y } = resolvePoint(editor, args, 240, 48)
  const id = createShapeId()
  editor.createShape({
    id,
    type: 'text',
    x,
    y,
    props: {
      richText: buildRichTextDoc(text),
    },
    ...(isPlainRecord(args.meta) ? { meta: omitUndefinedFields(args.meta) } : {}),
  } as never)
  return { id, summaryLabel: text.slice(0, 40) }
}

function createDesignComponent(
  editor: Editor,
  type: DesignCustomShapeType,
  args: Record<string, unknown>,
) {
  const source = args.props && typeof args.props === 'object'
    ? { ...(args.props as Record<string, unknown>) }
    : { ...args }
  const defaults = { ...getComponentDefaults(type) } as Record<string, unknown>

  if ('w' in defaults) defaults.w = clampDimension(args.w ?? source.w, Number(defaults.w), 24)
  if ('h' in defaults) defaults.h = clampDimension(args.h ?? source.h, Number(defaults.h), 20)

  switch (type) {
    case 'ui-button':
      if (typeof source.label === 'string' && source.label.trim()) defaults.label = source.label.trim()
      if (source.variant === 'primary' || source.variant === 'secondary' || source.variant === 'ghost') defaults.variant = source.variant
      break
    case 'ui-input':
      if (typeof source.label === 'string' && source.label.trim()) defaults.label = source.label.trim()
      if (typeof source.placeholder === 'string' && source.placeholder.trim()) defaults.placeholder = source.placeholder.trim()
      if (source.variant === 'default' || source.variant === 'filled') defaults.variant = source.variant
      break
    case 'ui-card':
      if (typeof source.title === 'string' && source.title.trim()) defaults.title = source.title.trim()
      break
    case 'ui-text-block':
      if (typeof source.content === 'string' && source.content.trim()) defaults.content = source.content.trim()
      else throw new Error('design.createTextBlock 缺少 content')
      if (Number.isFinite(Number(source.fontSize))) defaults.fontSize = Math.max(10, Math.round(Number(source.fontSize)))
      if (typeof source.color === 'string' && source.color.trim()) defaults.color = source.color.trim()
      break
    case 'ui-image-placeholder':
      if (typeof source.label === 'string' && source.label.trim()) defaults.label = source.label.trim()
      if (source.aspectRatio === '16:9' || source.aspectRatio === '4:3' || source.aspectRatio === '1:1') defaults.aspectRatio = source.aspectRatio
      break
    case 'ui-page-header':
      if (typeof source.title === 'string' && source.title.trim()) defaults.title = source.title.trim()
      else throw new Error('design.createPageHeader 缺少 title')
      if (typeof source.eyebrow === 'string' && source.eyebrow.trim()) defaults.eyebrow = source.eyebrow.trim()
      if (typeof source.meta === 'string' && source.meta.trim()) defaults.meta = source.meta.trim()
      if (typeof source.actionLabel === 'string' && source.actionLabel.trim()) defaults.actionLabel = source.actionLabel.trim()
      break
    case 'ui-section-block':
      if (typeof source.title === 'string' && source.title.trim()) defaults.title = source.title.trim()
      else throw new Error('design.createSectionBlock 缺少 title')
      if (typeof source.description === 'string' && source.description.trim()) defaults.description = source.description.trim()
      if (Number.isFinite(Number(source.columns))) {
        defaults.columns = Math.max(1, Math.min(3, Math.round(Number(source.columns)))) as 1 | 2 | 3
      }
      break
    case 'ui-stat-card':
      if (typeof source.label === 'string' && source.label.trim()) defaults.label = source.label.trim()
      if (typeof source.value === 'string' && source.value.trim()) defaults.value = source.value.trim()
      else throw new Error('design.createStatCard 缺少 value')
      if (typeof source.delta === 'string' && source.delta.trim()) defaults.delta = source.delta.trim()
      break
    case 'ui-list-item':
      if (typeof source.title === 'string' && source.title.trim()) defaults.title = source.title.trim()
      else throw new Error('design.createListItem 缺少 title')
      if (typeof source.meta === 'string' && source.meta.trim()) defaults.meta = source.meta.trim()
      if (typeof source.description === 'string' && source.description.trim()) defaults.description = source.description.trim()
      break
  }

  const width = Number(defaults.w || 160)
  const height = Number(defaults.h || 100)
  const { x, y } = resolvePoint(editor, args, width, height)
  const id = createShapeId()
  editor.createShape({
    id,
    type,
    x,
    y,
    props: defaults,
    ...(isPlainRecord(args.meta) ? { meta: omitUndefinedFields(args.meta) } : {}),
  } as never)

  const shape = editor.getShape(id) as TLShape | undefined
  return {
    id,
    summaryLabel: shape ? inferShapeSummaryLabel(shape) : type,
  }
}

function createStyledTextBlock(
  editor: Editor,
  args: {
    x: number
    y: number
    w: number
    h: number
    content: string
    fontSize: number
    fillColor?: string
    fillOpacity?: number
    textColor?: string
    fontWeight?: 'regular' | 'medium' | 'bold'
    lineHeight?: number
    paddingH?: number
    paddingV?: number
    cornerRadius?: number
    shadowEnabled?: boolean
    shadowColor?: string
    shadowOpacity?: number
    shadowBlur?: number
    shadowX?: number
    shadowY?: number
    textAlign?: 'start' | 'middle' | 'end'
    fontFamily?: 'serif' | 'mono' | 'draw' | 'sans'
    strokeVisible?: boolean
    strokeColor?: string
    strokeWidth?: number
    strokeOpacity?: number
    strokeDash?: 'solid' | 'dashed' | 'dotted'
    letterSpacing?: number
    clipContent?: boolean
    meta?: Record<string, unknown>
  },
) {
  const normalizedContent = args.content.trim() ? args.content : '.'
  const result = createDesignComponent(editor, 'ui-text-block', {
    x: args.x,
    y: args.y,
    w: args.w,
    h: args.h,
    content: normalizedContent,
    fontSize: args.fontSize,
    color: args.textColor || '#111827',
    meta: args.meta,
  })

  editor.updateShape({
    id: result.id,
    type: 'ui-text-block',
    meta: omitUndefinedFields({
      ...(args.meta || {}),
      readyFillVisible: Boolean(args.fillColor),
      readyFillStyle: args.fillColor ? 'semi' : 'none',
      readyFillColor: args.fillColor || '#FFFFFF',
      readyFillOpacity: args.fillOpacity ?? 100,
      readyTextColor: args.textColor || '#111827',
      readyFontWeight: args.fontWeight || 'regular',
      readyTextAlign: args.textAlign,
      readyFontFamily: args.fontFamily,
      readyLetterSpacing: args.letterSpacing,
      readyLineHeight: args.lineHeight,
      readyPaddingH: args.paddingH ?? 0,
      readyPaddingV: args.paddingV ?? 0,
      readyCornerRadius: args.cornerRadius ?? 0,
      readyStrokeVisible: args.strokeVisible ?? false,
      readyStrokeColor: args.strokeColor,
      readyStrokeWidth: args.strokeWidth,
      readyStrokeOpacity: args.strokeOpacity,
      readyStrokeDash: args.strokeDash,
      readyDropShadowEnabled: args.shadowEnabled === true,
      readyDropShadowColor: args.shadowColor || '#000000',
      readyDropShadowOpacity: args.shadowOpacity ?? 0,
      readyDropShadowBlur: args.shadowBlur ?? 0,
      readyDropShadowX: args.shadowX ?? 0,
      readyDropShadowY: args.shadowY ?? 2,
      readyClipContent: args.clipContent === true,
    }),
  } as never)

  return result.id as TLShapeId
}

function createGeoShape(
  editor: Editor,
  args: Record<string, unknown>,
): { id: TLShapeId; summaryLabel: string } {
  const shape = String(args.shape || '').trim()
  const label = typeof args.label === 'string' ? args.label.trim() : ''
  const fillColor = typeof args.fillColor === 'string' ? args.fillColor.trim() : '#E5E7EB'
  const textColor = typeof args.textColor === 'string' ? args.textColor.trim() : '#111827'

  if (shape === 'circle' || shape === 'pill' || shape === 'rectangle') {
    const fallbackW = shape === 'pill' ? 140 : 48
    const fallbackH = shape === 'pill' ? 40 : 48
    const rawW = clampDimension(args.w, fallbackW, 12)
    const rawH = clampDimension(args.h, fallbackH, 12)
    const w = shape === 'circle' ? Math.max(rawW, rawH) : rawW
    const h = shape === 'circle' ? w : rawH
    const { x, y } = resolvePoint(editor, args, w, h)
    const hiddenTextColor = label ? textColor : fillColor
    const id = createStyledTextBlock(editor, {
      x,
      y,
      w,
      h,
      content: label || '.',
      fontSize: shape === 'pill' ? Math.max(12, Math.round(h * 0.34)) : Math.max(12, Math.round(Math.min(w, h) * 0.34)),
      fillColor,
      fillOpacity: 100,
      textColor: hiddenTextColor,
      fontWeight: 'medium',
      lineHeight: h,
      paddingH: shape === 'pill' ? Math.round(h * 0.45) : 0,
      paddingV: 0,
      cornerRadius: shape === 'rectangle' ? 0 : Math.round(h / 2),
    })
    return {
      id,
      summaryLabel: label || shape,
    }
  }

  const w = clampDimension(args.w, 160, 24)
  const h = clampDimension(args.h, 120, 20)
  const { x, y } = resolvePoint(editor, args, w, h)
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'geo',
      x,
    y,
    props: {
      geo: 'ellipse',
      dash: 'draw',
      url: '',
      w,
      h,
      growY: 0,
      scale: 1,
      labelColor: textColor === '#FFFFFF' ? 'white' : 'black',
      color: 'blue',
      fill: 'solid',
      size: 'm',
      font: 'sans',
      align: 'middle',
        verticalAlign: 'middle',
        richText: buildRichTextDoc(label),
      },
      ...(isPlainRecord(args.meta) ? { meta: omitUndefinedFields(args.meta) } : {}),
    } as never)
    return { id, summaryLabel: label || shape }
  }

function createFrame(
  editor: Editor,
  args: Record<string, unknown>,
): { id: TLShapeId; summaryLabel: string } {
  const w = clampDimension(args.w, 540, 24)
  const h = clampDimension(args.h, 720, 24)
  const { x, y } = resolvePoint(editor, args, w, h)
  const id = createShapeId()
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Frame'
  editor.createShape({
    id,
    type: 'frame',
    x,
    y,
    props: {
      w,
      h,
      name,
    },
    ...(isPlainRecord(args.meta) ? { meta: omitUndefinedFields(args.meta) } : {}),
  } as never)
  return {
    id: id as TLShapeId,
    summaryLabel: name,
  }
}

function arrangeSelection(editor: Editor, args: Record<string, unknown>): string {
  const mode = String(args.mode || '').trim()
  const gap = Number.isFinite(Number(args.gap)) ? Math.max(0, Number(args.gap)) : 16
  const ids = editor.getSelectedShapeIds() as TLShapeId[]
  if (ids.length < 2) throw new Error('design.arrangeSelection 需要至少两个已选元素')

  if (mode === 'align-left') {
    editor.alignShapes(ids, 'left')
    return '已左对齐选中元素。'
  }
  if (mode === 'align-center') {
    editor.alignShapes(ids, 'center-horizontal')
    return '已居中对齐选中元素。'
  }
  if (mode === 'align-right') {
    editor.alignShapes(ids, 'right')
    return '已右对齐选中元素。'
  }
  if (mode === 'distribute-horizontal') {
    editor.distributeShapes(ids, 'horizontal')
    return '已水平分布选中元素。'
  }
  if (mode === 'distribute-vertical') {
    editor.distributeShapes(ids, 'vertical')
    return '已垂直分布选中元素。'
  }

  const items = ids
    .map((id) => {
      const shape = editor.getShape(id) as TLShape | undefined
      const bounds = editor.getShapePageBounds(id)
      if (!shape || !bounds) return null
      return { shape, bounds }
    })
    .filter(Boolean) as Array<{ shape: TLShape; bounds: { x: number; y: number; w: number; h: number } }>

  if (items.length < 2) throw new Error('design.arrangeSelection 无法解析选区边界')

  if (mode === 'stack-vertical') {
    const minX = Math.min(...items.map((item) => item.bounds.x))
    items.sort((a, b) => a.bounds.y - b.bounds.y)
    let cursor = items[0].bounds.y
    editor.updateShapes(items.map((item) => {
      const patch = { id: item.shape.id, type: item.shape.type, x: Math.round(minX), y: Math.round(cursor) }
      cursor += item.bounds.h + gap
      return patch
    }) as never)
    return `已按 ${gap}px 间距垂直堆叠选中元素。`
  }

  if (mode === 'stack-horizontal') {
    const minY = Math.min(...items.map((item) => item.bounds.y))
    items.sort((a, b) => a.bounds.x - b.bounds.x)
    let cursor = items[0].bounds.x
    editor.updateShapes(items.map((item) => {
      const patch = { id: item.shape.id, type: item.shape.type, x: Math.round(cursor), y: Math.round(minY) }
      cursor += item.bounds.w + gap
      return patch
    }) as never)
    return `已按 ${gap}px 间距水平堆叠选中元素。`
  }

  throw new Error(`Unsupported arrange mode: ${mode}`)
}

function composeContentLayout(editor: Editor, args: Record<string, unknown>) {
  const template = String(args.template || 'editorial').trim().toLowerCase()
  if (!['editorial', 'dashboard', 'landing'].includes(template)) {
    throw new Error('design.composeContentLayout 仅支持 editorial / dashboard / landing')
  }

  const viewport = editor.getViewportPageBounds()
  const baseX = Number.isFinite(Number(args.x)) ? Number(args.x) : viewport.x + 48
  const baseY = Number.isFinite(Number(args.y)) ? Number(args.y) : viewport.y + 48
  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim()
    : template === 'dashboard'
      ? 'Dashboard Overview'
      : template === 'landing'
        ? 'Launch a structured content story'
        : 'Editorial Content System'

  const createdIds: TLShapeId[] = []
  const insert = (type: DesignCustomShapeType, x: number, y: number, overrides: Record<string, unknown>) => {
    const result = createDesignComponent(editor, type, { ...overrides, x, y })
    createdIds.push(result.id as TLShapeId)
  }

  if (template === 'editorial') {
    insert('ui-page-header', baseX, baseY, { title, eyebrow: 'Editorial', meta: 'Long-form content layout · Nested structure', actionLabel: 'Review Draft', w: 760 })
    insert('ui-text-block', baseX, baseY + 156, { content: 'Lead paragraph, summary, and framing copy sit near the hero asset so readers understand the hierarchy before entering the full section stack.', w: 360, h: 152 })
    insert('ui-image-placeholder', baseX + 392, baseY + 156, { label: 'Hero Media', aspectRatio: '16:9', w: 368, h: 208 })
    insert('ui-section-block', baseX, baseY + 396, { title: 'Highlights', description: 'Three-column editorial modules for body content, pull quotes, and related resources.', columns: 3, w: 760, h: 252 })
    insert('ui-list-item', baseX, baseY + 672, { title: 'Key Takeaway', meta: 'Section summary', description: 'Compact list rows provide readable lower-level content blocks after the main sections.', w: 760 })
  }

  if (template === 'dashboard') {
    insert('ui-page-header', baseX, baseY, { title, eyebrow: 'Dashboard', meta: 'Weekly operating view · Updated live', actionLabel: 'Export Report', w: 760 })
    insert('ui-stat-card', baseX, baseY + 156, { label: 'Reach', value: '182.4K', delta: '+8.2%' })
    insert('ui-stat-card', baseX + 248, baseY + 156, { label: 'CTR', value: '6.4%', delta: '+0.8%' })
    insert('ui-stat-card', baseX + 496, baseY + 156, { label: 'Leads', value: '342', delta: '-2.1%' })
    insert('ui-section-block', baseX, baseY + 332, { title: 'Breakdown', description: 'Use larger section shells for charts, tables, or regional analysis blocks.', columns: 2, w: 760, h: 260 })
    insert('ui-list-item', baseX, baseY + 620, { title: 'North America', meta: 'Top region', description: 'Acquisition up 14% week-over-week.', w: 760 })
    insert('ui-list-item', baseX, baseY + 728, { title: 'Retention Risk', meta: 'Watchlist', description: 'One lower-performing segment needs a content refresh.', w: 760 })
  }

  if (template === 'landing') {
    insert('ui-page-header', baseX, baseY, { title, eyebrow: 'Launch', meta: 'Campaign page skeleton', actionLabel: 'Get Started', w: 760 })
    insert('ui-button', baseX, baseY + 154, { label: 'Primary CTA', variant: 'primary', w: 160 })
    insert('ui-button', baseX + 178, baseY + 154, { label: 'Secondary CTA', variant: 'secondary', w: 168 })
    insert('ui-image-placeholder', baseX + 440, baseY + 154, { label: 'Hero Visual', aspectRatio: '4:3', w: 320, h: 220 })
    insert('ui-text-block', baseX, baseY + 214, { content: 'Landing layouts need an obvious action path, a visual anchor, and immediately readable supporting copy.', w: 392, h: 160 })
    insert('ui-section-block', baseX, baseY + 410, { title: 'Feature Breakdown', description: 'A lower-level section block keeps cards, stories, and proof points in the same rhythm.', columns: 3, w: 760, h: 240 })
    insert('ui-list-item', baseX, baseY + 674, { title: 'Social Proof', meta: 'Case study', description: 'Use row components below the hero zone for details and evidence.', w: 760 })
  }

  editor.setSelectedShapes(createdIds)
  return { count: createdIds.length, template }
}

function normalizePalette(value: unknown, platform: string): DesignPalette {
  if (value && typeof value === 'object') {
    const palette = value as Record<string, unknown>
    const requiredKeys = ['name', 'background', 'surface', 'primaryText', 'secondaryText', 'accent', 'accentSoft']
    if (requiredKeys.every((key) => typeof palette[key] === 'string' && String(palette[key]).trim())) {
      return {
        name: String(palette.name),
        background: String(palette.background),
        surface: String(palette.surface),
        primaryText: String(palette.primaryText),
        secondaryText: String(palette.secondaryText),
        accent: String(palette.accent),
        accentSoft: String(palette.accentSoft),
        ...(typeof palette.contrastAccent === 'string' && palette.contrastAccent.trim()
          ? { contrastAccent: String(palette.contrastAccent) }
          : {}),
      }
    }
  }
  return platform === 'xiaohongshu' ? PALETTES['warm-editorial'] : PALETTES['clean-neutral']
}

function inferPaletteForArgs(args: Record<string, unknown>, platform: string): DesignPalette {
  if (isPlainRecord(args.palette)) {
    return normalizePalette(args.palette, platform)
  }
  const signals = readDesignSignalProfile(args)
  const basePalette =
    signals.prefersDark
      ? PALETTES['github-dark']
      : signals.prefersWarm || platform === 'xiaohongshu'
        ? PALETTES['warm-editorial']
        : PALETTES['clean-neutral']
  return applyColorIntentToPalette(basePalette, signals.rawText)
}

function normalizeCompositionFamily(args: Record<string, unknown>, palette: DesignPalette, sectionCount: number): DesignCompositionFamily {
  const requested = String(args.compositionFamily || '').trim()
  if (requested === 'editorial-stack' || requested === 'numbered-list' || requested === 'split-feature') return requested
  const signals = readDesignSignalProfile(args)
  if (signals.prefersButtons) return 'split-feature'
  if ((signals.prefersSideMeta || signals.prefersSparseContent) && sectionCount <= 2) return 'editorial-stack'
  if ((signals.prefersPoster || signals.prefersEditorial || signals.prefersCenter || signals.prefersMinimal) && sectionCount <= 3) {
    return 'editorial-stack'
  }
  if (signals.prefersDense || sectionCount >= 4) return 'numbered-list'
  if (palette.name === 'github-dark' && sectionCount <= 3) {
    return signals.prefersCards ? 'numbered-list' : 'editorial-stack'
  }
  if (sectionCount >= 3) return 'numbered-list'
  return 'editorial-stack'
}

function normalizeContentSections(
  args: Record<string, unknown>,
  compositionFamily: DesignCompositionFamily,
  sectionCount: number,
  palette: DesignPalette,
): DesignContentSection[] {
  if (Array.isArray(args.contentSections)) {
    const sections = args.contentSections
      .map((item, index) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        const title = String(record.title || '').trim()
        const body = String(record.body || '').trim()
        if (!title && !body) return null
        return {
          id: typeof record.id === 'string' ? record.id : `section-${index + 1}`,
          kind: (String(record.kind || 'supporting') as DesignContentSection['kind']),
          title: title || `信息组 ${index + 1}`,
          body: body || '替换成你的实际内容。',
        }
      })
      .filter(Boolean) as DesignContentSection[]
    if (sections.length > 0) return sections.slice(0, sectionCount)
  }

  const base = palette.name === 'github-dark'
    ? [
      ['核心结论', '一句话放结果、能力或判断。', 'headline'],
      ['关键证明', '放步骤、数据、对比或实现方式。', 'proof'],
      ['补充说明', '填限制条件、场景、适用对象。', 'supporting'],
      ['行动提示', '用下一步动作、版本信息或轻量备注收口。', 'cta'],
    ]
    : compositionFamily === 'numbered-list'
      ? [
        ['主题标签', '先交代赛道、人群、场景或问题。', 'numbered-item'],
        ['核心利益点', '一句话说清结果、方法或反差。', 'numbered-item'],
        ['证明与补充', '填案例、数据、步骤或时间成本。', 'numbered-item'],
        ['行动提示', '用 CTA、日期或系列标识收口。', 'numbered-item'],
      ]
      : [
        ['主标题信息', '大标题区域承载最重要的反差或结果。', 'headline'],
        ['辅助解释', '补充副标题、场景、受众或说明。', 'supporting'],
        ['证明信息', '放数字、案例、步骤或证据。', 'proof'],
        ['行动提示', '底部补 CTA 或替换备注。', 'cta'],
      ]

  return base.slice(0, sectionCount).map((item, index) => ({
    id: `section-${index + 1}`,
    kind: item[2] as DesignContentSection['kind'],
    title: item[0],
    body: item[1],
  }))
}

function normalizePlacementStrategy(args: Record<string, unknown>): DesignPlacementStrategy {
  const value = String(args.placementStrategy || '').trim()
  if (value === 'auto-right' || value === 'auto-below' || value === 'viewport-origin' || value === 'explicit') return value
  return 'auto-right'
}

function toPagePlacement(
  editor: Editor,
  dimensions: { w: number; h: number },
  args: Record<string, unknown>,
  placementStrategy: DesignPlacementStrategy,
) {
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    return {
      x: Number(args.x),
      y: Number(args.y),
      basis: 'explicit' as const,
    }
  }

  if (placementStrategy === 'viewport-origin') {
    const viewport = editor.getViewportPageBounds()
    return {
      x: Math.round(viewport.x + 48),
      y: Math.round(viewport.y + 48),
      basis: 'viewport-origin' as const,
    }
  }

  const empty = findEmptyCanvasSpace(editor, dimensions, {
    direction: placementStrategy === 'auto-below' ? 'below' : 'right',
    padding: 100,
  })
  return {
    x: empty.x,
    y: empty.y,
    basis: empty.basis,
  }
}

function createCoverBoard(
  editor: Editor,
  createdIds: TLShapeId[],
  palette: DesignPalette,
  baseX: number,
  baseY: number,
  width: number,
  height: number,
  radius: number,
) {
  const boardId = createStyledTextBlock(editor, {
    x: baseX,
    y: baseY,
    w: width,
    h: height,
    content: ' ',
    fontSize: 1,
    fillColor: palette.background,
    fillOpacity: 100,
    textColor: palette.background,
    cornerRadius: radius,
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowOpacity: palette.name === 'github-dark' ? 30 : 14,
    shadowBlur: Math.round(radius * 0.9),
    shadowY: Math.round(radius * 0.35),
    clipContent: true,
  })
  createdIds.push(boardId)
}

type CoverNodeRole =
  | 'board'
  | 'badge'
  | 'title'
  | 'subtitle'
  | 'divider'
  | 'section'
  | 'index'
  | 'cta-panel'
  | 'cta-button'
  | 'footer'

type CoverRenderNode =
  | {
    kind: 'text'
    role: CoverNodeRole
    x: number
    y: number
    w: number
    h: number
    content: string
    fontSize: number
    textColor?: string
    fillColor?: string
    fillOpacity?: number
    fontWeight?: 'regular' | 'medium' | 'bold'
    textAlign?: 'start' | 'middle' | 'end'
    fontFamily?: 'serif' | 'mono' | 'draw' | 'sans'
    strokeVisible?: boolean
    strokeColor?: string
    strokeWidth?: number
    strokeOpacity?: number
    strokeDash?: 'solid' | 'dashed' | 'dotted'
    letterSpacing?: number
    lineHeight?: number
    paddingH?: number
    paddingV?: number
    cornerRadius?: number
    clipContent?: boolean
  }
  | {
    kind: 'geo'
    role: CoverNodeRole
    shape: 'rectangle' | 'circle' | 'pill'
    x: number
    y: number
    w: number
    h: number
    label?: string
    fillColor?: string
    textColor?: string
  }
  | {
    kind: 'button'
    role: CoverNodeRole
    x: number
    y: number
    w: number
    h: number
    label: string
    variant: 'primary' | 'secondary' | 'ghost'
  }

interface CoverResolvedSpec {
  baseX: number
  baseY: number
  width: number
  height: number
  palette: DesignPalette
  styleGuide: DesignStyleGuide
  title: string
  subtitle: string
  sections: DesignContentSection[]
  badgeLabel: string
  footerText: string
  compositionFamily: DesignCompositionFamily
  variant: string
  board: DesignBoardPlan
  typography: DesignTypographyPlan
  layoutStrategy: DesignLayoutStrategyPlan
  layoutBlueprint: DesignLayoutBlueprint
}

interface CoverReviewResult {
  attempts: number
  overflowX: number
  overflowY: number
  compacted: boolean
}

interface DesignSignalProfile {
  rawText: string
  prefersCenter: boolean
  prefersMinimal: boolean
  prefersDense: boolean
  prefersLargeElements: boolean
  prefersSparseContent: boolean
  prefersSideMeta: boolean
  prefersContrastAccent: boolean
  prefersQuietFooter: boolean
  prefersButtons: boolean
  avoidsButtons: boolean
  prefersOutline: boolean
  prefersRail: boolean
  prefersWarm: boolean
  prefersDark: boolean
  prefersPoster: boolean
  prefersEditorial: boolean
  prefersCards: boolean
  prefersCorners: boolean
  avoidsWideDivider: boolean
}

interface CoverCandidateCritique {
  score: number
  issues: DesignReviewIssue[]
  summary: string
}

interface CoverCandidateSolution {
  spec: CoverResolvedSpec
  nodes: CoverRenderNode[]
  review: CoverReviewResult
  critique: CoverCandidateCritique
  candidateCount: number
}

const CHINESE_COUNT_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

function parseCountToken(token: string): number | null {
  const normalized = token.trim()
  if (!normalized) return null
  if (/^\d+$/.test(normalized)) return Math.max(1, Math.min(10, Number(normalized)))
  if (normalized === '十') return 10
  if (/^十[一二两三四五六七八九]$/.test(normalized)) {
    return 10 + (CHINESE_COUNT_MAP[normalized.slice(1)] || 0)
  }
  if (/^[一二两三四五六七八九]十$/.test(normalized)) {
    return (CHINESE_COUNT_MAP[normalized[0]] || 0) * 10
  }
  if (/^[一二两三四五六七八九]十[一二两三四五六七八九]$/.test(normalized)) {
    return ((CHINESE_COUNT_MAP[normalized[0]] || 0) * 10) + (CHINESE_COUNT_MAP[normalized[2]] || 0)
  }
  return CHINESE_COUNT_MAP[normalized] || null
}

function parseExplicitCanvasDimensionsFromText(text: string): { w: number; h: number } | null {
  const pattern = /(\d{3,4})\s*[x×]\s*(\d{3,4})/g
  let match: RegExpExecArray | null = pattern.exec(text)
  let last: { w: number; h: number } | null = null
  while (match) {
    last = {
      w: Math.max(120, Number(match[1])),
      h: Math.max(120, Number(match[2])),
    }
    match = pattern.exec(text)
  }
  return last
}

function parseSectionCountFromText(text: string): number | null {
  const explicitPatterns = [
    /([0-9一二两三四五六七八九十]{1,3})\s*(组|条|栏|块|个)\s*(文案|信息|信息区|模块|内容|sections?|cards?)/i,
    /([0-9一二两三四五六七八九十]{1,3})\s*(级|层级)\s*(排版|结构)/i,
  ]

  for (const pattern of explicitPatterns) {
    const match = text.match(pattern)
    if (!match) continue
    const parsed = parseCountToken(match[1] || '')
    if (parsed) return parsed
  }

  if (/(两级排版结构|二级排版结构|2级排版结构|两级结构|二层级|2 层级)/i.test(text)) return 2
  if (/(三级排版结构|3级排版结构|三层级)/i.test(text)) return 3
  if (/(只有标题和标题旁边的附加信息|只有标题和旁边的附加信息|标题旁边的附加信息|只要标题和附加信息)/i.test(text)) return 1
  if (/(标题和子标题[、,，/ ]+账号名.*三个信息)/i.test(text)) return 3
  return null
}

function resolveSectionCountFromPrompt(
  text: string,
  ratio: DesignRatio,
  controls: DesignSemanticControls,
): number {
  const explicit = parseSectionCountFromText(text)
  if (explicit) return explicit
  if (controls.prefersSideMeta) return 1
  if (controls.prefersSparseContent) {
    return getDesignRatioProfile(ratio) === 'landscape' ? 2 : 1
  }
  return getDefaultSectionCountForRatio(ratio)
}

function collectDesignSignalText(args: Record<string, unknown>): string {
  const chunks: string[] = []
  if (typeof args.designDirectiveText === 'string' && args.designDirectiveText.trim()) {
    chunks.push(args.designDirectiveText.trim())
  }
  if (Array.isArray(args.decisionTrace)) {
    chunks.push(args.decisionTrace.map((item) => String(item)).filter(Boolean).join(' '))
  }
  if (typeof args.reasoningSummary === 'string' && args.reasoningSummary.trim()) {
    chunks.push(args.reasoningSummary.trim())
  }
  if (typeof args.currentTheme === 'string' && args.currentTheme.trim()) {
    chunks.push(args.currentTheme.trim())
  }
  if (typeof args.tone === 'string' && args.tone.trim()) {
    chunks.push(args.tone.trim())
  }
  if (Array.isArray(args.themeKeywords) && args.themeKeywords.length > 0) {
    chunks.push(args.themeKeywords.map((item) => String(item)).filter(Boolean).join(' '))
  }
  return chunks.join(' ').trim()
}

function applyPromptDerivedHardConstraints(args: Record<string, unknown>, taskType: DesignTaskType): Record<string, unknown> {
  const rawPrompt = collectDesignSignalText(args)
  if (!rawPrompt) return { ...args }

  const nextArgs: Record<string, unknown> = { ...args }
  const semanticControls = resolveSemanticControls(nextArgs)
  const explicitSize = parseExplicitCanvasDimensionsFromText(rawPrompt)

  if (explicitSize) {
    if (!Number.isFinite(Number(nextArgs.w)) && !Number.isFinite(Number(nextArgs.width))) nextArgs.w = explicitSize.w
    if (!Number.isFinite(Number(nextArgs.h)) && !Number.isFinite(Number(nextArgs.height))) nextArgs.h = explicitSize.h
    if (!(typeof nextArgs.ratio === 'string' && nextArgs.ratio.trim())) {
      nextArgs.ratio = inferDesignRatioFromDimensions(explicitSize.w, explicitSize.h)
    }
  }

  if (!(typeof nextArgs.ratio === 'string' && nextArgs.ratio.trim())) {
    nextArgs.ratio = parseDesignRatioFromText(rawPrompt, taskType === 'social-cover' ? '9:16' : '1:1')
  }

  if (!(typeof nextArgs.platform === 'string' && nextArgs.platform.trim())) {
    nextArgs.platform = inferDesignPlatformFromText(rawPrompt, 'generic')
  }

  if (!Number.isFinite(Number(nextArgs.sectionCount))) {
    nextArgs.sectionCount = resolveSectionCountFromPrompt(
      rawPrompt,
      normalizeDesignRatio(nextArgs.ratio, taskType === 'social-cover' ? '9:16' : '1:1'),
      semanticControls,
    )
  }

  nextArgs.semanticControls = semanticControls

  return nextArgs
}

function stripExternalDesignPlanHints(args: Record<string, unknown>): Record<string, unknown> {
  const nextArgs = { ...args }
  for (const key of [
    'brief',
    'palette',
    'compositionFamily',
    'board',
    'typography',
    'layoutStrategy',
    'styleGuide',
    'styleSystem',
    'layoutBlueprint',
    'layoutBudget',
    'scenePlan',
    'executionProgram',
    'decisionTrace',
  ]) {
    delete nextArgs[key]
  }
  return nextArgs
}

function readDesignSignalProfile(args: Record<string, unknown>): DesignSignalProfile {
  const rawText = collectDesignSignalText(args)
  const avoidsButtons = /(不要按钮|无按钮|不要cta|不要 button|no button|去掉按钮|别做按钮|不需要.*按钮|无需.*按钮|不用.*按钮)/i.test(rawText)
  const avoidsWideDivider = /(不要粗线|不要底部线|不要分割线|no divider|去掉粗线|别做粗线)/i.test(rawText)
  return {
    rawText,
    prefersCenter: /(居中|中心|center|封面感|海报感|poster)/i.test(rawText),
    prefersMinimal: /(极简|minimal|留白|airy|简洁|克制)/i.test(rawText),
    prefersDense: /(密集|高密度|dense|信息量大|步骤|清单|列表感)/i.test(rawText),
    prefersLargeElements: /(字要更大|标题更大|元素更大|更显著|更醒目|放大一点|大一点)/i.test(rawText),
    prefersSparseContent: /(信息更少|更少信息|少一点信息|只保留|只有标题|只有主标题|只有标题和|只要标题)/i.test(rawText),
    prefersSideMeta: /(标题旁边|标题右侧|标题边上|旁边的附加信息|side info)/i.test(rawText),
    prefersContrastAccent: /(对色|撞色|对比色|contrast accent|加一点对色|补一点对色)/i.test(rawText),
    prefersQuietFooter: /(底部轻一点|底部更轻|弱化底部|footer light|底部轻一些)/i.test(rawText),
    prefersButtons: !avoidsButtons && /(按钮|cta|button|call to action|操作按钮)/i.test(rawText),
    avoidsButtons,
    prefersOutline: /(outline|描边|边框|线框)/i.test(rawText),
    prefersRail: /(轨道|rail|侧栏|导轨|栏目线)/i.test(rawText),
    prefersWarm: /(暖色|奶油|柔和|小红书|米色|编辑感)/i.test(rawText),
    prefersDark: /(黑灰|黑色|深色|github|技术|dark)/i.test(rawText),
    prefersPoster: /(封面|海报|poster|首图)/i.test(rawText),
    prefersEditorial: /(杂志|editorial|编辑感|排版感)/i.test(rawText),
    prefersCards: /(卡片|card|模块卡)/i.test(rawText),
    prefersCorners: /(角标|corner|贴角)/i.test(rawText),
    avoidsWideDivider,
  }
}

function resolveSemanticControls(args: Record<string, unknown>): DesignSemanticControls {
  const derived = extractDesignSemanticControls(collectDesignSignalText(args))
  if (!(args.semanticControls && typeof args.semanticControls === 'object' && !Array.isArray(args.semanticControls))) {
    return derived
  }
  const source = args.semanticControls as Record<string, unknown>
  return {
    titleScale: Number.isFinite(Number(source.titleScale)) ? Number(source.titleScale) : derived.titleScale,
    bodyScale: Number.isFinite(Number(source.bodyScale)) ? Number(source.bodyScale) : derived.bodyScale,
    sectionScale: Number.isFinite(Number(source.sectionScale)) ? Number(source.sectionScale) : derived.sectionScale,
    titleZoneRatio: Number.isFinite(Number(source.titleZoneRatio)) ? Number(source.titleZoneRatio) : derived.titleZoneRatio,
    titleWidthRatio: Number.isFinite(Number(source.titleWidthRatio)) ? Number(source.titleWidthRatio) : derived.titleWidthRatio,
    prefersSparseContent: source.prefersSparseContent === true || derived.prefersSparseContent,
    prefersLargeElements: source.prefersLargeElements === true || derived.prefersLargeElements,
    prefersSideMeta: source.prefersSideMeta === true || derived.prefersSideMeta,
    prefersContrastAccent: source.prefersContrastAccent === true || derived.prefersContrastAccent,
    prefersQuietFooter: source.prefersQuietFooter === true || derived.prefersQuietFooter,
    cornerRadiusScale: Number.isFinite(Number(source.cornerRadiusScale)) ? Number(source.cornerRadiusScale) : derived.cornerRadiusScale,
    explicitCornerRadius: Number.isFinite(Number(source.explicitCornerRadius)) ? Number(source.explicitCornerRadius) : derived.explicitCornerRadius,
    explicitTitleFontSize: Number.isFinite(Number(source.explicitTitleFontSize)) ? Number(source.explicitTitleFontSize) : derived.explicitTitleFontSize,
    explicitBodyFontSize: Number.isFinite(Number(source.explicitBodyFontSize)) ? Number(source.explicitBodyFontSize) : derived.explicitBodyFontSize,
    explicitLineHeight: Number.isFinite(Number(source.explicitLineHeight)) ? Number(source.explicitLineHeight) : derived.explicitLineHeight,
    fontWeightMode: (typeof source.fontWeightMode === 'string' ? source.fontWeightMode : derived.fontWeightMode) as 'light' | 'regular' | 'medium' | 'bold' | 'black' | null,
    spacingScale: Number.isFinite(Number(source.spacingScale)) ? Number(source.spacingScale) : derived.spacingScale,
    alignMode: (typeof source.alignMode === 'string' ? source.alignMode : derived.alignMode) as 'left' | 'center' | 'right' | null,
    stylePreset: (typeof source.stylePreset === 'string' ? source.stylePreset : derived.stylePreset) as DesignStylePreset,
    // Stage 3D: Enhanced Semantic Controls
    explicitBackgroundColor: (typeof source.explicitBackgroundColor === 'string' ? source.explicitBackgroundColor : derived.explicitBackgroundColor),
    explicitAccentColor: (typeof source.explicitAccentColor === 'string' ? source.explicitAccentColor : derived.explicitAccentColor),
    explicitTextColor: (typeof source.explicitTextColor === 'string' ? source.explicitTextColor : derived.explicitTextColor),
    explicitBorderWidth: Number.isFinite(Number(source.explicitBorderWidth)) ? Number(source.explicitBorderWidth) : derived.explicitBorderWidth,
    explicitBorderStyle: (typeof source.explicitBorderStyle === 'string' ? source.explicitBorderStyle : derived.explicitBorderStyle) as 'solid' | 'dashed' | 'dotted' | null,
    explicitPadding: Number.isFinite(Number(source.explicitPadding)) ? Number(source.explicitPadding) : derived.explicitPadding,
    explicitGap: Number.isFinite(Number(source.explicitGap)) ? Number(source.explicitGap) : derived.explicitGap,
  }
}

function countCharUnits(text: string): number {
  let units = 0
  for (const char of text) {
    if (char === '\n') continue
    if (/\s/.test(char)) {
      units += 0.32
      continue
    }
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) {
      units += 1
      continue
    }
    if (/[A-Z0-9]/.test(char)) {
      units += 0.66
      continue
    }
    units += 0.56
  }
  return units
}

function estimateWrappedLineCount(text: string, width: number, fontSize: number): number {
  const safeWidth = Math.max(12, width)
  const lines = text.split('\n')
  let count = 0
  for (const line of lines) {
    const units = Math.max(1, countCharUnits(line.trim() || ' '))
    const estimatedWidth = units * fontSize
    count += Math.max(1, Math.ceil(estimatedWidth / safeWidth))
  }
  return Math.max(1, count)
}

function estimateTextHeight(params: {
  text: string
  width: number
  fontSize: number
  lineHeight: number
  paddingH?: number
  paddingV?: number
  maxLines?: number
}): number {
  const availableWidth = Math.max(12, params.width - (params.paddingH || 0) * 2)
  const rawLines = estimateWrappedLineCount(params.text, availableWidth, params.fontSize)
  const lines = params.maxLines ? Math.min(rawLines, params.maxLines) : rawLines
  return Math.round(lines * params.lineHeight + (params.paddingV || 0) * 2)
}

function estimateLineWidth(text: string, fontSize: number): number {
  return Math.round(countCharUnits(text) * fontSize)
}

function clampRound(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

// ============================================================================
// Stage 3A: Design System Constraint Layer
// ============================================================================

/**
 * Adjust design parameters based on board size
 * Reference size: 540x960 (9:16)
 */
function adjustForBoardSize(
  baseValue: number,
  boardWidth: number,
  boardHeight: number,
  type: 'fontSize' | 'spacing' | 'cornerRadius'
): number {
  const boardArea = boardWidth * boardHeight
  const referenceArea = 540 * 960  // 9:16 reference size
  const sizeRatio = Math.sqrt(boardArea / referenceArea)

  switch (type) {
    case 'fontSize':
      // Font size scales linearly with board size
      return Math.round(baseValue * sizeRatio)
    case 'spacing':
      // Spacing scales slower (0.8 power)
      return Math.round(baseValue * Math.pow(sizeRatio, 0.8))
    case 'cornerRadius':
      // Corner radius scales even slower (0.6 power)
      return Math.round(baseValue * Math.pow(sizeRatio, 0.6))
  }
}

/**
 * Validate font size to board height ratio
 * Reasonable range: 0.03-0.08 (3%-8% of board height)
 */
function validateFontSizeRatio(fontSize: number, boardHeight: number): boolean {
  const ratio = fontSize / boardHeight
  return ratio >= 0.03 && ratio <= 0.08
}

/**
 * Corner radius hierarchy system
 * Ensures board > card > chip descending relationship
 */
interface CornerRadiusHierarchy {
  board: number    // Board/container corner radius
  card: number     // Card corner radius
  chip: number     // Small element corner radius
}

function buildCornerRadiusHierarchy(
  baseRadius: number,
  boardWidth: number,
  boardHeight: number,
  semanticControls: DesignSemanticControls
): CornerRadiusHierarchy {
  // Apply board size awareness
  const adjustedBase = adjustForBoardSize(baseRadius, boardWidth, boardHeight, 'cornerRadius')

  // Apply semantic controls
  const scaledBase = semanticControls.explicitCornerRadius
    ?? Math.round(adjustedBase * semanticControls.cornerRadiusScale)

  // Build hierarchy (board : card : chip = 1.0 : 0.67 : 0.5)
  return {
    board: clampRound(scaledBase, 0, 40),
    card: clampRound(scaledBase * 0.67, 0, 32),
    chip: clampRound(scaledBase * 0.5, 0, 24),
  }
}

/**
 * Contrast accent strategy: defines which elements should use contrast color
 * Contrast area should occupy 10-20%
 */
interface ContrastAccentStrategy {
  useInTitle: boolean       // Whether title uses contrast color
  useInSubtitle: boolean    // Whether subtitle uses contrast color
  useInSection: boolean     // Whether section cards use contrast color
  useInOrnament: boolean    // Whether ornament elements use contrast color
  useInFooter: boolean      // Whether footer uses contrast color
  targetAreaRatio: number   // Target area ratio (0.1-0.2)
}

function buildContrastAccentStrategy(
  semanticControls: DesignSemanticControls,
  layoutStrategy: DesignLayoutStrategyPlan
): ContrastAccentStrategy {
  if (!semanticControls.prefersContrastAccent) {
    return {
      useInTitle: false,
      useInSubtitle: false,
      useInSection: false,
      useInOrnament: false,
      useInFooter: false,
      targetAreaRatio: 0,
    }
  }

  // Decide contrast distribution based on layout strategy
  // If content is sparse, contrast can be bolder (title + ornament)
  // If content is dense, contrast should be more restrained (only ornament or footer)
  const isSparse = semanticControls.prefersSparseContent

  return {
    useInTitle: isSparse,           // Sparse layout: title uses contrast
    useInSubtitle: false,           // Subtitle doesn't use contrast (avoid too much)
    useInSection: !isSparse,        // Dense layout: section uses contrast
    useInOrnament: true,            // Ornament always uses contrast
    useInFooter: !isSparse,         // Dense layout: footer uses contrast
    targetAreaRatio: 0.15,          // Target 15% area
  }
}

// ============================================================================
// Stage 3C: ReAct Loop Mechanism
// ============================================================================

/**
 * Design task item for TodoWrite mechanism
 */
interface DesignTodoItem {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  dependencies: string[]  // IDs of tasks that must complete first
  result?: {
    nodeIds: string[]
    issues: DesignReviewIssue[]
  }
}

/**
 * Design task list
 */
interface DesignTodoList {
  tasks: DesignTodoItem[]
  currentTaskId: string | null
}

/**
 * Reflection result after task execution
 */
interface ReflectionResult {
  success: boolean
  issues: DesignReviewIssue[]
  suggestions: string[]
  needsRepair: boolean
}

/**
 * Repair action to fix design issues
 */
interface RepairAction {
  type: 'update-font-size' | 'update-corner-radius' | 'adjust-accent-area' | 'fix-geometry' | 'fix-alignment'
  nodeIds: string[]
  params: Record<string, unknown>
}

/**
 * Repair result
 */
interface RepairResult {
  repaired: number
  remaining: number
  actions: RepairAction[]
}

/**
 * Decompose complex design task into subtasks
 */
function decomposeDesignTask(
  intent: string,
  semanticControls: DesignSemanticControls,
  args: Record<string, unknown>
): DesignTodoList {
  const tasks: DesignTodoItem[] = []

  // Task 1: Create board
  tasks.push({
    id: 'create-board',
    description: '创建画板容器',
    status: 'pending',
    dependencies: [],
  })

  // Task 2: Set up title area
  if (!semanticControls.prefersSparseContent || semanticControls.stylePreset === 'poster') {
    tasks.push({
      id: 'create-title',
      description: '创建标题区域',
      status: 'pending',
      dependencies: ['create-board'],
    })
  }

  // Task 3: Create content area
  if (!semanticControls.prefersSparseContent) {
    tasks.push({
      id: 'create-sections',
      description: '创建内容 sections',
      status: 'pending',
      dependencies: ['create-title'],
    })
  }

  // Task 4: Add ornament elements
  if (semanticControls.prefersContrastAccent) {
    tasks.push({
      id: 'create-ornament',
      description: '添加对色装饰',
      status: 'pending',
      dependencies: ['create-sections'],
    })
  }

  // Task 5: Verify and repair
  tasks.push({
    id: 'verify-and-repair',
    description: '验证设计并修复问题',
    status: 'pending',
    dependencies: tasks.map(t => t.id).filter(id => id !== 'verify-and-repair'),
  })

  return {
    tasks,
    currentTaskId: null,
  }
}

/**
 * Reflect on design execution result
 */
function reflectOnDesignResult(
  todoItem: DesignTodoItem,
  review: DesignReviewReport,
  semanticControls: DesignSemanticControls,
  boardHeight: number
): ReflectionResult {
  const issues: DesignReviewIssue[] = [...review.issues]
  const suggestions: string[] = []

  // Check geometry issues
  if (!review.geometryPassed) {
    issues.push({
      code: 'structure-mismatch',
      severity: 'error',
      message: '元素几何布局不合理',
    })
    suggestions.push('需要调整元素位置和尺寸')
  }

  // Check font size ratio (for title task)
  if (todoItem.id === 'create-title' && todoItem.result) {
    // This would require reading actual font sizes from created nodes
    // For now, we add a placeholder check
    suggestions.push('验证标题字号与画板高度的比例')
  }

  // Check contrast accent area (for ornament task)
  if (semanticControls.prefersContrastAccent && todoItem.id === 'create-ornament') {
    suggestions.push('验证对色元素面积占比是否在 10-20% 范围内')
  }

  return {
    success: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    suggestions,
    needsRepair: issues.length > 0,
  }
}

/**
 * Check if an issue can be auto-repaired
 */
function canAutoRepair(issue: DesignReviewIssue): boolean {
  const repairableCodes: DesignReviewIssue['code'][] = [
    'overflow',
    'visual-rhythm',
  ]
  return repairableCodes.includes(issue.code)
}

/**
 * Auto-repair design issues
 */
async function repairDesignIssues(
  editor: Editor,
  nodeIds: string[],
  issues: DesignReviewIssue[],
  semanticControls: DesignSemanticControls,
  boardHeight: number
): Promise<RepairResult> {
  const repairs: RepairAction[] = []

  for (const issue of issues) {
    switch (issue.code) {
      case 'overflow':
        // Fix overflow issues by adjusting element sizes
        repairs.push({
          type: 'fix-geometry',
          nodeIds: nodeIds,
          params: { action: 'shrink-to-fit' },
        })
        break

      case 'visual-rhythm':
        // Fix visual rhythm by adjusting spacing
        repairs.push({
          type: 'fix-alignment',
          nodeIds: nodeIds,
          params: { action: 'align-grid' },
        })
        break

      // Add more repair cases as needed
    }
  }

  // Execute repairs (placeholder - actual implementation would modify shapes)
  // For now, we just return the repair plan
  const repairedCount = repairs.filter(r => canAutoRepair({ code: 'overflow', severity: 'warning', message: '' })).length
  const remainingCount = issues.filter(i => !canAutoRepair(i)).length

  return {
    repaired: repairedCount,
    remaining: remainingCount,
    actions: repairs,
  }
}

/**
 * Execute design task with ReAct loop
 * Phase: Observe → Plan → Execute → Verify → Reflect → Repair
 */
async function executeDesignTaskWithReAct(
  editor: Editor,
  intent: string,
  args: Record<string, unknown>,
  semanticControls: DesignSemanticControls,
  boardHeight: number
): Promise<{
  status: 'success' | 'partial' | 'failed'
  nodeIds: string[]
  issues: DesignReviewIssue[]
  todoList: DesignTodoList
}> {
  // Phase 1: Plan - Decompose task
  const todoList = decomposeDesignTask(intent, semanticControls, args)

  const allNodeIds: string[] = []
  const allIssues: DesignReviewIssue[] = []

  // Phase 2: Execute - Execute tasks
  for (const task of todoList.tasks) {
    if (task.status !== 'pending') continue

    // Check dependencies
    const dependenciesCompleted = task.dependencies.every(depId =>
      todoList.tasks.find(t => t.id === depId)?.status === 'completed'
    )
    if (!dependenciesCompleted) continue

    // Execute task (placeholder - actual implementation would create shapes)
    task.status = 'in_progress'

    // Simulate task execution result
    const result = {
      nodeIds: [] as string[],
      issues: [] as DesignReviewIssue[],
    }
    task.result = result

    // Phase 3: Verify - Verify result (placeholder)
    const review: DesignReviewReport = {
      passed: true,
      geometryPassed: true,
      screenshotPassed: true,
      attempts: 1,
      executionBatches: 1,
      repairRounds: 0,
      usedScreenshotVerification: false,
      touchedSelection: false,
      issues: [],
      summary: 'Task completed',
    }

    // Phase 4: Reflect - Reflect on result
    const reflection = reflectOnDesignResult(task, review, semanticControls, boardHeight)

    // Phase 5: Repair - Repair issues if needed
    if (reflection.needsRepair) {
      const repairResult = await repairDesignIssues(
        editor,
        result.nodeIds,
        reflection.issues,
        semanticControls,
        boardHeight
      )
      allIssues.push(...reflection.issues.filter(i => !canAutoRepair(i)))
    }

    task.status = reflection.success ? 'completed' : 'failed'
    allNodeIds.push(...result.nodeIds)
  }

  return {
    status: allIssues.filter(i => i.severity === 'error').length === 0 ? 'success' : 'partial',
    nodeIds: allNodeIds,
    issues: allIssues,
    todoList,
  }
}

// ============================================================================

// ============================================================================
// Stage 3E: Multi-Board Management
// ============================================================================

/**
 * Board creation strategy
 */
interface BoardCreationStrategy {
  mode: 'single' | 'multiple' | 'variant'
  count: number
  naming: 'sequential' | 'descriptive'
}

/**
 * Infer board creation strategy from user intent
 */
function inferBoardCreationStrategy(
  intent: string,
  semanticControls: DesignSemanticControls
): BoardCreationStrategy {
  // Check if explicitly requesting multiple variants
  const variantMatch = intent.match(/(\d+)\s*(?:个|种)?(?:变体|版本|方案)/i)
  if (variantMatch) {
    return {
      mode: 'variant',
      count: Number(variantMatch[1]),
      naming: 'descriptive',
    }
  }

  // Check if contains multiple independent requests (connected by "和", "以及", "还有")
  const multipleRequests = intent.split(/[，,；;]|(?:和|以及|还有)/).filter(s => s.trim().length > 5)
  if (multipleRequests.length > 1) {
    // Multiple independent requests = multiple boards
    return {
      mode: 'multiple',
      count: multipleRequests.length,
      naming: 'descriptive',
    }
  }

  // Default: single board
  return {
    mode: 'single',
    count: 1,
    naming: 'sequential',
  }
}

/**
 * Clean up old boards in a session
 * @param editor TLDraw editor instance
 * @param sessionId Session identifier
 * @param keepLatest Number of latest boards to keep (default: 5)
 */
function cleanupOldBoards(
  editor: Editor,
  sessionId: string,
  keepLatest: number = 5
): void {
  // Get all shapes in the current page
  const allShapes = editor.getCurrentPageShapes()

  // Filter for board shapes in this session
  const sessionBoards = allShapes.filter(shape => {
    const meta = shape.meta as Record<string, unknown> | undefined
    // Note: 'ready-board' is a custom shape type that may not be in TLShape type union
    // We check the type as a string to avoid type errors
    return (
      (shape.type as string) === 'ready-board' &&
      meta?.sessionId === sessionId
    )
  })

  // Sort by creation time (newest first)
  sessionBoards.sort((a, b) => {
    const metaA = a.meta as Record<string, unknown> | undefined
    const metaB = b.meta as Record<string, unknown> | undefined
    const timeA = typeof metaA?.createdAt === 'number' ? metaA.createdAt : 0
    const timeB = typeof metaB?.createdAt === 'number' ? metaB.createdAt : 0
    return timeB - timeA
  })

  // Delete boards beyond the keep limit
  const toDelete = sessionBoards.slice(keepLatest)
  if (toDelete.length > 0) {
    editor.deleteShapes(toDelete.map(shape => shape.id))
  }
}

// ============================================================================

function hasExplicitDesignRebuildIntent(args: Record<string, unknown>): boolean {
  const text = collectDesignSignalText(args)
  if (!text) return false
  return /(新建|重新建|再来一个|不同版式|不同方向|另一版|第二版|第二个版本|再出一版|多个版本|几个版本|AB版|A\/B|variation|variations|options|全新)/i.test(text)
}

function isDesignRevisionIntent(args: Record<string, unknown>): boolean {
  const text = collectDesignSignalText(args)
  if (!text) return false
  if (hasExplicitDesignRebuildIntent(args)) return false
  return /(调整|修改|修正|优化|改成|偏左|偏右|偏上|偏下|去掉|不要|减少|增加|保留|延续|继续改|基于这个|在这个基础上|轻一点|重一点|收紧|拉开|更像|标题再|底部再|版面再|不要按钮|不要粗线)/i.test(text)
}

function inferPlatformFromStyleSystem(styleSystem: DesignStyleSystem | null | undefined): DesignPlatform {
  return styleSystem?.palette?.name === 'warm-editorial' ? 'xiaohongshu' : 'generic'
}

function countSectionsFromOwnedNodes(
  editor: Editor,
  ownedNodeIds: string[],
): number {
  return ownedNodeIds.reduce((count, id) => {
    const shape = editor.getShape(id as TLShapeId) as TLShape | undefined
    const role = getShapeRole(shape)
    return role === 'section' || role === 'cta-panel' ? count + 1 : count
  }, 0)
}

function resolveContinuationContext(
  editor: Editor,
  args: Record<string, unknown>,
): {
  boardId: string | null
  boardBounds: { x: number; y: number; w: number; h: number } | null
  ownedNodeIds: string[]
  styleSystem: DesignStyleSystem | null
  ratio: DesignRatio | null
  platform: DesignPlatform
  sectionCount: number
} {
  const boardId = typeof args.__currentBoardId === 'string' && args.__currentBoardId.trim()
    ? args.__currentBoardId.trim()
    : null
  const rawBoardBounds = boardId ? editor.getShapePageBounds(boardId as TLShapeId) : null
  const boardBounds = rawBoardBounds
    ? {
      x: rawBoardBounds.x,
      y: rawBoardBounds.y,
      w: rawBoardBounds.w,
      h: rawBoardBounds.h,
    }
    : null
  const ownedNodeIds = Array.isArray(args.__currentOwnedNodeIds)
    ? args.__currentOwnedNodeIds.map((item) => String(item)).filter(Boolean)
    : []
  const styleSystem = isPlainRecord(args.__currentStyleSystem)
    ? args.__currentStyleSystem as unknown as DesignStyleSystem
    : null
  const ratio = boardBounds ? inferDesignRatioFromDimensions(boardBounds.w, boardBounds.h, '9:16') : null
  return {
    boardId,
    boardBounds,
    ownedNodeIds,
    styleSystem,
    ratio,
    platform: inferPlatformFromStyleSystem(styleSystem),
    sectionCount: countSectionsFromOwnedNodes(editor, ownedNodeIds),
  }
}

function seedPlanningArgsFromContinuation(
  args: Record<string, unknown>,
  continuation: ReturnType<typeof resolveContinuationContext>,
): Record<string, unknown> {
  const nextArgs: Record<string, unknown> = { ...args }
  if (!continuation.boardBounds) return nextArgs
  if (!args.ratio && continuation.ratio) nextArgs.ratio = continuation.ratio
  if (!args.platform) nextArgs.platform = continuation.platform
  if (!Number.isFinite(Number(args.sectionCount)) && continuation.sectionCount > 0) {
    nextArgs.sectionCount = continuation.sectionCount
  }
  if (!isPlainRecord(args.styleSystem) && continuation.styleSystem) {
    nextArgs.styleSystem = continuation.styleSystem
  }
  if (!isPlainRecord(args.palette) && continuation.styleSystem?.palette) {
    nextArgs.palette = continuation.styleSystem.palette
  }
  nextArgs.x = continuation.boardBounds.x
  nextArgs.y = continuation.boardBounds.y
  nextArgs.placementStrategy = 'explicit'
  return nextArgs
}

function normalizeBoardPlan(args: Record<string, unknown>, width: number, height: number): DesignBoardPlan {
  const source = args.board && typeof args.board === 'object' ? args.board as Record<string, unknown> : {}
  const semanticControls = resolveSemanticControls(args)

  const baseCornerRadius = height >= 900 ? 32 : 26
  const basePaddingX = height >= 900 ? 40 : height >= 700 ? 36 : 32
  const basePaddingTop = height >= 900 ? 48 : height >= 700 ? 38 : 32
  const basePaddingBottom = height >= 900 ? 36 : height >= 700 ? 30 : 24

  // Build corner radius hierarchy
  const cornerRadiusHierarchy = buildCornerRadiusHierarchy(
    baseCornerRadius,
    width,
    height,
    semanticControls
  )

  return {
    width,
    height,
    paddingX: clampRound(
      Number(source.paddingX ?? Math.round(basePaddingX * semanticControls.spacingScale)),
      24, 64
    ),
    paddingTop: clampRound(
      Number(source.paddingTop ?? Math.round(basePaddingTop * semanticControls.spacingScale)),
      24, 72
    ),
    paddingBottom: clampRound(
      Number(source.paddingBottom ?? Math.round(basePaddingBottom * semanticControls.spacingScale)),
      20, 56
    ),
    cornerRadius: cornerRadiusHierarchy.board,
  }
}

function normalizeTypographyPlan(
  args: Record<string, unknown>,
  ratio: string,
  compositionFamily: DesignCompositionFamily,
  palette: DesignPalette,
): DesignTypographyPlan {
  const source = args.typography && typeof args.typography === 'object' ? args.typography as Record<string, unknown> : {}
  const semanticControls = resolveSemanticControls(args)
  const normalizedRatio = normalizeDesignRatio(ratio)
  const ratioProfile = getDesignRatioProfile(normalizedRatio)
  const isTall = normalizedRatio === '9:16'
  const isLandscape = ratioProfile === 'landscape'
  const isDark = palette.name === 'github-dark'

  // Get board dimensions for size awareness
  const dimensions = getDimensionsForDesignRatio(normalizedRatio)
  const boardWidth = typeof args.w === 'number' ? args.w : dimensions.width
  const boardHeight = typeof args.h === 'number' ? args.h : dimensions.height

  const defaults: DesignTypographyPlan = isDark
    ? {
      titleFontSize: isLandscape ? 28 : isTall ? 33 : 31,
      titleLineHeight: isLandscape ? 34 : isTall ? 40 : 38,
      subtitleFontSize: isLandscape ? 13 : 14,
      subtitleLineHeight: isLandscape ? 18 : 20,
      sectionTitleFontSize: isLandscape ? 14 : 15,
      sectionBodyFontSize: isLandscape ? 11 : 12,
      sectionLineHeight: isLandscape ? 17 : 19,
      badgeFontSize: isLandscape ? 11 : 12,
      footerFontSize: isLandscape ? 10 : 11,
    }
    : compositionFamily === 'editorial-stack'
      ? {
        titleFontSize: isLandscape ? 27 : isTall ? 36 : 30,
        titleLineHeight: isLandscape ? 33 : isTall ? 43 : 37,
        subtitleFontSize: isLandscape ? 13 : 15,
        subtitleLineHeight: isLandscape ? 19 : 22,
        sectionTitleFontSize: isLandscape ? 15 : 17,
        sectionBodyFontSize: isLandscape ? 11 : 13,
        sectionLineHeight: isLandscape ? 18 : 21,
        badgeFontSize: isLandscape ? 11 : 12,
        footerFontSize: isLandscape ? 10 : 11,
      }
      : {
        titleFontSize: isLandscape ? 28 : isTall ? 35 : 29,
        titleLineHeight: isLandscape ? 34 : isTall ? 42 : 36,
        subtitleFontSize: isLandscape ? 13 : isTall ? 15 : 14,
        subtitleLineHeight: isLandscape ? 19 : isTall ? 22 : 20,
        sectionTitleFontSize: isLandscape ? 14 : isTall ? 16 : 15,
        sectionBodyFontSize: isLandscape ? 11 : isTall ? 13 : 12,
        sectionLineHeight: isLandscape ? 18 : isTall ? 20 : 19,
        badgeFontSize: isLandscape ? 11 : 12,
        footerFontSize: isLandscape ? 10 : 11,
      }

  // Apply board size awareness to base font sizes
  const adjustedBaseTitleSize = adjustForBoardSize(
    defaults.titleFontSize,
    boardWidth,
    boardHeight,
    'fontSize'
  )
  const adjustedBaseBodySize = adjustForBoardSize(
    defaults.subtitleFontSize,
    boardWidth,
    boardHeight,
    'fontSize'
  )

  // Apply semantic controls (explicit values take priority, otherwise use adjusted base values)
  let titleFontSize = semanticControls.explicitTitleFontSize
    ?? Math.round(adjustedBaseTitleSize * semanticControls.titleScale)
  let bodyFontSize = semanticControls.explicitBodyFontSize
    ?? Math.round(adjustedBaseBodySize * semanticControls.bodyScale)

  // Validate ratio constraints
  if (!validateFontSizeRatio(titleFontSize, boardHeight)) {
    // If out of range, adjust to middle value (5%)
    titleFontSize = Math.round(boardHeight * 0.05)
  }

  return {
    titleFontSize: clampRound(titleFontSize, 20, 52),
    titleLineHeight: clampRound(
      semanticControls.explicitLineHeight
        ? Math.round(titleFontSize * semanticControls.explicitLineHeight)
        : Number(source.titleLineHeight ?? Math.round(defaults.titleLineHeight * semanticControls.titleScale)),
      24, 60
    ),
    subtitleFontSize: clampRound(bodyFontSize, 11, 22),
    subtitleLineHeight: clampRound(
      semanticControls.explicitLineHeight
        ? Math.round(bodyFontSize * semanticControls.explicitLineHeight)
        : Number(source.subtitleLineHeight ?? Math.round(defaults.subtitleLineHeight * Math.max(1, semanticControls.bodyScale))),
      14, 32
    ),
    sectionTitleFontSize: clampRound(Number(source.sectionTitleFontSize ?? Math.round(defaults.sectionTitleFontSize * Math.max(1, semanticControls.sectionScale * 0.92))), 12, 24),
    sectionBodyFontSize: clampRound(bodyFontSize, 11, 20),
    sectionLineHeight: clampRound(
      semanticControls.explicitLineHeight
        ? Math.round(bodyFontSize * semanticControls.explicitLineHeight)
        : Number(source.sectionLineHeight ?? Math.round(defaults.sectionLineHeight * Math.max(1, semanticControls.bodyScale))),
      15, 32
    ),
    badgeFontSize: clampRound(Number(source.badgeFontSize ?? defaults.badgeFontSize), 10, 16),
    footerFontSize: clampRound(Number(source.footerFontSize ?? Math.round(defaults.footerFontSize * (semanticControls.prefersQuietFooter ? 0.92 : 1))), 10, 14),
  }
}

function normalizeLayoutStrategyPlan(
  args: Record<string, unknown>,
  compositionFamily: DesignCompositionFamily,
  palette: DesignPalette,
): DesignLayoutStrategyPlan {
  const source = args.layoutStrategy && typeof args.layoutStrategy === 'object' ? args.layoutStrategy as Record<string, unknown> : {}
  const semanticControls = resolveSemanticControls(args)
  const defaults: DesignLayoutStrategyPlan =
    compositionFamily === 'split-feature'
      ? {
        align: 'split',
        sectionStyle: 'feature-split',
        heroWeight: semanticControls.prefersLargeElements ? 0.62 : 0.58,
        sectionGap: Math.round((semanticControls.prefersSparseContent ? 18 : 14) * semanticControls.spacingScale),
        titleGap: Math.round(12 * semanticControls.spacingScale),
        footerMode: 'caption',
      }
      : compositionFamily === 'editorial-stack'
        ? {
          align: 'left',
          sectionStyle: 'cards',
          heroWeight: semanticControls.prefersSparseContent ? 0.42 : 0.36,
          sectionGap: Math.round((semanticControls.prefersSparseContent ? 18 : 14) * semanticControls.spacingScale),
          titleGap: Math.round(12 * semanticControls.spacingScale),
          footerMode: 'caption',
        }
        : {
          align: 'left',
          sectionStyle: 'rows',
          heroWeight: semanticControls.prefersSparseContent ? 0.36 : 0.3,
          sectionGap: Math.round((semanticControls.prefersSparseContent ? 22 : 18) * semanticControls.spacingScale),
          titleGap: Math.round(12 * semanticControls.spacingScale),
          footerMode: semanticControls.prefersQuietFooter ? 'caption' : 'pill',
        }

  return {
    align: source.align === 'split' ? 'split' : defaults.align,
    sectionStyle: source.sectionStyle === 'cards' || source.sectionStyle === 'feature-split' ? source.sectionStyle : defaults.sectionStyle,
    heroWeight: Math.max(0.28, Math.min(0.68, Number(source.heroWeight ?? defaults.heroWeight))),
    sectionGap: clampRound(Number(source.sectionGap ?? defaults.sectionGap), 8, 32),
    titleGap: clampRound(Number(source.titleGap ?? defaults.titleGap), 8, 24),
    footerMode: source.footerMode === 'caption' ? 'caption' : defaults.footerMode,
  }
}

function buildFooterText(palette: DesignPalette, platform: string): string {
  if (platform === 'youtube') return '频道名 / 系列 / 上线时间'
  if (palette.name === 'github-dark') return '底部备注 / Repo Tag / 版本信息'
  return platform === 'xiaohongshu'
    ? '底部备注 / 可替换成账号名、日期或系列标签'
    : '底部备注 / 系列标签 / 账号名'
}

function pickCoverVariant(args: Record<string, unknown>, compositionFamily: DesignCompositionFamily, styleGuide: DesignStyleGuide, ratio: string, sectionCount: number): string {
  const signals = readDesignSignalProfile(args)
  const ratioProfile = getDesignRatioProfile(normalizeDesignRatio(ratio))
  if (compositionFamily === 'split-feature') {
    if (signals.prefersButtons || styleGuide.ctaWeight === 'button') return 'cta-panel'
    return 'hero-band'
  }

  if (compositionFamily === 'editorial-stack') {
    if (styleGuide.headlineAlign === 'center' || signals.prefersPoster || signals.prefersCenter) return 'center-stack'
    return 'offset-stack'
  }

  if (((ratio === '9:16' || ratioProfile === 'portrait') && sectionCount >= 4 && styleGuide.density !== 'dense') || signals.prefersEditorial || signals.prefersRail) return 'editorial-rail'
  if (styleGuide.density === 'dense' || signals.prefersDense) return 'banded-list'
  return 'card-list'
}

function buildCoverSpec(
  args: Record<string, unknown>,
  platform: string,
  compositionFamily: DesignCompositionFamily,
  palette: DesignPalette,
  styleGuide: DesignStyleGuide,
  dimensions: { w: number; h: number },
  placement: { x: number; y: number },
  title: string,
  subtitle: string,
  sections: DesignContentSection[],
  badgeLabel: string,
): CoverResolvedSpec {
  const ratio = inferDesignRatioFromDimensions(dimensions.w, dimensions.h)
  const variant = pickCoverVariant(args, compositionFamily, styleGuide, ratio, sections.length)
  const layoutBlueprint = normalizeLayoutBlueprintForArgs(args, {
    ratio,
    sectionCount: sections.length,
    palette,
    compositionFamily,
    styleGuide,
  })
  return {
    baseX: placement.x,
    baseY: placement.y,
    width: dimensions.w,
    height: dimensions.h,
    palette,
    styleGuide,
    title,
    subtitle,
    sections,
    badgeLabel,
    footerText: buildFooterText(palette, platform),
    compositionFamily,
    variant,
    board: normalizeBoardPlan(args, dimensions.w, dimensions.h),
    typography: normalizeTypographyPlan(args, ratio, compositionFamily, palette),
    layoutStrategy: normalizeLayoutStrategyPlan(args, compositionFamily, palette),
    layoutBlueprint,
  }
}

function reviewCoverNodes(spec: CoverResolvedSpec, nodes: CoverRenderNode[], attempts: number): CoverReviewResult {
  const boardRight = spec.baseX + spec.width
  const boardBottom = spec.baseY + spec.height
  let overflowX = 0
  let overflowY = 0
  let footerTop: number | null = null
  let contentBottom = spec.baseY + spec.board.paddingTop

  for (const node of nodes) {
    if (node.role === 'board') continue
    overflowX = Math.max(overflowX, Math.max(0, spec.baseX - node.x), Math.max(0, node.x + node.w - boardRight))
    overflowY = Math.max(overflowY, Math.max(0, spec.baseY - node.y), Math.max(0, node.y + node.h - boardBottom))
    if (node.role === 'footer') {
      footerTop = node.y
      continue
    }
    contentBottom = Math.max(contentBottom, node.y + node.h)
  }

  if (footerTop !== null) {
    overflowY = Math.max(overflowY, Math.max(0, contentBottom + 12 - footerTop))
  } else {
    overflowY = Math.max(overflowY, Math.max(0, contentBottom - (boardBottom - spec.board.paddingBottom)))
  }

  return {
    attempts,
    overflowX,
    overflowY,
    compacted: attempts > 1,
  }
}

function compactCoverSpec(spec: CoverResolvedSpec, review: CoverReviewResult): CoverResolvedSpec {
  const severeOverflow = review.overflowY >= 48 || review.overflowX >= 24
  const board = {
    ...spec.board,
    paddingX: clampRound(spec.board.paddingX * 0.94, 24, 64),
    paddingTop: clampRound(spec.board.paddingTop * 0.94, 24, 72),
    paddingBottom: clampRound(spec.board.paddingBottom * 0.92, 18, 56),
    cornerRadius: clampRound(spec.board.cornerRadius * 0.96, 12, 40),
  }
  const typography = {
    ...spec.typography,
    titleFontSize: clampRound(spec.typography.titleFontSize * (severeOverflow ? 0.9 : 0.94), 20, 42),
    titleLineHeight: clampRound(spec.typography.titleLineHeight * (severeOverflow ? 0.92 : 0.95), 24, 50),
    subtitleFontSize: clampRound(spec.typography.subtitleFontSize * 0.94, 11, 18),
    subtitleLineHeight: clampRound(spec.typography.subtitleLineHeight * 0.95, 14, 28),
    sectionTitleFontSize: clampRound(spec.typography.sectionTitleFontSize * 0.94, 12, 22),
    sectionBodyFontSize: clampRound(spec.typography.sectionBodyFontSize * 0.94, 11, 18),
    sectionLineHeight: clampRound(spec.typography.sectionLineHeight * 0.95, 15, 28),
    badgeFontSize: clampRound(spec.typography.badgeFontSize * 0.94, 10, 16),
    footerFontSize: clampRound(spec.typography.footerFontSize * 0.94, 10, 14),
  }
  const layoutStrategy = {
    ...spec.layoutStrategy,
    heroWeight: spec.compositionFamily === 'split-feature'
      ? Math.max(0.32, Math.min(0.68, spec.layoutStrategy.heroWeight + 0.03))
      : spec.layoutStrategy.heroWeight,
    sectionGap: clampRound(spec.layoutStrategy.sectionGap * 0.9, 8, 32),
    titleGap: clampRound(spec.layoutStrategy.titleGap * 0.92, 8, 24),
    footerMode: severeOverflow ? 'caption' : spec.layoutStrategy.footerMode,
  }

  return {
    ...spec,
    board,
    typography,
    layoutStrategy,
  }
}

function renderCoverNodes(editor: Editor, nodes: CoverRenderNode[], spec: CoverResolvedSpec): TLShapeId[] {
  const createdIds: TLShapeId[] = []
  for (const node of nodes) {
    if (node.kind === 'text') {
      if (node.role === 'board') {
        createCoverBoard(editor, createdIds, spec.palette, node.x, node.y, node.w, node.h, node.cornerRadius || spec.board.cornerRadius)
        continue
      }
      createdIds.push(createStyledTextBlock(editor, {
        x: node.x,
        y: node.y,
        w: node.w,
        h: node.h,
        content: node.content,
        fontSize: node.fontSize,
        fillColor: node.fillColor,
        fillOpacity: node.fillOpacity,
        textColor: node.textColor,
        fontWeight: node.fontWeight,
        lineHeight: node.lineHeight,
        paddingH: node.paddingH,
        paddingV: node.paddingV,
        cornerRadius: node.cornerRadius,
        clipContent: node.clipContent,
      }))
      continue
    }
    if (node.kind === 'geo') {
      const created = createGeoShape(editor, node)
      createdIds.push(created.id)
      continue
    }
    const created = createDesignComponent(editor, 'ui-button', {
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      label: node.label,
      variant: node.variant,
    })
    createdIds.push(created.id as TLShapeId)
  }
  return createdIds
}

function buildNumberedListNodes(spec: CoverResolvedSpec): CoverRenderNode[] {
  const nodes: CoverRenderNode[] = []
  const railInset = spec.variant === 'editorial-rail' ? 18 : 0
  const innerX = spec.baseX + spec.board.paddingX
  const innerY = spec.baseY + spec.board.paddingTop
  const contentWidth = spec.width - spec.board.paddingX * 2
  const contentStartX = innerX + railInset
  const contentStartWidth = contentWidth - railInset
  const badgeH = clampRound(spec.typography.badgeFontSize * 2.7, 30, 40)
  const badgeW = clampRound(Math.min(contentStartWidth * 0.46, estimateLineWidth(spec.badgeLabel, spec.typography.badgeFontSize) + badgeH + 20), 96, contentStartWidth)
  const titleH = estimateTextHeight({
    text: spec.title,
    width: contentStartWidth,
    fontSize: spec.typography.titleFontSize,
    lineHeight: spec.typography.titleLineHeight,
    maxLines: 3,
  })
  const subtitleH = estimateTextHeight({
    text: spec.subtitle,
    width: contentStartWidth,
    fontSize: spec.typography.subtitleFontSize,
    lineHeight: spec.typography.subtitleLineHeight,
    maxLines: 3,
  })
  const circleSize = spec.variant === 'banded-list'
    ? 0
    : clampRound(Math.min(42, contentStartWidth * 0.08), 32, 42)
  const indexPillW = spec.variant === 'banded-list' ? 46 : circleSize
  const indexPillH = spec.variant === 'banded-list' ? 26 : circleSize
  const rowGap = spec.variant === 'banded-list'
    ? Math.max(10, spec.layoutStrategy.sectionGap - 4)
    : spec.layoutStrategy.sectionGap
  const rowCardGap = 14
  const rowWidth = spec.variant === 'banded-list'
    ? contentStartWidth
    : contentStartWidth - circleSize - rowCardGap
  const footerH = spec.layoutStrategy.footerMode === 'pill'
    ? estimateTextHeight({
      text: spec.footerText,
      width: contentStartWidth,
      fontSize: spec.typography.footerFontSize,
      lineHeight: Math.round(spec.typography.footerFontSize * 1.5),
      paddingH: 14,
      paddingV: 8,
      maxLines: 2,
    })
    : estimateTextHeight({
      text: spec.footerText,
      width: contentStartWidth,
      fontSize: spec.typography.footerFontSize,
      lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
      maxLines: 2,
    })

  nodes.push({
    kind: 'text',
    role: 'board',
    x: spec.baseX,
    y: spec.baseY,
    w: spec.width,
    h: spec.height,
    content: ' ',
    fontSize: 1,
    cornerRadius: spec.board.cornerRadius,
  })

  if (spec.styleGuide.ornament === 'side-rail') {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: innerX,
      y: innerY + badgeH + spec.layoutStrategy.titleGap,
      w: 8,
      h: spec.height - spec.board.paddingTop - spec.board.paddingBottom - 24,
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accentSoft,
    })
  }

  nodes.push({
    kind: 'geo',
    role: 'badge',
    shape: 'pill',
    x: contentStartX,
    y: innerY,
    w: badgeW,
    h: badgeH,
    label: spec.badgeLabel,
    fillColor: spec.palette.accentSoft,
    textColor: spec.palette.accent,
  })

  let cursorY = innerY + badgeH + spec.layoutStrategy.titleGap
  nodes.push({
    kind: 'text',
    role: 'title',
    x: contentStartX,
    y: cursorY,
    w: contentStartWidth,
    h: titleH,
    content: spec.title,
    fontSize: spec.typography.titleFontSize,
    textColor: spec.palette.primaryText,
    fontWeight: 'bold',
    textAlign: spec.styleGuide.headlineAlign === 'center' ? 'middle' : 'start',
    fontFamily: spec.palette.name === 'warm-editorial' ? 'serif' : spec.palette.name === 'github-dark' ? 'mono' : 'sans',
    letterSpacing: spec.palette.name === 'github-dark' ? 0.2 : 0,
    lineHeight: spec.typography.titleLineHeight,
  })

  cursorY += titleH + spec.layoutStrategy.titleGap
  nodes.push({
    kind: 'text',
    role: 'subtitle',
    x: contentStartX,
    y: cursorY,
    w: contentStartWidth,
    h: subtitleH,
    content: spec.subtitle,
    fontSize: spec.typography.subtitleFontSize,
    textColor: spec.palette.secondaryText,
    textAlign: spec.styleGuide.headlineAlign === 'center' ? 'middle' : 'start',
    lineHeight: spec.typography.subtitleLineHeight,
  })

  cursorY += subtitleH + 18
  if (spec.styleGuide.ornament === 'floating-pill') {
    const accentW = Math.min(78, contentStartWidth)
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'pill',
      x: spec.styleGuide.headlineAlign === 'center'
        ? contentStartX + Math.round((contentStartWidth - accentW) / 2)
        : contentStartX,
      y: cursorY,
      w: accentW,
      h: 10,
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accentSoft,
    })
    cursorY += 20
  } else if (spec.styleGuide.ornament === 'divider-bar') {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: spec.styleGuide.headlineAlign === 'center'
        ? contentStartX + Math.round((contentStartWidth - Math.min(72, contentStartWidth)) / 2)
        : contentStartX,
      y: cursorY,
      w: Math.min(72, contentStartWidth),
      h: spec.palette.name === 'github-dark' ? 5 : 3,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
    cursorY += 22
  } else {
    cursorY += 14
  }
  const footerY = spec.baseY + spec.height - spec.board.paddingBottom - footerH
  for (const [index, section] of spec.sections.entries()) {
    const cardH = Math.max(circleSize, estimateTextHeight({
      text: `${section.title}\n${section.body}`,
      width: rowWidth,
      fontSize: spec.typography.sectionBodyFontSize,
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: spec.variant === 'banded-list' ? 20 : 18,
      paddingV: 14,
      maxLines: 5,
    }))
    const cardX = spec.variant === 'banded-list' ? contentStartX : contentStartX + circleSize + rowCardGap
    const cardY = cursorY
    const indexX = spec.variant === 'banded-list' ? contentStartX + 16 : contentStartX
    const indexY = spec.variant === 'banded-list'
      ? cursorY + 14
      : cursorY + Math.max(0, Math.round((cardH - circleSize) / 2))
    nodes.push({
      kind: 'geo',
      role: 'index',
      shape: spec.variant === 'banded-list' ? 'pill' : 'circle',
      x: indexX,
      y: indexY,
      w: indexPillW,
      h: indexPillH,
      label: String(index + 1).padStart(2, '0'),
      fillColor: spec.palette.accent,
      textColor: '#FFFFFF',
    })
    nodes.push({
      kind: 'text',
      role: 'section',
      x: cardX,
      y: cardY,
      w: rowWidth,
      h: cardH,
      content: `${section.title}\n${section.body}`,
      fontSize: spec.typography.sectionBodyFontSize,
      fillColor: spec.styleGuide.sectionTone === 'solid' ? spec.palette.surface : spec.palette.accentSoft,
      fillOpacity: index === 0 ? 100 : spec.styleGuide.sectionTone === 'outline' ? 38 : 92,
      textColor: spec.palette.primaryText,
      fontWeight: index === 0 ? 'bold' : 'medium',
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: spec.variant === 'banded-list' ? 20 + indexPillW + 8 : 18,
      paddingV: 14,
      cornerRadius: 18,
      strokeVisible: spec.styleGuide.sectionTone === 'outline',
      strokeColor: spec.palette.accent,
      strokeWidth: spec.styleGuide.sectionTone === 'outline' ? 1.5 : 0,
      strokeOpacity: 36,
      strokeDash: spec.styleGuide.sectionTone === 'outline' ? 'solid' : 'solid',
      clipContent: true,
    })
    cursorY += cardH + rowGap
  }

  nodes.push(spec.styleGuide.ctaWeight === 'button'
    ? {
      kind: 'text',
      role: 'footer',
      x: contentStartX,
      y: footerY,
      w: contentStartWidth,
      h: footerH,
      content: spec.footerText,
      fontSize: spec.typography.footerFontSize,
      fillColor: spec.palette.accent,
      fillOpacity: 100,
      textColor: '#FFFFFF',
      fontWeight: 'medium',
      lineHeight: Math.round(spec.typography.footerFontSize * 1.5),
      paddingH: 16,
      paddingV: 8,
      textAlign: 'middle',
      cornerRadius: 999,
      clipContent: true,
    }
    : spec.layoutStrategy.footerMode === 'pill'
    ? {
      kind: 'text',
      role: 'footer',
      x: contentStartX,
      y: footerY,
      w: contentStartWidth,
      h: footerH,
      content: spec.footerText,
      fontSize: spec.typography.footerFontSize,
      fillColor: spec.palette.accentSoft,
      fillOpacity: 100,
      textColor: spec.palette.secondaryText,
      lineHeight: Math.round(spec.typography.footerFontSize * 1.5),
      paddingH: 14,
      paddingV: 8,
      cornerRadius: 999,
      clipContent: true,
    }
    : {
      kind: 'text',
      role: 'footer',
      x: contentStartX,
      y: footerY,
      w: contentStartWidth,
      h: footerH,
      content: spec.footerText,
      fontSize: spec.typography.footerFontSize,
      textColor: spec.palette.secondaryText,
      textAlign: spec.styleGuide.headlineAlign === 'center' ? 'middle' : 'start',
      lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
      clipContent: true,
    })

  return nodes
}

function buildSplitFeatureNodes(spec: CoverResolvedSpec): CoverRenderNode[] {
  const nodes: CoverRenderNode[] = []
  const innerX = spec.baseX + spec.board.paddingX
  const innerY = spec.baseY + spec.board.paddingTop
  const contentWidth = spec.width - spec.board.paddingX * 2
  const badgeH = clampRound(spec.typography.badgeFontSize * 2.5, 30, 38)
  const badgeW = clampRound(Math.min(contentWidth * 0.44, estimateLineWidth(spec.badgeLabel, spec.typography.badgeFontSize) + badgeH + 18), 96, contentWidth)
  const columnGap = 18
  const leftWidth = clampRound(contentWidth * spec.layoutStrategy.heroWeight, 220, contentWidth - 140)
  const rightWidth = Math.max(120, contentWidth - leftWidth - columnGap)
  const titleH = estimateTextHeight({
    text: spec.title,
    width: leftWidth,
    fontSize: spec.typography.titleFontSize,
    lineHeight: spec.typography.titleLineHeight,
    maxLines: 3,
  })
  const subtitleH = estimateTextHeight({
    text: spec.subtitle,
    width: leftWidth,
    fontSize: spec.typography.subtitleFontSize,
    lineHeight: spec.typography.subtitleLineHeight,
    maxLines: 3,
  })
  const heroH = Math.max(156, titleH + subtitleH + 22)
  const panelInset = 18
  const emphasisSection = spec.styleGuide.ctaWeight === 'button'
    ? (spec.sections.at(-1) || spec.sections[0])
    : (spec.sections[0] || spec.sections.at(-1))
  const emphasisText = emphasisSection?.body || '这里放一组更强调的摘要、证明或行动提示。'
  const emphasisTitle = emphasisSection?.title || '重点信息'
  const showActionPanel = spec.variant === 'cta-panel' || spec.styleGuide.ctaWeight === 'button'
  const showPrimaryButton = spec.styleGuide.ctaWeight === 'button' && spec.variant === 'cta-panel'
  const showWideDivider = spec.styleGuide.ornament === 'divider-bar'
  const showFloatingDivider = spec.styleGuide.ornament === 'floating-pill'
  const emphasisPanelH = Math.max(132, estimateTextHeight({
    text: emphasisText,
    width: rightWidth,
    fontSize: spec.typography.sectionBodyFontSize,
    lineHeight: spec.typography.sectionLineHeight,
    paddingH: panelInset,
    paddingV: panelInset,
    maxLines: 4,
  }) + 52)

  if (spec.styleGuide.ornament === 'side-rail') {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: innerX - 12,
      y: innerY,
      w: 6,
      h: spec.height - spec.board.paddingTop - spec.board.paddingBottom,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
  }

  nodes.push({
    kind: 'text',
    role: 'board',
    x: spec.baseX,
    y: spec.baseY,
    w: spec.width,
    h: spec.height,
    content: ' ',
    fontSize: 1,
    cornerRadius: spec.board.cornerRadius,
  })

  nodes.push({
    kind: 'geo',
    role: 'badge',
    shape: 'pill',
    x: innerX,
    y: innerY,
    w: badgeW,
    h: badgeH,
    label: spec.badgeLabel,
    fillColor: spec.palette.accentSoft,
    textColor: spec.palette.accent,
  })

  const heroY = innerY + badgeH + spec.layoutStrategy.titleGap
  nodes.push({
    kind: 'text',
    role: 'title',
    x: innerX,
    y: heroY,
    w: leftWidth,
    h: titleH,
    content: spec.title,
    fontSize: spec.typography.titleFontSize,
    textColor: spec.palette.primaryText,
    fontWeight: 'bold',
    textAlign: spec.styleGuide.headlineAlign === 'center' ? 'middle' : 'start',
    fontFamily: spec.palette.name === 'github-dark' ? 'mono' : 'sans',
    letterSpacing: spec.palette.name === 'github-dark' ? 0.2 : 0,
    lineHeight: spec.typography.titleLineHeight,
  })
  nodes.push({
    kind: 'text',
    role: 'subtitle',
    x: innerX,
    y: heroY + titleH + spec.layoutStrategy.titleGap,
    w: leftWidth,
    h: subtitleH,
    content: spec.subtitle,
    fontSize: spec.typography.subtitleFontSize,
    textColor: spec.palette.secondaryText,
    textAlign: spec.styleGuide.headlineAlign === 'center' ? 'middle' : 'start',
    lineHeight: spec.typography.subtitleLineHeight,
  })

  const panelX = innerX + leftWidth + columnGap
  nodes.push({
    kind: 'text',
    role: showActionPanel ? 'cta-panel' : 'section',
    x: panelX,
    y: heroY,
    w: rightWidth,
    h: emphasisPanelH,
    content: `${emphasisTitle}\n${emphasisText}`,
    fontSize: spec.typography.sectionBodyFontSize,
    fillColor: showActionPanel
      ? spec.palette.accentSoft
      : spec.styleGuide.sectionTone === 'outline'
        ? spec.palette.background
        : spec.palette.surface,
    fillOpacity: 100,
    textColor: spec.palette.primaryText,
    fontWeight: showActionPanel ? 'medium' : 'bold',
    lineHeight: spec.typography.sectionLineHeight,
    paddingH: panelInset,
    paddingV: panelInset,
    cornerRadius: 22,
    strokeVisible: showActionPanel ? spec.styleGuide.sectionTone === 'outline' : true,
    strokeColor: spec.palette.accent,
    strokeWidth: showActionPanel
      ? (spec.styleGuide.sectionTone === 'outline' ? 1.5 : 0)
      : 1.15,
    strokeOpacity: showActionPanel ? 40 : 26,
    clipContent: true,
  })

  if (showPrimaryButton) {
    const buttonWidth = Math.max(128, rightWidth - panelInset * 2)
    nodes.push({
      kind: 'button',
      role: 'cta-button',
      x: panelX + panelInset,
      y: heroY + emphasisPanelH - 52,
      w: buttonWidth,
      h: 40,
      label: emphasisTitle || 'Primary CTA',
      variant: 'primary',
    })
  }

  let cursorY = heroY + Math.max(heroH, emphasisPanelH) + 18
  if (showWideDivider) {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: innerX,
      y: cursorY,
      w: Math.round(contentWidth * 0.72),
      h: 3,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
    cursorY += 18
  } else if (showFloatingDivider) {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'pill',
      x: spec.styleGuide.headlineAlign === 'center'
        ? innerX + Math.round((contentWidth - 80) / 2)
        : innerX,
      y: cursorY,
      w: 80,
      h: 10,
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accentSoft,
    })
    cursorY += 18
  } else {
    cursorY += 8
  }

  const sections = showActionPanel
    ? spec.sections.slice(0, Math.max(0, spec.sections.length - 1))
    : spec.sections.slice(1)
  for (const [index, section] of sections.entries()) {
    const cardH = Math.max(88, estimateTextHeight({
      text: `${section.title}\n${section.body}`,
      width: contentWidth,
      fontSize: spec.typography.sectionBodyFontSize,
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: 18,
      paddingV: 16,
      maxLines: 5,
    }))
    nodes.push({
      kind: 'text',
      role: 'section',
      x: innerX,
      y: cursorY,
      w: contentWidth,
      h: cardH,
      content: `${section.title}\n${section.body}`,
      fontSize: spec.typography.sectionBodyFontSize,
      fillColor: spec.styleGuide.sectionTone === 'outline' ? spec.palette.background : spec.palette.surface,
      fillOpacity: 100,
      textColor: spec.palette.primaryText,
      fontWeight: index === 0 ? 'bold' : 'medium',
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: 18,
      paddingV: 16,
      cornerRadius: 18,
      strokeVisible: spec.styleGuide.sectionTone === 'outline',
      strokeColor: spec.palette.accent,
      strokeWidth: spec.styleGuide.sectionTone === 'outline' ? 1.25 : 0,
      strokeOpacity: 34,
      clipContent: true,
    })
    cursorY += cardH + spec.layoutStrategy.sectionGap
  }

  const footerH = estimateTextHeight({
    text: spec.footerText,
    width: contentWidth,
    fontSize: spec.typography.footerFontSize,
    lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
    maxLines: 2,
  })
  nodes.push({
    kind: 'text',
    role: 'footer',
    x: innerX,
    y: spec.baseY + spec.height - spec.board.paddingBottom - footerH,
    w: contentWidth,
    h: footerH,
    content: spec.footerText,
    fontSize: spec.typography.footerFontSize,
    textColor: spec.palette.secondaryText,
    textAlign: spec.styleGuide.headlineAlign === 'center' ? 'middle' : 'start',
    lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
    clipContent: true,
  })

  return nodes
}

function buildEditorialStackNodes(spec: CoverResolvedSpec): CoverRenderNode[] {
  const nodes: CoverRenderNode[] = []
  const innerX = spec.baseX + spec.board.paddingX
  const innerY = spec.baseY + spec.board.paddingTop
  const contentWidth = spec.width - spec.board.paddingX * 2
  const centered = spec.variant === 'center-stack' || spec.styleGuide.headlineAlign === 'center'
  const contentStartX = centered ? innerX + Math.round(contentWidth * 0.06) : innerX
  const contentStartWidth = centered ? Math.round(contentWidth * 0.88) : contentWidth
  const badgeH = clampRound(spec.typography.badgeFontSize * 2.6, 30, 40)
  const badgeW = clampRound(Math.min(contentStartWidth * 0.48, estimateLineWidth(spec.badgeLabel, spec.typography.badgeFontSize) + badgeH + 18), 96, contentStartWidth)
  const titleH = estimateTextHeight({
    text: spec.title,
    width: contentStartWidth,
    fontSize: spec.typography.titleFontSize,
    lineHeight: spec.typography.titleLineHeight,
    maxLines: 3,
  })
  const subtitleH = estimateTextHeight({
    text: spec.subtitle,
    width: contentStartWidth,
    fontSize: spec.typography.subtitleFontSize,
    lineHeight: spec.typography.subtitleLineHeight,
    maxLines: 3,
  })
  const hero = spec.sections[0]
  const heroH = Math.max(138, estimateTextHeight({
    text: `${hero?.title || '主信息区'}\n${hero?.body || '这里放最重要的一组内容信息。'}`,
    width: contentStartWidth,
    fontSize: spec.typography.sectionTitleFontSize,
    lineHeight: Math.round(spec.typography.sectionLineHeight * 1.12),
    paddingH: 22,
    paddingV: 18,
    maxLines: 6,
  }))

  nodes.push({
    kind: 'text',
    role: 'board',
    x: spec.baseX,
    y: spec.baseY,
    w: spec.width,
    h: spec.height,
    content: ' ',
    fontSize: 1,
    cornerRadius: spec.board.cornerRadius,
  })
  nodes.push({
    kind: 'geo',
    role: 'badge',
    shape: 'pill',
    x: innerX,
    y: innerY,
    w: badgeW,
    h: badgeH,
    label: spec.badgeLabel,
    fillColor: spec.palette.accentSoft,
    textColor: spec.palette.accent,
  })

  let cursorY = innerY + badgeH + spec.layoutStrategy.titleGap
  nodes.push({
    kind: 'text',
    role: 'title',
    x: contentStartX,
    y: cursorY,
    w: contentStartWidth,
    h: titleH,
    content: spec.title,
    fontSize: spec.typography.titleFontSize,
    textColor: spec.palette.primaryText,
    fontWeight: 'bold',
    textAlign: centered ? 'middle' : 'start',
    fontFamily: spec.palette.name === 'warm-editorial' ? 'serif' : 'sans',
    lineHeight: spec.typography.titleLineHeight,
  })
  cursorY += titleH + spec.layoutStrategy.titleGap

  nodes.push({
    kind: 'text',
    role: 'subtitle',
    x: contentStartX,
    y: cursorY,
    w: contentStartWidth,
    h: subtitleH,
    content: spec.subtitle,
    fontSize: spec.typography.subtitleFontSize,
    textColor: spec.palette.secondaryText,
    textAlign: centered ? 'middle' : 'start',
    lineHeight: spec.typography.subtitleLineHeight,
  })
  cursorY += subtitleH + 18

  if (spec.styleGuide.ornament === 'floating-pill') {
    const accentW = Math.min(76, contentStartWidth)
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'pill',
      x: centered
        ? contentStartX + Math.round((contentStartWidth - accentW) / 2)
        : contentStartX,
      y: cursorY,
      w: accentW,
      h: 10,
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accentSoft,
    })
    cursorY += 20
  } else if (spec.styleGuide.ornament === 'divider-bar') {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: centered
        ? contentStartX + Math.round((contentStartWidth - Math.min(76, contentStartWidth)) / 2)
        : contentStartX,
      y: cursorY,
      w: Math.min(76, contentStartWidth),
      h: 3,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
    cursorY += 20
  } else {
    cursorY += 12
  }

  nodes.push({
    kind: 'text',
    role: 'section',
    x: contentStartX,
    y: cursorY,
    w: contentStartWidth,
    h: heroH,
    content: `${hero?.title || '主信息区'}\n${hero?.body || '这里放最重要的一组内容信息。'}`,
    fontSize: spec.typography.sectionTitleFontSize,
    fillColor: spec.styleGuide.sectionTone === 'outline' ? spec.palette.background : spec.palette.surface,
    fillOpacity: 100,
    textColor: spec.palette.primaryText,
    fontWeight: 'bold',
    lineHeight: Math.round(spec.typography.sectionLineHeight * 1.12),
    paddingH: 22,
    paddingV: 18,
    cornerRadius: 24,
    strokeVisible: spec.styleGuide.sectionTone === 'outline',
    strokeColor: spec.palette.accent,
    strokeWidth: spec.styleGuide.sectionTone === 'outline' ? 1.5 : 0,
    strokeOpacity: 34,
    clipContent: true,
  })
  cursorY += heroH + spec.layoutStrategy.sectionGap

  for (const section of spec.sections.slice(1)) {
    const cardH = Math.max(82, estimateTextHeight({
      text: `${section.title}\n${section.body}`,
      width: contentStartWidth,
      fontSize: spec.typography.sectionBodyFontSize,
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: 18,
      paddingV: 16,
      maxLines: 5,
    }))
    nodes.push({
      kind: 'text',
      role: 'section',
      x: contentStartX,
      y: cursorY,
      w: contentStartWidth,
      h: cardH,
      content: `${section.title}\n${section.body}`,
      fontSize: spec.typography.sectionBodyFontSize,
      fillColor: spec.styleGuide.sectionTone === 'outline' ? spec.palette.background : spec.palette.accentSoft,
      fillOpacity: 100,
      textColor: spec.palette.primaryText,
      fontWeight: 'medium',
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: 18,
      paddingV: 16,
      cornerRadius: 18,
      strokeVisible: spec.styleGuide.sectionTone === 'outline',
      strokeColor: spec.palette.accent,
      strokeWidth: spec.styleGuide.sectionTone === 'outline' ? 1.25 : 0,
      strokeOpacity: 30,
      clipContent: true,
    })
    cursorY += cardH + spec.layoutStrategy.sectionGap
  }

  const footerH = estimateTextHeight({
    text: spec.footerText,
    width: contentStartWidth,
    fontSize: spec.typography.footerFontSize,
    lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
    maxLines: 2,
  })
  nodes.push({
    kind: 'text',
    role: 'footer',
    x: contentStartX,
    y: spec.baseY + spec.height - spec.board.paddingBottom - footerH,
    w: contentStartWidth,
    h: footerH,
    content: spec.footerText,
    fontSize: spec.typography.footerFontSize,
    textColor: spec.palette.secondaryText,
    textAlign: centered ? 'middle' : 'start',
    lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
    clipContent: true,
  })

  return nodes
}

function buildBlueprintCoverNodes(spec: CoverResolvedSpec): CoverRenderNode[] {
  const blueprint = spec.layoutBlueprint
  const nodes: CoverRenderNode[] = []
  const innerX = spec.baseX + spec.board.paddingX
  const innerY = spec.baseY + spec.board.paddingTop
  const contentWidth = spec.width - spec.board.paddingX * 2
  const centeredTitle = blueprint.titlePlacement === 'top-center' || blueprint.titlePlacement === 'top-wide'
  const badgeH = clampRound(spec.typography.badgeFontSize * 2.5, 28, 40)
  const badgeW = clampRound(
    Math.min(contentWidth * 0.42, estimateLineWidth(spec.badgeLabel, spec.typography.badgeFontSize) + badgeH + 18),
    92,
    contentWidth,
  )
  const sidePanelW = blueprint.emphasisPlacement === 'side-card'
    ? clampRound(contentWidth * (0.28 + blueprint.emphasisWeight * 0.32), 132, Math.max(132, contentWidth - 180))
    : 0
  const columnGap = sidePanelW > 0 ? 18 : 0
  const mainWidth = Math.max(180, contentWidth - sidePanelW - columnGap)
  const titleWidth = clampRound(
    mainWidth * blueprint.titleWidthRatio,
    Math.min(180, mainWidth),
    Math.max(Math.min(520, mainWidth), 180),
  )
  const titleX = centeredTitle
    ? innerX + Math.round((mainWidth - titleWidth) / 2)
    : innerX
  const badgeX = centeredTitle
    ? innerX + Math.round((mainWidth - badgeW) / 2)
    : innerX
  const badgeY = innerY
  const titleY = blueprint.titlePlacement === 'middle-left'
    ? innerY + badgeH + spec.layoutStrategy.titleGap + 10
    : innerY + badgeH + spec.layoutStrategy.titleGap

  const titleH = estimateTextHeight({
    text: spec.title,
    width: titleWidth,
    fontSize: spec.typography.titleFontSize,
    lineHeight: spec.typography.titleLineHeight,
    maxLines: 3,
  })
  const subtitleH = estimateTextHeight({
    text: spec.subtitle,
    width: titleWidth,
    fontSize: spec.typography.subtitleFontSize,
    lineHeight: spec.typography.subtitleLineHeight,
    maxLines: 3,
  })

  nodes.push({
    kind: 'text',
    role: 'board',
    x: spec.baseX,
    y: spec.baseY,
    w: spec.width,
    h: spec.height,
    content: ' ',
    fontSize: 1,
    cornerRadius: spec.board.cornerRadius,
  })

  if (blueprint.ornamentMode === 'rail') {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: innerX - 12,
      y: innerY,
      w: 6,
      h: spec.height - spec.board.paddingTop - spec.board.paddingBottom,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
  }

  nodes.push({
    kind: 'geo',
    role: 'badge',
    shape: 'pill',
    x: badgeX,
    y: badgeY,
    w: badgeW,
    h: badgeH,
    label: spec.badgeLabel,
    fillColor: spec.palette.accentSoft,
    textColor: spec.palette.accent,
  })

  nodes.push({
    kind: 'text',
    role: 'title',
    x: titleX,
    y: titleY,
    w: titleWidth,
    h: titleH,
    content: spec.title,
    fontSize: spec.typography.titleFontSize,
    textColor: spec.palette.primaryText,
    fontWeight: 'bold',
    textAlign: centeredTitle ? 'middle' : 'start',
    fontFamily: spec.palette.name === 'warm-editorial' ? 'serif' : spec.palette.name === 'github-dark' ? 'mono' : 'sans',
    letterSpacing: spec.palette.name === 'github-dark' ? 0.18 : 0,
    lineHeight: spec.typography.titleLineHeight,
  })

  nodes.push({
    kind: 'text',
    role: 'subtitle',
    x: titleX,
    y: titleY + titleH + spec.layoutStrategy.titleGap,
    w: titleWidth,
    h: subtitleH,
    content: spec.subtitle,
    fontSize: spec.typography.subtitleFontSize,
    textColor: spec.palette.secondaryText,
    textAlign: centeredTitle ? 'middle' : 'start',
    lineHeight: spec.typography.subtitleLineHeight,
  })

  let cursorY = titleY + titleH + spec.layoutStrategy.titleGap + subtitleH + 16
  if (blueprint.ornamentMode === 'short-line') {
    const w = Math.min(74, titleWidth)
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: centeredTitle ? titleX + Math.round((titleWidth - w) / 2) : titleX,
      y: cursorY,
      w,
      h: spec.palette.name === 'github-dark' ? 4 : 3,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
    cursorY += 18
  } else if (blueprint.ornamentMode === 'pill') {
    const w = Math.min(78, titleWidth)
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'pill',
      x: centeredTitle ? titleX + Math.round((titleWidth - w) / 2) : titleX,
      y: cursorY,
      w,
      h: 10,
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accentSoft,
    })
    cursorY += 18
  } else if (blueprint.ornamentMode === 'corner') {
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: titleX,
      y: cursorY,
      w: 22,
      h: 3,
      fillColor: spec.palette.accent,
      textColor: spec.palette.accent,
    })
    nodes.push({
      kind: 'geo',
      role: 'divider',
      shape: 'rectangle',
      x: titleX + Math.max(26, titleWidth - 30),
      y: cursorY,
      w: 22,
      h: 3,
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accentSoft,
    })
    cursorY += 16
  }

  const availableBottom = spec.baseY + spec.height - spec.board.paddingBottom
  const footerBaseH = estimateTextHeight({
    text: spec.footerText,
    width: contentWidth,
    fontSize: spec.typography.footerFontSize,
    lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
    maxLines: 2,
  })
  const footerExtra = blueprint.footerStyle === 'pill' ? 18 : blueprint.footerStyle === 'meta-strip' ? 10 : 0
  const footerH = footerBaseH + footerExtra
  const footerY = availableBottom - footerH

  const makeSectionNode = (params: {
    role?: 'section' | 'cta-panel'
    section: DesignContentSection
    x: number
    y: number
    w: number
    fontSize: number
    paddingH: number
    paddingV: number
    fontWeight?: 'regular' | 'medium' | 'bold'
    highlight?: boolean
  }): CoverRenderNode => {
    const h = Math.max(76, estimateTextHeight({
      text: `${params.section.title}\n${params.section.body}`,
      width: params.w,
      fontSize: params.fontSize,
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: params.paddingH,
      paddingV: params.paddingV,
      maxLines: 5,
    }))
    return {
      kind: 'text',
      role: params.role || 'section',
      x: params.x,
      y: params.y,
      w: params.w,
      h,
      content: `${params.section.title}\n${params.section.body}`,
      fontSize: params.fontSize,
      fillColor: params.highlight
        ? spec.palette.surface
        : spec.styleGuide.sectionTone === 'outline'
          ? spec.palette.background
          : spec.styleGuide.sectionTone === 'solid'
            ? spec.palette.surface
            : spec.palette.accentSoft,
      fillOpacity: params.highlight ? 100 : spec.styleGuide.sectionTone === 'outline' ? 100 : 94,
      textColor: spec.palette.primaryText,
      fontWeight: params.fontWeight || 'medium',
      lineHeight: spec.typography.sectionLineHeight,
      paddingH: params.paddingH,
      paddingV: params.paddingV,
      cornerRadius: params.highlight ? 22 : 18,
      strokeVisible: spec.styleGuide.sectionTone === 'outline' || params.highlight === true,
      strokeColor: spec.palette.accent,
      strokeWidth: spec.styleGuide.sectionTone === 'outline' || params.highlight === true ? 1.2 : 0,
      strokeOpacity: params.highlight ? 30 : 26,
      clipContent: true,
    }
  }

  let remainingSections = [...spec.sections]
  if (blueprint.emphasisPlacement === 'hero-band' && remainingSections.length > 0) {
    const hero = remainingSections.shift()!
    const heroNode = makeSectionNode({
      section: hero,
      x: innerX,
      y: cursorY,
      w: contentWidth,
      fontSize: spec.typography.sectionTitleFontSize,
      paddingH: 22,
      paddingV: 18,
      fontWeight: 'bold',
      highlight: true,
    })
    nodes.push(heroNode)
    cursorY += heroNode.h + spec.layoutStrategy.sectionGap
  } else if (blueprint.emphasisPlacement === 'hero-card' && remainingSections.length > 0) {
    const hero = remainingSections.shift()!
    const heroW = clampRound(contentWidth * (0.86 - blueprint.asymmetry * 0.18), 220, contentWidth)
    const heroX = innerX + Math.round((contentWidth - heroW) / 2)
    const heroNode = makeSectionNode({
      section: hero,
      x: heroX,
      y: cursorY,
      w: heroW,
      fontSize: spec.typography.sectionTitleFontSize,
      paddingH: 22,
      paddingV: 18,
      fontWeight: 'bold',
      highlight: true,
    })
    nodes.push(heroNode)
    cursorY += heroNode.h + spec.layoutStrategy.sectionGap
  }

  let sectionAreaX = innerX
  let sectionAreaW = contentWidth
  if (blueprint.emphasisPlacement === 'side-card' && remainingSections.length > 0) {
    const panelSection = spec.styleGuide.ctaWeight === 'button'
      ? (remainingSections.pop() || spec.sections.at(-1)!)
      : (remainingSections.shift() || spec.sections[0]!)
    const panelX = innerX + contentWidth - sidePanelW
    const panelY = Math.max(cursorY - 6, titleY)
    const panelNode = makeSectionNode({
      role: spec.styleGuide.ctaWeight === 'button' ? 'cta-panel' : 'section',
      section: panelSection,
      x: panelX,
      y: panelY,
      w: sidePanelW,
      fontSize: spec.typography.sectionBodyFontSize,
      paddingH: 18,
      paddingV: 16,
      fontWeight: spec.styleGuide.ctaWeight === 'button' ? 'medium' : 'bold',
      highlight: spec.styleGuide.ctaWeight === 'button',
    })
    nodes.push(panelNode)
    if (spec.styleGuide.ctaWeight === 'button') {
      nodes.push({
        kind: 'button',
        role: 'cta-button',
        x: panelX + 18,
        y: panelY + panelNode.h - 50,
        w: Math.max(112, sidePanelW - 36),
        h: 40,
        label: panelSection.title,
        variant: 'primary',
      })
    }
    sectionAreaW = Math.max(176, contentWidth - sidePanelW - columnGap)
    cursorY = Math.max(cursorY, panelY + panelNode.h + 14)
  } else if (blueprint.emphasisPlacement === 'floating-chip' && spec.sections.length > 0) {
    nodes.push({
      kind: 'geo',
      role: 'index',
      shape: 'pill',
      x: innerX + Math.max(0, contentWidth - 132),
      y: Math.max(innerY + 4, cursorY - 8),
      w: 132,
      h: 28,
      label: spec.sections[0]?.title || '重点信息',
      fillColor: spec.palette.accentSoft,
      textColor: spec.palette.accent,
    })
  }

  const pushFooter = () => {
    nodes.push(blueprint.footerStyle === 'pill'
      ? {
        kind: 'text',
        role: 'footer',
        x: innerX,
        y: footerY,
        w: contentWidth,
        h: footerH,
        content: spec.footerText,
        fontSize: spec.typography.footerFontSize,
        fillColor: spec.palette.accentSoft,
        fillOpacity: 100,
        textColor: spec.palette.secondaryText,
        lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
        paddingH: 14,
        paddingV: 8,
        textAlign: centeredTitle ? 'middle' : 'start',
        cornerRadius: 999,
        clipContent: true,
      }
      : blueprint.footerStyle === 'meta-strip'
        ? {
          kind: 'text',
          role: 'footer',
          x: innerX,
          y: footerY,
          w: contentWidth,
          h: footerH,
          content: spec.footerText,
          fontSize: spec.typography.footerFontSize,
          fillColor: spec.palette.surface,
          fillOpacity: 100,
          textColor: spec.palette.secondaryText,
          lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
          paddingH: 12,
          paddingV: 6,
          textAlign: centeredTitle ? 'middle' : 'start',
          cornerRadius: 10,
          clipContent: true,
        }
        : {
          kind: 'text',
          role: 'footer',
          x: innerX,
          y: footerY,
          w: contentWidth,
          h: footerH,
          content: spec.footerText,
          fontSize: spec.typography.footerFontSize,
          textColor: spec.palette.secondaryText,
          textAlign: centeredTitle ? 'middle' : 'start',
          lineHeight: Math.round(spec.typography.footerFontSize * 1.45),
          clipContent: true,
        })
  }

  const remainingHeight = Math.max(120, footerY - cursorY - 12)
  if (blueprint.sectionFlow === 'grid' && remainingSections.length > 0) {
    const gap = spec.layoutStrategy.sectionGap
    const columns = blueprint.sectionColumns
    const columnW = columns === 2 ? Math.floor((sectionAreaW - gap) / 2) : sectionAreaW
    let x = sectionAreaX
    let y = cursorY
    let rowBottom = cursorY
    remainingSections.forEach((section, index) => {
      const isLastHighlight = blueprint.sectionEmphasis === 'last-highlight' && remainingSections.length > 1 && index === remainingSections.length - 1
      const node = makeSectionNode({
        role: isLastHighlight && spec.styleGuide.ctaWeight !== 'none' ? 'cta-panel' : 'section',
        section,
        x,
        y,
        w: columns === 2 && (remainingSections.length % 2 === 1) && index === remainingSections.length - 1 ? sectionAreaW : columnW,
        fontSize: spec.typography.sectionBodyFontSize,
        paddingH: 18,
        paddingV: 16,
        fontWeight: isLastHighlight ? 'bold' : 'medium',
        highlight: isLastHighlight,
      })
      nodes.push(node)
      if (node.w === sectionAreaW || columns === 1 || index % 2 === 1) {
        y = rowBottom = Math.max(rowBottom, node.y + node.h) + gap
        x = sectionAreaX
      } else {
        x = sectionAreaX + columnW + gap
        rowBottom = Math.max(rowBottom, node.y + node.h)
      }
    })
  } else {
    let flowY = cursorY
    const baseGap = spec.layoutStrategy.sectionGap
    remainingSections.forEach((section, index) => {
      const widthRatio = blueprint.sectionFlow === 'stagger'
        ? (blueprint.sectionEmphasis === 'alternating'
          ? (index % 2 === 0 ? 0.92 : 0.76)
          : 0.84)
        : blueprint.sectionEmphasis === 'alternating'
          ? (index % 2 === 0 ? 1 : 0.86)
          : 1
      const cardW = clampRound(sectionAreaW * widthRatio, Math.min(180, sectionAreaW), sectionAreaW)
      const alignRight = blueprint.sectionFlow === 'stagger' && index % 2 === 1
      const cardX = alignRight
        ? sectionAreaX + Math.max(0, sectionAreaW - cardW)
        : sectionAreaX + (centeredTitle && widthRatio < 1 ? Math.round((sectionAreaW - cardW) / 2) : 0)
      const isFirstLarge = blueprint.sectionEmphasis === 'first-large' && index === 0
      const isLastHighlight = blueprint.sectionEmphasis === 'last-highlight' && remainingSections.length > 1 && index === remainingSections.length - 1
      const node = makeSectionNode({
        role: isLastHighlight && spec.styleGuide.ctaWeight !== 'none' ? 'cta-panel' : 'section',
        section,
        x: cardX,
        y: flowY,
        w: cardW,
        fontSize: isFirstLarge ? spec.typography.sectionTitleFontSize : spec.typography.sectionBodyFontSize,
        paddingH: isFirstLarge ? 22 : 18,
        paddingV: isFirstLarge ? 18 : 16,
        fontWeight: isFirstLarge || isLastHighlight ? 'bold' : 'medium',
        highlight: isFirstLarge || isLastHighlight,
      })
      nodes.push(node)
      flowY += node.h + baseGap
    })
  }

  if (spec.styleGuide.ctaWeight === 'button' && !nodes.some((node) => node.kind === 'button' && node.role === 'cta-button')) {
    const ctaSource = spec.sections.at(-1) || spec.sections[0]
    nodes.push({
      kind: 'button',
      role: 'cta-button',
      x: innerX,
      y: Math.max(cursorY, footerY - 52),
      w: Math.min(180, Math.max(128, contentWidth * 0.42)),
      h: 40,
      label: ctaSource?.title || 'Primary CTA',
      variant: 'primary',
    })
  }

  void remainingHeight
  pushFooter()
  return nodes
}

function solveAdaptiveCoverNodes(spec: CoverResolvedSpec): { nodes: CoverRenderNode[]; review: CoverReviewResult } {
  let working = spec
  let draft: CoverRenderNode[] = []
  let review: CoverReviewResult = { attempts: 1, overflowX: 0, overflowY: 0, compacted: false }

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    draft = buildBlueprintCoverNodes(working)
    review = reviewCoverNodes(working, draft, attempt)
    if (review.overflowX <= 0 && review.overflowY <= 0) {
      return { nodes: draft, review }
    }
    working = compactCoverSpec(working, review)
  }

  return { nodes: draft, review }
}

function cloneCoverSpec(
  spec: CoverResolvedSpec,
  args: Record<string, unknown>,
  compositionFamily: DesignCompositionFamily,
  variant: string,
): CoverResolvedSpec {
  const ratio = inferDesignRatioFromDimensions(spec.width, spec.height)
  const styleGuide = {
    ...buildStyleGuideForArgs(args, spec.palette, compositionFamily),
    headlineAlign: spec.styleGuide.headlineAlign,
    ornament: spec.styleGuide.ornament,
    sectionTone: spec.styleGuide.sectionTone,
    ctaWeight: spec.styleGuide.ctaWeight,
    density: spec.styleGuide.density,
    componentMood: spec.styleGuide.componentMood,
  }
  return {
    ...spec,
    compositionFamily,
    variant,
    styleGuide,
    typography: normalizeTypographyPlan(args, ratio, compositionFamily, spec.palette),
    layoutStrategy: normalizeLayoutStrategyPlan(args, compositionFamily, spec.palette),
    layoutBlueprint: normalizeLayoutBlueprintForArgs(args, {
      ratio,
      sectionCount: spec.sections.length,
      palette: spec.palette,
      compositionFamily,
      styleGuide,
    }),
  }
}

function collectCoverCandidateSpecs(spec: CoverResolvedSpec, args: Record<string, unknown>): CoverResolvedSpec[] {
  const signals = readDesignSignalProfile(args)
  const candidates: CoverResolvedSpec[] = []
  const seen = new Set<string>()
  const pushCandidate = (compositionFamily: DesignCompositionFamily, variant: string) => {
    const key = `${compositionFamily}:${variant}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(cloneCoverSpec(spec, args, compositionFamily, variant))
  }

  if (spec.compositionFamily === 'numbered-list') {
    pushCandidate('numbered-list', spec.variant)
    pushCandidate('numbered-list', 'editorial-rail')
    pushCandidate('numbered-list', 'banded-list')
    pushCandidate('numbered-list', 'card-list')
  } else if (spec.compositionFamily === 'editorial-stack') {
    pushCandidate('editorial-stack', spec.variant)
    pushCandidate('editorial-stack', 'center-stack')
    pushCandidate('editorial-stack', 'offset-stack')
  } else {
    pushCandidate('split-feature', spec.variant)
    pushCandidate('split-feature', 'hero-band')
    if (signals.prefersButtons || signals.prefersDark || spec.styleGuide.ctaWeight === 'button') {
      pushCandidate('split-feature', 'cta-panel')
    }
  }

  if ((signals.prefersCenter || signals.prefersPoster || signals.prefersEditorial) && spec.palette.name !== 'github-dark') {
    pushCandidate('editorial-stack', signals.prefersCenter ? 'center-stack' : 'offset-stack')
  }
  if (signals.prefersButtons || signals.prefersDark || spec.styleGuide.ctaWeight === 'button') {
    pushCandidate('split-feature', 'cta-panel')
  }
  if (signals.prefersDense || spec.sections.length >= 4) {
    pushCandidate('numbered-list', signals.prefersDense ? 'banded-list' : 'editorial-rail')
  }
  if (signals.prefersMinimal && spec.sections.length <= 4 && spec.palette.name !== 'github-dark') {
    pushCandidate('editorial-stack', 'center-stack')
  }

  return candidates.slice(0, 6)
}

function critiqueCoverCandidate(
  spec: CoverResolvedSpec,
  nodes: CoverRenderNode[],
  review: CoverReviewResult,
  args: Record<string, unknown>,
): CoverCandidateCritique {
  const signals = readDesignSignalProfile(args)
  const issues: DesignReviewIssue[] = []
  let score = 100
  score -= review.overflowX * 2.5
  score -= review.overflowY * 2.2
  if (review.compacted) score -= 4

  const sectionBlockCount = nodes.filter((node) => node.role === 'section' || node.role === 'cta-panel').length
  const titleNode = nodes.find((node): node is Extract<CoverRenderNode, { kind: 'text' }> => node.kind === 'text' && node.role === 'title')
  const footerNode = nodes.find((node): node is Extract<CoverRenderNode, { kind: 'text' }> => node.kind === 'text' && node.role === 'footer')
  const hasButton = nodes.some((node) => node.kind === 'button' && node.role === 'cta-button')
  const hasRail = nodes.some((node) => node.kind === 'geo' && node.role === 'divider' && node.h > node.w * 3)
  const hasOutlinedSection = nodes.some((node) => node.kind === 'text' && (node.role === 'section' || node.role === 'cta-panel') && node.strokeVisible === true && (node.strokeWidth || 0) > 0)
  const hasWideDivider = nodes.some((node) => node.kind === 'geo' && node.role === 'divider' && node.w >= spec.width * 0.66 && node.h >= 3)

  if (sectionBlockCount !== spec.sections.length) {
    issues.push({
      code: 'structure-mismatch',
      severity: 'error',
      message: `当前候选只承接了 ${sectionBlockCount}/${spec.sections.length} 组信息区。`,
    })
    score -= 28
  } else {
    score += 10
  }

  if (signals.prefersButtons) {
    if (!hasButton) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '用户要求更强按钮感，但当前候选缺少明确的按钮主动作。',
      })
      score -= 14
    } else {
      score += 8
    }
  }

  if (signals.avoidsButtons && hasButton) {
    issues.push({
      code: 'visual-rhythm',
      severity: 'warning',
      message: '用户明确不希望出现按钮化动作，但当前候选仍然生成了主按钮。',
    })
    score -= 18
  }

  if (signals.avoidsWideDivider && hasWideDivider) {
    issues.push({
      code: 'visual-rhythm',
      severity: 'warning',
      message: '用户不希望出现粗分割线，但当前候选仍保留了明显的宽分割条。',
    })
    score -= 12
  }

  if (signals.prefersCenter) {
    if (titleNode?.textAlign !== 'middle') {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '用户要求封面感/居中排版，但当前标题仍未居中。',
      })
      score -= 12
    } else {
      score += 8
    }
  }

  if (signals.prefersRail) {
    if (!hasRail) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '用户要求侧向导轨或栏目线，但当前候选没有形成纵向装饰基线。',
      })
      score -= 10
    } else {
      score += 6
    }
  }

  if (signals.prefersOutline) {
    if (!hasOutlinedSection) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '用户要求描边/线框信息区，但当前候选没有启用描边块。 ',
      })
      score -= 10
    } else {
      score += 6
    }
  }

  if (signals.prefersMinimal) {
    if (spec.compositionFamily === 'editorial-stack') score += 8
    if (spec.compositionFamily === 'numbered-list' && spec.variant === 'banded-list') score -= 6
  }

  if (signals.prefersPoster || signals.prefersEditorial) {
    if (spec.compositionFamily === 'editorial-stack') score += 12
    if (spec.compositionFamily === 'numbered-list') score -= 8
    if (spec.compositionFamily === 'split-feature') score -= 12
  }

  if (signals.prefersDense) {
    if (spec.compositionFamily === 'numbered-list') score += 8
    if (spec.compositionFamily === 'editorial-stack' && spec.sections.length >= 4) score -= 4
  }

  if (signals.prefersButtons && spec.compositionFamily === 'split-feature') {
    score += 10
  }
  if (!signals.prefersButtons && !signals.prefersDark && spec.compositionFamily === 'split-feature') {
    score -= 8
  }
  if (!signals.prefersButtons && spec.variant === 'cta-panel') {
    score -= 14
  }

  if (signals.prefersEditorial && spec.variant === 'editorial-rail') score += 7
  if (signals.prefersPoster && spec.styleGuide.headlineAlign === 'center') score += 6
  if (signals.prefersDark && spec.palette.name === 'github-dark') score += 6
  if (signals.prefersWarm && spec.palette.name === 'warm-editorial') score += 6
  if (!signals.prefersCards && spec.variant === 'card-list' && spec.sections.length >= 4) score -= 4
  if (footerNode?.textAlign === 'middle' && signals.prefersCenter) score += 2

  const summary = issues.length > 0
    ? issues.map((issue) => issue.message).join('；')
    : `候选 ${spec.compositionFamily}/${spec.variant} 与当前指令匹配度较高。`

  return {
    score,
    issues,
    summary,
  }
}

function selectResponsiveCoverSolution(
  spec: CoverResolvedSpec,
  args: Record<string, unknown>,
): CoverCandidateSolution {
  const candidates = rankResponsiveCoverSolutions(spec, args)
  return candidates[0] || {
    spec,
    nodes: [],
    review: { attempts: 1, overflowX: 0, overflowY: 0, compacted: false },
    critique: { score: 0, issues: [], summary: '没有可用候选。' },
    candidateCount: 0,
  }
}

function coverCandidateKey(spec: CoverResolvedSpec): string {
  return `${spec.compositionFamily}:${spec.variant}`
}

function rankResponsiveCoverSolutions(
  spec: CoverResolvedSpec,
  args: Record<string, unknown>,
): CoverCandidateSolution[] {
  const candidates = collectCoverCandidateSpecs(spec, args)
  const ranked: CoverCandidateSolution[] = []

  for (const candidate of candidates) {
    const solved = solveAdaptiveCoverNodes(candidate)
    const critique = critiqueCoverCandidate(candidate, solved.nodes, solved.review, args)
    ranked.push({
      spec: candidate,
      nodes: solved.nodes,
      review: solved.review,
      critique,
      candidateCount: candidates.length,
    })
  }

  return ranked.sort((left, right) => {
    const leftPass = left.review.overflowX <= 0 && left.review.overflowY <= 0
    const rightPass = right.review.overflowX <= 0 && right.review.overflowY <= 0
    if (leftPass !== rightPass) return rightPass ? 1 : -1
    if (right.critique.score !== left.critique.score) return right.critique.score - left.critique.score
    const leftOverflow = left.review.overflowX + left.review.overflowY
    const rightOverflow = right.review.overflowX + right.review.overflowY
    return leftOverflow - rightOverflow
  })
}

function composeSocialCover(editor: Editor, args: Record<string, unknown>) {
  const baseArgs = applyPromptDerivedHardConstraints(args, 'social-cover')
  const requestedPlatform = normalizeDesignPlatform(baseArgs.platform, 'xiaohongshu')
  if (!['xiaohongshu', 'youtube', 'generic'].includes(requestedPlatform)) {
    throw new Error('design.composeSocialCover 仅支持 xiaohongshu / youtube / generic')
  }

  const runId = typeof args.__scopeRunId === 'string' && args.__scopeRunId.trim()
    ? args.__scopeRunId.trim()
    : `design-run-${Date.now()}`
  const repairScope: DesignRepairScope = args.repairScope === 'run-owned' ? 'run-owned' : 'selected'
  const continuation = resolveContinuationContext(editor, args)
  const effectiveArgs = isDesignRevisionIntent(args) && continuation.boardBounds
    ? applyPromptDerivedHardConstraints(seedPlanningArgsFromContinuation(args, continuation), 'social-cover')
    : baseArgs
  if (effectiveArgs !== args) {
    const continuationDeleteIds = Array.from(new Set([
      ...continuation.ownedNodeIds,
      ...(continuation.boardId ? [continuation.boardId] : []),
    ]))
    if (continuationDeleteIds.length > 0) {
      deleteShapeIds(editor, continuationDeleteIds as TLShapeId[])
    }
  }
  const built = buildSocialCoverWorkPlan(editor, null, effectiveArgs, runId)
  runBatchDesign(editor, {
    ops: built.plan.executionSteps.flatMap((step) => step.batchOps),
  })
  const createdIds = listOwnedNodePayload(editor, runId).map((item) => item.id as TLShapeId)
  const verification = verifyLayoutState(editor, {
    runId,
    layoutBudget: built.plan.layoutBudget,
    expectedSectionCount: built.plan.sectionCount,
    expectedHeadlineAlign: built.plan.styleGuide.headlineAlign,
    expectedCtaWeight: built.plan.styleGuide.ctaWeight,
    expectedSectionTone: built.plan.styleGuide.sectionTone,
    expectedBannedMotifs: built.plan.scenePlan.bannedMotifs,
    repairScope,
  })

  editor.setSelectedShapes(createdIds)
  if (typeof editor.zoomToSelectionIfOffscreen === 'function') {
    const padding = Math.round(Math.min(built.plan.board.width, built.plan.board.height) * 0.12)
    editor.zoomToSelectionIfOffscreen(padding, { animation: { duration: 180 } })
  }

  return {
    count: createdIds.length,
    platform: built.plan.platform,
    ratio: built.plan.ratio,
    compositionFamily: built.plan.compositionFamily,
    sectionCount: built.plan.sectionCount,
    palette: built.plan.palette.name,
    placement: built.placement.basis,
    review: {
      attempts: verification.report.attempts,
      overflowX: verification.report.geometryPassed ? 0 : 1,
      overflowY: verification.report.geometryPassed ? 0 : 1,
      compacted: verification.report.issues.some((issue) => issue.code === 'overflow'),
    },
    variant: built.plan.scenePlan.id,
    critique: verification.report.summary,
  }
}

function updateShapeOwnership(
  editor: Editor,
  ids: TLShapeId[],
  params: { runId: string; stepId: string; role: string; repairScope: DesignRepairScope },
) {
  ids.forEach((id) => {
    const shape = editor.getShape(id) as TLShape | undefined
    if (!shape) return
    editor.updateShape({
      id,
      type: shape.type,
      meta: {
        ...shapeMeta(shape),
        ...buildOwnershipMeta(params),
      },
    } as never)
  })
}

function buildSocialCoverWorkPlan(
  editor: Editor,
  activeFile: string | null,
  args: Record<string, unknown>,
  runId: string,
): {
  plan: DesignWorkPlan
  placement: { x: number; y: number; basis: 'empty-canvas' | 'existing-layout-right' | 'existing-layout-below' | 'viewport-origin' | 'explicit' }
} {
  const platform = normalizeDesignPlatform(args.platform, 'xiaohongshu')
  const ratio = normalizeDesignRatio(args.ratio)
  const semanticControls = resolveSemanticControls(args)
  const dimensions = resolveTaskDimensions('social-cover', { ...args, ratio })
  const repairScope = args.repairScope === 'run-owned' ? 'run-owned' : 'selected'
  const observation = buildObservation(editor, activeFile, dimensions, args)
  const palette = inferPaletteForArgs(args, platform)
  const sectionCount = Math.max(1, Math.min(6,
    Number.isFinite(Number(args.sectionCount))
      ? Math.round(Number(args.sectionCount))
      : Array.isArray(args.contentSections)
        ? args.contentSections.length
        : resolveSectionCountFromPrompt(collectDesignSignalText(args), ratio, semanticControls),
  ))
  const compositionFamily = normalizeCompositionFamily(args, palette, sectionCount)
  const sections = normalizeContentSections(args, compositionFamily, sectionCount, palette)
  const placementStrategy = normalizePlacementStrategy(args)
  const placement = observation.emptySpace || findPreferredCanvasPlacement(editor, dimensions, args, placementStrategy)
  const board = normalizeBoardPlan(args, dimensions.w, dimensions.h)
  const typography = normalizeTypographyPlan(args, ratio, compositionFamily, palette)
  const layoutStrategy = normalizeLayoutStrategyPlan(args, compositionFamily, palette)
  const styleGuide = buildStyleGuideForArgs(args, palette, compositionFamily)
  const layoutBlueprint = normalizeLayoutBlueprintForArgs(args, {
    ratio,
    sectionCount: sections.length,
    palette,
    compositionFamily,
    styleGuide,
  })
  const layoutBudget = buildLayoutBudgetForArgs(args, board, layoutStrategy)
  const brief = buildDesignBriefForArgs(args, {
    platform,
    ratio,
    palette,
    audience: typeof args.audience === 'string' && args.audience.trim()
      ? args.audience.trim()
      : platform === 'youtube'
        ? '视频平台浏览用户'
        : platform === 'xiaohongshu'
          ? '小红书内容浏览用户'
          : '内容浏览用户',
    tone: typeof args.tone === 'string' && args.tone.trim() ? args.tone.trim() : palette.name === 'github-dark' ? 'technical-precise' : 'editorial-warm',
    sectionCount: sections.length,
    sections,
  })
  const styleSystem = buildStyleSystemForArgs(args, palette, styleGuide, typography, board)
  const scenePlan = buildFallbackScenePlanForArgs(args, {
    ratio,
    placementStrategy,
    compositionFamily,
    board,
    layoutBudget,
    layoutBlueprint,
    brief,
    styleGuide,
    styleSystem,
    sections,
  })
  const executionProgram = isPlainRecord(args.executionProgram) && Array.isArray(args.executionProgram.stages)
    ? args.executionProgram as unknown as DesignExecutionProgram
    : compileScenePlanToExecutionProgram(scenePlan, placement, styleSystem, runId, repairScope)
  const reviewChecklist = Array.isArray(args.reviewChecklist)
    ? args.reviewChecklist.map((item) => String(item)).filter(Boolean)
    : [
      `保持 ${ratio} 版面比例准确`,
      '标题区控制在 2 到 3 行，不抢信息区预算',
      sections.length >= 4 ? '信息组保持稳定节奏，避免尾部超出版心' : '信息区保持清晰留白',
      '避免重复模板母题，不出现无意义大椭圆、固定右侧按钮或底部粗横条',
    ]
  const plan: DesignWorkPlan = {
    taskType: 'social-cover',
    platform,
    ratio,
    audience: brief.audience,
    tone: brief.visualTone,
    themeKeywords: Array.isArray(args.themeKeywords) ? args.themeKeywords.map((item) => String(item)).filter(Boolean) : [],
    palette,
    compositionFamily,
    sectionCount: sections.length,
    contentSections: sections,
    placementStrategy,
    geometryRules: {
      badgeShape: 'pill',
      indexMarker: compositionFamily === 'numbered-list' ? 'circle' : 'pill',
      divider: styleSystem.ornamentRules.mode === 'short-line' ? 'line' : 'bar',
      allowStretchedEllipse: false,
    },
    board,
    typography,
    layoutStrategy,
    semanticControls,
    constraintFlags: {
      ratioExplicit: true,
      sectionCountExplicit: Number.isFinite(Number(args.sectionCount)),
      platformExplicit: typeof args.platform === 'string' && String(args.platform).trim().length > 0,
    },
    observation,
    brief,
    styleGuide,
    styleSystem,
    layoutBlueprint,
    layoutBudget,
    scenePlan,
    executionProgram,
    executionSteps: executionProgramToSteps(executionProgram),
    reviewReport: null,
    repairPlan: null,
    repairScope,
    reviewChecklist,
    decisionTrace: Array.isArray(args.decisionTrace) && args.decisionTrace.length > 0
      ? args.decisionTrace.map((item) => String(item)).filter(Boolean)
      : [
        `约束归一化：锁定 ${ratio} 比例与 ${sections.length} 组信息区。`,
        `设计判断：先产出 brief，再生成 ${styleSystem.id} 风格系统，禁止 ${scenePlan.bannedMotifs.join(' / ')}。`,
        `结构决策：当前场景采用 ${layoutBlueprint.skeleton}/${layoutBlueprint.sectionFlow}，装饰模式为 ${styleSystem.ornamentRules.mode}。`,
        '执行原则：先建 frame 与背景，再写标题区，然后逐批生成信息区和底部元信息。',
      ],
    reasoningSummary: typeof args.reasoningSummary === 'string' && args.reasoningSummary.trim()
      ? args.reasoningSummary.trim()
      : `观察现有画布后，先生成 design brief 与 style system，再将 ${ratio} 版面编译成 scene plan 和 execution program，用 ${sections.length} 组信息区完成标题、证明和底部收口。`,
  }

  return {
    plan,
    placement,
  }
}

async function runDesignTaskController(
  editor: Editor,
  deps: DesignAgentHandlerDeps,
  args: Record<string, unknown>,
) {
  const taskType = String(args.taskType || 'social-cover').trim() === 'content-layout' ? 'content-layout' : 'social-cover'
  const runId = typeof args.__scopeRunId === 'string' && args.__scopeRunId.trim()
    ? args.__scopeRunId.trim()
    : `design-run-${Date.now()}`
  const repairScope: DesignRepairScope = args.repairScope === 'run-owned' ? 'run-owned' : 'selected'
  const continuation = resolveContinuationContext(editor, args)
  const reuseCurrentBoard = taskType === 'social-cover'
    && isDesignRevisionIntent(args)
    && continuation.boardBounds !== null
  const sanitizedArgs = stripExternalDesignPlanHints(args)
  const basePlanningArgs: Record<string, unknown> = reuseCurrentBoard
    ? seedPlanningArgsFromContinuation(sanitizedArgs, continuation)
    : { ...sanitizedArgs }
  const planningArgs = applyPromptDerivedHardConstraints(basePlanningArgs, taskType)
  const progressReporter = getDesignProgressReporter(args)
  const cancelChecker = getDesignCancelChecker(args)
  const toolEvents: DesignControllerEvent[] = []
  let todo: Array<{ id: string; title: string; status: 'pending' | 'running' | 'done' | 'error' }> = []
  const emitEvent = (
    kind: DesignControllerEvent['kind'],
    text: string,
    designPhase?: DesignControllerPhase,
    patch?: Partial<DesignControllerEvent>,
  ) => {
    const event: DesignControllerEvent = {
      kind,
      text,
      designPhase,
      designTodo: patch?.designTodo ?? (todo.length > 0 ? todo.map((item) => ({ ...item })) : undefined),
      designReviewSummary: patch?.designReviewSummary,
      ownedNodeIds: patch?.ownedNodeIds,
      repairScope: patch?.repairScope,
    }
    toolEvents.push(event)
    progressReporter?.(event)
  }
  const emitAndYield = async (
    kind: DesignControllerEvent['kind'],
    text: string,
    designPhase?: DesignControllerPhase,
    patch?: Partial<DesignControllerEvent>,
  ) => {
    assertDesignNotCancelled(cancelChecker)
    emitEvent(kind, text, designPhase, patch)
    await yieldControllerFrame(180, cancelChecker)
  }

  assertDesignNotCancelled(cancelChecker)
  const dimensions = resolveTaskDimensions(taskType, planningArgs)
  await emitAndYield('call', '观察画布：读取编辑器状态、布局摘要和可用空白区。', 'observe', {
    repairScope,
  })
  assertDesignNotCancelled(cancelChecker)
  const observation = buildObservation(editor, deps.activeFileRef.current, dimensions, planningArgs)
  await emitAndYield('result', `观察完成：当前画布 ${observation.layoutDigest?.topLevelElementCount || 0} 个元素，${observation.selectedElementCount > 0 ? `选中 ${observation.selectedElementCount} 个元素` : '无选区'}。`, 'observe', {
    repairScope,
  })
  let plan: DesignWorkPlan
  let placementBasis: 'empty-canvas' | 'existing-layout-right' | 'existing-layout-below' | 'viewport-origin' | 'explicit' =
    observation.emptySpace?.basis || 'viewport-origin'

  if (taskType === 'social-cover') {
    await emitAndYield('call', '生成设计 brief：归一化目标、层级、限制条件和反目标。', 'brief', {
      repairScope,
    })
    const planned = buildSocialCoverWorkPlan(editor, deps.activeFileRef.current, planningArgs, runId)
    plan = planned.plan
    placementBasis = planned.placement.basis
    await emitAndYield('result', `brief 完成：${plan.brief.objective} 目标受众为 ${plan.brief.audience}，反目标包括 ${plan.brief.antiGoals.join(' / ')}。`, 'brief', {
      repairScope,
    })
    await emitAndYield('call', '生成场景蓝图：把 brief 编译成 scene plan、区块树和预算。', 'scene-plan', {
      repairScope,
    })
    for (const line of plan.scenePlan.rationale.slice(0, 3)) {
      await emitAndYield('result', line, 'scene-plan', { repairScope })
    }
    await emitAndYield('call', '编译执行程序：把 scene plan 转成分批 batch ops。', 'compile', {
      repairScope,
    })
    await emitAndYield('result', `编译完成：共 ${plan.executionProgram.stages.length} 个执行阶段，画板比例锁定为 ${plan.ratio}。`, 'compile', {
      repairScope,
    })
  } else {
    await emitAndYield('call', '生成设计 brief：归一化内容排版目标与可编辑结构。', 'brief', {
      repairScope,
    })
    const board: DesignBoardPlan = {
      width: dimensions.w,
      height: dimensions.h,
      paddingX: 36,
      paddingTop: 36,
      paddingBottom: 32,
      cornerRadius: 24,
    }
    const palette = inferPaletteForArgs(args, 'generic')
    const compositionFamily: DesignCompositionFamily = 'editorial-stack'
    const styleGuide = buildStyleGuideForArgs(args, palette, compositionFamily)
    const typography = normalizeTypographyPlan(args, '1:1', compositionFamily, palette)
    const layoutStrategy: DesignLayoutStrategyPlan = {
      align: 'left',
      sectionStyle: 'cards',
      heroWeight: 0.4,
      sectionGap: 18,
      titleGap: 12,
      footerMode: 'caption',
    }
    const layoutBudget = buildLayoutBudgetForArgs(args, board, layoutStrategy)
    const brief = buildDesignBriefForArgs(args, {
      platform: 'generic',
      ratio: '1:1',
      palette,
      audience: typeof args.audience === 'string' ? args.audience : '内容浏览用户',
      tone: typeof args.tone === 'string' ? args.tone : 'structured-editorial',
      sectionCount: 3,
      sections: [],
    })
    const styleSystem = buildStyleSystemForArgs(args, palette, styleGuide, typography, board)
    const scenePlan = buildFallbackScenePlanForArgs(args, {
      ratio: '1:1',
      placementStrategy: normalizePlacementStrategy(args),
      compositionFamily,
      board,
      layoutBudget,
      layoutBlueprint: normalizeLayoutBlueprintForArgs(args, {
        ratio: '1:1',
        sectionCount: 3,
        palette,
        compositionFamily,
        styleGuide,
      }),
      brief,
      styleGuide,
      styleSystem,
      sections: [],
    })
    const placement = observation.emptySpace || findPreferredCanvasPlacement(editor, dimensions, args, normalizePlacementStrategy(args))
    const semanticControls = resolveSemanticControls(args)
    const executionProgram = compileScenePlanToExecutionProgram(scenePlan, placement, styleSystem, runId, repairScope)
    plan = {
      taskType: 'content-layout',
      platform: 'generic',
      ratio: '1:1',
      audience: brief.audience,
      tone: brief.visualTone,
      themeKeywords: Array.isArray(args.themeKeywords) ? args.themeKeywords.map((item) => String(item)).filter(Boolean) : [],
      palette,
      compositionFamily,
      sectionCount: 3,
      contentSections: [],
      placementStrategy: normalizePlacementStrategy(args),
      geometryRules: {
        badgeShape: 'pill',
        indexMarker: 'pill',
        divider: 'line',
        allowStretchedEllipse: false,
      },
      board,
      typography,
      layoutStrategy,
      semanticControls,
      constraintFlags: {
        ratioExplicit: Boolean(args.ratio),
        sectionCountExplicit: Boolean(args.sectionCount),
        platformExplicit: Boolean(args.platform),
      },
      observation,
      brief,
      styleGuide,
      styleSystem,
      layoutBlueprint: scenePlan ? normalizeLayoutBlueprintForArgs(args, {
        ratio: '1:1',
        sectionCount: 3,
        palette,
        compositionFamily,
        styleGuide,
      }) : undefined,
      layoutBudget,
      scenePlan,
      executionProgram,
      executionSteps: executionProgramToSteps(executionProgram),
      reviewReport: null,
      repairPlan: null,
      repairScope,
      reviewChecklist: ['生成清晰的层级结构', '避免覆盖原有非选中内容'],
      reasoningSummary: typeof args.reasoningSummary === 'string' && args.reasoningSummary.trim()
        ? args.reasoningSummary.trim()
        : '先观察画布，再在空白区创建一组可继续编辑的内容排版骨架。',
    }
    placementBasis = placement.basis
    await emitAndYield('result', `brief 完成：${plan.reasoningSummary}`, 'brief', {
      repairScope,
    })
    await emitAndYield('call', '生成场景蓝图：把内容排版要求转成区块树。', 'scene-plan', {
      repairScope,
    })
    await emitAndYield('result', `当前内容布局采用 ${plan.scenePlan.layoutBudget.boardWidth}x${plan.scenePlan.layoutBudget.boardHeight} 画板和 ${plan.executionProgram.stages.length} 个执行阶段。`, 'scene-plan', {
      repairScope,
    })
    await emitAndYield('call', '编译执行程序：把场景蓝图转成分批 batch ops。', 'compile', {
      repairScope,
    })
    await emitAndYield('result', '编译完成：准备进入批次执行。', 'compile', {
      repairScope,
    })
  }
  await emitAndYield('call', `定位落区：优先使用${placementBasis === 'existing-layout-right' ? '右侧空白区' : placementBasis === 'existing-layout-below' ? '下方空白区' : placementBasis === 'viewport-origin' ? '当前视口起始区' : '指定位置'}。`, 'locate', {
    repairScope,
  })
  await emitAndYield('result', `落区确认：${placementBasis}。`, 'locate', { repairScope })
  if (reuseCurrentBoard && continuation.boardBounds) {
    await emitAndYield('result', `检测到连续修正指令：沿用当前画板 (${continuation.boardBounds.x}, ${continuation.boardBounds.y}) ${continuation.boardBounds.w}x${continuation.boardBounds.h}，在原位置重建。`, 'locate', {
      repairScope,
    })
  }

  let ownedNodeIds: string[] = []
  let executionBatches = 0
  let repairRounds = 0
  let boardId: string | null = null
  let boardCreates = 0
  let boardDeletes = 0
  let boardRebuilds = 0
  let sectionRebuilds = 0
  const maxBoardRebuilds = 1
  todo = plan.executionSteps.map((step) => ({ id: step.id, title: step.title, status: 'pending' }))
  const resetTodoFromPlan = () => {
    todo = plan.executionSteps.map((step) => ({ id: step.id, title: step.title, status: 'pending' }))
  }

  const markTodo = (stepId: string, status: 'pending' | 'running' | 'done' | 'error') => {
    const item = todo.find((entry) => entry.id === stepId)
    if (item) item.status = status
  }

  const continuationDeleteIds = reuseCurrentBoard
    ? Array.from(new Set([
      ...continuation.ownedNodeIds,
      ...(continuation.boardId ? [continuation.boardId] : []),
    ]))
    : []

  if (reuseCurrentBoard && continuationDeleteIds.length > 0) {
    await emitAndYield('call', '修正模式：清理上一轮 owned nodes，准备在当前画板原位重建。', 'repair', {
      repairScope,
      ownedNodeIds: continuationDeleteIds,
    })
    deleteShapeIds(editor, continuationDeleteIds as TLShapeId[])
    if (continuation.boardId) {
      boardDeletes += 1
    }
    deps.markDirty()
    await emitAndYield('result', `已清理 ${continuationDeleteIds.length} 个上一轮节点，保持当前画板位置继续修正。`, 'repair', {
      repairScope,
    })
  }

  const executePlanSteps = async (stepsToRun: DesignExecutionStep[]) => {
    assertDesignNotCancelled(cancelChecker)
    if (taskType === 'content-layout') {
      executionBatches += 1
      const beforeIds = new Set(Array.from(editor.getCurrentPageShapeIds()).map((id) => String(id)))
      await emitAndYield('call', '执行批次 1/1：生成内容排版骨架。', 'execute', {
        repairScope,
      })
      assertDesignNotCancelled(cancelChecker)
      composeContentLayout(editor, args)
      deps.markDirty()
      const createdIds = Array.from(editor.getCurrentPageShapeIds())
        .filter((id) => !beforeIds.has(String(id)))
      if (createdIds.length > 0) {
        updateShapeOwnership(editor, createdIds, {
          runId,
          stepId: 'step-layout',
          role: 'content-layout',
          repairScope,
        })
        if (!reuseCurrentBoard) {
          boardCreates += 1
        }
      }
      ownedNodeIds = createdIds.map((id) => String(id))
      markTodo('step-layout', 'done')
      await emitAndYield('result', `已生成 ${createdIds.length} 个内容布局节点。`, 'execute', {
        ownedNodeIds,
        repairScope,
      })
      return
    }

    for (const [index, step] of stepsToRun.entries()) {
      assertDesignNotCancelled(cancelChecker)
      executionBatches += 1
      if (step.batchOps.some((op) => op.op === 'create' && op.target === 'frame' && op.role === 'board')) {
        boardCreates += 1
      }
      markTodo(step.id, 'running')
      await emitAndYield('call', `执行批次 ${index + 1}/${stepsToRun.length}：${step.title}`, 'execute', {
        repairScope,
      })
      runBatchDesign(editor, { ops: step.batchOps })
      deps.markDirty()
      markTodo(step.id, 'done')
      ownedNodeIds = listOwnedNodePayload(editor, runId).map((item) => item.id)
      await emitAndYield('result', `完成 ${step.title}，已写入 ${step.batchOps.length} 个原子操作。`, 'execute', {
        ownedNodeIds,
        repairScope,
      })
    }
  }

  const executePlanOnce = async () => {
    return executePlanSteps(plan.executionSteps)
  }

  await executePlanOnce()
  await emitAndYield('call', '复查并修正：执行几何检查、需求匹配检查与版式节奏检查。', 'verify', {
    ownedNodeIds,
    repairScope,
  })
  let verification = verifyLayoutState(editor, {
    runId,
    layoutBudget: plan.layoutBudget,
    expectedSectionCount: plan.sectionCount,
    expectedHeadlineAlign: plan.styleGuide.headlineAlign,
    expectedCtaWeight: plan.styleGuide.ctaWeight,
    expectedSectionTone: plan.styleGuide.sectionTone,
    expectedBannedMotifs: plan.scenePlan.bannedMotifs,
    repairScope,
    executionBatches,
    repairRounds,
  })
  boardId = verification.boardId
  const maxAutoRepairRounds = getAutoRepairRoundLimit(verification.report.issues)
  await emitAndYield('result', verification.report.summary, 'verify', {
    designReviewSummary: verification.report.summary,
    ownedNodeIds,
    repairScope,
  })

  while (taskType === 'social-cover' && !verification.report.passed && repairRounds < maxAutoRepairRounds) {
    repairRounds += 1
    const repairPlan = buildRepairPlanFromIssues(plan, verification.report.issues)
    if (!repairPlan) {
      break
    }
    if (repairPlan?.strategy === 'rebuild-board' && boardRebuilds >= maxBoardRebuilds) {
      verification.report = {
        ...verification.report,
        passed: false,
        summary: `${verification.report.summary} 已达到整板重建上限，停止继续重建。`,
        issues: [
          ...verification.report.issues,
          {
            code: 'structure-mismatch',
            severity: 'error',
            message: '已达到整板重建上限，停止继续自动刷新重做。',
          },
        ],
      }
      break
    }
    plan.repairPlan = repairPlan
    const repairBoardBounds = boardId
      ? editor.getShapePageBounds(boardId as TLShapeId)
      : null
    await emitAndYield('call', `复查并修正：第 ${repairRounds} 轮，${repairPlan?.reason || '根据复查结果重建局部结构。'}`, 'reflect', {
      designReviewSummary: verification.report.summary,
      ownedNodeIds,
      repairScope,
    })
    const deleteIds = repairPlan?.strategy === 'rebuild-board'
      ? ownedNodeIds as TLShapeId[]
      : collectRepairOwnedNodeIds(editor, runId, repairPlan?.targets || [])
    if (deleteIds.length > 0) {
      deleteShapeIds(editor, deleteIds)
      if (repairPlan?.strategy === 'rebuild-board' && boardId) {
        boardDeletes += 1
        boardRebuilds += 1
      } else {
        sectionRebuilds += deleteIds.length
      }
      deps.markDirty()
      ownedNodeIds = listOwnedNodePayload(editor, runId).map((item) => item.id)
    }
    if (repairPlan?.strategy === 'tighten-layout') {
      planningArgs.board = {
        ...(isPlainRecord(planningArgs.board) ? planningArgs.board : plan.board),
        paddingX: Math.max(24, plan.board.paddingX - 2),
        paddingTop: Math.max(24, plan.board.paddingTop - 2),
        paddingBottom: Math.max(20, plan.board.paddingBottom - 2),
      }
      planningArgs.typography = {
        ...(isPlainRecord(planningArgs.typography) ? planningArgs.typography : plan.typography),
        titleFontSize: Math.max(20, plan.typography.titleFontSize - 2),
        sectionBodyFontSize: Math.max(11, plan.typography.sectionBodyFontSize - 1),
      }
    } else if (repairPlan?.strategy === 'remove-motif') {
      planningArgs.styleGuide = {
        ...(isPlainRecord(planningArgs.styleGuide) ? planningArgs.styleGuide : plan.styleGuide),
        ctaWeight: 'none',
        ornament: plan.styleSystem.ornamentRules.mode === 'short-line' ? 'corner-plates' : 'floating-pill',
      }
      planningArgs.layoutBlueprint = {
        ...(isPlainRecord(planningArgs.layoutBlueprint) ? planningArgs.layoutBlueprint : plan.layoutBlueprint),
        skeleton: 'staggered',
        emphasisPlacement: 'none',
        sectionFlow: 'stagger',
        sectionEmphasis: 'alternating',
        asymmetry: Math.max(0.18, Number(plan.layoutBlueprint?.asymmetry || 0.08)),
      }
    } else if (repairPlan?.strategy === 'restack-sections') {
      planningArgs.layoutBlueprint = {
        ...(isPlainRecord(planningArgs.layoutBlueprint) ? planningArgs.layoutBlueprint : plan.layoutBlueprint),
        sectionFlow: 'stack',
        sectionColumns: 1,
        sectionEmphasis: 'uniform',
      }
    }
    if (repairBoardBounds) {
      planningArgs.x = repairBoardBounds.x
      planningArgs.y = repairBoardBounds.y
      planningArgs.placementStrategy = 'explicit'
    }

    const rebuilt = buildSocialCoverWorkPlan(editor, deps.activeFileRef.current, planningArgs, runId)
    plan = {
      ...rebuilt.plan,
      repairPlan,
    }
    if (!repairBoardBounds || rebuilt.placement.basis !== 'explicit') {
      placementBasis = rebuilt.placement.basis
    }
    resetTodoFromPlan()
    const stepsToRepair = repairPlan?.strategy === 'rebuild-board'
      ? plan.executionSteps
      : plan.executionSteps.filter((step) => stepMatchesRepairTargets(step, repairPlan?.targets || []))
    if (stepsToRepair.length > 0 && stepsToRepair.length < plan.executionSteps.length) {
      for (const step of plan.executionSteps) {
        if (!stepsToRepair.some((candidate) => candidate.id === step.id)) {
          markTodo(step.id, 'done')
        }
      }
    }
    await emitAndYield('result', `repair plan：${repairPlan?.strategy || 'rebuild-board'}，重新执行 ${stepsToRepair.length || plan.executionSteps.length}/${plan.executionSteps.length} 个阶段。`, 'repair', {
      repairScope,
    })
    await executePlanSteps(stepsToRepair.length > 0 ? stepsToRepair : plan.executionSteps)
    verification = verifyLayoutState(editor, {
      runId,
      layoutBudget: plan.layoutBudget,
      expectedSectionCount: plan.sectionCount,
      expectedHeadlineAlign: plan.styleGuide.headlineAlign,
      expectedCtaWeight: plan.styleGuide.ctaWeight,
      expectedSectionTone: plan.styleGuide.sectionTone,
      expectedBannedMotifs: plan.scenePlan.bannedMotifs,
      repairScope,
      executionBatches,
      repairRounds,
    })
    boardId = verification.boardId
    await emitAndYield('result', verification.report.summary, 'repair', {
      designReviewSummary: verification.report.summary,
      ownedNodeIds,
      repairScope,
    })
  }

  await emitAndYield('call', '截图验收：导出当前结果快照用于最终复核。', 'finalize', {
    ownedNodeIds,
    repairScope,
  })
  assertDesignNotCancelled(cancelChecker)
  if (ownedNodeIds.length > 0) {
    editor.setSelectedShapes(ownedNodeIds as TLShapeId[])
    if (typeof editor.zoomToSelectionIfOffscreen === 'function') {
      const padding = Math.round(Math.min(plan.board.width, plan.board.height) * 0.12)
      editor.zoomToSelectionIfOffscreen(padding, { animation: { duration: 180 } })
    }
  }
  const screenshotPath = await deps.exportCurrentDesign({
    format: 'png',
    defaultName: `${taskType}-${runId}.png`,
  })
  assertDesignNotCancelled(cancelChecker)
  verification = verifyLayoutState(editor, {
    runId,
    layoutBudget: plan.layoutBudget,
    expectedSectionCount: plan.sectionCount,
    expectedHeadlineAlign: plan.styleGuide.headlineAlign,
    expectedCtaWeight: plan.styleGuide.ctaWeight,
    expectedSectionTone: plan.styleGuide.sectionTone,
    expectedBannedMotifs: plan.scenePlan.bannedMotifs,
    boardId: boardId || undefined,
    repairScope,
    screenshotPath,
    executionBatches,
    repairRounds,
  })
  boardId = verification.boardId
  await emitAndYield('result', verification.report.summary, 'finalize', {
    designReviewSummary: verification.report.summary,
    ownedNodeIds,
    repairScope,
  })

  const mutationStats: DesignMutationStats = {
    boardCreates,
    boardDeletes,
    boardRebuilds,
    sectionRebuilds,
    executionBatches,
    repairRounds,
    touchedSelection: verification.report.touchedSelection,
  }
  const requestSpec: DesignRequestSpec = {
    taskType,
    promptText: plan.brief.promptText,
    platform: plan.platform,
    ratio: plan.ratio,
    sectionCount: plan.sectionCount,
    repairScope,
    requestedAt: new Date().toISOString(),
    rawArgs: (toSerializableValue(
      Object.fromEntries(
        Object.entries(args).filter(([key]) => !key.startsWith('__')),
      ),
    ) as Record<string, unknown>) || {},
  }
  const resolvedPlan: DesignResolvedPlan = {
    observation: plan.observation,
    brief: plan.brief,
    styleGuide: plan.styleGuide,
    styleSystem: plan.styleSystem,
    semanticControls: plan.semanticControls,
    layoutBudget: plan.layoutBudget,
    scenePlan: plan.scenePlan,
    executionProgram: plan.executionProgram,
    executionSteps: plan.executionSteps,
    repairScope,
  }
  const status: DesignExecutionResult['status'] = verification.report.passed ? 'success' : 'failed'
  const runCapture: DesignRunCapture = {
    runId,
    request: requestSpec,
    observation: plan.observation,
    resolvedPlan,
    mutationStats,
    review: verification.report,
    boardId,
    ownedNodeIds: [...ownedNodeIds],
    screenshotPath,
    createdAt: new Date().toISOString(),
  }

  useDesignSession.getState().setSnapshotMeta({
    latestReviewSummary: verification.report.summary,
    repairScope,
    scenePlanId: plan.scenePlan.id,
    boardId,
    styleSystem: plan.styleSystem,
    reviewFailures: verification.report.issues.map((issue) => issue.code),
    lastAcceptedScreenshot: screenshotPath,
  })
  deps.markDirty()

  return {
    intent: 'run_design_task_controller',
    ownerResourceId: deps.activeFileRef.current,
    status,
    summary: buildControllerSummary({
      taskType,
      ratio: taskType === 'social-cover' ? plan.ratio : undefined,
      compositionFamily: plan.compositionFamily,
      review: verification.report,
      executionSteps: plan.executionSteps,
      placementBasis,
    }),
    ratio: plan.ratio,
    designPhase: 'finalize' as const,
    designTodo: todo,
    designReviewSummary: verification.report.summary,
    ownedNodeIds,
    repairScope,
    scenePlanId: plan.scenePlan.id,
    boardId,
    styleSystem: plan.styleSystem,
    reviewFailures: verification.report.issues.map((issue) => issue.code),
    lastAcceptedScreenshot: screenshotPath,
    review: {
      passed: verification.report.passed,
      geometryPassed: verification.report.geometryPassed,
      screenshotPassed: verification.report.screenshotPassed,
      summary: verification.report.summary,
      issues: verification.report.issues,
    },
    mutationStats,
    requestSpec,
    resolvedPlan,
    runCapture,
    plan,
    reviewReport: verification.report,
    toolEvents,
    streamedToolEvents: progressReporter !== null,
    artifactRefs: screenshotPath ? [{
      kind: 'design-export',
      label: getPathBasename(screenshotPath),
      path: screenshotPath,
      mimeType: 'image/png',
    }] : [],
  }
}

function getEditorState(editor: Editor, activeFile: string | null) {
  const selectedIds = editor.getSelectedShapeIds() as TLShapeId[]
  const selectionSummary = selectedIds.length > 0 ? `已选中 ${selectedIds.length} 个元素` : '未选中元素'
  const layoutDigest = buildDesignLayoutDigest(editor, selectionSummary, useDesignSession.getState().latestReviewSummary || undefined)
  return {
    snapshotHash: hashDesignSnapshot(editor.getSnapshot()),
    selectedCount: selectedIds.length,
    viewport: editor.getViewportPageBounds(),
    activeFile,
    availableComponents: [...DESIGN_CUSTOM_SHAPE_TYPES, 'text', 'geo', 'frame', 'group'],
    layoutDigest,
  }
}

function snapshotLayout(editor: Editor, args: Record<string, unknown>) {
  const maxDepth = Number.isFinite(Number(args.maxDepth)) ? Math.max(0, Math.round(Number(args.maxDepth))) : 1
  const summaries = collectPageShapeSummaries(editor)
  const selectionSummary = editor.getSelectedShapeIds().length > 0 ? `已选中 ${editor.getSelectedShapeIds().length} 个元素` : '未选中元素'
  return {
    maxDepth,
    layoutDigest: buildDesignLayoutDigest(editor, selectionSummary, useDesignSession.getState().latestReviewSummary || undefined),
    shapes: summaries.slice(0, Math.max(8, 8 + maxDepth * 8)),
  }
}

function deleteShapeIds(editor: Editor, ids: TLShapeId[]) {
  if (typeof (editor as Editor & { deleteShapes?: (items: TLShapeId[]) => void }).deleteShapes === 'function') {
    ;(editor as Editor & { deleteShapes: (items: TLShapeId[]) => void }).deleteShapes(ids)
    return
  }
  const store = editor as Editor & { shapes?: Map<TLShapeId, unknown> }
  ids.forEach((id) => store.shapes?.delete(id))
}

function updateNodePatches(
  editor: Editor,
  patches: Array<{ id: string; x?: number; y?: number; props?: Record<string, unknown>; meta?: Record<string, unknown> }>,
) {
  patches.forEach((patch) => {
    if (patch.props !== undefined && containsUndefinedDeep(patch.props)) {
      throw new Error('design.updateNodes 不接受包含 undefined 的 props')
    }
    if (patch.meta !== undefined && containsUndefinedDeep(patch.meta)) {
      throw new Error('design.updateNodes 不接受包含 undefined 的 meta')
    }
    editor.updateShape({
      id: patch.id as TLShapeId,
      type: (editor.getShape(patch.id as TLShapeId)?.type || 'geo') as string,
      ...(Number.isFinite(Number(patch.x)) ? { x: Number(patch.x) } : {}),
      ...(Number.isFinite(Number(patch.y)) ? { y: Number(patch.y) } : {}),
      ...(patch.props ? { props: patch.props } : {}),
      ...(patch.meta ? { meta: omitUndefinedFields(patch.meta) } : {}),
    } as never)
  })
}

function setNodeZOrder(editor: Editor, ids: TLShapeId[], mode: 'front' | 'back' | 'forward' | 'backward') {
  const candidate = editor as Editor & {
    bringToFront?: (shapeIds: TLShapeId[]) => void
    sendToBack?: (shapeIds: TLShapeId[]) => void
    bringForward?: (shapeIds: TLShapeId[]) => void
    sendBackward?: (shapeIds: TLShapeId[]) => void
  }
  if (mode === 'front' && typeof candidate.bringToFront === 'function') {
    candidate.bringToFront(ids)
    return
  }
  if (mode === 'back' && typeof candidate.sendToBack === 'function') {
    candidate.sendToBack(ids)
    return
  }
  if (mode === 'forward' && typeof candidate.bringForward === 'function') {
    candidate.bringForward(ids)
    return
  }
  if (mode === 'backward' && typeof candidate.sendBackward === 'function') {
    candidate.sendBackward(ids)
  }
}

function groupNodeIds(
  editor: Editor,
  ids: TLShapeId[],
  args: { name?: string; meta?: Record<string, unknown> },
): TLShapeId | null {
  const candidate = editor as Editor & {
    groupShapes?: (shapeIds: TLShapeId[], options?: { groupId?: TLShapeId }) => void
  }
  if (typeof candidate.groupShapes === 'function') {
    const groupId = createShapeId()
    candidate.groupShapes(ids, { groupId })
    if (args.meta) {
      const shape = editor.getShape(groupId)
      if (shape) {
        editor.updateShape({
          id: groupId,
          type: shape.type,
          meta: {
            ...shapeMeta(shape),
            ...omitUndefinedFields(args.meta),
          },
        } as never)
      }
    }
    return groupId
  }

  const bounds = ids
    .map((id) => editor.getShapePageBounds(id))
    .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>
  if (bounds.length === 0) return null
  const minX = Math.min(...bounds.map((item) => item.x))
  const minY = Math.min(...bounds.map((item) => item.y))
  const maxX = Math.max(...bounds.map((item) => item.x + item.w))
  const maxY = Math.max(...bounds.map((item) => item.y + item.h))
  const groupId = createShapeId()
  editor.createShape({
    id: groupId,
    type: 'group',
    x: minX,
    y: minY,
    props: {
      w: maxX - minX,
      h: maxY - minY,
      name: args.name || 'Group',
      childIds: ids,
    },
    ...(args.meta ? { meta: omitUndefinedFields(args.meta) } : {}),
  } as never)
  return groupId
}

function runBatchDesign(editor: Editor, args: Record<string, unknown>) {
  const ops = Array.isArray(args.ops) ? args.ops as DesignBatchOp[] : []
  if (ops.length === 0) throw new Error('design.batchDesign 缺少 ops')
  if (ops.length > 15) throw new Error('design.batchDesign 单次最多支持 15 个原子操作')

  const createdIds: TLShapeId[] = []
  const touchedIds = new Set<TLShapeId>()

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue
    if (op.op === 'create' && op.target === 'text') {
      if (op.meta !== undefined && containsUndefinedDeep(op.meta)) {
        throw new Error('design.batchDesign 不接受包含 undefined 的 meta')
      }
      const created = createNativeText(editor, {
        x: op.x,
        y: op.y,
        text: op.text,
        meta: op.meta,
      })
      createdIds.push(created.id as TLShapeId)
      touchedIds.add(created.id as TLShapeId)
      continue
    }

    if (op.op === 'create' && op.target === 'geo') {
      if (op.meta !== undefined && containsUndefinedDeep(op.meta)) {
        throw new Error('design.batchDesign 不接受包含 undefined 的 meta')
      }
      const created = createGeoShape(editor, {
        x: op.x,
        y: op.y,
        w: op.w,
        h: op.h,
        shape: op.shape,
        label: op.label,
        fillColor: op.fillColor,
        textColor: op.textColor,
        meta: op.meta,
      })
      createdIds.push(created.id)
      touchedIds.add(created.id)
      continue
    }

    if (op.op === 'create' && op.target === 'frame') {
      if (op.meta !== undefined && containsUndefinedDeep(op.meta)) {
        throw new Error('design.batchDesign 不接受包含 undefined 的 meta')
      }
      const created = createFrame(editor, {
        x: op.x,
        y: op.y,
        w: op.w,
        h: op.h,
        name: op.name,
        meta: op.meta,
      })
      createdIds.push(created.id)
      touchedIds.add(created.id)
      continue
    }

    if (op.op === 'create' && op.target === 'component') {
      if (!DESIGN_CUSTOM_SHAPE_TYPES.includes(op.component as DesignCustomShapeType)) {
        throw new Error(`Unsupported design component: ${op.component}`)
      }
      if (op.props !== undefined && containsUndefinedDeep(op.props)) {
        throw new Error('design.batchDesign 不接受包含 undefined 的 props')
      }
      if (op.meta !== undefined && containsUndefinedDeep(op.meta)) {
        throw new Error('design.batchDesign 不接受包含 undefined 的 meta')
      }
      const created = createDesignComponent(editor, op.component as DesignCustomShapeType, {
        ...(op.props || {}),
        x: op.x,
        y: op.y,
        meta: op.meta,
      })
      createdIds.push(created.id as TLShapeId)
      touchedIds.add(created.id as TLShapeId)
      continue
    }

    if (op.op === 'update') {
      updateNodePatches(editor, [op])
      touchedIds.add(op.id as TLShapeId)
      continue
    }

    if (op.op === 'group') {
      const groupId = groupNodeIds(editor, op.ids as TLShapeId[], {
        name: op.name,
        meta: op.meta,
      })
      if (groupId) {
        createdIds.push(groupId)
        touchedIds.add(groupId)
      }
      continue
    }

    if (op.op === 'z-order') {
      setNodeZOrder(editor, op.ids as TLShapeId[], op.mode)
      op.ids.forEach((id) => touchedIds.add(id as TLShapeId))
      continue
    }

    if (op.op === 'delete') {
      deleteShapeIds(editor, op.ids as TLShapeId[])
      continue
    }

    if (op.op === 'select') {
      editor.setSelectedShapes(op.ids as TLShapeId[])
      continue
    }
  }

  if (createdIds.length > 0) {
    editor.setSelectedShapes(createdIds)
  }

  return {
    createdCount: createdIds.length,
    touchedCount: touchedIds.size,
  }
}

function resolveTaskDimensions(taskType: string, args: Record<string, unknown>): { w: number; h: number } {
  const explicitWidth = Number.isFinite(Number(args.w))
    ? Number(args.w)
    : Number.isFinite(Number(args.width))
      ? Number(args.width)
      : NaN
  const explicitHeight = Number.isFinite(Number(args.h))
    ? Number(args.h)
    : Number.isFinite(Number(args.height))
      ? Number(args.height)
      : NaN
  if (Number.isFinite(explicitWidth) && Number.isFinite(explicitHeight)) {
    return {
      w: clampDimension(explicitWidth, 760, 120),
      h: clampDimension(explicitHeight, 760, 120),
    }
  }

  if (taskType === 'content-layout') {
    return {
      w: clampDimension(args.w, 760, 120),
      h: clampDimension(args.h, 760, 120),
    }
  }

  const ratio = normalizeDesignRatio(args.ratio)
  const dimensions = getDimensionsForDesignRatio(ratio)
  return { w: dimensions.width, h: dimensions.height }
}

function getSelectionBounds(editor: Editor): DesignObservation['selectionBounds'] {
  const ids = editor.getSelectedShapeIds() as TLShapeId[]
  if (ids.length === 0) return null
  const bounds = ids
    .map((id) => editor.getShapePageBounds(id))
    .filter(Boolean) as Array<{ x: number; y: number; w: number; h: number }>
  if (bounds.length === 0) return null
  const minX = Math.min(...bounds.map((item) => item.x))
  const minY = Math.min(...bounds.map((item) => item.y))
  const maxX = Math.max(...bounds.map((item) => item.x + item.w))
  const maxY = Math.max(...bounds.map((item) => item.y + item.h))
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
  }
}

function findPreferredCanvasPlacement(
  editor: Editor,
  dimensions: { w: number; h: number },
  args: Record<string, unknown>,
  placementStrategy: DesignPlacementStrategy,
) {
  if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) {
    return {
      x: Math.round(Number(args.x)),
      y: Math.round(Number(args.y)),
      basis: 'explicit' as const,
    }
  }

  const selectionBounds = getSelectionBounds(editor)
  if (selectionBounds) {
    const padding = Number.isFinite(Number(args.padding)) ? Math.max(24, Number(args.padding)) : 64
    const preferBelow = placementStrategy === 'auto-below' || selectionBounds.h > selectionBounds.w * 1.4
    return preferBelow
      ? {
        x: Math.round(selectionBounds.x),
        y: Math.round(selectionBounds.y + selectionBounds.h + padding),
        basis: 'existing-layout-below' as const,
      }
      : {
        x: Math.round(selectionBounds.x + selectionBounds.w + padding),
        y: Math.round(selectionBounds.y),
        basis: 'existing-layout-right' as const,
      }
  }

  return toPagePlacement(editor, dimensions, args, placementStrategy)
}

function buildObservation(
  editor: Editor,
  activeFile: string | null,
  dimensions: { w: number; h: number },
  args: Record<string, unknown>,
): DesignObservation {
  const selectedIds = editor.getSelectedShapeIds() as TLShapeId[]
  const selectionSummary = selectedIds.length > 0 ? `已选中 ${selectedIds.length} 个元素` : '未选中元素'
  const latestReviewSummary = useDesignSession.getState().latestReviewSummary || undefined
  const layoutDigest = buildDesignLayoutDigest(editor, selectionSummary, latestReviewSummary)
  const placementStrategy = normalizePlacementStrategy(args)
  return {
    activeFile,
    selectedIds: selectedIds.map((id) => String(id)),
    selectedElementCount: selectedIds.length,
    selectionBounds: layoutDigest.selectionBounds ?? getSelectionBounds(editor),
    layoutDigest,
    emptySpace: findPreferredCanvasPlacement(editor, dimensions, args, placementStrategy),
    currentToolContext: String((editor as Editor & { getCurrentToolId?: () => string }).getCurrentToolId?.() || 'select'),
  }
}

function buildStyleGuideForArgs(
  args: Record<string, unknown>,
  palette: DesignPalette,
  compositionFamily: DesignCompositionFamily,
): DesignStyleGuide {
  if (isPlainRecord(args.styleGuide)) {
    const source = args.styleGuide
    return {
      palette: isPlainRecord(source.palette) ? normalizePalette(source.palette, palette.name === 'warm-editorial' ? 'xiaohongshu' : 'generic') : palette,
      borderRadius: Number(source.borderRadius ?? (palette.name === 'github-dark' ? 20 : compositionFamily === 'editorial-stack' ? 24 : 18)),
      headlineAlign: source.headlineAlign === 'center' ? 'center' : 'left',
      ornament: source.ornament === 'side-rail' || source.ornament === 'corner-plates' || source.ornament === 'floating-pill' || source.ornament === 'none' ? source.ornament : 'divider-bar',
      sectionTone: source.sectionTone === 'outline' || source.sectionTone === 'solid' ? source.sectionTone : 'soft',
      ctaWeight: source.ctaWeight === 'none' || source.ctaWeight === 'button' ? source.ctaWeight : 'pill',
      density: source.density === 'airy' || source.density === 'dense' ? source.density : 'balanced',
      shadow: isPlainRecord(source.shadow)
        ? {
          enabled: source.shadow.enabled !== false,
          blur: Number(source.shadow.blur ?? (palette.name === 'github-dark' ? 24 : 18)),
          opacity: Number(source.shadow.opacity ?? (palette.name === 'github-dark' ? 24 : 14)),
          offsetY: Number(source.shadow.offsetY ?? (palette.name === 'github-dark' ? 10 : 8)),
        }
        : {
          enabled: true,
          blur: palette.name === 'github-dark' ? 24 : 18,
          opacity: palette.name === 'github-dark' ? 24 : 14,
          offsetY: palette.name === 'github-dark' ? 10 : 8,
        },
      spacingScale: isPlainRecord(source.spacingScale)
        ? {
          xs: Number(source.spacingScale.xs ?? 8),
          sm: Number(source.spacingScale.sm ?? 12),
          md: Number(source.spacingScale.md ?? 16),
          lg: Number(source.spacingScale.lg ?? 24),
          xl: Number(source.spacingScale.xl ?? 36),
        }
        : palette.name === 'github-dark'
          ? { xs: 8, sm: 12, md: 18, lg: 24, xl: 32 }
          : { xs: 8, sm: 12, md: 16, lg: 24, xl: 36 },
      componentMood: source.componentMood === 'dark-technical' || source.componentMood === 'clean-neutral' ? source.componentMood : 'warm-editorial',
    }
  }

  const signals = readDesignSignalProfile(args)
  const semanticControls = resolveSemanticControls(args)
  const mood = palette.name === 'github-dark' || signals.prefersDark
    ? 'dark-technical'
    : palette.name === 'warm-editorial'
      ? 'warm-editorial'
      : 'clean-neutral'

  // 应用对齐控制：优先使用 semanticControls.alignMode
  const headlineAlign: 'left' | 'center' = semanticControls.alignMode === 'center'
    ? 'center'
    : semanticControls.alignMode === 'left'
      ? 'left'
      : signals.prefersCenter
        ? 'center'
        : 'left'

  const density: 'airy' | 'balanced' | 'dense' =
    signals.prefersMinimal ? 'airy' : signals.prefersDense ? 'dense' : 'balanced'

  return {
    palette,
    borderRadius: palette.name === 'github-dark' ? 20 : compositionFamily === 'editorial-stack' ? 24 : 18,
    headlineAlign,
    ornament: signals.prefersRail
      ? 'side-rail'
      : palette.name === 'github-dark'
        ? (signals.prefersMinimal ? 'none' : 'corner-plates')
        : signals.prefersEditorial || signals.prefersWarm
          ? 'floating-pill'
          : signals.prefersCorners
            ? 'corner-plates'
            : 'none',
    sectionTone: palette.name === 'github-dark'
      ? (signals.prefersOutline ? 'outline' : 'solid')
      : (signals.prefersOutline ? 'outline' : 'soft'),
    ctaWeight: signals.avoidsButtons || semanticControls.prefersSparseContent
      ? 'none'
      : signals.prefersButtons
        ? 'button'
        : palette.name === 'warm-editorial' || signals.prefersWarm
          ? 'pill'
          : 'none',
    density,
    shadow: {
      enabled: true,
      blur: palette.name === 'github-dark' ? 24 : 18,
      opacity: palette.name === 'github-dark' ? 24 : 14,
      offsetY: palette.name === 'github-dark' ? 10 : 8,
    },
    spacingScale: palette.name === 'github-dark'
      ? { xs: 8, sm: 12, md: 18, lg: 24, xl: 32 }
      : { xs: 8, sm: 12, md: 16, lg: 24, xl: 36 },
    componentMood: mood,
  }
}

function normalizeLayoutBlueprintForArgs(
  args: Record<string, unknown>,
  params: {
    ratio: DesignRatio
    sectionCount: number
    palette: DesignPalette
    compositionFamily: DesignCompositionFamily
    styleGuide: DesignStyleGuide
  },
): DesignLayoutBlueprint {
  if (isPlainRecord(args.layoutBlueprint)) {
    const source = args.layoutBlueprint
    return {
      skeleton: source.skeleton === 'poster' || source.skeleton === 'column' || source.skeleton === 'grid' || source.skeleton === 'split' || source.skeleton === 'staggered'
        ? source.skeleton
        : 'column',
      titlePlacement: source.titlePlacement === 'top-left' || source.titlePlacement === 'top-center' || source.titlePlacement === 'top-wide' || source.titlePlacement === 'middle-left'
        ? source.titlePlacement
        : 'top-left',
      emphasisPlacement: source.emphasisPlacement === 'none' || source.emphasisPlacement === 'hero-band' || source.emphasisPlacement === 'hero-card' || source.emphasisPlacement === 'side-card' || source.emphasisPlacement === 'floating-chip'
        ? source.emphasisPlacement
        : 'none',
      sectionFlow: source.sectionFlow === 'stack' || source.sectionFlow === 'grid' || source.sectionFlow === 'stagger'
        ? source.sectionFlow
        : 'stack',
      sectionEmphasis: source.sectionEmphasis === 'uniform' || source.sectionEmphasis === 'first-large' || source.sectionEmphasis === 'last-highlight' || source.sectionEmphasis === 'alternating'
        ? source.sectionEmphasis
        : 'uniform',
      ornamentMode: source.ornamentMode === 'none' || source.ornamentMode === 'short-line' || source.ornamentMode === 'pill' || source.ornamentMode === 'corner' || source.ornamentMode === 'rail'
        ? source.ornamentMode
        : 'short-line',
      footerStyle: source.footerStyle === 'caption' || source.footerStyle === 'pill' || source.footerStyle === 'meta-strip'
        ? source.footerStyle
        : 'caption',
      titleWidthRatio: Math.max(0.48, Math.min(0.94, Number(source.titleWidthRatio || 0.84))),
      titleZoneRatio: Math.max(0.18, Math.min(0.38, Number(source.titleZoneRatio || 0.24))),
      emphasisWeight: Math.max(0.12, Math.min(0.36, Number(source.emphasisWeight || 0.2))),
      sectionColumns: Number(source.sectionColumns) === 2 ? 2 : 1,
      asymmetry: Math.max(0, Math.min(0.32, Number(source.asymmetry || 0.08))),
    }
  }

  const signals = readDesignSignalProfile(args)
  const semanticControls = resolveSemanticControls(args)
  const rawText = signals.rawText
  const ratioProfile = getDesignRatioProfile(params.ratio)
  const explicitSplit = /(左右|分栏|split|对开|双栏)/i.test(rawText)
  const explicitGrid = /(网格|grid|矩阵|tile|宫格|卡片墙)/i.test(rawText)
  const explicitStagger = /(错位|stagger|杂志感|编辑感|海报感|节奏变化)/i.test(rawText)
  const explicitMinimal = /(极简|minimal|无装饰|纯文字|留白|克制)/i.test(rawText)
  const posterLike = signals.prefersPoster || signals.prefersEditorial
  const technicalLike = signals.prefersDark || /(github|技术|产品|工程|dashboard)/i.test(rawText)

  let skeleton: DesignLayoutBlueprint['skeleton'] = 'column'
  if (semanticControls.prefersSideMeta) skeleton = 'split'
  else if (explicitSplit) skeleton = 'split'
  else if (ratioProfile === 'landscape' && technicalLike) skeleton = params.styleGuide.ctaWeight === 'button' ? 'split' : 'grid'
  else if (ratioProfile === 'landscape' && posterLike) skeleton = 'grid'
  else if (explicitGrid) skeleton = 'grid'
  else if (explicitStagger || (posterLike && params.sectionCount >= 3)) skeleton = 'staggered'
  else if (posterLike || params.styleGuide.headlineAlign === 'center') skeleton = 'poster'
  else if (technicalLike && params.sectionCount <= 3) skeleton = 'grid'
  else if (params.sectionCount >= 4) skeleton = 'column'
  else if (params.compositionFamily === 'split-feature' && params.styleGuide.ctaWeight === 'button') skeleton = 'split'

  const sectionColumns: 1 | 2 = skeleton === 'grid' || skeleton === 'split' || ratioProfile === 'landscape' ? 2 : 1

  return {
    skeleton,
    titlePlacement: params.styleGuide.headlineAlign === 'center'
      ? (skeleton === 'poster' ? 'top-wide' : 'top-center')
      : skeleton === 'poster'
        ? 'middle-left'
        : 'top-left',
    emphasisPlacement: semanticControls.prefersSideMeta
      ? 'side-card'
      : params.styleGuide.ctaWeight === 'button'
      ? (skeleton === 'split' || technicalLike ? 'side-card' : 'hero-card')
      : skeleton === 'poster'
        ? 'hero-band'
        : skeleton === 'staggered'
          ? 'floating-chip'
          : explicitMinimal
            ? 'none'
            : technicalLike && params.sectionCount <= 3 && signals.prefersCards
              ? 'hero-card'
              : 'none',
    sectionFlow: sectionColumns === 2 ? 'grid' : skeleton === 'staggered' ? 'stagger' : 'stack',
    sectionEmphasis: params.styleGuide.ctaWeight === 'button'
      ? 'last-highlight'
      : skeleton === 'poster'
        ? 'first-large'
        : skeleton === 'staggered'
          ? 'alternating'
          : 'uniform',
    ornamentMode: explicitMinimal ? 'none'
      : params.styleGuide.ornament === 'side-rail' ? 'rail'
        : params.styleGuide.ornament === 'floating-pill' ? 'pill'
          : params.styleGuide.ornament === 'corner-plates' ? 'corner'
            : 'short-line',
    footerStyle: params.styleGuide.ctaWeight === 'button'
      ? 'pill'
      : semanticControls.prefersQuietFooter
        ? 'caption'
      : technicalLike && signals.prefersDense && !signals.prefersMinimal
        ? 'meta-strip'
        : 'caption',
    titleWidthRatio: semanticControls.titleWidthRatio
      ? Math.max(0.32, Math.min(0.9, semanticControls.titleWidthRatio))
      : ratioProfile === 'landscape'
      ? skeleton === 'split' ? 0.44 : skeleton === 'grid' ? 0.52 : 0.58
      : skeleton === 'split' ? 0.56 : skeleton === 'poster' ? 0.88 : skeleton === 'grid' ? 0.82 : 0.84,
    titleZoneRatio: semanticControls.titleZoneRatio
      ? Math.max(0.18, Math.min(0.42, semanticControls.titleZoneRatio))
      : ratioProfile === 'portrait' && params.ratio === '9:16'
      ? skeleton === 'poster' ? 0.3 : skeleton === 'staggered' ? 0.28 : 0.24
      : ratioProfile === 'landscape'
        ? skeleton === 'split' ? 0.2 : 0.18
        : skeleton === 'poster' ? 0.28 : 0.22,
    emphasisWeight: ratioProfile === 'landscape'
      ? (params.styleGuide.ctaWeight === 'button' ? 0.24 : 0.16)
      : params.styleGuide.ctaWeight === 'button' ? 0.28 : skeleton === 'poster' ? 0.22 : 0.18,
    sectionColumns,
    asymmetry: skeleton === 'staggered' ? 0.22 : skeleton === 'split' ? 0.28 : skeleton === 'poster' ? 0.16 : 0.08,
  }
}

function buildLayoutBudgetForArgs(
  args: Record<string, unknown>,
  board: DesignBoardPlan,
  layoutStrategy: DesignLayoutStrategyPlan,
): DesignLayoutBudget {
  const semanticControls = resolveSemanticControls(args)
  if (isPlainRecord(args.layoutBudget)) {
    const record = args.layoutBudget
    return {
      boardWidth: Number(record.boardWidth ?? board.width),
      boardHeight: Number(record.boardHeight ?? board.height),
      paddingX: Number(record.paddingX ?? board.paddingX),
      paddingTop: Number(record.paddingTop ?? board.paddingTop),
      paddingBottom: Number(record.paddingBottom ?? board.paddingBottom),
      titleMaxLines: Number(record.titleMaxLines ?? 3),
      subtitleMaxLines: Number(record.subtitleMaxLines ?? 3),
      sectionMaxLines: Number(record.sectionMaxLines ?? 5),
      footerMaxLines: Number(record.footerMaxLines ?? 2),
      titleZoneHeight: Number(record.titleZoneHeight ?? Math.round((board.height - board.paddingTop - board.paddingBottom) * 0.24)),
      sectionsZoneHeight: Number(record.sectionsZoneHeight ?? Math.round((board.height - board.paddingTop - board.paddingBottom) * 0.62)),
      footerZoneHeight: Number(record.footerZoneHeight ?? Math.round((board.height - board.paddingTop - board.paddingBottom) * 0.12)),
    }
  }

  const usableHeight = board.height - board.paddingTop - board.paddingBottom
  const baseTitleRatio = layoutStrategy.align === 'split' ? 0.26 : 0.24
  const resolvedTitleRatio = semanticControls.titleZoneRatio
    ? Math.max(0.18, Math.min(0.42, semanticControls.titleZoneRatio))
    : Math.max(0.2, Math.min(0.38, baseTitleRatio + (semanticControls.prefersLargeElements ? 0.04 : 0) + (semanticControls.prefersSparseContent ? 0.03 : 0)))
  const titleZoneHeight = Math.round(usableHeight * resolvedTitleRatio)
  const footerZoneHeight = Math.round(usableHeight * (semanticControls.prefersQuietFooter ? 0.08 : (layoutStrategy.footerMode === 'pill' ? 0.12 : 0.1)))
  return {
    boardWidth: board.width,
    boardHeight: board.height,
    paddingX: board.paddingX,
    paddingTop: board.paddingTop,
    paddingBottom: board.paddingBottom,
    titleMaxLines: 3,
    subtitleMaxLines: 3,
    sectionMaxLines: 5,
    footerMaxLines: 2,
    titleZoneHeight,
    sectionsZoneHeight: Math.max(120, usableHeight - titleZoneHeight - footerZoneHeight),
    footerZoneHeight,
  }
}

function buildDesignBriefForArgs(
  args: Record<string, unknown>,
  params: {
    platform: DesignPlatform
    ratio: DesignRatio
    palette: DesignPalette
    audience: string
    tone: string
    sectionCount: number
    sections: DesignContentSection[]
  },
): DesignBrief {
  if (isPlainRecord(args.brief)) {
    const source = args.brief
    return {
      id: typeof source.id === 'string' ? source.id : `brief-${params.platform}-${params.ratio}`,
      taskType: source.taskType === 'content-layout' ? 'content-layout' : 'social-cover',
      platform: normalizeDesignPlatform(source.platform, params.platform),
      ratio: normalizeDesignRatio(source.ratio, params.ratio),
      promptText: typeof source.promptText === 'string' ? source.promptText : collectDesignSignalText(args),
      objective: typeof source.objective === 'string' ? source.objective : '生成一张可继续编辑的社媒封面。',
      visualTone: typeof source.visualTone === 'string' ? source.visualTone : params.tone,
      audience: typeof source.audience === 'string' ? source.audience : params.audience,
      headline: typeof source.headline === 'string' && source.headline.trim()
        ? source.headline
        : params.palette.name === 'github-dark'
          ? '把你的核心标题放这里\n更像产品框架或技术封面\n控制在 2 到 3 行'
          : '你的主标题放这里\n突出反差、收益或结果\n建议控制在 2 到 3 行',
      subheadline: typeof source.subheadline === 'string' && source.subheadline.trim()
        ? source.subheadline
        : params.palette.name === 'github-dark'
          ? '用一行副标题补充对象、方法或约束，让封面看起来更像有判断的框架。'
          : '补一行副标题或结果摘要，让用户先看懂主题再往下读。',
      contentHierarchy: Array.isArray(source.contentHierarchy)
        ? source.contentHierarchy as DesignBrief['contentHierarchy']
        : [],
      antiGoals: Array.isArray(source.antiGoals) ? source.antiGoals.map((item) => String(item)).filter(Boolean) : [],
      sectionCount: Number.isFinite(Number(source.sectionCount)) ? Math.max(1, Math.round(Number(source.sectionCount))) : params.sectionCount,
    }
  }

  const promptText = collectDesignSignalText(args)
  const isGithub = params.palette.name === 'github-dark'
  const isYoutube = params.platform === 'youtube'
  return {
    id: `brief-${params.platform}-${params.ratio}-${params.palette.name}`,
    taskType: 'social-cover',
    platform: params.platform,
    ratio: params.ratio,
    promptText,
    objective: isYoutube
      ? '生成适合视频封面/缩略图的排版，而不是竖版社媒卡片。'
      : isGithub
        ? '生成技术型封面，而不是营销感封面。'
        : '生成可直接替换文案的社媒封面框架。',
    visualTone: params.tone,
    audience: params.audience,
    headline: typeof args.title === 'string' && args.title.trim()
      ? args.title.trim()
      : isGithub
        ? '把你的核心标题放这里\n更像产品框架或技术封面\n控制在 2 到 3 行'
        : '你的主标题放这里\n突出反差、收益或结果\n建议控制在 2 到 3 行',
    subheadline: typeof args.reasoningSummary === 'string' && args.reasoningSummary.trim()
      ? args.reasoningSummary.trim()
      : isGithub
        ? '用一行副标题补充对象、方法或约束，让封面看起来更像有判断的框架。'
        : '补一行副标题或结果摘要，让用户先看懂主题再往下读。',
    contentHierarchy: [
      { id: 'badge', role: 'badge', label: isYoutube ? 'YOUTUBE COVER' : isGithub ? 'OPEN SOURCE PLAYBOOK' : '干货分享', priority: 1, maxLines: 1 },
      { id: 'headline', role: 'headline', label: '主标题', priority: 2, maxLines: 3 },
      { id: 'subtitle', role: 'subtitle', label: '副标题', priority: 3, maxLines: 3 },
      ...params.sections.map((section, index) => ({
        id: section.id,
        role: 'section' as const,
        label: section.title,
        priority: 4 + index,
        maxLines: 5,
      })),
      { id: 'meta', role: 'meta', label: isYoutube ? '频道名 / 系列 / 上线时间' : isGithub ? 'Repo / CTA / Version' : '底部备注 / 可替换信息', priority: 90, maxLines: 2 },
    ],
    antiGoals: isGithub
      ? ['不要暖色营销感', '不要大椭圆', '不要默认右侧按钮母题', '不要底部粗横条']
      : ['不要技术仪表盘感', '不要过重按钮', '不要无意义大色块'],
    sectionCount: params.sectionCount,
  }
}

function buildStyleSystemForArgs(
  args: Record<string, unknown>,
  palette: DesignPalette,
  styleGuide: DesignStyleGuide,
  typography: DesignTypographyPlan,
  board: DesignBoardPlan,
): DesignStyleSystem {
  if (isPlainRecord(args.styleSystem)) {
    const source = args.styleSystem
    return {
      id: typeof source.id === 'string' ? source.id : `style-${palette.name}-${styleGuide.componentMood}`,
      palette: isPlainRecord(source.palette) ? normalizePalette(source.palette, palette.name === 'warm-editorial' ? 'xiaohongshu' : 'generic') : palette,
      typographyTokens: isPlainRecord(source.typographyTokens)
        ? {
          headlineFamily: source.typographyTokens.headlineFamily === 'mono' || source.typographyTokens.headlineFamily === 'serif' ? source.typographyTokens.headlineFamily : 'sans',
          headlineWeight: source.typographyTokens.headlineWeight === 'bold' ? 'bold' : 'black',
          bodyFamily: source.typographyTokens.bodyFamily === 'mono' || source.typographyTokens.bodyFamily === 'serif' ? source.typographyTokens.bodyFamily : 'sans',
          bodyWeight: source.typographyTokens.bodyWeight === 'medium' ? 'medium' : 'regular',
          titleFontSize: Number(source.typographyTokens.titleFontSize ?? typography.titleFontSize),
          titleLineHeight: Number(source.typographyTokens.titleLineHeight ?? typography.titleLineHeight),
          subtitleFontSize: Number(source.typographyTokens.subtitleFontSize ?? typography.subtitleFontSize),
          subtitleLineHeight: Number(source.typographyTokens.subtitleLineHeight ?? typography.subtitleLineHeight),
          sectionTitleFontSize: Number(source.typographyTokens.sectionTitleFontSize ?? typography.sectionTitleFontSize),
          sectionBodyFontSize: Number(source.typographyTokens.sectionBodyFontSize ?? typography.sectionBodyFontSize),
          sectionLineHeight: Number(source.typographyTokens.sectionLineHeight ?? typography.sectionLineHeight),
          badgeFontSize: Number(source.typographyTokens.badgeFontSize ?? typography.badgeFontSize),
          metaFontSize: Number(source.typographyTokens.metaFontSize ?? typography.footerFontSize),
          letterSpacing: Number(source.typographyTokens.letterSpacing ?? (palette.name === 'github-dark' ? 0.4 : 0)),
        }
        : {
          headlineFamily: palette.name === 'github-dark' ? 'mono' : 'sans',
          headlineWeight: palette.name === 'github-dark' ? 'bold' : 'black',
          bodyFamily: palette.name === 'github-dark' ? 'mono' : 'sans',
          bodyWeight: 'regular',
          titleFontSize: typography.titleFontSize,
          titleLineHeight: typography.titleLineHeight,
          subtitleFontSize: typography.subtitleFontSize,
          subtitleLineHeight: typography.subtitleLineHeight,
          sectionTitleFontSize: typography.sectionTitleFontSize,
          sectionBodyFontSize: typography.sectionBodyFontSize,
          sectionLineHeight: typography.sectionLineHeight,
          badgeFontSize: typography.badgeFontSize,
          metaFontSize: typography.footerFontSize,
          letterSpacing: palette.name === 'github-dark' ? 0.4 : 0,
        },
      radiusTokens: isPlainRecord(source.radiusTokens)
        ? {
          board: Number(source.radiusTokens.board ?? board.cornerRadius),
          card: Number(source.radiusTokens.card ?? Math.max(10, Math.round(styleGuide.borderRadius * 0.8))),
          chip: Number(source.radiusTokens.chip ?? Math.max(12, Math.round(styleGuide.borderRadius * 1.2))),
        }
        : {
          board: board.cornerRadius,
          card: Math.max(10, Math.round(styleGuide.borderRadius * 0.8)),
          chip: Math.max(12, Math.round(styleGuide.borderRadius * 1.2)),
        },
      spacingScale: isPlainRecord(source.spacingScale)
        ? {
          xs: Number(source.spacingScale.xs ?? styleGuide.spacingScale.xs),
          sm: Number(source.spacingScale.sm ?? styleGuide.spacingScale.sm),
          md: Number(source.spacingScale.md ?? styleGuide.spacingScale.md),
          lg: Number(source.spacingScale.lg ?? styleGuide.spacingScale.lg),
          xl: Number(source.spacingScale.xl ?? styleGuide.spacingScale.xl),
        }
        : styleGuide.spacingScale,
      borderRules: isPlainRecord(source.borderRules)
        ? {
          enabled: source.borderRules.enabled !== false,
          width: Number(source.borderRules.width ?? (palette.name === 'github-dark' ? 1.5 : 1)),
          color: typeof source.borderRules.color === 'string' ? source.borderRules.color : palette.accent,
          accentWidth: Number(source.borderRules.accentWidth ?? (palette.name === 'github-dark' ? 2 : 1)),
        }
        : {
          enabled: styleGuide.sectionTone === 'outline' || palette.name === 'github-dark',
          width: palette.name === 'github-dark' ? 1.5 : 1,
          color: palette.name === 'github-dark' ? '#30363D' : palette.accent,
          accentWidth: palette.name === 'github-dark' ? 2 : 1,
        },
      shadowRules: styleGuide.shadow,
      ornamentRules: isPlainRecord(source.ornamentRules)
        ? {
          mode: source.ornamentRules.mode === 'chip' || source.ornamentRules.mode === 'corner' || source.ornamentRules.mode === 'rail' || source.ornamentRules.mode === 'none'
            ? source.ornamentRules.mode
            : 'short-line',
          accentAreaLimit: Number(source.ornamentRules.accentAreaLimit ?? (palette.name === 'github-dark' ? 0.12 : 0.18)),
          allowLargeEllipse: source.ornamentRules.allowLargeEllipse === true,
        }
        : {
          mode: styleGuide.ornament === 'divider-bar'
            ? 'short-line'
            : styleGuide.ornament === 'floating-pill'
              ? 'chip'
              : styleGuide.ornament === 'corner-plates'
                ? 'corner'
                : styleGuide.ornament === 'side-rail'
                  ? 'rail'
                  : 'none',
          accentAreaLimit: palette.name === 'github-dark' ? 0.12 : 0.18,
          allowLargeEllipse: false,
        },
      motionRules: isPlainRecord(source.motionRules)
        ? {
          emphasis: source.motionRules.emphasis === 'quiet' || source.motionRules.emphasis === 'expressive'
            ? source.motionRules.emphasis
            : 'balanced',
        }
        : {
          emphasis: styleGuide.density === 'dense' ? 'expressive' : styleGuide.density === 'airy' ? 'quiet' : 'balanced',
        },
    }
  }

  return {
    id: `style-${palette.name}-${styleGuide.componentMood}`,
    palette,
    typographyTokens: {
      headlineFamily: palette.name === 'github-dark' ? 'mono' : 'sans',
      headlineWeight: palette.name === 'github-dark' ? 'bold' : 'black',
      bodyFamily: palette.name === 'github-dark' ? 'mono' : 'sans',
      bodyWeight: 'regular',
      titleFontSize: typography.titleFontSize,
      titleLineHeight: typography.titleLineHeight,
      subtitleFontSize: typography.subtitleFontSize,
      subtitleLineHeight: typography.subtitleLineHeight,
      sectionTitleFontSize: typography.sectionTitleFontSize,
      sectionBodyFontSize: typography.sectionBodyFontSize,
      sectionLineHeight: typography.sectionLineHeight,
      badgeFontSize: typography.badgeFontSize,
      metaFontSize: typography.footerFontSize,
      letterSpacing: palette.name === 'github-dark' ? 0.4 : 0,
    },
    radiusTokens: {
      board: board.cornerRadius,
      card: Math.max(10, Math.round(styleGuide.borderRadius * 0.8)),
      chip: Math.max(12, Math.round(styleGuide.borderRadius * 1.2)),
    },
    spacingScale: styleGuide.spacingScale,
    borderRules: {
      enabled: styleGuide.sectionTone === 'outline' || palette.name === 'github-dark',
      width: palette.name === 'github-dark' ? 1.5 : 1,
      color: palette.name === 'github-dark' ? '#30363D' : palette.accent,
      accentWidth: palette.name === 'github-dark' ? 2 : 1,
    },
    shadowRules: styleGuide.shadow,
    ornamentRules: {
      mode: styleGuide.ornament === 'divider-bar'
        ? 'short-line'
        : styleGuide.ornament === 'floating-pill'
          ? 'chip'
          : styleGuide.ornament === 'corner-plates'
            ? 'corner'
            : styleGuide.ornament === 'side-rail'
              ? 'rail'
              : 'none',
      accentAreaLimit: palette.name === 'github-dark' ? 0.12 : 0.18,
      allowLargeEllipse: false,
    },
    motionRules: {
      emphasis: styleGuide.density === 'dense' ? 'expressive' : styleGuide.density === 'airy' ? 'quiet' : 'balanced',
    },
  }
}

function buildSceneNodesForArgs(params: {
  args: Record<string, unknown>
  brief: DesignBrief
  styleSystem: DesignStyleSystem
  styleGuide: DesignStyleGuide
  board: DesignBoardPlan
  layoutBlueprint: DesignLayoutBlueprint
  compositionFamily: DesignCompositionFamily
  sections: DesignContentSection[]
}): DesignSceneNode[] {
  const isGithub = params.styleSystem.palette.name === 'github-dark'
  const alignCenter = params.layoutBlueprint.titlePlacement === 'top-center' || params.layoutBlueprint.titlePlacement === 'top-wide'
  const signals = readDesignSignalProfile(params.args)
  const semanticControls = resolveSemanticControls(params.args)
  const columnCount = params.layoutBlueprint.sectionColumns
  const explicitBadge = /(标签|badge|tag|repo|open source|playbook|栏目)/i.test(signals.rawText)
  const ratioProfile = params.board.width === params.board.height ? 'square' : params.board.width > params.board.height ? 'landscape' : 'portrait'
  const accentColor = semanticControls.prefersContrastAccent && params.styleSystem.palette.contrastAccent
    ? params.styleSystem.palette.contrastAccent
    : params.styleSystem.palette.accent
  const showBadge = explicitBadge
    || (!semanticControls.prefersSparseContent && params.brief.platform === 'xiaohongshu')
    || (!semanticControls.prefersSparseContent && !isGithub && ratioProfile !== 'landscape' && (signals.prefersPoster || signals.prefersWarm))
  const titleY = showBadge ? 0.145 : (alignCenter ? 0.11 : 0.1)
  const subtitleY = showBadge ? 0.29 : (alignCenter ? 0.245 : 0.22)
  const nodes: DesignSceneNode[] = [
    {
      id: 'board-frame',
      role: 'board',
      kind: 'frame',
      xRatio: 0,
      yRatio: 0,
      wRatio: 1,
      hRatio: 1,
      content: 'Design Board',
      style: { cornerRadius: params.styleSystem.radiusTokens.board },
    },
    {
      id: 'board-surface',
      role: 'board-surface',
      kind: 'surface',
      xRatio: 0,
      yRatio: 0,
      wRatio: 1,
      hRatio: 1,
      style: {
        fill: params.styleSystem.palette.background,
        cornerRadius: params.styleSystem.radiusTokens.board,
      },
    },
    {
      id: 'headline',
      role: 'title',
      kind: 'text',
      xRatio: alignCenter ? 0.12 : 0.08,
      yRatio: titleY,
      wRatio: params.layoutBlueprint.titleWidthRatio,
      hRatio: Math.min(0.18, Math.max(0.12, params.layoutBlueprint.titleZoneRatio * 0.6)),
      content: params.brief.headline,
      style: {
        textColor: params.styleSystem.palette.primaryText,
        textAlign: alignCenter ? 'center' : 'left',
        fontFamily: params.styleSystem.typographyTokens.headlineFamily,
        fontWeight: 'bold',
      },
    },
    {
      id: 'subtitle',
      role: 'subtitle',
      kind: 'text',
      xRatio: alignCenter ? 0.14 : 0.08,
      yRatio: subtitleY,
      wRatio: Math.min(0.82, params.layoutBlueprint.titleWidthRatio),
      hRatio: 0.08,
      content: params.brief.subheadline,
      style: {
        textColor: params.styleSystem.palette.secondaryText,
        textAlign: alignCenter ? 'center' : 'left',
        fontFamily: params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: 'regular',
      },
    },
  ]

  if (showBadge) {
    nodes.splice(2, 0, {
      id: 'badge',
      role: 'badge',
      kind: 'badge',
      xRatio: alignCenter ? 0.32 : 0.08,
      yRatio: 0.07,
      wRatio: isGithub ? 0.28 : 0.18,
      hRatio: 0.045,
      content: params.brief.contentHierarchy.find((item) => item.role === 'badge')?.label || (isGithub ? 'OPEN SOURCE PLAYBOOK' : '干货分享'),
      style: {
        fill: isGithub ? params.styleSystem.palette.surface : params.styleSystem.palette.accentSoft,
        textColor: semanticControls.prefersContrastAccent ? accentColor : (isGithub ? params.styleSystem.palette.accent : '#8B6914'),
        textAlign: alignCenter ? 'center' : 'left',
        fontFamily: params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: 'medium',
        cornerRadius: params.styleSystem.radiusTokens.chip,
      },
    })
  }

  const shouldRenderOrnament = !semanticControls.prefersSparseContent
    && params.styleSystem.ornamentRules.mode !== 'none'
    && (
      params.brief.platform === 'xiaohongshu'
      || signals.prefersPoster
      || signals.prefersEditorial
      || signals.prefersWarm
      || signals.prefersRail
      || signals.prefersCorners
      || isGithub
    )
  if (shouldRenderOrnament) {
    nodes.push({
      id: 'ornament',
      role: params.styleSystem.ornamentRules.mode === 'rail' ? 'rail' : 'divider',
      kind: params.styleSystem.ornamentRules.mode === 'chip' ? 'chip' : 'geo',
      xRatio: alignCenter ? 0.42 : 0.08,
      yRatio: 0.385,
      wRatio: params.styleSystem.ornamentRules.mode === 'rail'
        ? 0.008
        : params.styleSystem.ornamentRules.mode === 'chip'
          ? 0.16
          : params.styleSystem.ornamentRules.mode === 'corner'
            ? 0.04
            : 0.12,
      hRatio: params.styleSystem.ornamentRules.mode === 'rail'
        ? 0.7
        : params.styleSystem.ornamentRules.mode === 'chip'
          ? 0.022
          : 0.008,
      shape: params.styleSystem.ornamentRules.mode === 'chip'
        ? 'pill'
        : 'rectangle',
      style: {
        fill: accentColor,
        cornerRadius: params.styleSystem.ornamentRules.mode === 'chip' ? params.styleSystem.radiusTokens.chip : params.styleSystem.radiusTokens.card,
      },
    })
  }

  if (params.styleSystem.ornamentRules.mode === 'corner') {
    nodes.push({
      id: 'corner-left',
      role: 'divider',
      kind: 'geo',
      xRatio: 0.08,
      yRatio: 0.388,
      wRatio: 0.035,
      hRatio: 0.008,
      shape: 'rectangle',
      style: {
        fill: accentColor,
      },
    })
    nodes.push({
      id: 'corner-right',
      role: 'divider',
      kind: 'geo',
      xRatio: 0.87,
      yRatio: 0.388,
      wRatio: 0.035,
      hRatio: 0.008,
      shape: 'rectangle',
      style: {
        fill: params.styleSystem.palette.accentSoft,
      },
    })
  }

  if (params.layoutBlueprint.emphasisPlacement === 'floating-chip') {
    nodes.push({
      id: 'meta-chip',
      role: 'meta-chip',
      kind: 'chip',
      xRatio: alignCenter ? 0.63 : 0.68,
      yRatio: 0.215,
      wRatio: isGithub ? 0.22 : 0.18,
      hRatio: 0.04,
      content: isGithub ? 'v1.0 / Repo' : '重点摘要',
      style: {
        fill: params.styleSystem.palette.accentSoft,
        textColor: accentColor,
        textAlign: 'center',
        fontFamily: isGithub ? 'mono' : params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: 'medium',
        cornerRadius: params.styleSystem.radiusTokens.chip,
      },
    })
  }

  let remainingSections = [...params.sections]
  let sectionAreaX = 0.08
  let sectionAreaW = 0.84
  let sectionAreaTop = isGithub && params.layoutBlueprint.skeleton === 'split' ? 0.41 : 0.44
  const footerH = params.layoutBlueprint.footerStyle === 'pill' ? 0.05 : params.layoutBlueprint.footerStyle === 'meta-strip' ? 0.04 : 0.032
  const footerY = 1 - (footerH + 0.026)
  const sectionAreaBottom = Math.min(0.88, footerY - 0.034)
  const addSectionNode = (input: {
    id: string
    role?: string
    xRatio: number
    yRatio: number
    wRatio: number
    hRatio: number
    section: DesignContentSection
    highlight?: boolean
    prefix?: string
  }) => {
    nodes.push({
      id: input.id,
      role: input.role || 'section',
      kind: 'section-card',
      xRatio: input.xRatio,
      yRatio: input.yRatio,
      wRatio: input.wRatio,
      hRatio: input.hRatio,
      content: `${input.prefix || ''}${input.section.title}\n${input.section.body}`,
      style: {
        fill: input.highlight
          ? params.styleSystem.palette.surface
          : params.styleGuide.sectionTone === 'outline'
            ? params.styleSystem.palette.background
            : params.styleGuide.sectionTone === 'solid'
              ? params.styleSystem.palette.surface
              : params.styleSystem.palette.accentSoft,
        textColor: params.styleSystem.palette.primaryText,
        stroke: params.styleSystem.borderRules.enabled || input.highlight
          ? params.styleSystem.borderRules.color
          : undefined,
        strokeWidth: params.styleSystem.borderRules.enabled || input.highlight
          ? (input.highlight ? params.styleSystem.borderRules.accentWidth : params.styleSystem.borderRules.width)
          : 0,
        fontFamily: params.styleSystem.typographyTokens.bodyFamily,
        fontWeight: input.highlight ? 'bold' : 'medium',
        cornerRadius: input.highlight
          ? Math.max(params.styleSystem.radiusTokens.card, params.styleSystem.radiusTokens.chip)
          : params.styleSystem.radiusTokens.card,
      },
    })
  }

  if (params.layoutBlueprint.emphasisPlacement === 'hero-band' && remainingSections.length > 0) {
    const hero = remainingSections.shift()!
    addSectionNode({
      id: 'hero-band',
      xRatio: sectionAreaX,
      yRatio: sectionAreaTop,
      wRatio: sectionAreaW,
      hRatio: 0.13,
      section: hero,
      highlight: true,
    })
    sectionAreaTop += 0.15
  } else if (params.layoutBlueprint.emphasisPlacement === 'hero-card' && remainingSections.length > 0) {
    const hero = remainingSections.shift()!
    const heroWidth = 0.72 + (params.layoutBlueprint.asymmetry * 0.2)
    addSectionNode({
      id: 'hero-card',
      xRatio: alignCenter ? 0.14 : 0.08,
      yRatio: sectionAreaTop,
      wRatio: Math.min(0.84, heroWidth),
      hRatio: 0.145,
      section: hero,
      highlight: true,
    })
    sectionAreaTop += 0.165
  } else if (params.layoutBlueprint.emphasisPlacement === 'side-card' && remainingSections.length > 0) {
    const sideSection = params.styleGuide.ctaWeight === 'button'
      ? (remainingSections.pop() || params.sections.at(-1)!)
      : (remainingSections.shift() || params.sections[0]!)
    const sideWidth = Math.min(0.27, 0.18 + params.layoutBlueprint.emphasisWeight * 0.35)
    const sideX = 0.92 - sideWidth
    addSectionNode({
      id: 'side-panel',
      role: params.styleGuide.ctaWeight === 'button' ? 'cta-panel' : 'section',
      xRatio: sideX,
      yRatio: 0.19,
      wRatio: sideWidth,
      hRatio: 0.22,
      section: sideSection,
      highlight: true,
    })
    if (!signals.avoidsButtons && params.styleGuide.ctaWeight === 'button') {
      nodes.push({
        id: 'cta',
        role: 'cta-button',
        kind: 'button',
        xRatio: sideX + 0.02,
        yRatio: 0.355,
        wRatio: Math.max(0.12, sideWidth - 0.04),
        hRatio: 0.05,
        content: sideSection.title || '打开详情',
        style: {
          variant: 'primary',
        },
      })
    }
    sectionAreaW = Math.max(0.48, sideX - sectionAreaX - 0.03)
  }

  const availableHeight = Math.max(0.18, sectionAreaBottom - sectionAreaTop)
  const effectiveColumns: 1 | 2 =
    params.layoutBlueprint.sectionFlow === 'grid' && remainingSections.length > 1
      ? 2
      : params.layoutBlueprint.sectionFlow === 'grid' && columnCount === 2
        ? 2
        : 1

  if (params.layoutBlueprint.sectionFlow === 'grid' && remainingSections.length > 0) {
    const gap = 0.03
    const firstLarge = params.layoutBlueprint.sectionEmphasis === 'first-large' && remainingSections.length > 2
    const highlightLast = params.layoutBlueprint.sectionEmphasis === 'last-highlight'
    let cursorY = sectionAreaTop

    if (firstLarge) {
      const hero = remainingSections.shift()!
      addSectionNode({
        id: 'grid-hero',
        xRatio: sectionAreaX,
        yRatio: cursorY,
        wRatio: sectionAreaW,
        hRatio: Math.min(0.15, availableHeight * 0.32),
        section: hero,
        highlight: true,
      })
      cursorY += Math.min(0.17, availableHeight * 0.36)
    }

    const rows = Math.max(1, Math.ceil(remainingSections.length / effectiveColumns))
    const cardW = effectiveColumns === 2 ? (sectionAreaW - gap) / 2 : sectionAreaW
    const cardH = Math.max(0.09, (sectionAreaBottom - cursorY - gap * Math.max(0, rows - 1)) / rows)

    remainingSections.forEach((section, index) => {
      const row = Math.floor(index / effectiveColumns)
      const column = index % effectiveColumns
      const isLast = index === remainingSections.length - 1
      const isLastHighlight = highlightLast && remainingSections.length > 1 && isLast
      const spanFull = effectiveColumns === 2 && isLast && remainingSections.length % 2 === 1
      addSectionNode({
        id: `section-${index + 1}`,
        role: isLastHighlight && params.styleGuide.ctaWeight !== 'none' ? 'cta-panel' : 'section',
        xRatio: spanFull
          ? sectionAreaX
          : sectionAreaX + column * (cardW + gap),
        yRatio: cursorY + row * (cardH + gap),
        wRatio: spanFull ? sectionAreaW : cardW,
        hRatio: Math.min(0.16, cardH * (isLastHighlight ? 1.08 : 1)),
        section,
        highlight: isLastHighlight,
      })
    })
  } else {
    const stagger = params.layoutBlueprint.sectionFlow === 'stagger'
    const highlightFirst = params.layoutBlueprint.sectionEmphasis === 'first-large'
    const highlightLast = params.layoutBlueprint.sectionEmphasis === 'last-highlight'
    const alternating = params.layoutBlueprint.sectionEmphasis === 'alternating'
    const gap = stagger ? 0.024 : 0.022
    const rows = Math.max(1, remainingSections.length)
    const baseH = Math.max(0.085, (availableHeight - gap * Math.max(0, rows - 1)) / rows)

    remainingSections.forEach((section, index) => {
      const isFirst = index === 0
      const isLast = index === remainingSections.length - 1
      const isLastHighlight = highlightLast && remainingSections.length > 1 && isLast
      const widthRatio = stagger
        ? (alternating ? (index % 2 === 0 ? 0.92 : 0.76) : 0.84)
        : alternating
          ? (index % 2 === 0 ? 1 : 0.88)
          : 1
      const wRatio = Math.max(0.58, sectionAreaW * widthRatio)
      const xRatio = stagger && index % 2 === 1
        ? sectionAreaX + Math.max(0, sectionAreaW - wRatio)
        : alignCenter && widthRatio < 1
          ? sectionAreaX + Math.max(0, (sectionAreaW - wRatio) / 2)
          : sectionAreaX
      const highlight = (highlightFirst && isFirst) || (highlightLast && isLast)
      const yRatio = sectionAreaTop + index * (baseH + gap)

      if (params.compositionFamily === 'numbered-list') {
        const pillIndex = signals.prefersDense
        const markerSize = pillIndex ? 0.048 : 0.044
        nodes.push({
          id: `index-${index + 1}`,
          role: 'index',
          kind: 'geo',
          xRatio,
          yRatio: yRatio + 0.01,
          wRatio: pillIndex ? 0.08 : markerSize,
          hRatio: markerSize,
          shape: pillIndex ? 'pill' : 'circle',
          content: String(index + 1).padStart(2, '0'),
          style: {
            fill: accentColor,
            textColor: '#FFFFFF',
            textAlign: 'center',
            fontWeight: 'bold',
            cornerRadius: params.styleSystem.radiusTokens.chip,
          },
        })
      }

      addSectionNode({
        id: `section-${index + 1}`,
        role: isLastHighlight && params.styleGuide.ctaWeight !== 'none' ? 'cta-panel' : 'section',
        xRatio: params.compositionFamily === 'numbered-list' ? xRatio + 0.08 : xRatio,
        yRatio,
        wRatio: params.compositionFamily === 'numbered-list' ? Math.max(0.5, wRatio - 0.08) : wRatio,
        hRatio: Math.min(0.17, baseH * (highlight ? 1.14 : 1)),
        section,
        highlight,
        prefix: params.compositionFamily === 'numbered-list' ? '' : undefined,
      })
    })
  }

  nodes.push({
    id: 'footer',
    role: 'footer',
    kind: 'text',
    xRatio: 0.08,
    yRatio: footerY,
    wRatio: 0.84,
    hRatio: footerH,
    content: params.brief.contentHierarchy.find((item) => item.role === 'meta')?.label
      || (params.styleSystem.palette.name === 'github-dark'
        ? 'Repo / CTA / Version'
        : params.brief.platform === 'youtube'
          ? '频道名 / 系列 / 上线时间'
          : '底部备注 / 可替换成账号名、日期或系列标签'),
    style: {
      fill: params.layoutBlueprint.footerStyle === 'pill'
        ? params.styleSystem.palette.accentSoft
        : params.layoutBlueprint.footerStyle === 'meta-strip'
          ? params.styleSystem.palette.surface
          : undefined,
      textColor: params.styleSystem.palette.secondaryText,
      textAlign: alignCenter ? 'center' : 'left',
      fontFamily: params.styleSystem.typographyTokens.bodyFamily,
      fontWeight: 'regular',
      cornerRadius: params.layoutBlueprint.footerStyle === 'pill' ? params.styleSystem.radiusTokens.chip : params.layoutBlueprint.footerStyle === 'meta-strip' ? 10 : 0,
    },
  })

  return nodes
}

function buildScenePlanIdForArgs(params: {
  ratio: DesignRatio
  palette: DesignPalette
  layoutBlueprint: DesignLayoutBlueprint
  styleGuide: DesignStyleGuide
}): string {
  return [
    'scene',
    params.ratio,
    params.palette.name,
    params.layoutBlueprint.skeleton,
    params.layoutBlueprint.sectionFlow,
    params.layoutBlueprint.sectionEmphasis,
    params.layoutBlueprint.emphasisPlacement,
    params.layoutBlueprint.footerStyle,
    params.styleGuide.ornament,
    params.styleGuide.ctaWeight,
    `tw${Math.round(params.layoutBlueprint.titleWidthRatio * 100)}`,
    `tz${Math.round(params.layoutBlueprint.titleZoneRatio * 100)}`,
  ].join('-')
}

function buildFallbackScenePlanForArgs(
  args: Record<string, unknown>,
  params: {
    ratio: DesignRatio
    placementStrategy: DesignPlacementStrategy
    compositionFamily: DesignCompositionFamily
    board: DesignBoardPlan
    layoutBudget: DesignLayoutBudget
    layoutBlueprint: DesignLayoutBlueprint
    brief: DesignBrief
    styleGuide: DesignStyleGuide
    styleSystem: DesignStyleSystem
    sections: DesignContentSection[]
  },
): DesignScenePlan {
  if (isPlainRecord(args.scenePlan) && Array.isArray(args.scenePlan.nodes)) {
    const source = args.scenePlan
    const ratio = normalizeDesignRatio(source.ratio, params.ratio)
    const placementStrategy = source.placementStrategy === 'auto-below' || source.placementStrategy === 'viewport-origin' || source.placementStrategy === 'explicit'
      ? source.placementStrategy
      : params.placementStrategy
    const compositionFamily = source.compositionFamily === 'numbered-list' || source.compositionFamily === 'split-feature'
      ? source.compositionFamily
      : params.compositionFamily
    const board = isPlainRecord(source.board) ? {
      ...params.board,
      ...source.board,
    } : params.board
    const layoutBudget = isPlainRecord(source.layoutBudget) ? {
      ...params.layoutBudget,
      ...source.layoutBudget,
    } : params.layoutBudget
    return {
      id: typeof source.id === 'string' ? source.id : buildScenePlanIdForArgs({
        ratio,
        palette: params.styleSystem.palette,
        layoutBlueprint: params.layoutBlueprint,
        styleGuide: params.styleGuide,
      }),
      ratio,
      placementStrategy,
      compositionFamily,
      board,
      layoutBudget,
      regions: Array.isArray(source.regions) ? source.regions as DesignScenePlan['regions'] : [
        { id: 'board', role: 'board', xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
      ],
      // Recompile scene nodes in renderer so follow-up style constraints and richer node grammar
      // take effect even when the upstream planner only provided a lighter-weight scene plan.
      nodes: buildSceneNodesForArgs({
        args,
        brief: params.brief,
        styleSystem: params.styleSystem,
        styleGuide: params.styleGuide,
        board,
        layoutBlueprint: params.layoutBlueprint,
        compositionFamily,
        sections: params.sections,
      }),
      bannedMotifs: Array.isArray(source.bannedMotifs) ? source.bannedMotifs.map((item) => String(item)).filter(Boolean) : params.brief.antiGoals,
      rationale: Array.isArray(source.rationale) ? source.rationale.map((item) => String(item)).filter(Boolean) : [],
    }
  }

  return {
    id: buildScenePlanIdForArgs({
      ratio: params.ratio,
      palette: params.styleSystem.palette,
      layoutBlueprint: params.layoutBlueprint,
      styleGuide: params.styleGuide,
    }),
    ratio: params.ratio,
    placementStrategy: params.placementStrategy,
    compositionFamily: params.compositionFamily,
    board: params.board,
    layoutBudget: params.layoutBudget,
    regions: [
      { id: 'board', role: 'board', xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
      { id: 'header', role: 'header', xRatio: 0, yRatio: 0, wRatio: 1, hRatio: params.layoutBudget.titleZoneHeight / params.layoutBudget.boardHeight },
      { id: 'sections', role: 'sections', xRatio: 0, yRatio: params.layoutBudget.titleZoneHeight / params.layoutBudget.boardHeight, wRatio: 1, hRatio: params.layoutBudget.sectionsZoneHeight / params.layoutBudget.boardHeight },
      { id: 'footer', role: 'footer', xRatio: 0, yRatio: 1 - (params.layoutBudget.footerZoneHeight / params.layoutBudget.boardHeight), wRatio: 1, hRatio: params.layoutBudget.footerZoneHeight / params.layoutBudget.boardHeight },
    ],
    nodes: buildSceneNodesForArgs({
      args,
      brief: params.brief,
      styleSystem: params.styleSystem,
      styleGuide: params.styleGuide,
      board: params.board,
      layoutBlueprint: params.layoutBlueprint,
      compositionFamily: params.compositionFamily,
      sections: params.sections,
    }),
    bannedMotifs: params.brief.antiGoals,
    rationale: [
      `根据 ${params.ratio} 比例和 ${params.compositionFamily} 方向生成场景蓝图。`,
      `节点树采用 ${params.layoutBlueprint.skeleton} / ${params.layoutBlueprint.sectionFlow}，避免固定右侧按钮母题。`,
      `装饰模式为 ${params.styleSystem.ornamentRules.mode}，禁止大椭圆与粗横条。`,
    ],
  }
}

function sceneNodeRect(scenePlan: DesignScenePlan, placement: { x: number; y: number }, node: DesignSceneNode) {
  return {
    x: Math.round(placement.x + scenePlan.board.width * node.xRatio),
    y: Math.round(placement.y + scenePlan.board.height * node.yRatio),
    w: Math.max(8, Math.round(scenePlan.board.width * node.wRatio)),
    h: Math.max(8, Math.round(scenePlan.board.height * node.hRatio)),
  }
}

function sceneNodeToBatchOp(
  scenePlan: DesignScenePlan,
  placement: { x: number; y: number },
  styleSystem: DesignStyleSystem,
  node: DesignSceneNode,
  params: { runId: string; stepId: string; repairScope: DesignRepairScope; scenePlanId: string },
): DesignBatchOp {
  const rect = sceneNodeRect(scenePlan, placement, node)
  const meta = buildOwnershipMeta({
    runId: params.runId,
    stepId: params.stepId,
    role: node.role,
    repairScope: params.repairScope,
    extra: {
      readyScenePlanId: params.scenePlanId,
      readySceneNodeId: node.id,
    },
  })

  if (node.kind === 'frame') {
    return {
      op: 'create',
      target: 'frame',
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      name: node.content || 'Design Board',
      role: node.role,
      meta,
    }
  }

  if (node.kind === 'button') {
    return {
      op: 'create',
      target: 'component',
      x: rect.x,
      y: rect.y,
      component: 'ui-button',
      props: {
        w: rect.w,
        h: rect.h,
        label: node.content || 'Action',
        variant: node.style?.variant || 'primary',
      },
      name: node.id,
      role: node.role,
      meta,
    }
  }

  if (node.kind === 'divider' || node.kind === 'chip' || node.kind === 'geo') {
    const geoShape = node.kind === 'chip'
      ? 'pill'
      : node.shape || (node.kind === 'divider' ? 'rectangle' : 'rectangle')
    return {
      op: 'create',
      target: 'geo',
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      shape: geoShape,
      label: node.content || '',
      fillColor: node.style?.fill || styleSystem.palette.accent,
      textColor: node.style?.textColor || styleSystem.palette.primaryText,
      name: node.id,
      role: node.role,
      meta: omitUndefinedFields({
        ...meta,
        readyCornerRadius: node.style?.cornerRadius,
      }),
    }
  }

  return {
    op: 'create',
    target: 'component',
    x: rect.x,
    y: rect.y,
    component: 'ui-text-block',
    props: {
      w: rect.w,
      h: rect.h,
      content: node.content || '.',
      fontSize: node.role === 'title'
        ? styleSystem.typographyTokens.titleFontSize
        : node.role === 'subtitle'
          ? styleSystem.typographyTokens.subtitleFontSize
          : node.role === 'badge'
            ? styleSystem.typographyTokens.badgeFontSize
            : node.role === 'footer'
              ? styleSystem.typographyTokens.metaFontSize
              : styleSystem.typographyTokens.sectionBodyFontSize,
      color: node.style?.textColor || styleSystem.palette.primaryText,
    },
    name: node.id,
    role: node.role,
    meta: omitUndefinedFields({
      ...meta,
      readyFillVisible: Boolean(node.style?.fill),
      readyFillStyle: node.style?.fill ? 'semi' : 'none',
      readyFillColor: node.style?.fill || '#FFFFFF',
      readyFillOpacity: node.style?.opacity ?? 100,
      readyTextColor: node.style?.textColor || styleSystem.palette.primaryText,
      readyFontWeight: node.style?.fontWeight || 'regular',
      readyTextAlign: node.style?.textAlign === 'center' ? 'middle' : 'start',
      readyFontFamily: node.style?.fontFamily || styleSystem.typographyTokens.bodyFamily,
      readyLetterSpacing: node.role === 'title' ? styleSystem.typographyTokens.letterSpacing : 0,
      readyLineHeight: node.role === 'title'
        ? styleSystem.typographyTokens.titleLineHeight
        : node.role === 'subtitle'
          ? styleSystem.typographyTokens.subtitleLineHeight
          : node.role === 'footer'
            ? styleSystem.typographyTokens.metaFontSize + 4
            : styleSystem.typographyTokens.sectionLineHeight,
      readyPaddingH: node.role === 'section' ? styleSystem.spacingScale.md : styleSystem.spacingScale.sm,
      readyPaddingV: node.role === 'title'
        ? styleSystem.spacingScale.sm
        : node.role === 'section'
          ? styleSystem.spacingScale.sm
          : Math.max(4, Math.round(styleSystem.spacingScale.xs * 0.75)),
      readyCornerRadius: node.style?.cornerRadius ?? (node.role === 'section' || node.role === 'board-surface' || node.role === 'badge'
        ? styleSystem.radiusTokens.card
        : 0),
      readyStrokeVisible: Boolean(node.style?.stroke && (node.style?.strokeWidth || 0) > 0),
      readyStrokeColor: node.style?.stroke,
      readyStrokeWidth: node.style?.strokeWidth,
      readyStrokeOpacity: node.style?.stroke ? 100 : undefined,
      readyDropShadowEnabled: node.role === 'board-surface' ? styleSystem.shadowRules.enabled : false,
      readyDropShadowColor: '#000000',
      readyDropShadowOpacity: node.role === 'board-surface' ? styleSystem.shadowRules.opacity : 0,
      readyDropShadowBlur: node.role === 'board-surface' ? styleSystem.shadowRules.blur : 0,
      readyDropShadowY: node.role === 'board-surface' ? styleSystem.shadowRules.offsetY : 0,
      readyClipContent: node.role === 'board-surface',
    }),
  }
}

function compileScenePlanToExecutionProgram(
  scenePlan: DesignScenePlan,
  placement: { x: number; y: number },
  styleSystem: DesignStyleSystem,
  runId: string,
  repairScope: DesignRepairScope,
): DesignExecutionProgram {
  const groups: Array<{
    id: string
    title: string
    goal: string
    role: DesignExecutionProgramStage['role']
    matcher: (node: DesignSceneNode) => boolean
  }> = [
    {
      id: 'stage-board',
      title: '创建画板与背景',
      goal: '先建立 frame 和视觉底板，固定主版心。',
      role: 'board',
      matcher: (node) => node.role === 'board' || node.role === 'board-surface',
    },
    {
      id: 'stage-header',
      title: '插入标题区',
      goal: '写入标签、标题、副标题和标题装饰。',
      role: 'header',
      matcher: (node) => ['badge', 'title', 'subtitle', 'divider', 'emphasis', 'meta-chip', 'rail', 'index'].includes(node.role),
    },
    {
      id: 'stage-sections',
      title: '插入信息区',
      goal: '分批创建信息模块与编号结构。',
      role: 'sections',
      matcher: (node) => node.role === 'section' || node.role === 'cta-panel',
    },
    {
      id: 'stage-footer',
      title: '收尾底部信息',
      goal: '补齐 CTA 和底部元信息。',
      role: 'footer',
      matcher: (node) => ['cta-button', 'footer'].includes(node.role),
    },
  ]

  return {
    id: `program-${scenePlan.id}`,
    scenePlanId: scenePlan.id,
    expectedBoardRole: 'board',
    stages: groups
      .map((group) => ({
        id: group.id,
        title: group.title,
        goal: group.goal,
        role: group.role,
        ops: scenePlan.nodes
          .filter(group.matcher)
          .map((node) => sceneNodeToBatchOp(scenePlan, placement, styleSystem, node, {
            runId,
            stepId: group.id,
            repairScope,
            scenePlanId: scenePlan.id,
          })),
      }))
      .filter((stage) => stage.ops.length > 0),
  }
}

function executionProgramToSteps(program: DesignExecutionProgram): DesignExecutionStep[] {
  return program.stages.map((stage) => ({
    id: stage.id,
    phase: 'execute',
    title: stage.title,
    goal: stage.goal,
    successCriteria: [`完成 ${stage.ops.length} 个原子操作`, '节点带有 run ownership 和 scene plan 标记'],
    failureCriteria: ['节点创建失败', '布局越界', '关键角色缺失'],
    batchOps: stage.ops,
    opDescriptors: stage.ops
      .filter((op) => op.op === 'create')
      .map((op) => ({
        name: String('name' in op && op.name ? op.name : 'shape'),
        role: String('role' in op && op.role ? op.role : 'shape'),
      })),
    rollbackIds: [],
  }))
}

function buildRepairPlanFromIssues(
  plan: DesignWorkPlan,
  issues: DesignReviewIssue[],
): DesignRepairPlan | null {
  if (issues.length === 0) return null
  if (issues.some((issue) => issue.code === 'ratio-mismatch' || issue.code === 'duplicate-node')) {
    return {
      id: `repair-${plan.scenePlan.id}-rebuild`,
      reason: '当前画板比例或主版式结构错误，需要重建本轮 owned board。',
      strategy: 'rebuild-board',
      targets: ['board', 'title', 'section', 'footer', 'divider', 'cta-button', 'emphasis', 'badge', 'subtitle', 'index', 'cta-panel', 'meta-chip', 'rail'],
      notes: issues.map((issue) => issue.message),
    }
  }
  if (issues.some((issue) => issue.code === 'overflow')) {
    return {
      id: `repair-${plan.scenePlan.id}-tighten`,
      reason: '当前版面存在硬性几何问题，需要收紧版心并重建。',
      strategy: 'tighten-layout',
      targets: ['title', 'subtitle', 'badge', 'section', 'cta-panel', 'footer', 'cta-button', 'divider', 'rail', 'meta-chip', 'index'],
      notes: issues.map((issue) => issue.message),
    }
  }
  if (!issues.some((issue) => issue.severity === 'error')) {
    return null
  }
  if (issues.some((issue) => issue.code === 'visual-rhythm')) {
    return {
      id: `repair-${plan.scenePlan.id}-motif`,
      reason: '当前版面存在重复母题或装饰不符，需要移除模板感元素。',
      strategy: 'remove-motif',
      targets: ['divider', 'rail', 'cta-button', 'emphasis', 'meta-chip', 'footer', 'badge', 'section', 'index', 'cta-panel'],
      notes: issues.map((issue) => issue.message),
    }
  }
  return {
    id: `repair-${plan.scenePlan.id}-restack`,
    reason: '当前结构和用户要求不一致，需要重新编排信息区。',
    strategy: 'restack-sections',
    targets: ['section', 'cta-panel', 'index', 'footer'],
    notes: issues.map((issue) => issue.message),
  }
}

function getAutoRepairRoundLimit(issues: DesignReviewIssue[]): number {
  if (!issues.some((issue) => issue.severity === 'error')) return 0
  if (issues.some((issue) => issue.code === 'ratio-mismatch' || issue.code === 'duplicate-node')) return 1
  if (issues.some((issue) => issue.code === 'structure-mismatch')) return 1
  if (issues.some((issue) => issue.code === 'overflow')) return 1
  return 0
}

function roleMatchesRepairTarget(role: string | null | undefined, target: string): boolean {
  if (!role) return false
  if (role === target) return true
  if (target === 'title') return role === 'title' || role === 'subtitle' || role === 'badge'
  if (target === 'section') return role === 'section' || role === 'cta-panel' || role === 'index'
  if (target === 'footer') return role === 'footer' || role === 'cta-button'
  if (target === 'divider') return role === 'divider' || role === 'rail'
  if (target === 'emphasis') return role === 'meta-chip'
  if (target === 'board') return role === 'board' || role === 'board-surface'
  return false
}

function collectRepairOwnedNodeIds(
  editor: Editor,
  runId: string,
  targets: string[],
): TLShapeId[] {
  if (targets.length === 0) return []
  return collectOwnedNodes(editor, runId)
    .filter((item) => targets.some((target) => roleMatchesRepairTarget(getShapeRole(item.shape), target)))
    .map((item) => item.id)
}

function stepMatchesRepairTargets(step: DesignExecutionStep, targets: string[]): boolean {
  if (targets.length === 0) return true
  return step.batchOps.some((op) => {
    if (!('role' in op)) return false
    const role = typeof op.role === 'string' ? op.role : null
    return targets.some((target) => roleMatchesRepairTarget(role, target))
  })
}

function collectOwnedNodes(editor: Editor, runId: string): Array<{
  id: TLShapeId
  shape: TLShape
  bounds: { x: number; y: number; w: number; h: number } | null
}> {
  return Array.from(editor.getCurrentPageShapeIds())
    .map((id) => {
      const shape = editor.getShape(id) as TLShape | undefined
      if (!shape || getShapeRunId(shape) !== runId) return null
      return {
        id,
        shape,
        bounds: editor.getShapePageBounds(id),
      }
    })
    .filter(Boolean) as Array<{ id: TLShapeId; shape: TLShape; bounds: { x: number; y: number; w: number; h: number } | null }>
}

function listOwnedNodePayload(editor: Editor, runId: string) {
  return collectOwnedNodes(editor, runId).map((item) => ({
    id: String(item.id),
    type: item.shape.type,
    role: getShapeRole(item.shape) || 'shape',
    bounds: item.bounds,
    meta: shapeMeta(item.shape),
  }))
}

function createTextMeta(node: Extract<CoverRenderNode, { kind: 'text' }>, ownershipMeta: Record<string, unknown>) {
  return omitUndefinedFields({
    ...ownershipMeta,
    readyFillVisible: Boolean(node.fillColor),
    readyFillStyle: node.fillColor ? 'semi' : 'none',
    readyFillColor: node.fillColor || '#FFFFFF',
    readyFillOpacity: node.fillOpacity ?? 100,
    readyTextColor: node.textColor || '#111827',
    readyFontWeight: node.fontWeight || 'regular',
    readyTextAlign: node.textAlign,
    readyFontFamily: node.fontFamily,
    readyLetterSpacing: node.letterSpacing,
    readyLineHeight: node.lineHeight,
    readyPaddingH: node.paddingH ?? 0,
    readyPaddingV: node.paddingV ?? 0,
    readyCornerRadius: node.cornerRadius ?? 0,
    readyStrokeVisible: node.strokeVisible ?? false,
    readyStrokeColor: node.strokeColor,
    readyStrokeWidth: node.strokeWidth,
    readyStrokeOpacity: node.strokeOpacity,
    readyStrokeDash: node.strokeDash,
    readyClipContent: node.clipContent === true,
  })
}

function coverNodeToBatchOp(
  node: CoverRenderNode,
  params: { runId: string; stepId: string; repairScope: DesignRepairScope; spec: CoverResolvedSpec },
): DesignBatchOp {
  const ownershipMeta = buildOwnershipMeta({
    runId: params.runId,
    stepId: params.stepId,
    role: node.role,
    repairScope: params.repairScope,
  })

  if (node.kind === 'geo') {
    return {
      op: 'create',
      target: 'geo',
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
      shape: node.shape,
      label: node.label,
      fillColor: node.fillColor,
      textColor: node.textColor,
      name: `${node.role}-${node.shape}`,
      role: node.role,
      meta: ownershipMeta,
    }
  }

  if (node.kind === 'button') {
    return {
      op: 'create',
      target: 'component',
      x: node.x,
      y: node.y,
      component: 'ui-button',
      props: {
        w: node.w,
        h: node.h,
        label: node.label,
        variant: node.variant,
      },
      name: `${node.role}-button`,
      role: node.role,
      meta: ownershipMeta,
    }
  }

  return {
    op: 'create',
    target: 'component',
    x: node.x,
    y: node.y,
    component: 'ui-text-block',
    props: {
      w: node.w,
      h: node.h,
      content: node.content.trim() ? node.content : '.',
      fontSize: node.fontSize,
      color: node.textColor || '#111827',
    },
    name: `${node.role}-text`,
    role: node.role,
    meta: node.role === 'board'
      ? omitUndefinedFields({
        ...createTextMeta({
          ...node,
          fillColor: params.spec.palette.background,
          fillOpacity: 100,
          textColor: params.spec.palette.background,
          cornerRadius: params.spec.board.cornerRadius,
        }, ownershipMeta),
        readyDropShadowEnabled: true,
        readyDropShadowColor: '#000000',
        readyDropShadowOpacity: params.spec.palette.name === 'github-dark' ? 30 : 14,
        readyDropShadowBlur: Math.round(params.spec.board.cornerRadius * 0.9),
        readyDropShadowX: 0,
        readyDropShadowY: Math.round(params.spec.board.cornerRadius * 0.35),
      })
      : createTextMeta(node, ownershipMeta),
  }
}

function buildCoverExecutionSteps(
  spec: CoverResolvedSpec,
  nodes: CoverRenderNode[],
  runId: string,
  repairScope: DesignRepairScope,
): DesignExecutionStep[] {
  const grouped: Array<{ id: string; title: string; goal: string; nodes: CoverRenderNode[] }> = [
    {
      id: 'step-board',
      title: '创建主容器',
      goal: '先建立目标比例和背景容器，固定版心。',
      nodes: nodes.filter((node) => node.role === 'board'),
    },
    {
      id: 'step-header',
      title: '插入标题区',
      goal: '建立标签、标题、副标题与分隔结构。',
      nodes: nodes.filter((node) => ['badge', 'title', 'subtitle', 'divider'].includes(node.role)),
    },
  ]

  const bodyNodes = nodes.filter((node) => !['board', 'badge', 'title', 'subtitle', 'divider', 'footer'].includes(node.role))
  const footerNodes = nodes.filter((node) => node.role === 'footer')
  const bodyChunks: CoverRenderNode[][] = []
  for (let index = 0; index < bodyNodes.length; index += 12) {
    bodyChunks.push(bodyNodes.slice(index, index + 12))
  }
  bodyChunks.forEach((chunk, index) => {
    grouped.push({
      id: `step-body-${index + 1}`,
      title: `插入主结构 ${index + 1}/${bodyChunks.length}`,
      goal: '继续填充信息区、编号和 CTA 结构。',
      nodes: chunk,
    })
  })
  grouped.push({
    id: 'step-footer',
    title: '收尾底部信息',
    goal: '补齐底部备注和轻量 CTA 收口。',
    nodes: footerNodes,
  })

  return grouped
    .filter((group) => group.nodes.length > 0)
    .map((group) => {
      const batchOps = group.nodes.map((node) => coverNodeToBatchOp(node, {
        runId,
        stepId: group.id,
        repairScope,
        spec,
      }))
      return {
        id: group.id,
        phase: 'execute',
        title: group.title,
        goal: group.goal,
        successCriteria: [`完成 ${group.nodes.length} 个语义节点创建`, '节点带有 run ownership 元数据'],
        failureCriteria: ['创建失败', '节点越界或重叠严重'],
        batchOps,
        opDescriptors: batchOps
          .filter((op) => op.op === 'create')
          .map((op) => ({
            name: (op.name || (op.target === 'component' ? op.component : op.target)) as string,
            role: String(op.role || 'shape'),
          })),
        rollbackIds: [],
      }
    })
}

function buildReviewSummary(report: DesignReviewReport): string {
  return `${report.passed ? '验收通过' : '验收未通过'}：执行 ${report.executionBatches} 批，修正 ${report.repairRounds} 轮，${report.usedScreenshotVerification ? '已截图复核' : '未截图复核'}。${report.issues.map((issue) => issue.message).join('；') || '没有发现阻断问题。'}`
}

function verifyLayoutState(
  editor: Editor,
  args: {
    runId?: string
    boardId?: string
    nodeIds?: string[]
    layoutBudget?: DesignLayoutBudget
    expectedSectionCount?: number
    expectedHeadlineAlign?: 'left' | 'center'
    expectedCtaWeight?: 'none' | 'pill' | 'button'
    expectedSectionTone?: 'soft' | 'solid' | 'outline'
    expectedBannedMotifs?: string[]
    repairScope?: DesignRepairScope
    screenshotPath?: string | null
    executionBatches?: number
    repairRounds?: number
  },
): { report: DesignReviewReport; ownedNodeIds: string[]; boardId: string | null } {
  const owned = args.runId ? collectOwnedNodes(editor, args.runId) : []
  const ownedIds = (args.nodeIds && args.nodeIds.length > 0 ? args.nodeIds : owned.map((item) => String(item.id)))
  const entries = ownedIds
    .map((id) => {
      const shape = editor.getShape(id as TLShapeId) as TLShape | undefined
      if (!shape) return null
      return { id, shape, bounds: editor.getShapePageBounds(id as TLShapeId) }
    })
    .filter(Boolean) as Array<{ id: string; shape: TLShape; bounds: { x: number; y: number; w: number; h: number } | null }>

  const issues: DesignReviewIssue[] = []
  const boardEntries = entries.filter((entry) => getShapeRole(entry.shape) === 'board')
  const boardEntry = args.boardId
    ? entries.find((entry) => entry.id === args.boardId) || null
    : boardEntries[0] || null

  if (boardEntries.length > 1) {
    issues.push({
      code: 'duplicate-node',
      severity: 'error',
      message: '检测到重复画板，当前任务应只保留一个主版式。',
    })
  }

  if (!boardEntry || !boardEntry.bounds) {
    if (entries.length === 0) {
      issues.push({
        code: 'structure-mismatch',
        severity: 'error',
        message: '没有生成任何可校验的设计节点。',
      })
    }
  } else {
    const boardRight = boardEntry.bounds.x + boardEntry.bounds.w
    const boardBottom = boardEntry.bounds.y + boardEntry.bounds.h
    const expectedRatio = args.layoutBudget ? args.layoutBudget.boardWidth / args.layoutBudget.boardHeight : null
    const actualRatio = boardEntry.bounds.w / boardEntry.bounds.h
    if (expectedRatio && Math.abs(expectedRatio - actualRatio) > 0.02) {
      issues.push({
        code: 'ratio-mismatch',
        severity: 'error',
        message: `当前画板比例偏离目标，期望 ${args.layoutBudget?.boardWidth}x${args.layoutBudget?.boardHeight}。`,
      })
    }

    let footerTop = Number.POSITIVE_INFINITY
    let contentBottom = boardEntry.bounds.y + (args.layoutBudget?.paddingTop || 0)
    let sectionBlockCount = 0
    let hasButtonCta = false
    let allHeadlineCentered = true
    let hasOutlineSections = false
    let hasWideDivider = false
    let hasLargeEllipse = false
    let hasRightSideButtonCluster = false
    for (const entry of entries) {
      const role = getShapeRole(entry.shape)
      if (entry.id === boardEntry.id || role === 'board-surface' || !entry.bounds) continue
      const right = entry.bounds.x + entry.bounds.w
      const bottom = entry.bounds.y + entry.bounds.h
      const meta = shapeMeta(entry.shape)
      if (
        entry.bounds.x < boardEntry.bounds.x
        || entry.bounds.y < boardEntry.bounds.y
        || right > boardRight
        || bottom > boardBottom
      ) {
        issues.push({
          code: 'overflow',
          severity: 'error',
          message: `节点 ${getShapeRole(entry.shape) || entry.shape.type} 超出版心。`,
        })
      }

      if (role === 'section' || role === 'cta-panel') {
        sectionBlockCount += 1
        if (meta.readyStrokeVisible === true && Number(meta.readyStrokeWidth || 0) > 0) {
          hasOutlineSections = true
        }
      }

      if (role === 'cta-button') {
        hasButtonCta = true
        if (entry.bounds.x >= boardEntry.bounds.x + boardEntry.bounds.w * 0.58) {
          hasRightSideButtonCluster = true
        }
      }

      if (role === 'title' || role === 'subtitle' || role === 'footer') {
        if (args.expectedHeadlineAlign === 'center' && meta.readyTextAlign !== 'middle') {
          allHeadlineCentered = false
        }
      }

      if ((role === 'divider' || role === 'rail') && entry.bounds.w >= boardEntry.bounds.w * 0.5 && entry.bounds.h <= Math.max(16, boardEntry.bounds.h * 0.02)) {
        hasWideDivider = true
      }

      const boundsRatio = entry.bounds.w / Math.max(1, entry.bounds.h)
      if ((entry.shape.type === 'geo' || role === 'emphasis') && boundsRatio >= 2.1 && entry.bounds.h >= Math.max(20, boardEntry.bounds.h * 0.035)) {
        hasLargeEllipse = true
      }

      if (role === 'footer') {
        footerTop = Math.min(footerTop, entry.bounds.y)
      } else {
        contentBottom = Math.max(contentBottom, bottom)
      }
    }

    if (Number.isFinite(footerTop) && contentBottom + 8 > footerTop) {
      issues.push({
        code: 'overflow',
        severity: 'error',
        message: '底部备注与主内容区发生挤压或重叠。',
      })
    }

    if (typeof args.expectedSectionCount === 'number' && sectionBlockCount !== args.expectedSectionCount) {
      issues.push({
        code: 'structure-mismatch',
        severity: 'error',
        message: `当前只生成了 ${sectionBlockCount}/${args.expectedSectionCount} 组信息区。`,
      })
    }

    if (args.expectedHeadlineAlign === 'center' && !allHeadlineCentered) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '当前版式没有完整落实居中标题策略。',
      })
    }

    if (args.expectedCtaWeight === 'button' && !hasButtonCta) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '当前版式缺少明确的按钮型 CTA。',
      })
    }

    if (args.expectedSectionTone === 'outline' && !hasOutlineSections) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '当前信息区没有体现描边结构。',
      })
    }

    const bannedMotifs = new Set((args.expectedBannedMotifs || []).map((item) => String(item)))
    if (hasLargeEllipse && Array.from(bannedMotifs).some((item) => /椭圆/i.test(item))) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '当前版面出现了大椭圆强调块，不符合本轮设计限制。',
      })
    }
    if (hasRightSideButtonCluster && Array.from(bannedMotifs).some((item) => /右侧按钮|按钮母题/i.test(item))) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '当前版面仍保留了固定右侧按钮母题，模板感过强。',
      })
    }
    if (hasWideDivider && Array.from(bannedMotifs).some((item) => /粗横条|粗线|横条/i.test(item))) {
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message: '当前版面仍存在底部或横向粗分割条，和本轮要求不一致。',
      })
    }
  }

  const geometryPassed = issues.every((issue) => issue.severity !== 'error')
  const usedScreenshotVerification = Boolean(args.screenshotPath)
  const screenshotReview = usedScreenshotVerification && args.runId
    ? compareScreenshotHeuristics(editor, {
      runId: args.runId,
      boardId: boardEntry?.id || undefined,
      expectedCtaWeight: args.expectedCtaWeight,
      expectedBannedMotifs: args.expectedBannedMotifs,
    })
    : null
  if (screenshotReview) {
    for (const message of screenshotReview.issues) {
      if (issues.some((issue) => issue.message === message)) continue
      issues.push({
        code: 'visual-rhythm',
        severity: 'warning',
        message,
      })
    }
  }
  const screenshotPassed = usedScreenshotVerification ? (screenshotReview?.issues.length || 0) === 0 : true
  const report: DesignReviewReport = {
    passed: geometryPassed && screenshotPassed,
    geometryPassed,
    screenshotPassed,
    attempts: Math.max(1, (args.repairRounds || 0) + 1),
    executionBatches: Math.max(1, args.executionBatches || 0),
    repairRounds: Math.max(0, args.repairRounds || 0),
    usedScreenshotVerification,
    touchedSelection: args.repairScope === 'selected',
    issues,
    summary: '',
  }
  report.summary = buildReviewSummary(report)
  return {
    report,
    ownedNodeIds: entries.map((entry) => entry.id),
    boardId: boardEntry?.id || null,
  }
}

function getDesignGuides(
  editor: Editor,
  args: Record<string, unknown>,
): {
  boardId: string | null
  bounds: { x: number; y: number; w: number; h: number } | null
  columns: number
  gutter: number
  margins: { left: number; right: number; top: number; bottom: number } | null
  columnGuides: number[]
} {
  const preferredBoardId = typeof args.boardId === 'string' ? args.boardId : null
  const shapes = Array.from(editor.getCurrentPageShapeIds())
    .map((id) => ({
      id: String(id),
      shape: editor.getShape(id),
      bounds: editor.getShapePageBounds(id),
    }))
    .filter((item) => item.shape && item.bounds) as Array<{ id: string; shape: TLShape; bounds: { x: number; y: number; w: number; h: number } }>
  const boardEntry = preferredBoardId
    ? shapes.find((item) => item.id === preferredBoardId) || null
    : shapes.find((item) => getShapeRole(item.shape) === 'board' || item.shape.type === 'frame') || null
  if (!boardEntry) {
    return {
      boardId: null,
      bounds: null,
      columns: 0,
      gutter: 0,
      margins: null,
      columnGuides: [],
    }
  }
  const columns = Number.isFinite(Number(args.columns)) ? Math.max(1, Math.round(Number(args.columns))) : 2
  const gutter = Number.isFinite(Number(args.gutter)) ? Math.max(8, Math.round(Number(args.gutter))) : 24
  const margin = Math.max(24, Math.round(boardEntry.bounds.w * 0.08))
  const usableWidth = boardEntry.bounds.w - margin * 2 - gutter * Math.max(0, columns - 1)
  const columnWidth = usableWidth / Math.max(1, columns)
  const columnGuides = Array.from({ length: columns }, (_, index) => (
    Math.round(boardEntry.bounds.x + margin + index * (columnWidth + gutter))
  ))
  return {
    boardId: boardEntry.id,
    bounds: boardEntry.bounds,
    columns,
    gutter,
    margins: {
      left: margin,
      right: margin,
      top: margin,
      bottom: margin,
    },
    columnGuides,
  }
}

function compareScreenshotHeuristics(
  editor: Editor,
  args: Record<string, unknown>,
): {
  summary: string
  issues: string[]
  score: number
} {
  const currentRunId = typeof args.runId === 'string' ? args.runId.trim() : ''
  if (!currentRunId) {
    return {
      summary: '截图对比启发式检查跳过：当前没有可追踪的 run 节点。',
      issues: [],
      score: 100,
    }
  }
  const nodes = currentRunId ? listOwnedNodePayload(editor, currentRunId) : []
  const issues: string[] = []
  const boundedNodes = nodes
    .map((node) => {
      const bounds = node.bounds as { x?: number; y?: number; w?: number; h?: number } | null
      if (!bounds) return { ...node, bounds: null }
      return {
        ...node,
        bounds: {
          x: Number(bounds.x || 0),
          y: Number(bounds.y || 0),
          w: Number(bounds.w || 0),
          h: Number(bounds.h || 0),
        },
      }
    })
  const boardNode = boundedNodes.find((node) => node.role === 'board' && node.bounds)
  const boardWidth = boardNode?.bounds?.w || 540
  const boardHeight = boardNode?.bounds?.h || 960
  const expectedCtaWeight = args.expectedCtaWeight === 'none' || args.expectedCtaWeight === 'pill' || args.expectedCtaWeight === 'button'
    ? args.expectedCtaWeight
    : null
  const bannedMotifs = new Set(
    Array.isArray(args.expectedBannedMotifs)
      ? args.expectedBannedMotifs.map((item) => String(item)).filter(Boolean)
      : [],
  )
  const sectionNodes = boundedNodes.filter((node) => (node.role === 'section' || node.role === 'cta-panel') && node.bounds)
  const titleNode = boundedNodes.find((node) => node.role === 'title' && node.bounds)
  const badgeNode = boundedNodes.find((node) => node.role === 'badge' && node.bounds)
  const footerNode = boundedNodes
    .filter((node) => (node.role === 'footer' || node.role === 'meta-chip') && node.bounds)
    .sort((left, right) => (right.bounds?.w || 0) - (left.bounds?.w || 0))[0]
  const hasRightButton = boundedNodes.some((node) => (
    node.role === 'cta-button'
    && node.bounds
    && node.bounds.x >= (boardNode?.bounds?.x || 0) + boardWidth * 0.56
  ))
  const hasWideDivider = boundedNodes.some((node) => (
    (node.role === 'divider' || node.role === 'rail')
    && node.bounds
    && node.bounds.w >= boardWidth * 0.48
    && node.bounds.h <= Math.max(18, boardHeight * 0.02)
  ))
  const sectionCount = nodes.filter((node) => node.role === 'section').length
  if (sectionNodes.length >= 3) {
    const widths = sectionNodes.map((node) => node.bounds!.w)
    const heights = sectionNodes.map((node) => node.bounds!.h)
    const xPositions = sectionNodes.map((node) => node.bounds!.x)
    const sortedSections = [...sectionNodes].sort((left, right) => left.bounds!.y - right.bounds!.y)
    const gaps = sortedSections.slice(1).map((node, index) => (
      node.bounds!.y - (sortedSections[index].bounds!.y + sortedSections[index].bounds!.h)
    ))
    const widthSpread = Math.max(...widths) - Math.min(...widths)
    const heightSpread = Math.max(...heights) - Math.min(...heights)
    const xSpread = Math.max(...xPositions) - Math.min(...xPositions)
    const gapSpread = gaps.length > 0 ? Math.max(...gaps) - Math.min(...gaps) : 0
    const hasUniformSectionStack = widthSpread <= Math.max(18, boardWidth * 0.05)
      && heightSpread <= Math.max(20, boardHeight * 0.035)
      && xSpread <= Math.max(18, boardWidth * 0.04)
      && gapSpread <= Math.max(18, boardHeight * 0.018)
    if (hasUniformSectionStack) {
      issues.push('信息区以几乎同宽同高的单列卡片重复堆叠，模板感过强。')
    }
  }
  const titleMeta = titleNode?.meta as Record<string, unknown> | undefined
  const hasBoxedTitle = Boolean(titleNode && (titleMeta?.readyFillVisible === true || titleMeta?.readyStrokeVisible === true))
  if (hasBoxedTitle && sectionNodes.length >= 3) {
    issues.push('主标题仍被放在明显描边或填充盒内，和正文卡片共同形成固定套版。')
  }
  const hasBadgePill = Boolean(badgeNode?.bounds && badgeNode.bounds.w / Math.max(1, badgeNode.bounds.h) >= 3)
  const hasFooterPill = Boolean(footerNode?.bounds && footerNode.bounds.w / Math.max(1, footerNode.bounds.h) >= 5)
  if (hasBadgePill && hasFooterPill && hasBoxedTitle) {
    issues.push('顶部标签、标题盒和底部胶囊同时出现，整体母题过于固定。')
  }
  if (hasRightButton && expectedCtaWeight !== 'button') {
    issues.push('版面仍存在显眼 CTA 按钮，和当前更克制的要求不一致。')
  }
  if (
    hasWideDivider
    && (
      Array.from(bannedMotifs).some((item) => /粗横条|粗线|横条/i.test(item))
      || hasBoxedTitle
      || sectionNodes.length >= 3
    )
  ) {
    issues.push('版面仍存在较粗分割条，容易形成固定套版。')
  }
  if (sectionCount === 0) issues.push('当前结果没有可识别的信息区。')
  const score = Math.max(0, 100 - issues.length * 20)
  return {
    summary: issues.length === 0
      ? '截图对比启发式检查通过：未发现明显模板母题。'
      : `截图对比启发式检查发现 ${issues.length} 个风险点。`,
    issues,
    score,
  }
}

function buildControllerSummary(result: {
  taskType: string
  ratio?: string
  compositionFamily?: string
  review: DesignReviewReport
  executionSteps: DesignExecutionStep[]
  placementBasis: string
}) {
  const placementLabel = result.placementBasis === 'existing-layout-right'
    ? '当前画布右侧空白区'
    : result.placementBasis === 'existing-layout-below'
      ? '当前画布下方空白区'
      : result.placementBasis === 'viewport-origin'
        ? '当前视口起始区'
        : '指定位置'
  return result.taskType === 'social-cover'
    ? `${result.ratio || '目标'} 封面已完成闭环生成：执行 ${result.executionSteps.length} 批、修正 ${result.review.repairRounds} 轮，采用 ${result.compositionFamily || 'scene'} 结构并完成版面审查，最终落在${placementLabel}，${result.review.passed ? '已通过' : '未通过'}几何与截图验收。`
    : `内容排版任务已完成：执行 ${result.executionSteps.length} 批，最终落在${placementLabel}，${result.review.passed ? '已通过' : '未通过'}验收。`
}

export interface DesignAgentHandlerDeps {
  editorRef: MutableRefObject<Editor | null>
  activeFileRef: MutableRefObject<string | null>
  isDirty: boolean
  saveStatus: string
  loadDesignFileIntoEditor: (path: string) => Promise<boolean>
  flushSave: (path?: string) => Promise<boolean>
  exportCurrentDesign: (payload: { format: 'png' | 'svg'; path?: string; defaultName?: string }) => Promise<string>
  markDirty: () => void
  markSaved: () => void
  selectWorkspaceFile: (path: string | null) => void
  setActiveFile: (file: string | null) => void
}

export function createDesignAgentHandler(deps: DesignAgentHandlerDeps): ModuleAgentActionHandler {
  return async ({ action, args }) => {
    if (action === 'design.captureSession') {
      const editor = deps.editorRef.current
      const snapshot = editor ? editor.getSnapshot() : null
      const selectedCount = editor?.getSelectedShapeIds().length || 0
      const selectionSummary = selectedCount > 0 ? `已选中 ${selectedCount} 个元素` : '当前没有选中元素'
      const layoutDigest = editor ? buildDesignLayoutDigest(editor, selectionSummary, useDesignSession.getState().latestReviewSummary || undefined) : null
      const activeFile = deps.activeFileRef.current
      return {
        intent: 'capture_design_session',
        ownerResourceId: activeFile,
        summary: activeFile
          ? `设计会话已捕获：${getPathBasename(activeFile)}，${selectedCount > 0 ? `已选中 ${selectedCount} 个元素` : '当前没有选中元素'}。`
          : '设计会话已捕获：当前为未保存画布。',
        snapshotHash: hashDesignSnapshot(snapshot),
        selectedCount,
        saveStatus: deps.saveStatus,
        isDirty: deps.isDirty,
        layoutDigest,
      }
    }

    if (action === 'design.openFile') {
      const path = String(args.path || '').trim()
      if (!path) throw new Error('design.openFile 缺少 path')
      await deps.loadDesignFileIntoEditor(path)
      return {
        intent: 'open_design_file',
        ownerResourceId: path,
        summary: `已打开设计文件：${getPathBasename(path)}。`,
      }
    }

    const requiresReadyEditor =
      action === 'design.getEditorState'
      || action === 'design.getStyleGuide'
      || action === 'design.snapshotLayout'
      || action === 'design.findEmptySpaceOnCanvas'
      || action === 'design.getGuides'
      || action === 'design.captureCanvasScreenshot'
      || action === 'design.compareScreenshot'
      || action === 'design.verifyLayout'
      || action === 'design.listOwnedNodes'
      || action === 'design.createFrame'
      || action === 'design.createText'
      || action === 'design.createGeoShape'
      || action === 'design.createButton'
      || action === 'design.createInput'
      || action === 'design.createCard'
      || action === 'design.createTextBlock'
      || action === 'design.createImagePlaceholder'
      || action === 'design.createPageHeader'
      || action === 'design.createSectionBlock'
      || action === 'design.createStatCard'
      || action === 'design.createListItem'
      || action === 'design.arrangeSelection'
      || action === 'design.batchDesign'
      || action === 'design.updateNodes'
      || action === 'design.updateSelected'
      || action === 'design.setZOrder'
      || action === 'design.groupNodes'
      || action === 'design.runTaskController'
      || action === 'design.composeContentLayout'
      || action === 'design.composeSocialCover'
      || action === 'design.saveProject'
      || action === 'design.exportArtifact'

    const editor = requiresReadyEditor
      ? await waitForReadyEditor(deps.editorRef, 8000, 40)
      : deps.editorRef.current

    if (requiresReadyEditor && !editor) {
      throw new Error('Design editor is not ready')
    }

    if (action === 'design.getEditorState') {
      const state = getEditorState(editor!, deps.activeFileRef.current)
      return {
        intent: 'get_design_editor_state',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已读取设计编辑器状态：${state.activeFile ? getPathBasename(state.activeFile) : '未保存画布'}，当前画布 ${state.layoutDigest.topLevelElementCount} 个元素。`,
        ...state,
      }
    }

    if (action === 'design.getStyleGuide') {
      const platform = normalizeDesignPlatform(args.platform, 'generic')
      const palette = inferPaletteForArgs(args, platform)
      const compositionFamily = normalizeCompositionFamily(args, palette, Number(args.sectionCount || 4))
      const styleGuide = buildStyleGuideForArgs(args, palette, compositionFamily)
      return {
        intent: 'get_design_style_guide',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已生成结构化设计风格指南：${styleGuide.componentMood}，主色 ${styleGuide.palette.accent}。`,
        styleGuide,
      }
    }

    if (action === 'design.measureText') {
      const text = String(args.text || '').trim()
      if (!text) throw new Error('design.measureText 缺少 text')
      const width = clampDimension(args.width, 240, 12)
      const fontSize = clampDimension(args.fontSize, 16, 8)
      const lineHeight = clampDimension(args.lineHeight, Math.round(fontSize * 1.4), fontSize)
      const paddingH = Number.isFinite(Number(args.paddingH)) ? Math.max(0, Number(args.paddingH)) : 0
      const paddingV = Number.isFinite(Number(args.paddingV)) ? Math.max(0, Number(args.paddingV)) : 0
      const maxLines = Number.isFinite(Number(args.maxLines)) ? Math.max(1, Math.round(Number(args.maxLines))) : undefined
      const lines = estimateWrappedLineCount(text, Math.max(12, width - paddingH * 2), fontSize)
      const height = estimateTextHeight({
        text,
        width,
        fontSize,
        lineHeight,
        paddingH,
        paddingV,
        maxLines,
      })
      return {
        intent: 'measure_design_text',
        ownerResourceId: deps.activeFileRef.current,
        summary: `文本测量完成：约 ${lines} 行，高度 ${height}px。`,
        text,
        width,
        fontSize,
        lineHeight,
        estimatedLines: lines,
        estimatedHeight: height,
      }
    }

    if (action === 'design.snapshotLayout') {
      const snapshot = snapshotLayout(editor!, args)
      return {
        intent: 'snapshot_design_layout',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已生成设计布局摘要：共 ${snapshot.layoutDigest.topLevelElementCount} 个元素，输出 ${snapshot.shapes.length} 个主要区域。`,
        ...snapshot,
      }
    }

    if (action === 'design.getGuides') {
      const guides = getDesignGuides(editor!, args)
      return {
        intent: 'get_design_guides',
        ownerResourceId: deps.activeFileRef.current,
        summary: guides.boardId
          ? `已生成设计参考线：${guides.columns} 列，gutter ${guides.gutter}px。`
          : '当前画布没有可用画板，返回空参考线结果。',
        ...guides,
      }
    }

    if (action === 'design.findEmptySpaceOnCanvas') {
      const width = clampDimension(args.width, 320, 24)
      const height = clampDimension(args.height, 200, 24)
      const placement = findPreferredCanvasPlacement(editor!, { w: width, h: height }, {
        ...args,
        placementStrategy: String(args.direction || 'right') === 'below' ? 'auto-below' : 'auto-right',
      }, String(args.direction || 'right') === 'below' ? 'auto-below' : 'auto-right')
      return {
        intent: 'find_design_empty_space',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已找到空白区：(${placement.x}, ${placement.y})，依据 ${placement.basis}。`,
        ...placement,
      }
    }

    if (action === 'design.captureCanvasScreenshot') {
      if (Array.isArray(args.nodeIds) && args.nodeIds.length > 0) {
        editor!.setSelectedShapes(args.nodeIds as TLShapeId[])
      }
      const outputPath = await deps.exportCurrentDesign({
        format: 'png',
        path: typeof args.path === 'string' ? args.path : undefined,
        defaultName: typeof args.defaultName === 'string' ? args.defaultName : undefined,
      })
      return {
        intent: 'capture_design_canvas_screenshot',
        ownerResourceId: deps.activeFileRef.current,
        summary: `设计截图已导出：${outputPath}`,
        artifactRefs: [{
          kind: 'design-export',
          label: getPathBasename(outputPath),
          path: outputPath,
          mimeType: 'image/png',
        }],
      }
    }

    if (action === 'design.compareScreenshot') {
      const result = compareScreenshotHeuristics(editor!, args)
      return {
        intent: 'compare_design_screenshot',
        ownerResourceId: deps.activeFileRef.current,
        summary: result.summary,
        issues: result.issues,
        score: result.score,
      }
    }

    if (action === 'design.listOwnedNodes') {
      const runId = String(args.runId || '').trim()
      if (!runId) throw new Error('design.listOwnedNodes 缺少 runId')
      const nodes = listOwnedNodePayload(editor!, runId)
      return {
        intent: 'list_design_owned_nodes',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已列出本轮 run 的 ${nodes.length} 个设计节点。`,
        nodes,
      }
    }

    if (action === 'design.verifyLayout') {
      const verification = verifyLayoutState(editor!, {
        runId: typeof args.runId === 'string' ? args.runId : undefined,
        boardId: typeof args.boardId === 'string' ? args.boardId : undefined,
        nodeIds: Array.isArray(args.nodeIds) ? args.nodeIds.map((item) => String(item)) : undefined,
        layoutBudget: isPlainRecord(args.layoutBudget) ? args.layoutBudget as unknown as DesignLayoutBudget : undefined,
        expectedSectionCount: Number.isFinite(Number(args.expectedSectionCount)) ? Number(args.expectedSectionCount) : undefined,
        expectedHeadlineAlign: args.expectedHeadlineAlign === 'center' ? 'center' : args.expectedHeadlineAlign === 'left' ? 'left' : undefined,
        expectedCtaWeight: args.expectedCtaWeight === 'none' || args.expectedCtaWeight === 'button' || args.expectedCtaWeight === 'pill'
          ? args.expectedCtaWeight
          : undefined,
        expectedSectionTone: args.expectedSectionTone === 'outline' || args.expectedSectionTone === 'solid' || args.expectedSectionTone === 'soft'
          ? args.expectedSectionTone
          : undefined,
        expectedBannedMotifs: Array.isArray(args.expectedBannedMotifs)
          ? args.expectedBannedMotifs.map((item) => String(item)).filter(Boolean)
          : undefined,
        repairScope: args.repairScope === 'run-owned' ? 'run-owned' : 'selected',
        screenshotPath: typeof args.screenshotPath === 'string' ? args.screenshotPath : undefined,
      })
      useDesignSession.getState().setSnapshotMeta({
        latestReviewSummary: verification.report.summary,
        repairScope: args.repairScope === 'run-owned' ? 'run-owned' : 'selected',
      })
      return {
        intent: 'verify_design_layout',
        ownerResourceId: deps.activeFileRef.current,
        summary: verification.report.summary,
        designReviewSummary: verification.report.summary,
        ownedNodeIds: verification.ownedNodeIds,
        reviewFailures: verification.report.issues.map((issue) => issue.code),
        reviewReport: verification.report,
      }
    }

    if (action === 'design.createFrame') {
      const created = createFrame(editor!, args)
      editor!.setSelectedShapes([created.id])
      deps.markDirty()
      return {
        intent: 'create_design_frame',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已创建 frame：${created.summaryLabel}。`,
      }
    }

    if (action === 'design.createText') {
      const created = createNativeText(editor!, args)
      editor!.setSelectedShapes([created.id as TLShapeId])
      deps.markDirty()
      return {
        intent: 'create_design_element',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已在画布上插入文本元素：“${created.summaryLabel}”。`,
      }
    }

    if (action === 'design.createGeoShape') {
      const created = createGeoShape(editor!, args)
      editor!.setSelectedShapes([created.id])
      deps.markDirty()
      return {
        intent: 'create_design_geometry',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已创建几何元素：${created.summaryLabel}。`,
      }
    }

    const componentActionMap: Record<string, DesignCustomShapeType> = {
      'design.createButton': 'ui-button',
      'design.createInput': 'ui-input',
      'design.createCard': 'ui-card',
      'design.createTextBlock': 'ui-text-block',
      'design.createImagePlaceholder': 'ui-image-placeholder',
      'design.createPageHeader': 'ui-page-header',
      'design.createSectionBlock': 'ui-section-block',
      'design.createStatCard': 'ui-stat-card',
      'design.createListItem': 'ui-list-item',
    }

    if (action in componentActionMap) {
      const created = createDesignComponent(editor!, componentActionMap[action], args)
      editor!.setSelectedShapes([created.id as TLShapeId])
      deps.markDirty()
      return {
        intent: 'create_design_component',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已创建 ${componentActionMap[action]} 组件：${created.summaryLabel.slice(0, 48)}。`,
      }
    }

    if (action === 'design.arrangeSelection') {
      const summary = arrangeSelection(editor!, args)
      deps.markDirty()
      return {
        intent: 'arrange_design_selection',
        ownerResourceId: deps.activeFileRef.current,
        summary,
      }
    }

    if (action === 'design.batchDesign') {
      const result = runBatchDesign(editor!, args)
      deps.markDirty()
      return {
        intent: 'batch_design_mutation',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已执行批量设计操作：创建 ${result.createdCount} 个元素，触达 ${result.touchedCount} 个元素。`,
      }
    }

    if (action === 'design.updateNodes') {
      const patches = Array.isArray(args.patches) ? args.patches as Array<{ id: string; x?: number; y?: number; props?: Record<string, unknown>; meta?: Record<string, unknown> }> : []
      updateNodePatches(editor!, patches)
      deps.markDirty()
      return {
        intent: 'update_design_nodes',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已更新 ${patches.length} 个节点。`,
      }
    }

    if (action === 'design.updateSelected') {
      const selectedIds = editor!.getSelectedShapeIds()
      if (selectedIds.length === 0) {
        return {
          intent: 'update_selected_nodes',
          ownerResourceId: deps.activeFileRef.current,
          summary: '没有选中的元素。',
        }
      }

      // Build patches for all selected shapes
      const patches = selectedIds.map(id => ({
        id: id as string,
        ...(Number.isFinite(Number(args.x)) ? { x: Number(args.x) } : {}),
        ...(Number.isFinite(Number(args.y)) ? { y: Number(args.y) } : {}),
        ...(args.props && typeof args.props === 'object' ? { props: args.props as Record<string, unknown> } : {}),
        ...(args.meta && typeof args.meta === 'object' ? { meta: args.meta as Record<string, unknown> } : {}),
      }))

      updateNodePatches(editor!, patches)
      deps.markDirty()
      return {
        intent: 'update_selected_nodes',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已更新 ${selectedIds.length} 个选中元素。`,
      }
    }

    if (action === 'design.setZOrder') {
      const ids = Array.isArray(args.ids) ? args.ids.map((item) => String(item)) as TLShapeId[] : []
      const mode = String(args.mode || 'front').trim()
      setNodeZOrder(editor!, ids, mode === 'back' || mode === 'forward' || mode === 'backward' ? mode : 'front')
      deps.markDirty()
      return {
        intent: 'set_design_z_order',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已调整 ${ids.length} 个节点的层级：${mode}。`,
      }
    }

    if (action === 'design.groupNodes') {
      const ids = Array.isArray(args.ids) ? args.ids.map((item) => String(item)) as TLShapeId[] : []
      const groupId = groupNodeIds(editor!, ids, { name: typeof args.name === 'string' ? args.name : undefined })
      if (groupId) {
        editor!.setSelectedShapes([groupId])
      }
      deps.markDirty()
      return {
        intent: 'group_design_nodes',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已将 ${ids.length} 个节点编组。`,
      }
    }

    if (action === 'design.runTaskController') {
      return await runDesignTaskController(editor!, deps, args)
    }

    if (action === 'design.composeContentLayout') {
      const result = composeContentLayout(editor!, args)
      deps.markDirty()
      return {
        intent: 'compose_content_layout',
        ownerResourceId: deps.activeFileRef.current,
        summary: `已生成 ${result.template} 内容排版骨架，共 ${result.count} 个组件。`,
      }
    }

    if (action === 'design.composeSocialCover') {
      const result = await runDesignTaskController(editor!, deps, {
        ...args,
        taskType: 'social-cover',
      })
      return {
        ...result,
        intent: 'compose_social_cover',
      }
    }

    if (action === 'design.saveProject') {
      const requestedPath = String(args.path || '').trim()
      if (!editor) throw new Error('Design editor is not ready')
      const snapshot = editor.getSnapshot()

      let savedPath = deps.activeFileRef.current
      if (requestedPath) {
        const result = await window.electronAPI?.design?.write(requestedPath, snapshot)
        if (!result?.success) {
          throw new Error(result?.error || '保存设计文件失败')
        }
        savedPath = requestedPath
        deps.selectWorkspaceFile(requestedPath)
        deps.setActiveFile(requestedPath)
        deps.activeFileRef.current = requestedPath
        deps.markSaved()
      } else if (savedPath) {
        const ok = await deps.flushSave(savedPath)
        if (!ok) throw new Error('保存设计文件失败')
      } else {
        const result = await window.electronAPI?.design?.saveAs({ data: snapshot })
        if (!result?.success || !result.path) {
          throw new Error(result?.error || '另存设计文件失败')
        }
        savedPath = result.path
        deps.selectWorkspaceFile(savedPath)
        deps.setActiveFile(savedPath)
        deps.activeFileRef.current = savedPath
        deps.markSaved()
      }

      return {
        intent: 'save_design_project',
        ownerResourceId: savedPath,
        summary: `设计项目已保存到 ${savedPath}.`,
        artifactRefs: savedPath ? [{
          kind: 'design-project',
          label: getPathBasename(savedPath),
          path: savedPath,
          mimeType: 'application/json',
        }] : [],
      }
    }

    if (action === 'design.exportArtifact') {
      const format = String(args.format || 'png').trim().toLowerCase() === 'svg' ? 'svg' : 'png'
      const outputPath = await deps.exportCurrentDesign({
        format,
        path: typeof args.path === 'string' ? args.path : undefined,
        defaultName: typeof args.defaultName === 'string' ? args.defaultName : undefined,
      })
      return {
        intent: 'export_design_artifact',
        ownerResourceId: deps.activeFileRef.current,
        summary: `设计已导出为 ${format.toUpperCase()}：${outputPath}`,
        artifactRefs: [{
          kind: 'design-export',
          label: getPathBasename(outputPath),
          path: outputPath,
          mimeType: format === 'svg' ? 'image/svg+xml' : 'image/png',
        }],
      }
    }

    throw new Error(`Unsupported design agent action: ${action}`)
  }
}
