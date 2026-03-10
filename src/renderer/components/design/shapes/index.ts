import { ButtonShapeUtil } from './ButtonShape'
import { InputShapeUtil } from './InputShape'
import { CardShapeUtil } from './CardShape'
import { TextBlockShapeUtil } from './TextBlockShape'
import { ImagePlaceholderShapeUtil } from './ImagePlaceholderShape'
import { PageHeaderShapeUtil } from './PageHeaderShape'
import { SectionBlockShapeUtil } from './SectionBlockShape'
import { StatCardShapeUtil } from './StatCardShape'
import { ListItemShapeUtil } from './ListItemShape'

import { ButtonShapeTool } from '../tools/ButtonShapeTool'
import { InputShapeTool } from '../tools/InputShapeTool'
import { CardShapeTool } from '../tools/CardShapeTool'
import { TextBlockShapeTool } from '../tools/TextBlockShapeTool'
import { ImagePlaceholderShapeTool } from '../tools/ImagePlaceholderShapeTool'
import { PageHeaderShapeTool } from '../tools/PageHeaderShapeTool'
import { SectionBlockShapeTool } from '../tools/SectionBlockShapeTool'
import { StatCardShapeTool } from '../tools/StatCardShapeTool'
import { ListItemShapeTool } from '../tools/ListItemShapeTool'

import {
  BUTTON_DEFAULT_PADDING,
  DESIGN_CUSTOM_SHAPE_TYPES,
  INPUT_DEFAULT_PADDING,
  LIST_ITEM_DEFAULT_PADDING,
  PAGE_HEADER_DEFAULT_PADDING,
  SECTION_BLOCK_DEFAULT_PADDING,
  STAT_CARD_DEFAULT_PADDING,
  TEXT_BLOCK_DEFAULT_PADDING,
  getDefaultPropsForType,
  type DesignCustomShapeType,
} from './types'

export {
  BUTTON_DEFAULT_PADDING,
  DESIGN_CUSTOM_SHAPE_TYPES,
  INPUT_DEFAULT_PADDING,
  LIST_ITEM_DEFAULT_PADDING,
  PAGE_HEADER_DEFAULT_PADDING,
  SECTION_BLOCK_DEFAULT_PADDING,
  STAT_CARD_DEFAULT_PADDING,
  TEXT_BLOCK_DEFAULT_PADDING,
  getDefaultPropsForType,
}

export type {
  DesignCustomShape,
  DesignCustomShapeType,
  ButtonShape,
  InputShape,
  CardShape,
  TextBlockShape,
  ImagePlaceholderShape,
  PageHeaderShape,
  SectionBlockShape,
  StatCardShape,
  ListItemShape,
} from './types'

export { isDesignCustomShape } from './types'

export const allShapeUtils = [
  ButtonShapeUtil,
  InputShapeUtil,
  CardShapeUtil,
  TextBlockShapeUtil,
  ImagePlaceholderShapeUtil,
  PageHeaderShapeUtil,
  SectionBlockShapeUtil,
  StatCardShapeUtil,
  ListItemShapeUtil,
] as const

export const allTools = [
  ButtonShapeTool,
  InputShapeTool,
  CardShapeTool,
  TextBlockShapeTool,
  ImagePlaceholderShapeTool,
  PageHeaderShapeTool,
  SectionBlockShapeTool,
  StatCardShapeTool,
  ListItemShapeTool,
] as const

export interface DesignComponentDescriptor {
  type: DesignCustomShapeType
  toolId: string
  label: string
  description: string
}

const componentDescriptions: Record<DesignCustomShapeType, Pick<DesignComponentDescriptor, 'label' | 'description'>> = {
  'ui-button': { label: '按钮', description: '120×40 · 多变体' },
  'ui-input': { label: '输入框', description: '240×56 · 标签 + 占位' },
  'ui-card': { label: '卡片', description: '320×200 · 容器' },
  'ui-text-block': { label: '文本块', description: '240×80 · 可调字号' },
  'ui-image-placeholder': { label: '图片占位', description: '200×150 · 比例' },
  'ui-page-header': { label: '页面头部', description: '720×132 · 标题层级 + 操作' },
  'ui-section-block': { label: '内容分区', description: '720×240 · 多列版块' },
  'ui-stat-card': { label: '数据卡片', description: '220×140 · 指标展示' },
  'ui-list-item': { label: '列表项', description: '440×94 · 条目信息层级' },
}

export const designComponentCatalog: DesignComponentDescriptor[] = DESIGN_CUSTOM_SHAPE_TYPES.map((type) => ({
  type,
  toolId: type,
  label: componentDescriptions[type].label,
  description: componentDescriptions[type].description,
}))

export function getComponentDefaults(type: DesignCustomShapeType) {
  return getDefaultPropsForType(type)
}
