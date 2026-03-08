// Shared types for Image Mode creative components

export interface CanvasObject {
  id: string
  type: 'rect' | 'text' | 'image' | 'ellipse' | 'group' | 'path'
  name: string
  x: number
  y: number
  width: number
  height: number
  rotation?: number
  fill?: string
  fillOpacity?: number
  fillEnabled?: boolean
  stroke?: string
  strokeWidth?: number
  strokeEnabled?: boolean
  text?: string
  fontSize?: number
  fontWeight?: string
  fontFamily?: string
  textAlign?: 'left' | 'center' | 'right'
  imageSrc?: string
  cornerRadius?: number
  pathPoints?: { x: number; y: number }[]
  visible: boolean
  locked: boolean
  zIndex: number
  // Group nesting
  parentId?: string
  children?: string[]
  expanded?: boolean
  // Auto Layout
  layoutDirection?: 'horizontal' | 'vertical'
  layoutGap?: number
  layoutPaddingH?: number
  layoutPaddingV?: number
  layoutAlign?: 'start' | 'center' | 'end' | 'stretch'
  // Effects
  shadowEnabled?: boolean
  shadowColor?: string
  shadowOffsetX?: number
  shadowOffsetY?: number
  shadowBlur?: number
}

export type ActiveTool = 'select' | 'pan' | 'frame' | 'shape' | 'text' | 'pen'

export type ShapeType = 'rect' | 'ellipse'

export interface CanvasSize {
  width: number
  height: number
  label: string
}

export const CANVAS_PRESETS: CanvasSize[] = [
  { width: 800, height: 600, label: '默认 (800×600)' },
  { width: 1080, height: 1080, label: 'Instagram 帖子 (1080×1080)' },
  { width: 1080, height: 1920, label: 'Instagram 故事 (1080×1920)' },
  { width: 1280, height: 720, label: 'YouTube 缩略图 (1280×720)' },
  { width: 1920, height: 1080, label: '全高清 (1920×1080)' },
]

export interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  layerId: string | null
}
