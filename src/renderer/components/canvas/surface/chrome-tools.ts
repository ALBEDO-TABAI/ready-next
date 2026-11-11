import { Columns3, Hand, LayoutGrid, MousePointer2, MoveUpRight, PenLine, Shuffle, Spline, Square, type LucideIcon } from 'lucide-react'
import type { Tool } from './types'

// The board's tools and arrangements: one table for the dock, the menus and the keyboard (W4 MS1).

export const DOCK_TOOLS: Array<{ id: Tool; label: string; key: string; icon: LucideIcon }> = [
  { id: 'select', label: '选择', key: 'V', icon: MousePointer2 },
  { id: 'pan', label: '平移', key: 'H', icon: Hand },
]
export const SHAPE_TOOLS: Array<{ id: Tool; label: string; key: string; icon: LucideIcon }> = [
  { id: 'rect', label: '矩形', key: 'B', icon: Square },
  { id: 'arrow', label: '箭头', key: 'A', icon: MoveUpRight },
  { id: 'edge', label: '连线', key: 'C', icon: Spline },
]
export const DRAW_TOOL = { id: 'path' as Tool, label: '手绘', key: 'D', icon: PenLine }
export const ARRANGEMENTS = [
  { id: 'P' as const, label: '画廊排版', key: 'P', icon: LayoutGrid },
  { id: 'L' as const, label: '瀑布排版', key: 'L', icon: Columns3 },
  { id: 'R' as const, label: '散开排版', key: 'R', icon: Shuffle },
]
