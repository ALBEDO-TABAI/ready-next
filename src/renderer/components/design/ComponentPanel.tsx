import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AssetRecordType,
  DefaultColorStyle,
  DefaultColorThemePalette,
  DefaultDashStyle,
  DefaultFillStyle,
  DefaultFontStyle,
  DefaultHorizontalAlignStyle,
  DefaultSizeStyle,
  DefaultTextAlignStyle,
  DefaultVerticalAlignStyle,
  createShapeId,
  defaultColorNames,
  useEditor,
  useValue,
  type TLDefaultColorStyle,
  type TLDefaultDashStyle,
  type TLDefaultFillStyle,
  type TLDefaultFontStyle,
  type TLDefaultHorizontalAlignStyle,
  type TLDefaultSizeStyle,
  type TLDefaultTextAlignStyle,
  type TLDefaultVerticalAlignStyle,
  type TLShape,
  type TLShapeId,
} from 'tldraw'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  ChevronDown,
  ChevronRight,
  Expand,
  CopyPlus,
  Diamond,
  Eye,
  EyeOff,
  Frame,
  Grid3x3,
  Hand,
  Hash,
  Keyboard,
  Layers3,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
  PaintBucket,
  PenLine,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Square,
  Type,
  Blocks,
} from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { toLocalFileUrl } from '../../utils/dragDrop'
import {
  designComponentCatalog,
  getComponentDefaults,
  isDesignCustomShape,
  type DesignCustomShape,
  type DesignCustomShapeType,
} from './shapes'

interface LayerNode {
  shape: TLShape
  children: LayerNode[]
}

interface StyleGuidePreset {
  id: string
  name: string
  description: string
  prompt: string
}

type InspectorSection =
  | 'context'
  | 'alignment'
  | 'position'
  | 'flex'
  | 'dimension'
  | 'appearance'
  | 'typography'
  | 'fill'
  | 'stroke'
  | 'effects'
  | 'layoutGuide'
  | 'export'

const DESIGN_UI_HIDDEN_KEY = 'ready-design-ui-hidden'

const LIGHT_COLORS = {
  sidebar: 'var(--bg-panel)',
  border: 'var(--border-default)',
  text: 'var(--text-body)',
  textSubtle: 'var(--text-muted)',
  canvas: 'var(--bg-canvas)',
  inputBg: 'var(--bg-editor)',
  activeBg: 'var(--color-blue-light)',
  activeBlue: 'var(--color-blue)',
} 

const STYLE_GUIDES: StyleGuidePreset[] = [
  {
    id: 'minimal-saas',
    name: 'Minimal SaaS',
    description: '干净白底、细边框、弱阴影、组件密度适中',
    prompt: [
      'Style Guide · Minimal SaaS',
      '- 8pt 网格，间距优先使用 8/12/16/24',
      '- 字体层级: 20/16/14/13/11',
      '- 主色 #0D99FF，其他色彩尽量中性',
      '- 卡片圆角 8，输入与按钮 hover 仅轻微提亮',
      '- 过渡 160ms，避免重动画',
    ].join('\n'),
  },
  {
    id: 'editorial-grid',
    name: 'Editorial Grid',
    description: '强调版式与留白，图文结构清晰',
    prompt: [
      'Style Guide · Editorial Grid',
      '- 强分栏布局，内容区间距使用 24/32',
      '- 标题字重 600，正文 400，信息层级明确',
      '- 黑白灰为主，强调色只用于关键交互',
      '- 模块之间用留白区分，减少重边框',
      '- 标题最多两行，辅助信息底部对齐',
    ].join('\n'),
  },
  {
    id: 'dashboard-data',
    name: 'Data Dashboard',
    description: '数据优先，信息密度高且可扫描',
    prompt: [
      'Style Guide · Data Dashboard',
      '- 顶部摘要卡 + 下方细节面板',
      '- 数字字号 18~24，标签 11~12',
      '- 成功/警告/错误语义色统一 token',
      '- 图表区域高度统一，表格行高 >= 32',
      '- 筛选与时间维度固定在上方',
    ].join('\n'),
  },
]

const VARIABLE_KEYS = [
  '--bg-primary',
  '--bg-panel',
  '--bg-toolbar',
  '--bg-content',
  '--text-title',
  '--text-body',
  '--text-muted',
  '--text-light',
  '--border-default',
  '--border-input',
  '--color-blue',
  '--color-blue-light',
  '--color-green',
  '--color-red',
]

const DEFAULT_COLOR_STYLES = [...defaultColorNames] as TLDefaultColorStyle[]

const SIZE_TO_STROKE_WIDTH: Record<TLDefaultSizeStyle, number> = {
  s: 1,
  m: 2,
  l: 3,
  xl: 4,
}

const SIZE_TO_FONT_SIZE: Record<TLDefaultSizeStyle, number> = {
  s: 12,
  m: 16,
  l: 22,
  xl: 30,
}

type TLColorVariant = 'solid' | 'semi' | 'pattern' | 'fill' | 'linedFill'

function normalizeHex(input: string): string {
  const value = input.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(value)) return value
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
  }
  return '#000000'
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = normalizeHex(hex).slice(1)
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return [r, g, b]
}

function distanceRgb(a: [number, number, number], b: [number, number, number]) {
  const dr = a[0] - b[0]
  const dg = a[1] - b[1]
  const db = a[2] - b[2]
  return dr * dr + dg * dg + db * db
}

function hexToRgba(hex: string, alpha: number) {
  const [r, g, b] = hexToRgb(hex)
  const a = Math.max(0, Math.min(1, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

function fillStyleToVariant(fillStyle: TLDefaultFillStyle): TLColorVariant {
  if (fillStyle === 'semi') return 'semi'
  if (fillStyle === 'pattern') return 'pattern'
  if (fillStyle === 'fill') return 'fill'
  if (fillStyle === 'lined-fill') return 'linedFill'
  return 'solid'
}

function colorStyleToHex(color: TLDefaultColorStyle, variant: TLColorVariant = 'solid') {
  const palette = DefaultColorThemePalette.lightMode[color]
  return normalizeHex(palette?.[variant] || '#000000')
}

function nearestDefaultColorStyle(hex: string, variant: TLColorVariant = 'solid'): TLDefaultColorStyle {
  const target = hexToRgb(hex)
  let nearest: TLDefaultColorStyle = 'black'
  let nearestDistance = Number.POSITIVE_INFINITY

  DEFAULT_COLOR_STYLES.forEach((style) => {
    const styleColor = hexToRgb(colorStyleToHex(style, variant))
    const currentDistance = distanceRgb(target, styleColor)
    if (currentDistance < nearestDistance) {
      nearest = style
      nearestDistance = currentDistance
    }
  })

  return nearest
}

function strokeWidthToSizeStyle(width: number): TLDefaultSizeStyle {
  if (width <= 1) return 's'
  if (width <= 2) return 'm'
  if (width <= 3) return 'l'
  return 'xl'
}

function fontSizeToSizeStyle(size: number): TLDefaultSizeStyle {
  if (size <= 13) return 's'
  if (size <= 18) return 'm'
  if (size <= 26) return 'l'
  return 'xl'
}

function normalizeHorizontalAlign(
  align: TLDefaultHorizontalAlignStyle | TLDefaultTextAlignStyle | undefined,
): 'start' | 'middle' | 'end' {
  if (!align) return 'start'
  if (align.includes('end')) return 'end'
  if (align.includes('middle')) return 'middle'
  return 'start'
}

function getShapeLabel(shape: TLShape): string {
  if (isDesignCustomShape(shape)) {
    switch (shape.type) {
      case 'ui-button':
        return shape.props.label || 'Button'
      case 'ui-input':
        return shape.props.label || 'Input'
      case 'ui-card':
        return shape.props.title || 'Card'
      case 'ui-text-block':
        return shape.props.content.split('\n')[0]?.slice(0, 20) || 'Text Block'
      case 'ui-image-placeholder':
        return shape.props.label || 'Image Placeholder'
    }
  }
  if (shape.type === 'text') return 'Text'
  if (shape.type === 'frame') return 'Frame'
  if (shape.type === 'group') return 'Group'
  if (shape.type === 'geo') return 'Shape'
  return shape.type
}

function getShapeIcon(shape: TLShape) {
  if (shape.type === 'text') return Type
  if (shape.type === 'frame') return Frame
  if (shape.type === 'group') return Layers3
  if (isDesignCustomShape(shape)) return Diamond
  return Square
}

function isImageName(name: string): boolean {
  const ext = (name.split('.').pop() || '').toLowerCase()
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff', 'tif'].includes(ext)
}

function getImageMimeType(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'bmp') return 'image/bmp'
  if (ext === 'svg') return 'image/svg+xml'
  if (ext === 'ico') return 'image/x-icon'
  if (ext === 'tiff' || ext === 'tif') return 'image/tiff'
  return 'image/png'
}

function getBaseName(filePath: string | null): string {
  if (!filePath) return 'design-export'
  const name = filePath.split('/').pop() || 'design-export'
  return name.replace(/\.[^.]+$/, '') || 'design-export'
}

function downloadDataUrl(url: string, filename: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
}

function downloadSvg(svg: string, filename: string) {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function ToolIconButton({
  active,
  onClick,
  title,
  children,
  size = 34,
}: {
  active?: boolean
  onClick: () => void
  title: string
  children: ReactNode
  size?: number
}) {
  const background = active ? LIGHT_COLORS.activeBg : LIGHT_COLORS.sidebar
  const borderColor = active ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.border
  const color = active ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.textSubtle

  return (
    <button
      onClick={onClick}
      title={title}
      className="ready-design-tool-button"
      data-active={active ? 'true' : 'false'}
      style={{
        width: size,
        height: size,
        borderRadius: 8,
        border: `1px solid ${borderColor}`,
        background,
        color,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'all 140ms ease',
      }}
    >
      {children}
    </button>
  )
}

function Section({
  title,
  open,
  onToggle,
  children,
  addable,
  onAdd,
}: {
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
  addable?: boolean
  onAdd?: () => void
}) {
  return (
    <section
      style={{
        border: `1px solid ${LIGHT_COLORS.border}`,
        borderRadius: 8,
        background: LIGHT_COLORS.sidebar,
      }}
    >
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          height: 34,
          padding: '0 10px',
          border: 'none',
          background: LIGHT_COLORS.sidebar,
          color: LIGHT_COLORS.text,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          borderRadius: 8,
        }}
      >
        <span>{title}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {addable ? (
            <span
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onAdd?.()
              }}
              style={{
                width: 18,
                height: 18,
                borderRadius: 5,
                border: `1px solid ${LIGHT_COLORS.border}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: LIGHT_COLORS.inputBg,
                cursor: onAdd ? 'pointer' : 'default',
              }}
              title="Add"
            >
              <Plus size={11} />
            </span>
          ) : null}
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {open ? <div style={{ padding: '0 10px 10px' }}>{children}</div> : null}
    </section>
  )
}

function NumberInput({
  value,
  onChange,
  label,
  suffix,
}: {
  value: number
  onChange: (value: number) => void
  label: string
  suffix?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>{label}</span>
      <div
        className="ready-design-number-shell"
        style={{
          height: 30,
          borderRadius: 8,
          border: `1px solid ${LIGHT_COLORS.border}`,
          background: LIGHT_COLORS.inputBg,
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <input
          className="ready-design-number-input"
          type="number"
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(Number(e.target.value || 0))}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 12,
            color: LIGHT_COLORS.text,
          }}
        />
        {suffix ? <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>{suffix}</span> : null}
      </div>
    </label>
  )
}

export default function ComponentPanel() {
  const editor = useEditor()
  const selectedFile = useWorkspace((state) => state.selectedFile)
  const selectFile = useWorkspace((state) => state.selectFile)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  const [uiHidden, setUiHidden] = useState<boolean>(() => localStorage.getItem(DESIGN_UI_HIDDEN_KEY) === 'true')
  const [leftPanelVisible, setLeftPanelVisible] = useState(true)
  const [layersPanelExpanded, setLayersPanelExpanded] = useState(true)
  const [layerPanelWidth, setLayerPanelWidth] = useState(264)
  const [rightPanelVisible, setRightPanelVisible] = useState(true)
  const [showVariablesPanel, setShowVariablesPanel] = useState(false)
  const [showStyleGuidePanel, setShowStyleGuidePanel] = useState(false)
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false)
  const [componentMenuOpen, setComponentMenuOpen] = useState(false)
  const [styleGuideNotice, setStyleGuideNotice] = useState('')
  const [contextInfo, setContextInfo] = useState('Context information')
  const [layoutMode, setLayoutMode] = useState<'grid' | 'flex'>('flex')
  const [distributionMode, setDistributionMode] = useState<'between' | 'around'>('between')
  const [alignmentIndex, setAlignmentIndex] = useState(4)
  const [gapValue, setGapValue] = useState(8)
  const [paddingH, setPaddingH] = useState(12)
  const [paddingV, setPaddingV] = useState(12)
  const [fillWidth, setFillWidth] = useState(false)
  const [fillHeight, setFillHeight] = useState(false)
  const [hugWidth, setHugWidth] = useState(false)
  const [hugHeight, setHugHeight] = useState(false)
  const [clipContent, setClipContent] = useState(false)
  const [opacityPercent, setOpacityPercent] = useState(100)
  const [cornerRadius, setCornerRadius] = useState(8)
  const [fontSize, setFontSize] = useState(13)
  const [lineHeightValue, setLineHeightValue] = useState(0)
  const [letterSpacing, setLetterSpacing] = useState(0)
  const [fontFamily, setFontFamily] = useState<TLDefaultFontStyle>('sans')
  const [fontWeight, setFontWeight] = useState<'regular' | 'medium' | 'bold'>('regular')
  const [textColor, setTextColor] = useState('#1a1a1a')
  const [paragraphAlign, setParagraphAlign] = useState<'start' | 'middle' | 'end'>('start')
  const [verticalAlignValue, setVerticalAlignValue] = useState<'start' | 'middle' | 'end'>('middle')
  const [fillColor, setFillColor] = useState('#ffffff')
  const [fillOpacityPercent, setFillOpacityPercent] = useState(100)
  const [fillVisible, setFillVisible] = useState(true)
  const [fillStyle, setFillStyle] = useState<TLDefaultFillStyle>('solid')
  const [strokeColor, setStrokeColor] = useState('#000000')
  const [strokeOpacityPercent, setStrokeOpacityPercent] = useState(100)
  const [strokeVisible, setStrokeVisible] = useState(true)
  const [strokeWidth, setStrokeWidth] = useState(1)
  const [strokeDash, setStrokeDash] = useState<TLDefaultDashStyle>('solid')
  const [strokePosition, setStrokePosition] = useState<'center' | 'inside' | 'outside'>('center')
  const [shadowColor, setShadowColor] = useState('#000000')
  const [shadowOpacity, setShadowOpacity] = useState(25)
  const [shadowBlur, setShadowBlur] = useState(4)
  const [shadowX, setShadowX] = useState(0)
  const [shadowY, setShadowY] = useState(4)
  const [gridSize, setGridSize] = useState(10)
  const [gridColor, setGridColor] = useState('#ff0000')
  const [gridType, setGridType] = useState<'Grid' | 'Columns' | 'Rows'>('Grid')
  const [exportScale, setExportScale] = useState('1x')
  const [exportFormat, setExportFormat] = useState<'png' | 'svg' | 'jpg'>('png')
  const [openSections, setOpenSections] = useState<Record<InspectorSection, boolean>>({
    context: true,
    alignment: true,
    position: true,
    flex: true,
    dimension: true,
    appearance: true,
    typography: true,
    fill: true,
    stroke: true,
    effects: true,
    layoutGuide: true,
    export: true,
  })

  const currentTool = useValue('design-current-tool', () => editor.getCurrentToolId(), [editor])
  const isGridMode = useValue('design-grid-mode', () => Boolean(editor.getInstanceState().isGridMode), [editor])
  const selectedShapeIds = useValue('design-selected-ids', () => editor.getSelectedShapeIds() as TLShapeId[], [editor])
  const selectedShape = useValue('design-selected-shape', () => editor.getOnlySelectedShape() as TLShape | null, [editor])
  const pageShapes = useValue('design-page-shapes', () => editor.getCurrentPageShapesSorted() as TLShape[], [editor])
  const hasPageShapes = pageShapes.length > 0

  useEffect(() => {
    setLayoutMode(isGridMode ? 'grid' : 'flex')
  }, [isGridMode])

  const selectedBounds = useMemo(() => {
    if (!selectedShape) return null
    return editor.getShapePageBounds(selectedShape.id)
  }, [editor, selectedShape])

  const variableRows = useMemo(() => {
    if (typeof window === 'undefined') return []
    const computed = getComputedStyle(document.documentElement)
    return VARIABLE_KEYS
      .map((key) => ({ key, value: computed.getPropertyValue(key).trim() }))
      .filter((row) => row.value.length > 0)
  }, [showVariablesPanel])

  const layerTree = useMemo(() => {
    const byId = new Map<string, LayerNode>()
    const order = new Map<string, number>()

    pageShapes.forEach((shape, index) => {
      byId.set(shape.id, { shape, children: [] })
      order.set(shape.id, index)
    })

    const roots: LayerNode[] = []

    byId.forEach((node) => {
      const parentId = String((node.shape as { parentId?: unknown }).parentId || '')
      if (parentId && byId.has(parentId)) {
        byId.get(parentId)?.children.push(node)
      } else {
        roots.push(node)
      }
    })

    const sortNodes = (nodes: LayerNode[]) => {
      nodes.sort((a, b) => (order.get(b.shape.id) || 0) - (order.get(a.shape.id) || 0))
      nodes.forEach((node) => sortNodes(node.children))
    }
    sortNodes(roots)

    return roots
  }, [pageShapes])

  const selectedCount = selectedShapeIds.length
  const zoomPercent = useMemo(() => Math.round(editor.getZoomLevel() * 100), [editor])

  const [posX, setPosX] = useState(0)
  const [posY, setPosY] = useState(0)
  const [rotation, setRotation] = useState(0)
  const [widthValue, setWidthValue] = useState(0)
  const [heightValue, setHeightValue] = useState(0)

  useEffect(() => {
    if (!selectedShape) return
    setLineHeightValue(0)
    setLetterSpacing(0)
    setFontWeight('regular')
    setTextColor('#1a1a1a')
    setParagraphAlign('start')
    setVerticalAlignValue('middle')
    setFillVisible(true)
    setStrokeVisible(true)
    setFillStyle('solid')
    setStrokeDash('solid')
    setFillOpacityPercent(100)
    setStrokeOpacityPercent(100)
    setStrokeWidth(1)
    setStrokePosition('center')
    setCornerRadius(8)
    setFillWidth(false)
    setFillHeight(false)
    setHugWidth(false)
    setHugHeight(false)
    setClipContent(false)
    setPaddingH(12)
    setPaddingV(12)
    setGridSize(10)
    setGridColor('#ff0000')
    setGridType('Grid')
    setContextInfo('Context information')
    setShadowOpacity(25)
    setShadowBlur(4)
    setShadowX(0)
    setShadowY(4)
    setPosX(Math.round((selectedShape as { x?: number }).x || 0))
    setPosY(Math.round((selectedShape as { y?: number }).y || 0))
    setRotation(Math.round((((selectedShape as { rotation?: number }).rotation || 0) * 180) / Math.PI))
    setOpacityPercent(Math.round(((selectedShape as { opacity?: number }).opacity ?? 1) * 100))

    if (selectedBounds) {
      setWidthValue(Math.round(selectedBounds.w))
      setHeightValue(Math.round(selectedBounds.h))
    }

    const sharedFill = editor.getShapeStyleIfExists(selectedShape, DefaultFillStyle) as TLDefaultFillStyle | undefined
    if (sharedFill) {
      setFillStyle(sharedFill)
      setFillVisible(sharedFill !== 'none')
    }

    const sharedColor = editor.getShapeStyleIfExists(selectedShape, DefaultColorStyle) as TLDefaultColorStyle | undefined
    if (sharedColor) {
      const fillVariant = fillStyleToVariant(sharedFill || 'solid')
      setStrokeColor(colorStyleToHex(sharedColor, 'solid'))
      setFillColor(colorStyleToHex(sharedColor, fillVariant))
      setTextColor(colorStyleToHex(sharedColor, 'solid'))
    }

    const sharedDash = editor.getShapeStyleIfExists(selectedShape, DefaultDashStyle) as TLDefaultDashStyle | undefined
    if (sharedDash) {
      setStrokeDash(sharedDash)
      setStrokeVisible(sharedDash !== 'dotted')
    }

    const sharedSize = editor.getShapeStyleIfExists(selectedShape, DefaultSizeStyle) as TLDefaultSizeStyle | undefined
    if (sharedSize) {
      setStrokeWidth(SIZE_TO_STROKE_WIDTH[sharedSize])
      if (selectedShape.type === 'text') {
        setFontSize(SIZE_TO_FONT_SIZE[sharedSize])
      }
    }

    const sharedFont = editor.getShapeStyleIfExists(selectedShape, DefaultFontStyle) as TLDefaultFontStyle | undefined
    if (sharedFont) {
      setFontFamily(sharedFont)
    }

    const sharedTextAlign = editor.getShapeStyleIfExists(selectedShape, DefaultTextAlignStyle) as TLDefaultTextAlignStyle | undefined
    const sharedHorizontalAlign = editor.getShapeStyleIfExists(selectedShape, DefaultHorizontalAlignStyle) as TLDefaultHorizontalAlignStyle | undefined
    setParagraphAlign(normalizeHorizontalAlign(sharedTextAlign || sharedHorizontalAlign))

    const sharedVerticalAlign = editor.getShapeStyleIfExists(selectedShape, DefaultVerticalAlignStyle) as TLDefaultVerticalAlignStyle | undefined
    if (sharedVerticalAlign) {
      setVerticalAlignValue(normalizeHorizontalAlign(sharedVerticalAlign))
    }

    const meta = (selectedShape.meta || {}) as Record<string, unknown>
    const metaFillColor = typeof meta.readyFillColor === 'string' ? normalizeHex(meta.readyFillColor) : null
    const metaStrokeColor = typeof meta.readyStrokeColor === 'string' ? normalizeHex(meta.readyStrokeColor) : null
    const metaFillStyle = typeof meta.readyFillStyle === 'string' ? meta.readyFillStyle as TLDefaultFillStyle : null
    const metaStrokeDash = typeof meta.readyStrokeDash === 'string' ? meta.readyStrokeDash as TLDefaultDashStyle : null
    const metaStrokeWidth = typeof meta.readyStrokeWidth === 'number' ? meta.readyStrokeWidth : null
    const metaStrokeVisible = typeof meta.readyStrokeVisible === 'boolean' ? meta.readyStrokeVisible : null
    const metaFillOpacity = typeof meta.readyFillOpacity === 'number' ? meta.readyFillOpacity : null
    const metaStrokeOpacity = typeof meta.readyStrokeOpacity === 'number' ? meta.readyStrokeOpacity : null
    const metaStrokePosition = typeof meta.readyStrokePosition === 'string'
      ? meta.readyStrokePosition as 'center' | 'inside' | 'outside'
      : null
    const metaFillWidth = typeof meta.readyFillWidth === 'boolean' ? meta.readyFillWidth : null
    const metaFillHeight = typeof meta.readyFillHeight === 'boolean' ? meta.readyFillHeight : null
    const metaHugWidth = typeof meta.readyHugWidth === 'boolean' ? meta.readyHugWidth : null
    const metaHugHeight = typeof meta.readyHugHeight === 'boolean' ? meta.readyHugHeight : null
    const metaClipContent = typeof meta.readyClipContent === 'boolean' ? meta.readyClipContent : null
    const metaPaddingH = typeof meta.readyPaddingH === 'number' ? meta.readyPaddingH : null
    const metaPaddingV = typeof meta.readyPaddingV === 'number' ? meta.readyPaddingV : null
    const metaGridSize = typeof meta.readyGridSize === 'number' ? meta.readyGridSize : null
    const metaGridColor = typeof meta.readyGridColor === 'string' ? normalizeHex(meta.readyGridColor) : null
    const metaGridType = typeof meta.readyGridType === 'string'
      ? (meta.readyGridType === 'Columns' || meta.readyGridType === 'Rows' ? meta.readyGridType : 'Grid')
      : null
    const metaInspectorContext = typeof meta.readyInspectorContext === 'string' ? meta.readyInspectorContext : null
    const metaFontFamily = typeof meta.readyFontFamily === 'string' ? meta.readyFontFamily as TLDefaultFontStyle : null
    const metaFillVisible = typeof meta.readyFillVisible === 'boolean' ? meta.readyFillVisible : null
    const metaFontWeight = typeof meta.readyFontWeight === 'string'
      ? meta.readyFontWeight as 'regular' | 'medium' | 'bold'
      : null
    const metaTextAlign = typeof meta.readyTextAlign === 'string'
      ? meta.readyTextAlign as 'start' | 'middle' | 'end'
      : null
    const metaVerticalAlign = typeof meta.readyVerticalAlign === 'string'
      ? meta.readyVerticalAlign as 'start' | 'middle' | 'end'
      : null
    const metaLineHeight = typeof meta.readyLineHeight === 'number' ? meta.readyLineHeight : null
    const metaLetterSpacing = typeof meta.readyLetterSpacing === 'number' ? meta.readyLetterSpacing : null
    const metaTextColor = typeof meta.readyTextColor === 'string' ? normalizeHex(meta.readyTextColor) : null
    const metaShadowColor = typeof meta.readyDropShadowColor === 'string' ? normalizeHex(meta.readyDropShadowColor) : null
    const metaShadowOpacity = typeof meta.readyDropShadowOpacity === 'number' ? meta.readyDropShadowOpacity : null
    const metaShadowBlur = typeof meta.readyDropShadowBlur === 'number' ? meta.readyDropShadowBlur : null
    const metaShadowX = typeof meta.readyDropShadowX === 'number' ? meta.readyDropShadowX : null
    const metaShadowY = typeof meta.readyDropShadowY === 'number' ? meta.readyDropShadowY : null

    if (metaFillColor) setFillColor(metaFillColor)
    if (metaStrokeColor) setStrokeColor(metaStrokeColor)
    if (metaFillStyle) setFillStyle(metaFillStyle)
    if (metaStrokeDash) setStrokeDash(metaStrokeDash)
    if (metaStrokeWidth !== null) setStrokeWidth(Math.max(1, metaStrokeWidth))
    if (metaStrokeVisible !== null) setStrokeVisible(metaStrokeVisible)
    if (metaFillOpacity !== null) setFillOpacityPercent(Math.max(0, Math.min(100, metaFillOpacity)))
    if (metaStrokeOpacity !== null) setStrokeOpacityPercent(Math.max(0, Math.min(100, metaStrokeOpacity)))
    if (metaStrokePosition) setStrokePosition(metaStrokePosition)
    if (metaFillWidth !== null) setFillWidth(metaFillWidth)
    if (metaFillHeight !== null) setFillHeight(metaFillHeight)
    if (metaHugWidth !== null) setHugWidth(metaHugWidth)
    if (metaHugHeight !== null) setHugHeight(metaHugHeight)
    if (metaClipContent !== null) setClipContent(metaClipContent)
    if (metaPaddingH !== null) setPaddingH(metaPaddingH)
    if (metaPaddingV !== null) setPaddingV(metaPaddingV)
    if (metaGridSize !== null) setGridSize(metaGridSize)
    if (metaGridColor) setGridColor(metaGridColor)
    if (metaGridType) setGridType(metaGridType)
    if (metaInspectorContext) setContextInfo(metaInspectorContext)
    if (metaFontFamily) setFontFamily(metaFontFamily)
    if (metaFillVisible !== null) setFillVisible(metaFillVisible)
    if (metaFontWeight) setFontWeight(metaFontWeight)
    if (metaTextAlign) setParagraphAlign(metaTextAlign)
    if (metaVerticalAlign) setVerticalAlignValue(metaVerticalAlign)
    if (metaLineHeight !== null) setLineHeightValue(metaLineHeight)
    if (metaLetterSpacing !== null) setLetterSpacing(metaLetterSpacing)
    if (metaTextColor) setTextColor(metaTextColor)
    if (metaShadowColor) setShadowColor(metaShadowColor)
    if (metaShadowOpacity !== null) setShadowOpacity(metaShadowOpacity)
    if (metaShadowBlur !== null) setShadowBlur(metaShadowBlur)
    if (metaShadowX !== null) setShadowX(metaShadowX)
    if (metaShadowY !== null) setShadowY(metaShadowY)

    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-text-block') {
      setFontSize(selectedShape.props.fontSize)
      setTextColor(selectedShape.props.color)
    }
    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-button') {
      setCornerRadius(selectedShape.props.cornerRadius)
    }
    if (isDesignCustomShape(selectedShape) && selectedShape.type !== 'ui-button') {
      const metaCorner = typeof meta.readyCornerRadius === 'number' ? meta.readyCornerRadius : null
      if (metaCorner !== null) {
        setCornerRadius(Math.max(0, metaCorner))
      }
    }
    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-card') {
      setShadowOpacity(selectedShape.props.hasShadow ? 25 : 0)
      setShadowBlur(selectedShape.props.hasShadow ? 4 : 0)
    }
  }, [editor, selectedShape, selectedBounds])

  const toggleSection = useCallback((key: InspectorSection) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const updateShapePosition = useCallback((x: number, y: number) => {
    if (!selectedShape) return
    editor.updateShape({ id: selectedShape.id, type: selectedShape.type, x, y } as never)
  }, [editor, selectedShape])

  const updateShapeRotation = useCallback((deg: number) => {
    if (!selectedShape) return
    const rad = (deg * Math.PI) / 180
    editor.updateShape({ id: selectedShape.id, type: selectedShape.type, rotation: rad } as never)
  }, [editor, selectedShape])

  const updateShapeDimension = useCallback((axis: 'w' | 'h', value: number) => {
    if (!selectedShape) return

    if (isDesignCustomShape(selectedShape)) {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...selectedShape.props,
          [axis]: Math.max(8, value),
        },
      } as never)
      return
    }

    const shapeAny = selectedShape as TLShape & { props?: Record<string, unknown> }
    if (!shapeAny.props) return

    if (typeof shapeAny.props.w === 'number' || typeof shapeAny.props.h === 'number') {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...shapeAny.props,
          [axis]: Math.max(8, value),
        },
      } as never)
    }
  }, [editor, selectedShape])

  const updateCornerRadius = useCallback((value: number) => {
    setCornerRadius(value)
    if (!selectedShape) return

    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-button') {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...selectedShape.props,
          cornerRadius: Math.max(0, value),
        },
      } as never)
      return
    }

    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyCornerRadius: Math.max(0, value) })
      return
    }

    const shapeAny = selectedShape as TLShape & { props?: Record<string, unknown> }
    if (!shapeAny.props) return

    if (typeof shapeAny.props.cornerRadius === 'number') {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...shapeAny.props,
          cornerRadius: Math.max(0, value),
        },
      } as never)
    }
  }, [editor, selectedShape])

  const updateTextSize = useCallback((size: number) => {
    const nextSize = Math.max(10, size)
    setFontSize(nextSize)
    if (!selectedShape) return

    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-text-block') {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...selectedShape.props,
          fontSize: nextSize,
        },
      } as never)
      return
    }

    if (selectedShape.type === 'text') {
      editor.setStyleForSelectedShapes(DefaultSizeStyle, fontSizeToSizeStyle(nextSize))
    }
  }, [editor, selectedShape])

  const updateSelectedMeta = useCallback((partialMeta: Record<string, unknown>) => {
    if (!selectedShape) return
    editor.updateShape({
      id: selectedShape.id,
      type: selectedShape.type,
      meta: {
        ...(selectedShape.meta || {}),
        ...partialMeta,
      },
    } as never)
  }, [editor, selectedShape])

  const updateTextColor = useCallback((color: string) => {
    const normalized = normalizeHex(color)
    setTextColor(normalized)
    if (!selectedShape) return

    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-text-block') {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...selectedShape.props,
          color: normalized,
        },
        meta: {
          ...(selectedShape.meta || {}),
          readyTextColor: normalized,
        },
      } as never)
      return
    }

    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyTextColor: normalized })
      return
    }

    editor.setStyleForSelectedShapes(DefaultColorStyle, nearestDefaultColorStyle(normalized))
  }, [editor, selectedShape, updateSelectedMeta])

  const applyOpacity = useCallback((value: number) => {
    const next = Math.max(0, Math.min(100, value))
    setOpacityPercent(next)
    if (!selectedShape) return
    editor.setOpacityForSelectedShapes(next / 100)
  }, [editor, selectedShape])

  const applyFillOpacity = useCallback((value: number) => {
    const next = Math.max(0, Math.min(100, value))
    setFillOpacityPercent(next)
    if (!selectedShape) return
    updateSelectedMeta({ readyFillOpacity: next })
  }, [selectedShape, updateSelectedMeta])

  const applyStrokeOpacity = useCallback((value: number) => {
    const next = Math.max(0, Math.min(100, value))
    setStrokeOpacityPercent(next)
    if (!selectedShape) return
    updateSelectedMeta({ readyStrokeOpacity: next })
  }, [selectedShape, updateSelectedMeta])

  const applyFillColor = useCallback((color: string) => {
    const normalized = normalizeHex(color)
    setFillColor(normalized)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyFillColor: normalized })
      return
    }
    editor.setStyleForSelectedShapes(DefaultColorStyle, nearestDefaultColorStyle(normalized, fillStyleToVariant(fillStyle)))
  }, [editor, fillStyle, selectedShape, updateSelectedMeta])

  const applyFillVisible = useCallback((visible: boolean) => {
    setFillVisible(visible)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({
        readyFillVisible: visible,
        ...(visible && fillStyle === 'none' ? { readyFillStyle: 'solid' } : {}),
      })
      if (visible && fillStyle === 'none') setFillStyle('solid')
      return
    }
    editor.setStyleForSelectedShapes(DefaultFillStyle, visible ? (fillStyle === 'none' ? 'solid' : fillStyle) : 'none')
  }, [editor, fillStyle, selectedShape, updateSelectedMeta])

  const applyFillStyle = useCallback((style: TLDefaultFillStyle) => {
    setFillStyle(style)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyFillStyle: style, readyFillVisible: style !== 'none' })
      setFillVisible(style !== 'none')
      return
    }
    editor.setStyleForSelectedShapes(DefaultFillStyle, style)
    setFillVisible(style !== 'none')
    const currentColor = editor.getShapeStyleIfExists(selectedShape, DefaultColorStyle) as TLDefaultColorStyle | undefined
    if (currentColor) {
      setFillColor(colorStyleToHex(currentColor, fillStyleToVariant(style)))
    }
  }, [editor, selectedShape, updateSelectedMeta])

  const applyStrokeColor = useCallback((color: string) => {
    const normalized = normalizeHex(color)
    setStrokeColor(normalized)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyStrokeColor: normalized })
      return
    }
    if (selectedShape.type === 'line' || selectedShape.type === 'arrow' || selectedShape.type === 'draw' || selectedShape.type === 'highlight') {
      editor.setStyleForSelectedShapes(DefaultColorStyle, nearestDefaultColorStyle(normalized))
      return
    }
    updateSelectedMeta({ readyStrokeColor: normalized })
  }, [editor, selectedShape, updateSelectedMeta])

  const applyStrokeDash = useCallback((dash: TLDefaultDashStyle) => {
    setStrokeDash(dash)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyStrokeDash: dash })
      return
    }
    editor.setStyleForSelectedShapes(DefaultDashStyle, dash)
  }, [editor, selectedShape, updateSelectedMeta])

  const applyStrokeWidth = useCallback((width: number) => {
    const next = Math.max(1, width)
    setStrokeWidth(next)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyStrokeWidth: next })
      return
    }
    editor.setStyleForSelectedShapes(DefaultSizeStyle, strokeWidthToSizeStyle(next))
  }, [editor, selectedShape, updateSelectedMeta])

  const applyStrokeVisible = useCallback((visible: boolean) => {
    setStrokeVisible(visible)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyStrokeVisible: visible })
      return
    }
    if (!visible) {
      applyStrokeDash('dotted')
      return
    }
    applyStrokeDash('solid')
  }, [applyStrokeDash, selectedShape, updateSelectedMeta])

  const applyFontFamily = useCallback((font: TLDefaultFontStyle) => {
    setFontFamily(font)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyFontFamily: font })
      return
    }
    editor.setStyleForSelectedShapes(DefaultFontStyle, font)
  }, [editor, selectedShape, updateSelectedMeta])

  const applyParagraphAlign = useCallback((align: 'start' | 'middle' | 'end') => {
    setParagraphAlign(align)
    if (!selectedShape) return
    if (selectedShape.type === 'text') {
      editor.setStyleForSelectedShapes(DefaultTextAlignStyle, align)
      return
    }
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyTextAlign: align })
      return
    }
    editor.setStyleForSelectedShapes(DefaultHorizontalAlignStyle, align)
  }, [editor, selectedShape, updateSelectedMeta])

  const applyVerticalAlign = useCallback((align: 'start' | 'middle' | 'end') => {
    setVerticalAlignValue(align)
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      updateSelectedMeta({ readyVerticalAlign: align })
      return
    }
    editor.setStyleForSelectedShapes(DefaultVerticalAlignStyle, align)
  }, [editor, selectedShape, updateSelectedMeta])

  const applyMatrixAlignment = useCallback((index: number) => {
    setAlignmentIndex(index)
    const ids = editor.getSelectedShapeIds() as TLShapeId[]
    if (ids.length < 2) return

    const horizontal = (['left', 'center-horizontal', 'right'] as const)[index % 3]
    const vertical = (['top', 'center-vertical', 'bottom'] as const)[Math.floor(index / 3)]
    editor.alignShapes(ids, horizontal)
    editor.alignShapes(ids, vertical)
  }, [editor])

  const resolveDistributionAxis = useCallback((ids: TLShapeId[]) => {
    const rawBounds = ids.map((id) => editor.getShapePageBounds(id))
    const bounds = rawBounds.filter((b): b is NonNullable<typeof rawBounds[number]> => Boolean(b))

    if (bounds.length < 2) return 'x' as const

    const minX = Math.min(...bounds.map((b) => b.x))
    const maxX = Math.max(...bounds.map((b) => b.x + b.w))
    const minY = Math.min(...bounds.map((b) => b.y))
    const maxY = Math.max(...bounds.map((b) => b.y + b.h))
    return maxX - minX >= maxY - minY ? 'x' as const : 'y' as const
  }, [editor])

  const distributeSelected = useCallback((direction: 'horizontal' | 'vertical') => {
    const ids = editor.getSelectedShapeIds() as TLShapeId[]
    if (ids.length < 3) return
    editor.distributeShapes(ids, direction)
  }, [editor])

  const applyGap = useCallback((gap: number) => {
    const normalizedGap = Math.max(0, gap)
    setGapValue(normalizedGap)
    const ids = editor.getSelectedShapeIds() as TLShapeId[]
    if (ids.length < 2) return

    const axis = resolveDistributionAxis(ids)
    const sizedShapes = ids
      .map((id) => {
        const shape = editor.getShape(id)
        if (!shape) return null
        const bounds = editor.getShapePageBounds(id)
        if (!bounds) return null
        return { shape, bounds }
      })
      .filter(Boolean) as Array<{ shape: TLShape; bounds: { x: number; y: number; w: number; h: number } }>

    if (sizedShapes.length < 2) return
    sizedShapes.sort((a, b) => (axis === 'x' ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y))

    let cursor = axis === 'x' ? sizedShapes[0].bounds.x : sizedShapes[0].bounds.y
    const updates: Array<{ id: TLShapeId; type: string; x?: number; y?: number }> = []

    sizedShapes.forEach((item, index) => {
      const size = axis === 'x' ? item.bounds.w : item.bounds.h
      if (distributionMode === 'between' && index === 0) {
        cursor += size + normalizedGap
        return
      }

      if (distributionMode === 'around' && index === 0) {
        cursor += normalizedGap
      }

      if (axis === 'x') {
        updates.push({ id: item.shape.id, type: item.shape.type, x: Math.round(cursor), y: item.shape.y })
      } else {
        updates.push({ id: item.shape.id, type: item.shape.type, x: item.shape.x, y: Math.round(cursor) })
      }
      cursor += size + normalizedGap
    })

    if (updates.length > 0) {
      editor.updateShapes(updates as never)
    }
  }, [distributionMode, editor, resolveDistributionAxis])

  const applyPadding = useCallback((horizontal: number, vertical: number) => {
    if (!selectedShape) return
    const nextPadding = Math.max(0, Math.round((horizontal + vertical) / 2))
    if (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-card') {
      editor.updateShape({
        id: selectedShape.id,
        type: selectedShape.type,
        props: {
          ...selectedShape.props,
          padding: nextPadding,
        },
      } as never)
      return
    }
    updateSelectedMeta({ readyPaddingH: horizontal, readyPaddingV: vertical })
  }, [editor, selectedShape, updateSelectedMeta])

  const applyShadowEnabled = useCallback((enabled: boolean) => {
    if (!selectedShape) return
    if (isDesignCustomShape(selectedShape)) {
      if (selectedShape.type === 'ui-card') {
        editor.updateShape({
          id: selectedShape.id,
          type: selectedShape.type,
          props: {
            ...selectedShape.props,
            hasShadow: enabled,
          },
          meta: {
            ...(selectedShape.meta || {}),
            readyDropShadowEnabled: enabled,
          },
        } as never)
        return
      }
      updateSelectedMeta({ readyDropShadowEnabled: enabled })
      return
    }
    updateSelectedMeta({ readyDropShadowEnabled: enabled })
  }, [editor, selectedShape, updateSelectedMeta])

  const applyGridEnabled = useCallback((enabled: boolean) => {
    editor.updateInstanceState({ isGridMode: enabled })
    setLayoutMode(enabled ? 'grid' : 'flex')
    if (selectedShape) {
      updateSelectedMeta({ readyGridEnabled: enabled })
    }
  }, [editor, selectedShape, updateSelectedMeta])

  const applyGridPreset = useCallback((partial: {
    size?: number
    color?: string
    type?: 'Grid' | 'Columns' | 'Rows'
  }) => {
    if (partial.size !== undefined) {
      const nextSize = Math.max(2, partial.size)
      setGridSize(nextSize)
    }
    if (partial.color !== undefined) {
      setGridColor(normalizeHex(partial.color))
    }
    if (partial.type !== undefined) {
      setGridType(partial.type)
    }

    if (selectedShape) {
      updateSelectedMeta({
        ...(partial.size !== undefined ? { readyGridSize: Math.max(2, partial.size) } : {}),
        ...(partial.color !== undefined ? { readyGridColor: normalizeHex(partial.color) } : {}),
        ...(partial.type !== undefined ? { readyGridType: partial.type } : {}),
      })
    }
  }, [selectedShape, updateSelectedMeta])

  const applyResizeConstraint = useCallback((constraint: 'fillWidth' | 'fillHeight' | 'hugWidth' | 'hugHeight', enabled: boolean) => {
    updateSelectedMeta({ [`ready${constraint[0].toUpperCase()}${constraint.slice(1)}`]: enabled })
    if (!selectedShape || !isDesignCustomShape(selectedShape) || !enabled) return

    const parentId = (selectedShape as { parentId?: string }).parentId
    const parentShape = parentId ? editor.getShape(parentId as TLShapeId) : null
    const parentBounds = parentShape ? editor.getShapePageBounds(parentShape.id) : null
    const nextProps = { ...selectedShape.props } as Record<string, unknown>

    const meta = (selectedShape.meta || {}) as Record<string, unknown>
    const paddingHMeta = typeof meta.readyPaddingH === 'number' ? Math.max(0, Number(meta.readyPaddingH)) : 12
    const paddingVMeta = typeof meta.readyPaddingV === 'number' ? Math.max(0, Number(meta.readyPaddingV)) : 12

    if (constraint === 'fillWidth' && parentBounds) {
      nextProps.w = Math.max(24, Math.round(parentBounds.w - paddingHMeta * 2))
    }
    if (constraint === 'fillHeight' && parentBounds) {
      nextProps.h = Math.max(20, Math.round(parentBounds.h - paddingVMeta * 2))
    }

    if (constraint === 'hugWidth') {
      if (selectedShape.type === 'ui-button') {
        nextProps.w = Math.max(72, Math.round((selectedShape.props.label.length || 6) * 7 + 26))
      }
      if (selectedShape.type === 'ui-input') {
        const textLen = Math.max(selectedShape.props.placeholder.length, selectedShape.props.label.length, 8)
        nextProps.w = Math.max(140, Math.round(textLen * 7 + 52))
      }
      if (selectedShape.type === 'ui-card') {
        nextProps.w = Math.max(180, Math.round((selectedShape.props.title.length || 10) * 9 + 120))
      }
      if (selectedShape.type === 'ui-text-block') {
        const longestLine = selectedShape.props.content
          .split('\n')
          .reduce((max, line) => Math.max(max, line.length), 0)
        nextProps.w = Math.max(80, Math.round(longestLine * (selectedShape.props.fontSize * 0.58) + 22))
      }
      if (selectedShape.type === 'ui-image-placeholder') {
        if (selectedShape.props.aspectRatio === '16:9') nextProps.w = Math.max(160, Math.round((selectedShape.props.h || 150) * (16 / 9)))
        if (selectedShape.props.aspectRatio === '4:3') nextProps.w = Math.max(140, Math.round((selectedShape.props.h || 150) * (4 / 3)))
        if (selectedShape.props.aspectRatio === '1:1') nextProps.w = Math.max(120, selectedShape.props.h || 150)
      }
    }

    if (constraint === 'hugHeight') {
      if (selectedShape.type === 'ui-button') nextProps.h = 40
      if (selectedShape.type === 'ui-input') nextProps.h = 56
      if (selectedShape.type === 'ui-card') nextProps.h = 200
      if (selectedShape.type === 'ui-text-block') {
        const lines = selectedShape.props.content.split('\n').length
        const lineHeight = Math.max(16, selectedShape.props.fontSize * 1.4)
        nextProps.h = Math.max(32, Math.round(lines * lineHeight + 12))
      }
      if (selectedShape.type === 'ui-image-placeholder') {
        if (selectedShape.props.aspectRatio === '16:9') nextProps.h = Math.max(90, Math.round((selectedShape.props.w || 200) * (9 / 16)))
        if (selectedShape.props.aspectRatio === '4:3') nextProps.h = Math.max(96, Math.round((selectedShape.props.w || 200) * (3 / 4)))
        if (selectedShape.props.aspectRatio === '1:1') nextProps.h = Math.max(100, selectedShape.props.w || 200)
      }
    }

    editor.updateShape({
      id: selectedShape.id,
      type: selectedShape.type,
      props: nextProps,
    } as never)
  }, [editor, selectedShape, updateSelectedMeta])

  const activateTool = useCallback((toolId: string) => {
    editor.setCurrentTool(toolId)
  }, [editor])

  const isToolActive = useCallback((toolId: string) => {
    return currentTool === toolId || currentTool.startsWith(`${toolId}.`)
  }, [currentTool])

  const insertGeoShape = useCallback((geo: 'rectangle' | 'ellipse') => {
    const viewport = editor.getViewportPageBounds()
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'geo',
      x: viewport.x + viewport.w / 2 - 80,
      y: viewport.y + viewport.h / 2 - 60,
      props: {
        geo,
        w: 160,
        h: 120,
      },
    } as never)
    editor.setSelectedShapes([id])
    editor.setCurrentTool('select')
  }, [editor])

  const insertIconShape = useCallback(() => {
    const viewport = editor.getViewportPageBounds()
    const id = createShapeId()
    editor.createShape({
      id,
      type: 'text',
      x: viewport.x + viewport.w / 2 - 10,
      y: viewport.y + viewport.h / 2 - 10,
      props: {
        richText: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '★' }] }],
        },
      },
    } as never)
    editor.setSelectedShapes([id])
  }, [editor])

  const insertDesignComponent = useCallback((type: DesignCustomShapeType) => {
    const defaults = getComponentDefaults(type) as { w?: number; h?: number }
    const w = Math.max(24, Number(defaults.w ?? 160))
    const h = Math.max(20, Number(defaults.h ?? 100))
    const viewport = editor.getViewportPageBounds()
    const id = createShapeId()

    editor.createShape({
      id,
      type,
      x: viewport.x + viewport.w / 2 - w / 2,
      y: viewport.y + viewport.h / 2 - h / 2,
      props: getComponentDefaults(type),
    } as never)
    editor.setSelectedShapes([id])
    editor.setCurrentTool('select')
  }, [editor])

  const importImageFiles = useCallback((files: File[]) => {
    const imageFiles = files.filter((file) => isImageName(file.name))
    if (imageFiles.length === 0) return

    const viewport = editor.getViewportPageBounds()
    const baseX = viewport.x + viewport.w / 2
    const baseY = viewport.y + viewport.h / 2
    const createdIds: TLShapeId[] = []

    editor.run(() => {
      imageFiles.forEach((file, index) => {
        const id = createShapeId()
        const assetId = AssetRecordType.createId(`asset-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`)
        const path = typeof window !== 'undefined' && window.electronAPI?.getFilePathFromDrop
          ? window.electronAPI.getFilePathFromDrop(file)
          : ''
        const src = path ? toLocalFileUrl(path) : URL.createObjectURL(file)

        editor.createAssets([
          {
            id: assetId,
            typeName: 'asset',
            type: 'image',
            props: {
              name: file.name,
              src,
              w: 320,
              h: 200,
              mimeType: getImageMimeType(file.name),
              isAnimated: file.name.toLowerCase().endsWith('.gif'),
              fileSize: file.size,
            },
            meta: {},
          } as never,
        ])

        editor.createShape({
          id,
          type: 'image',
          x: baseX - 160 + index * 24,
          y: baseY - 100 + index * 24,
          props: {
            w: 320,
            h: 200,
            playing: true,
            url: '',
            assetId,
            crop: null,
            flipX: false,
            flipY: false,
            altText: file.name,
          },
        })
        createdIds.push(id)
      })
    })

    if (createdIds.length > 0) {
      editor.setSelectedShapes(createdIds)
      editor.zoomToSelectionIfOffscreen(96, { animation: { duration: 180 } })
    }
  }, [editor])

  const handleImportPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      importImageFiles(files)
    }
    e.target.value = ''
  }, [importImageFiles])

  const exportLayer = useCallback(async () => {
    const selected = editor.getSelectedShapeIds() as TLShapeId[]
    const all = Array.from(editor.getCurrentPageShapeIds()) as TLShapeId[]
    const targetIds = selected.length > 0 ? selected : all
    if (targetIds.length === 0) return

    const filenameBase = getBaseName(selectedFile)

    if (exportFormat === 'svg') {
      const svgResult = await editor.getSvgString(targetIds, { background: false })
      if (!svgResult) return

      if (window.electronAPI?.design) {
        await window.electronAPI.design.export({
          format: 'svg',
          data: svgResult.svg,
          defaultName: `${filenameBase}.svg`,
        })
      } else {
        downloadSvg(svgResult.svg, `${filenameBase}.svg`)
      }
      return
    }

    const scaleNum = exportScale === '2x' ? 2 : exportScale === '3x' ? 3 : 1
    const imageResult = await editor.toImageDataUrl(targetIds, {
      format: exportFormat === 'jpg' ? 'jpeg' : 'png',
      background: true,
      scale: scaleNum,
    })

    if (window.electronAPI?.design) {
      await window.electronAPI.design.export({
        format: exportFormat === 'jpg' ? 'png' : exportFormat,
        data: imageResult.url,
        defaultName: `${filenameBase}.${exportFormat}`,
      })
    } else {
      downloadDataUrl(imageResult.url, `${filenameBase}.${exportFormat}`)
    }
  }, [editor, exportFormat, exportScale, selectedFile])

  const alignSelected = useCallback((mode: 'left' | 'center-horizontal' | 'right' | 'top' | 'center-vertical' | 'bottom') => {
    const ids = editor.getSelectedShapeIds() as TLShapeId[]
    if (ids.length < 2) return
    editor.alignShapes(ids, mode)
  }, [editor])

  const handleCreateComponent = useCallback(() => {
    const ids = editor.getSelectedShapeIds() as TLShapeId[]
    if (ids.length === 0) {
      setStyleGuideNotice('请先选择一个或多个图层后再创建组件。')
      return
    }

    if (ids.length === 1) {
      const onlyId = ids[0]
      const shape = editor.getShape(onlyId)
      if (!shape) return
      editor.updateShape({
        id: onlyId,
        type: shape.type,
        meta: {
          ...(shape.meta || {}),
          readyComponent: true,
          readyComponentName: getShapeLabel(shape),
          readyComponentAt: Date.now(),
        },
      } as never)
      setStyleGuideNotice(`已将 "${getShapeLabel(shape)}" 标记为组件。`)
      return
    }

    const groupId = createShapeId()
    editor.groupShapes(ids, { groupId, select: true })
    editor.updateShape({
      id: groupId,
      type: 'group',
      meta: {
        readyComponent: true,
        readyComponentName: `Component ${new Date().toLocaleTimeString()}`,
        readyComponentAt: Date.now(),
        readyChildrenCount: ids.length,
      },
    } as never)
    setStyleGuideNotice(`已创建组件组（${ids.length} 个图层）。`)
  }, [editor])

  const handleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    const root = document.documentElement
    if (root.requestFullscreen) {
      await root.requestFullscreen()
    }
  }, [])

  const sendStyleGuideToChat = useCallback(async (preset: StyleGuidePreset) => {
    try {
      await navigator.clipboard.writeText(preset.prompt)
      setStyleGuideNotice('Style guide copied to clipboard. Paste it into the agent chat.')
    } catch {
      setStyleGuideNotice('样式指南已生成。')
    }
    useWorkspace.setState({ chatPanelVisible: true })
  }, [])

  const renderLayerRows = useCallback((nodes: LayerNode[], depth = 0): ReactNode => {
    return nodes.map((node) => {
      const Icon = getShapeIcon(node.shape)
      const isSelected = selectedShapeIds.includes(node.shape.id)
      return (
        <div key={node.shape.id}>
          <button
            onClick={() => editor.setSelectedShapes([node.shape.id])}
            className="ready-design-layer-row"
            data-selected={isSelected ? 'true' : 'false'}
            style={{
              width: '100%',
              height: 28,
              padding: `0 8px 0 ${8 + depth * 14}px`,
              border: 'none',
              borderRadius: 6,
              background: isSelected ? LIGHT_COLORS.activeBg : 'transparent',
              color: LIGHT_COLORS.text,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: isSelected ? 600 : 500,
            }}
            title={node.shape.id}
          >
            <Icon size={13} color={isSelected ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.textSubtle} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {getShapeLabel(node.shape)}
            </span>
          </button>
          {node.children.length > 0 ? renderLayerRows(node.children, depth + 1) : null}
        </div>
      )
    })
  }, [editor, selectedShapeIds])

  useEffect(() => {
    if (!styleGuideNotice) return
    const timer = window.setTimeout(() => setStyleGuideNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [styleGuideNotice])

  useEffect(() => {
    const onImportImages = () => importInputRef.current?.click()
    const onToggleUI = () => {
      setUiHidden((prev) => {
        const next = !prev
        localStorage.setItem(DESIGN_UI_HIDDEN_KEY, String(next))
        return next
      })
    }
    const onToggleLeft = () => setLeftPanelVisible((prev) => !prev)
    const onToggleRight = () => setRightPanelVisible((prev) => !prev)
    const onToggleVariables = () => setShowVariablesPanel((prev) => !prev)
    const onToggleLayers = () => {
      setLeftPanelVisible((prevVisible) => {
        if (!prevVisible) {
          setLayersPanelExpanded(true)
          return true
        }
        setLayersPanelExpanded((prev) => !prev)
        return prevVisible
      })
    }
    const onOpenStyleGuides = () => setShowStyleGuidePanel((prev) => !prev)

    window.addEventListener('ready-design-import-images', onImportImages as EventListener)
    window.addEventListener('ready-design-toggle-ui', onToggleUI as EventListener)
    window.addEventListener('ready-design-toggle-left-panel', onToggleLeft as EventListener)
    window.addEventListener('ready-design-toggle-right-panel', onToggleRight as EventListener)
    window.addEventListener('ready-design-toggle-variables', onToggleVariables as EventListener)
    window.addEventListener('ready-design-toggle-layers', onToggleLayers as EventListener)
    window.addEventListener('ready-design-open-style-guides', onOpenStyleGuides as EventListener)

    return () => {
      window.removeEventListener('ready-design-import-images', onImportImages as EventListener)
      window.removeEventListener('ready-design-toggle-ui', onToggleUI as EventListener)
      window.removeEventListener('ready-design-toggle-left-panel', onToggleLeft as EventListener)
      window.removeEventListener('ready-design-toggle-right-panel', onToggleRight as EventListener)
      window.removeEventListener('ready-design-toggle-variables', onToggleVariables as EventListener)
      window.removeEventListener('ready-design-toggle-layers', onToggleLayers as EventListener)
      window.removeEventListener('ready-design-open-style-guides', onOpenStyleGuides as EventListener)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        const next = !uiHidden
        setUiHidden(next)
        localStorage.setItem(DESIGN_UI_HIDDEN_KEY, String(next))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [uiHidden])

  const isTextSelected = Boolean(
    selectedShape && (
      selectedShape.type === 'text' ||
      (isDesignCustomShape(selectedShape) && selectedShape.type === 'ui-text-block')
    )
  )

  const leftDockWidth = leftPanelVisible
    ? (layersPanelExpanded ? 50 + layerPanelWidth : 50)
    : 0
  const rightPanelWidth = 232
  const gridStroke = hexToRgba(gridColor, 0.22)
  const gridOverlayBackground = gridType === 'Columns'
    ? `repeating-linear-gradient(to right, ${gridStroke}, ${gridStroke} 1px, transparent 1px, transparent ${gridSize}px)`
    : gridType === 'Rows'
      ? `repeating-linear-gradient(to bottom, ${gridStroke}, ${gridStroke} 1px, transparent 1px, transparent ${gridSize}px)`
      : `
        repeating-linear-gradient(to right, ${gridStroke}, ${gridStroke} 1px, transparent 1px, transparent ${gridSize}px),
        repeating-linear-gradient(to bottom, ${gridStroke}, ${gridStroke} 1px, transparent 1px, transparent ${gridSize}px)
      `

  return (
    <div
      className="ready-design-shell"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'stretch',
        gap: 0,
      }}
    >
      <input
        ref={importInputRef}
        type="file"
        accept="image/*,.svg"
        multiple
        style={{ display: 'none' }}
        onChange={handleImportPickerChange}
      />

      {isGridMode ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: gridOverlayBackground,
            backgroundSize: 'auto',
            opacity: 1,
            zIndex: 0,
          }}
        />
      ) : null}

      {!uiHidden && leftPanelVisible ? (
        <div
          style={{
            width: leftDockWidth,
            borderRight: `1px solid ${LIGHT_COLORS.border}`,
            background: LIGHT_COLORS.sidebar,
            display: 'flex',
            pointerEvents: 'auto',
            minHeight: 0,
            transition: 'width 160ms ease',
            position: 'relative',
          }}
        >
          <div
            style={{
              width: 50,
              borderRight: layersPanelExpanded ? `1px solid ${LIGHT_COLORS.border}` : 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              padding: '8px 0',
              background: LIGHT_COLORS.sidebar,
            }}
          >
            <ToolIconButton active={isToolActive('select')} onClick={() => activateTool('select')} title="Select / Move">
              <MousePointer2 size={16} />
            </ToolIconButton>
            <ToolIconButton active={isToolActive('frame')} onClick={() => activateTool('frame')} title="Frame / Region">
              <Frame size={16} />
            </ToolIconButton>
            <ToolIconButton
              active={layersPanelExpanded}
              onClick={() => setLayersPanelExpanded((prev) => !prev)}
              title={layersPanelExpanded ? '折叠图层面板' : '展开图层面板'}
            >
              <Layers3 size={16} />
            </ToolIconButton>

            <div style={{ position: 'relative' }}>
              <ToolIconButton active={shapeMenuOpen || isToolActive('geo')} onClick={() => setShapeMenuOpen((v) => !v)} title="Shape Tool">
                <Square size={16} />
              </ToolIconButton>
              {shapeMenuOpen ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 40,
                    top: 0,
                    zIndex: 80,
                    width: 170,
                    background: LIGHT_COLORS.sidebar,
                    border: `1px solid ${LIGHT_COLORS.border}`,
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                    padding: 6,
                  }}
                >
                  {[
                    { id: 'rectangle', label: 'Rectangle' },
                    { id: 'ellipse', label: 'Ellipse' },
                    { id: 'icon', label: 'Icon' },
                    { id: 'import-image', label: 'Import Image or SVG...' },
                    { id: 'import-figma', label: 'Import Figma' },
                    { id: 'pen', label: 'Pen' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        if (item.id === 'rectangle') insertGeoShape('rectangle')
                        if (item.id === 'ellipse') insertGeoShape('ellipse')
                        if (item.id === 'icon') insertIconShape()
                        if (item.id === 'import-image') importInputRef.current?.click()
                        if (item.id === 'import-figma') setStyleGuideNotice('Import Figma 功能将在后续版本补齐。')
                        if (item.id === 'pen') activateTool('draw')
                        setShapeMenuOpen(false)
                      }}
                      style={{
                        width: '100%',
                        height: 28,
                        border: 'none',
                        borderRadius: 6,
                        background: 'transparent',
                        textAlign: 'left',
                        padding: '0 8px',
                        color: LIGHT_COLORS.text,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <ToolIconButton active={isToolActive('draw')} onClick={() => activateTool('draw')} title="Pen">
              <PenLine size={16} />
            </ToolIconButton>
            <ToolIconButton active={isToolActive('text')} onClick={() => activateTool('text')} title="Text">
              <Type size={16} />
            </ToolIconButton>
            <ToolIconButton
              active={isGridMode}
              onClick={() => {
                applyGridEnabled(!isGridMode)
                setLayoutMode(!isGridMode ? 'grid' : 'flex')
              }}
              title="Grid / Layout"
            >
              <Hash size={16} />
            </ToolIconButton>

            <div style={{ position: 'relative' }}>
              <ToolIconButton active={componentMenuOpen} onClick={() => setComponentMenuOpen((v) => !v)} title="Components">
                <Diamond size={16} />
              </ToolIconButton>
              {componentMenuOpen ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 40,
                    top: 0,
                    zIndex: 80,
                    width: 188,
                    background: LIGHT_COLORS.sidebar,
                    border: `1px solid ${LIGHT_COLORS.border}`,
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                    padding: 6,
                  }}
                >
                  {designComponentCatalog.map((item) => (
                    <button
                      key={item.type}
                      onClick={() => {
                        insertDesignComponent(item.type)
                        setComponentMenuOpen(false)
                      }}
                      style={{
                        width: '100%',
                        minHeight: 34,
                        border: 'none',
                        borderRadius: 6,
                        background: 'transparent',
                        textAlign: 'left',
                        padding: '6px 8px',
                        color: LIGHT_COLORS.text,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{item.label}</div>
                      <div style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>{item.description}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <ToolIconButton active={isToolActive('hand')} onClick={() => activateTool('hand')} title="Hand Tool">
              <Hand size={16} />
            </ToolIconButton>
            <ToolIconButton active={false} onClick={() => setStyleGuideNotice('Plugins / Widgets 即将支持。')} title="Plugins / Widgets">
              <Blocks size={16} />
            </ToolIconButton>
            <ToolIconButton active={false} onClick={() => setStyleGuideNotice('快捷键: V/H/T/D/Cmd+S/Cmd+\\')} title="Keyboard Shortcuts">
              <Keyboard size={16} />
            </ToolIconButton>
            <ToolIconButton active={showVariablesPanel} onClick={() => setShowVariablesPanel((v) => !v)} title="Settings">
              <Settings2 size={16} />
            </ToolIconButton>
            <ToolIconButton active={false} onClick={() => void handleFullscreen()} title="Fullscreen">
              <Expand size={16} />
            </ToolIconButton>
          </div>

          {layersPanelExpanded ? (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  height: 38,
                  borderBottom: `1px solid ${LIGHT_COLORS.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0 12px',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: LIGHT_COLORS.text }}>Layers</span>
                <span style={{ fontSize: 11, color: LIGHT_COLORS.textSubtle }}>{pageShapes.length}</span>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
                {layerTree.length === 0 ? (
                  <div style={{ fontSize: 12, color: LIGHT_COLORS.textSubtle, padding: 8 }}>空画布</div>
                ) : (
                  renderLayerRows(layerTree)
                )}
              </div>
            </div>
          ) : null}
          {/* Resize handle for layer panel */}
          {layersPanelExpanded && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                right: -3,
                width: 6,
                height: '100%',
                cursor: 'col-resize',
                zIndex: 20,
              }}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const startX = e.clientX
                const startWidth = layerPanelWidth
                const handleMouseMove = (ev: MouseEvent) => {
                  const delta = ev.clientX - startX
                  const newWidth = Math.max(160, Math.min(500, startWidth + delta))
                  setLayerPanelWidth(newWidth)
                }
                const handleMouseUp = () => {
                  document.removeEventListener('mousemove', handleMouseMove)
                  document.removeEventListener('mouseup', handleMouseUp)
                  document.body.style.cursor = ''
                  document.body.style.userSelect = ''
                }
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
                document.addEventListener('mousemove', handleMouseMove)
                document.addEventListener('mouseup', handleMouseUp)
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 2,
                  width: 2,
                  height: '100%',
                  borderRadius: 1,
                  transition: 'opacity 150ms',
                  opacity: 0,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = LIGHT_COLORS.activeBlue }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = '0'; e.currentTarget.style.background = 'transparent' }}
              />
            </div>
          )}
        </div>
      ) : null}

      <div style={{ flex: 1 }} />

      {!uiHidden && rightPanelVisible ? (
        <div
          style={{
            width: rightPanelWidth,
            borderLeft: `1px solid ${LIGHT_COLORS.border}`,
            background: LIGHT_COLORS.sidebar,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            pointerEvents: 'auto',
            overflow: 'auto',
          }}
        >
          <div
            style={{
              border: `1px solid ${LIGHT_COLORS.border}`,
              borderRadius: 8,
              background: LIGHT_COLORS.sidebar,
              padding: 10,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {selectedShape ? (() => {
                const Icon = getShapeIcon(selectedShape)
                return <Icon size={14} color={LIGHT_COLORS.textSubtle} />
              })() : <Square size={14} color={LIGHT_COLORS.textSubtle} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: LIGHT_COLORS.text, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {selectedShape ? getShapeLabel(selectedShape) : 'No layer selected'}
                </div>
                <div style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>
                  {selectedShape ? selectedShape.type : 'Select an element'}
                </div>
              </div>
            </div>
            <button
              onClick={handleCreateComponent}
              style={{
                height: 30,
                borderRadius: 8,
                border: `1px solid ${LIGHT_COLORS.border}`,
                background: LIGHT_COLORS.sidebar,
                color: LIGHT_COLORS.text,
                fontSize: 12,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                cursor: 'pointer',
              }}
            >
              <Diamond size={13} />
              Create Component
            </button>
          </div>

          <Section title="Context" open={openSections.context} onToggle={() => toggleSection('context')}>
            <select
              value={contextInfo}
              onChange={(e) => {
                const next = e.target.value
                setContextInfo(next)
                updateSelectedMeta({ readyInspectorContext: next })
              }}
              style={{
                width: '100%',
                height: 32,
                borderRadius: 8,
                border: `1px solid ${LIGHT_COLORS.border}`,
                background: LIGHT_COLORS.inputBg,
                padding: '0 8px',
                color: LIGHT_COLORS.text,
                fontSize: 12,
              }}
            >
              <option>Context information</option>
              <option>Layout / Auto Layout</option>
              <option>Typography</option>
              <option>Visual Style</option>
            </select>
          </Section>

          <Section title="Alignment" open={openSections.alignment} onToggle={() => toggleSection('alignment')}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
              <ToolIconButton title="Align Left" onClick={() => alignSelected('left')}><AlignStartHorizontal size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              <ToolIconButton title="Align Horizontal Centers" onClick={() => alignSelected('center-horizontal')}><AlignCenterHorizontal size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              <ToolIconButton title="Align Right" onClick={() => alignSelected('right')}><AlignEndHorizontal size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              <ToolIconButton title="Align Top" onClick={() => alignSelected('top')}><AlignStartVertical size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              <ToolIconButton title="Align Vertical Centers" onClick={() => alignSelected('center-vertical')}><AlignCenterVertical size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              <ToolIconButton title="Align Bottom" onClick={() => alignSelected('bottom')}><AlignEndVertical size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
            </div>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <button
                onClick={() => distributeSelected('horizontal')}
                style={{
                  height: 30,
                  borderRadius: 8,
                  border: `1px solid ${LIGHT_COLORS.border}`,
                  background: LIGHT_COLORS.sidebar,
                  color: LIGHT_COLORS.text,
                  fontSize: 11,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  cursor: 'pointer',
                }}
              >
                <MoveHorizontal size={14} />
                H
              </button>
              <button
                onClick={() => distributeSelected('vertical')}
                style={{
                  height: 30,
                  borderRadius: 8,
                  border: `1px solid ${LIGHT_COLORS.border}`,
                  background: LIGHT_COLORS.sidebar,
                  color: LIGHT_COLORS.text,
                  fontSize: 11,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  cursor: 'pointer',
                }}
              >
                <MoveVertical size={14} />
                V
              </button>
            </div>
          </Section>

          <Section title="Position" open={openSections.position} onToggle={() => toggleSection('position')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <NumberInput label="X" value={posX} onChange={(v) => { setPosX(v); updateShapePosition(v, posY) }} />
              <NumberInput label="Y" value={posY} onChange={(v) => { setPosY(v); updateShapePosition(posX, v) }} />
            </div>
            <div style={{ marginTop: 8 }}>
              <NumberInput label="R" value={rotation} onChange={(v) => { setRotation(v); updateShapeRotation(v) }} suffix="°" />
            </div>
          </Section>

          <Section title="Flex Layout" open={openSections.flex} onToggle={() => toggleSection('flex')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <button
                onClick={() => {
                  setLayoutMode('grid')
                  applyGridEnabled(true)
                }}
                style={{
                  height: 28,
                  borderRadius: 8,
                  border: `1px solid ${layoutMode === 'grid' ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.border}`,
                  background: layoutMode === 'grid' ? LIGHT_COLORS.activeBg : LIGHT_COLORS.sidebar,
                  color: LIGHT_COLORS.text,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Grid
              </button>
              <button
                onClick={() => {
                  setLayoutMode('flex')
                  applyGridEnabled(false)
                }}
                style={{
                  height: 28,
                  borderRadius: 8,
                  border: `1px solid ${layoutMode === 'flex' ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.border}`,
                  background: layoutMode === 'flex' ? LIGHT_COLORS.activeBg : LIGHT_COLORS.sidebar,
                  color: LIGHT_COLORS.text,
                  fontSize: 11,
                  cursor: 'pointer',
                }}
              >
                Flex
              </button>
            </div>

            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle, marginBottom: 4 }}>Alignment Matrix</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                {Array.from({ length: 9 }).map((_, index) => (
                  <button
                    key={index}
                    onClick={() => applyMatrixAlignment(index)}
                    style={{
                      height: 24,
                      borderRadius: 6,
                      border: `1px solid ${alignmentIndex === index ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.border}`,
                      background: alignmentIndex === index ? LIGHT_COLORS.activeBg : LIGHT_COLORS.sidebar,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 999,
                        background: alignmentIndex === index ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.textSubtle,
                        display: 'inline-block',
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <NumberInput label="Gap" value={gapValue} onChange={applyGap} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <button
                  onClick={() => {
                    setDistributionMode('between')
                    distributeSelected('horizontal')
                  }}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: `1px solid ${distributionMode === 'between' ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.border}`,
                    background: distributionMode === 'between' ? LIGHT_COLORS.activeBg : LIGHT_COLORS.sidebar,
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  Between
                </button>
                <button
                  onClick={() => {
                    setDistributionMode('around')
                    distributeSelected('vertical')
                  }}
                  style={{
                    height: 30,
                    borderRadius: 8,
                    border: `1px solid ${distributionMode === 'around' ? LIGHT_COLORS.activeBlue : LIGHT_COLORS.border}`,
                    background: distributionMode === 'around' ? LIGHT_COLORS.activeBg : LIGHT_COLORS.sidebar,
                    fontSize: 10,
                    cursor: 'pointer',
                  }}
                >
                  Around
                </button>
              </div>
            </div>

            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <NumberInput
                label="Padding V"
                value={paddingV}
                onChange={(value) => {
                  setPaddingV(value)
                  applyPadding(paddingH, value)
                }}
              />
              <NumberInput
                label="Padding H"
                value={paddingH}
                onChange={(value) => {
                  setPaddingH(value)
                  applyPadding(value, paddingV)
                }}
              />
            </div>
          </Section>

          <Section title="Dimensions & Resizing" open={openSections.dimension} onToggle={() => toggleSection('dimension')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <NumberInput label="W" value={widthValue} onChange={(v) => { setWidthValue(v); updateShapeDimension('w', v) }} />
              <NumberInput label="H" value={heightValue} onChange={(v) => { setHeightValue(v); updateShapeDimension('h', v) }} />
            </div>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11, color: LIGHT_COLORS.text }}>
              <label><input type="checkbox" checked={fillWidth} onChange={(e) => { setFillWidth(e.target.checked); applyResizeConstraint('fillWidth', e.target.checked) }} /> Fill Width</label>
              <label><input type="checkbox" checked={fillHeight} onChange={(e) => { setFillHeight(e.target.checked); applyResizeConstraint('fillHeight', e.target.checked) }} /> Fill Height</label>
              <label><input type="checkbox" checked={hugWidth} onChange={(e) => { setHugWidth(e.target.checked); applyResizeConstraint('hugWidth', e.target.checked) }} /> Hug Width</label>
              <label><input type="checkbox" checked={hugHeight} onChange={(e) => { setHugHeight(e.target.checked); applyResizeConstraint('hugHeight', e.target.checked) }} /> Hug Height</label>
            </div>
            <label style={{ marginTop: 8, display: 'block', fontSize: 11, color: LIGHT_COLORS.text }}>
              <input type="checkbox" checked={clipContent} onChange={(e) => { setClipContent(e.target.checked); updateSelectedMeta({ readyClipContent: e.target.checked }) }} /> Clip Content
            </label>
          </Section>

          <Section title="Appearance" open={openSections.appearance} onToggle={() => toggleSection('appearance')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <NumberInput label="Opacity" value={opacityPercent} onChange={applyOpacity} suffix="%" />
              <NumberInput label="Corner Radius" value={cornerRadius} onChange={updateCornerRadius} />
            </div>
          </Section>

          {isTextSelected ? (
            <Section title="Typography" open={openSections.typography} onToggle={() => toggleSection('typography')}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Font Family</span>
                  <select
                    value={fontFamily}
                    onChange={(e) => applyFontFamily(e.target.value as TLDefaultFontStyle)}
                    style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                  >
                    <option value="sans">Inter / Sans</option>
                    <option value="serif">Serif</option>
                    <option value="mono">Mono</option>
                    <option value="draw">Draw</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Font Weight</span>
                  <select
                    value={fontWeight}
                    onChange={(e) => {
                      const next = e.target.value as 'regular' | 'medium' | 'bold'
                      setFontWeight(next)
                      updateSelectedMeta({ readyFontWeight: next })
                    }}
                    style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                  >
                    <option value="regular">Regular</option>
                    <option value="medium">Medium</option>
                    <option value="bold">Bold</option>
                  </select>
                </label>
              </div>

              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <NumberInput label="S" value={fontSize} onChange={updateTextSize} />
                <NumberInput label="Line" value={lineHeightValue} onChange={(value) => { setLineHeightValue(value); updateSelectedMeta({ readyLineHeight: value }) }} />
                <NumberInput
                  label="|A|"
                  value={letterSpacing}
                  onChange={(value) => {
                    setLetterSpacing(value)
                    updateSelectedMeta({ readyLetterSpacing: value })
                  }}
                />
              </div>

              <div style={{ marginTop: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Text Color</span>
                  <input
                    type="color"
                    value={textColor}
                    onChange={(e) => updateTextColor(e.target.value)}
                    style={{ width: '100%', height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}` }}
                  />
                </label>
              </div>

              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                <ToolIconButton active={paragraphAlign === 'start'} title="Align Left" onClick={() => applyParagraphAlign('start')}><AlignStartHorizontal size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
                <ToolIconButton active={paragraphAlign === 'middle'} title="Align Center" onClick={() => applyParagraphAlign('middle')}><AlignCenterHorizontal size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
                <ToolIconButton active={paragraphAlign === 'end'} title="Align Right" onClick={() => applyParagraphAlign('end')}><AlignEndHorizontal size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              </div>

              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                <ToolIconButton active={verticalAlignValue === 'start'} title="Align Top" onClick={() => applyVerticalAlign('start')}><AlignStartVertical size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
                <ToolIconButton active={verticalAlignValue === 'middle'} title="Align Middle" onClick={() => applyVerticalAlign('middle')}><AlignCenterVertical size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
                <ToolIconButton active={verticalAlignValue === 'end'} title="Align Bottom" onClick={() => applyVerticalAlign('end')}><AlignEndVertical size={14} color={LIGHT_COLORS.text} /></ToolIconButton>
              </div>
            </Section>
          ) : null}

          <Section
            title="Fill"
            open={openSections.fill}
            onToggle={() => toggleSection('fill')}
            addable
            onAdd={() => {
              applyFillVisible(true)
              if (fillStyle === 'none') applyFillStyle('solid')
              if (fillOpacityPercent <= 0) applyFillOpacity(100)
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto auto', gap: 6, alignItems: 'center' }}>
              <input type="color" value={fillColor} onChange={(e) => applyFillColor(e.target.value)} style={{ width: '100%', height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}` }} />
              <NumberInput label="" value={fillOpacityPercent} onChange={applyFillOpacity} suffix="%" />
              <button onClick={() => applyFillVisible(!fillVisible)} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}>
                {fillVisible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button onClick={() => applyFillStyle('none')} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}>
                <Minus size={14} />
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Fill Style</span>
                <select
                  value={fillStyle}
                  onChange={(e) => applyFillStyle(e.target.value as TLDefaultFillStyle)}
                  style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                >
                  <option value="solid">Solid</option>
                  <option value="semi">Semi</option>
                  <option value="pattern">Pattern</option>
                  <option value="fill">Fill</option>
                  <option value="lined-fill">Lined Fill</option>
                  <option value="none">None</option>
                </select>
              </label>
            </div>
          </Section>

          <Section
            title="Stroke"
            open={openSections.stroke}
            onToggle={() => toggleSection('stroke')}
            addable
            onAdd={() => {
              applyStrokeVisible(true)
              applyStrokeDash('solid')
              if (strokeWidth <= 0) applyStrokeWidth(1)
              if (strokeOpacityPercent <= 0) applyStrokeOpacity(100)
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px auto auto', gap: 6, alignItems: 'center' }}>
              <input type="color" value={strokeColor} onChange={(e) => applyStrokeColor(e.target.value)} style={{ width: '100%', height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}` }} />
              <NumberInput label="" value={strokeOpacityPercent} onChange={applyStrokeOpacity} suffix="%" />
              <button onClick={() => applyStrokeVisible(!strokeVisible)} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}>
                {strokeVisible ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button onClick={() => applyStrokeVisible(false)} style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}>
                <Minus size={14} />
              </button>
            </div>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Stroke Position</span>
                <select
                  value={strokePosition}
                  onChange={(e) => {
                    const next = e.target.value as 'center' | 'inside' | 'outside'
                    setStrokePosition(next)
                    updateSelectedMeta({ readyStrokePosition: next })
                  }}
                  style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                >
                  <option value="center">Center</option>
                  <option value="inside">Inside</option>
                  <option value="outside">Outside</option>
                </select>
              </label>
              <NumberInput label="W" value={strokeWidth} onChange={applyStrokeWidth} />
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Stroke Dash</span>
                <select
                  value={strokeDash}
                  onChange={(e) => applyStrokeDash(e.target.value as TLDefaultDashStyle)}
                  style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                >
                  <option value="solid">Solid</option>
                  <option value="dashed">Dashed</option>
                  <option value="dotted">Dotted</option>
                  <option value="draw">Draw</option>
                </select>
              </label>
            </div>
          </Section>

          <Section
            title="Effects"
            open={openSections.effects}
            onToggle={() => toggleSection('effects')}
            addable
            onAdd={() => {
              if (shadowBlur <= 0) setShadowBlur(4)
              if (shadowOpacity <= 0) setShadowOpacity(25)
              applyShadowEnabled(true)
              updateSelectedMeta({
                readyDropShadowEnabled: true,
                readyDropShadowBlur: shadowBlur <= 0 ? 4 : shadowBlur,
                readyDropShadowOpacity: shadowOpacity <= 0 ? 25 : shadowOpacity,
              })
            }}
          >
            <div style={{
              border: `1px solid ${LIGHT_COLORS.border}`,
              borderRadius: 8,
              background: LIGHT_COLORS.inputBg,
              padding: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: LIGHT_COLORS.text }}>Drop Shadow</span>
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <button
                    onClick={() => {
                      setShadowColor(strokeColor)
                      updateSelectedMeta({ readyDropShadowColor: strokeColor })
                    }}
                    style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}
                  >
                    <PaintBucket size={12} />
                  </button>
                  <button
                    onClick={() => applyShadowEnabled(shadowOpacity <= 0 || shadowBlur <= 0)}
                    style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}
                  >
                    {shadowOpacity <= 0 || shadowBlur <= 0 ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <button
                    onClick={() => {
                      setShadowOpacity(0)
                      setShadowBlur(0)
                      applyShadowEnabled(false)
                    }}
                    style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}
                  >
                    <Minus size={12} />
                  </button>
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Color</span>
                  <input
                    type="color"
                    value={shadowColor}
                    onChange={(e) => {
                      const next = normalizeHex(e.target.value)
                      setShadowColor(next)
                      updateSelectedMeta({ readyDropShadowColor: next })
                    }}
                    style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}` }}
                  />
                </label>
                <NumberInput label="Opacity" value={shadowOpacity} onChange={(value) => { setShadowOpacity(value); applyShadowEnabled(value > 0 && shadowBlur > 0); updateSelectedMeta({ readyDropShadowOpacity: value }) }} suffix="%" />
                <NumberInput label="B" value={shadowBlur} onChange={(value) => { setShadowBlur(value); applyShadowEnabled(shadowOpacity > 0 && value > 0); updateSelectedMeta({ readyDropShadowBlur: value }) }} />
                <NumberInput label="X" value={shadowX} onChange={(value) => { setShadowX(value); updateSelectedMeta({ readyDropShadowX: value }) }} />
                <NumberInput label="Y" value={shadowY} onChange={(value) => { setShadowY(value); updateSelectedMeta({ readyDropShadowY: value }) }} />
              </div>
            </div>
          </Section>

          <Section
            title="Layout Guide"
            open={openSections.layoutGuide}
            onToggle={() => toggleSection('layoutGuide')}
            addable
            onAdd={() => applyGridEnabled(true)}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 6, alignItems: 'center' }}>
              <div style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px', display: 'flex', alignItems: 'center', fontSize: 12 }}>
                Grid {gridSize}px
              </div>
              <button
                onClick={() => applyGridEnabled(!isGridMode)}
                style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}
              >
                {isGridMode ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
              <button
                onClick={() => applyGridEnabled(false)}
                style={{ width: 30, height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar }}
              >
                <Minus size={14} />
              </button>
            </div>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Type</span>
                <select
                  value={gridType}
                  onChange={(e) => applyGridPreset({ type: e.target.value as 'Grid' | 'Columns' | 'Rows' })}
                  style={{ height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                >
                  <option>Grid</option>
                  <option>Columns</option>
                  <option>Rows</option>
                </select>
              </label>
              <NumberInput label="Size" value={gridSize} onChange={(value) => applyGridPreset({ size: value })} />
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Color</span>
                <input
                  type="color"
                  value={gridColor}
                  onChange={(e) => {
                    applyGridPreset({ color: e.target.value })
                  }}
                  style={{ width: '100%', height: 30, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}` }}
                />
              </label>
            </div>
          </Section>

          <Section title="Export" open={openSections.export} onToggle={() => toggleSection('export')}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Scale</span>
                <select value={exportScale} onChange={(e) => setExportScale(e.target.value)} style={{ height: 32, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}>
                  <option value="1x">1x</option>
                  <option value="2x">2x</option>
                  <option value="3x">3x</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>Format</span>
                <select
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as 'png' | 'svg' | 'jpg')}
                  style={{ height: 32, borderRadius: 8, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.inputBg, padding: '0 8px' }}
                >
                  <option value="png">PNG</option>
                  <option value="svg">SVG</option>
                  <option value="jpg">JPG</option>
                </select>
              </label>
            </div>
            <button
              onClick={() => void exportLayer()}
              disabled={!hasPageShapes}
              style={{
                marginTop: 10,
                width: '100%',
                height: 36,
                borderRadius: 10,
                border: 'none',
                background: LIGHT_COLORS.activeBlue,
                color: '#fff',
                fontSize: 13,
                fontWeight: 700,
                cursor: hasPageShapes ? 'pointer' : 'not-allowed',
                opacity: hasPageShapes ? 1 : 0.55,
              }}
            >
              Export layer
            </button>
          </Section>

          {styleGuideNotice ? (
            <div style={{ fontSize: 11, color: LIGHT_COLORS.textSubtle, padding: '2px 4px' }}>
              {styleGuideNotice}
            </div>
          ) : null}
        </div>
      ) : null}

      {!uiHidden && showVariablesPanel ? (
        <div
          style={{
            position: 'absolute',
            right: rightPanelVisible ? rightPanelWidth + 14 : 12,
            top: 12,
            width: 280,
            maxHeight: 'min(60vh, 520px)',
            overflow: 'auto',
            background: LIGHT_COLORS.sidebar,
            border: `1px solid ${LIGHT_COLORS.border}`,
            borderRadius: 10,
            boxShadow: '0 10px 24px rgba(0,0,0,0.08)',
            padding: 10,
            pointerEvents: 'auto',
            zIndex: 100,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: LIGHT_COLORS.text }}>Variables Panel</div>
            <button
              onClick={() => setShowVariablesPanel(false)}
              style={{ height: 24, padding: '0 8px', borderRadius: 6, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar, fontSize: 10 }}
            >
              Close
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {variableRows.map((row) => (
              <div key={row.key} style={{ border: `1px solid ${LIGHT_COLORS.border}`, borderRadius: 8, padding: '6px 8px', background: LIGHT_COLORS.inputBg }}>
                <div style={{ fontSize: 10, color: LIGHT_COLORS.textSubtle }}>{row.key}</div>
                <div style={{ marginTop: 2, fontSize: 11, color: LIGHT_COLORS.text, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{row.value}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!uiHidden && showStyleGuidePanel ? (
        <div
          style={{
            position: 'absolute',
            left: leftDockWidth > 0 ? leftDockWidth + 10 : 12,
            top: 12,
            width: 340,
            maxHeight: 'min(60vh, 560px)',
            overflow: 'auto',
            background: LIGHT_COLORS.sidebar,
            border: `1px solid ${LIGHT_COLORS.border}`,
            borderRadius: 10,
            boxShadow: '0 10px 24px rgba(0,0,0,0.08)',
            padding: 10,
            pointerEvents: 'auto',
            zIndex: 100,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: LIGHT_COLORS.text }}>Select a Style Guide to Apply in Chat</div>
            <button
              onClick={() => setShowStyleGuidePanel(false)}
              style={{ height: 24, padding: '0 8px', borderRadius: 6, border: `1px solid ${LIGHT_COLORS.border}`, background: LIGHT_COLORS.sidebar, fontSize: 10 }}
            >
              Close
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {STYLE_GUIDES.map((preset) => (
              <div key={preset.id} style={{ border: `1px solid ${LIGHT_COLORS.border}`, borderRadius: 8, padding: 8, background: LIGHT_COLORS.inputBg }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: LIGHT_COLORS.text }}>{preset.name}</div>
                <div style={{ marginTop: 2, fontSize: 10, color: LIGHT_COLORS.textSubtle }}>{preset.description}</div>
                <button
                  onClick={() => void sendStyleGuideToChat(preset)}
                  style={{
                    marginTop: 6,
                    height: 26,
                    borderRadius: 7,
                    border: `1px solid ${LIGHT_COLORS.border}`,
                    background: LIGHT_COLORS.sidebar,
                    color: LIGHT_COLORS.text,
                    padding: '0 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Copy Guide
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

    </div>
  )
}
