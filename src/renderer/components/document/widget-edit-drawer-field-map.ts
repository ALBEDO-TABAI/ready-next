import type { WidgetSkeletonId, WidgetRampId } from '../../../shared/document-widget-skeletons'

export type FieldDescriptor =
  | { kind: 'text'; path: string; label: string; placeholder?: string }
  | { kind: 'textarea'; path: string; label: string; placeholder?: string; rows?: number }
  | { kind: 'ramp'; path: string; label: string }
  | { kind: 'metrics-list'; path: string; label: string }
  | { kind: 'events-list'; path: string; label: string }
  | { kind: 'grid-items-list'; path: string; label: string }
  | { kind: 'tags-list'; path: string; label: string }
  | { kind: 'hero-image'; path: string; label: string }
  | { kind: 'enum'; path: string; label: string; options: readonly { value: string; label: string }[] }

export interface WidgetSkeletonFieldMap {
  skeletonId: WidgetSkeletonId
  displayName: string
  fields: FieldDescriptor[]
}

export const DEFAULT_RAMP: WidgetRampId = 'indigo'

export const WIDGET_EDIT_DRAWER_FIELD_MAP: Record<WidgetSkeletonId, WidgetSkeletonFieldMap> = {
  single_focus: {
    skeletonId: 'single_focus',
    displayName: '单焦长卡',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'textarea', path: 'body', label: '正文', rows: 6 },
      { kind: 'text', path: 'kicker', label: '上标（可选）' },
      { kind: 'text', path: 'footer', label: '脚注（可选）' },
      { kind: 'ramp', path: 'ramp', label: '强调色' },
    ],
  },
  dual_compare: {
    skeletonId: 'dual_compare',
    displayName: '双栏对比',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'text', path: 'left.title', label: '左栏标题' },
      { kind: 'textarea', path: 'left.body', label: '左栏正文', rows: 4 },
      { kind: 'text', path: 'right.title', label: '右栏标题' },
      { kind: 'textarea', path: 'right.body', label: '右栏正文', rows: 4 },
      { kind: 'ramp', path: 'ramp', label: '强调色' },
    ],
  },
  metric_grid: {
    skeletonId: 'metric_grid',
    displayName: '多栏数据板',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'text', path: 'subtitle', label: '副标题（可选）' },
      { kind: 'metrics-list', path: 'metrics', label: 'KPI 列表' },
      { kind: 'ramp', path: 'ramp', label: '强调色' },
    ],
  },
  vertical_timeline: {
    skeletonId: 'vertical_timeline',
    displayName: '垂直时间线',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'text', path: 'subtitle', label: '副标题（可选）' },
      { kind: 'events-list', path: 'events', label: '事件序列' },
      { kind: 'ramp', path: 'ramp', label: '强调色' },
    ],
  },
  photo_note: {
    skeletonId: 'photo_note',
    displayName: '图文笔记',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'textarea', path: 'body', label: '正文（可选）', rows: 4 },
      { kind: 'hero-image', path: 'hero', label: '主视觉' },
      { kind: 'tags-list', path: 'tags', label: '标签' },
      { kind: 'text', path: 'footer', label: '脚注（可选）' },
      { kind: 'ramp', path: 'ramp', label: '强调色' },
    ],
  },
  chart_focus: {
    skeletonId: 'chart_focus',
    displayName: '单图表聚焦',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'text', path: 'subtitle', label: '副标题（可选）' },
      { kind: 'textarea', path: 'insight', label: '洞察句', rows: 2 },
      { kind: 'text', path: 'source_note', label: '数据来源（可选）' },
      { kind: 'ramp', path: 'ramp', label: '强调色' },
    ],
  },
  grid_collection: {
    skeletonId: 'grid_collection',
    displayName: '网格拼贴',
    fields: [
      { kind: 'text', path: 'title', label: '标题' },
      { kind: 'enum', path: 'cols', label: '列数', options: [
        { value: '2', label: '2 列' },
        { value: '3', label: '3 列' },
        { value: '4', label: '4 列' },
      ]},
      { kind: 'enum', path: 'item_shape', label: '格子形状', options: [
        { value: 'square', label: '方格' },
        { value: 'portrait', label: '竖向' },
        { value: 'free', label: '自适应' },
      ]},
      { kind: 'grid-items-list', path: 'items', label: '网格项' },
    ],
  },
  freeform_static: {
    skeletonId: 'freeform_static',
    displayName: '自由构图（静态）',
    fields: [
      { kind: 'textarea', path: 'widget_code', label: 'HTML / SVG 源码', rows: 16, placeholder: '仅支持白名单沙箱内的静态 HTML/SVG' },
    ],
  },
  freeform_interactive: {
    skeletonId: 'freeform_interactive',
    displayName: '自由构图（交互）',
    fields: [
      { kind: 'textarea', path: 'widget_code', label: 'HTML / SVG / JS 源码', rows: 18, placeholder: '可含沙箱内交互脚本；导出为静帧快照，Live 视频导出在规划中' },
    ],
  },
}

export function getFieldMap(skeletonId: string): WidgetSkeletonFieldMap | null {
  return (WIDGET_EDIT_DRAWER_FIELD_MAP as Record<string, WidgetSkeletonFieldMap>)[skeletonId] ?? null
}
