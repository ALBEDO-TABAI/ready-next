import { ButtonShapeUtil } from './ButtonShape'
import { InputShapeUtil } from './InputShape'
import { CardShapeUtil } from './CardShape'
import { TextBlockShapeUtil } from './TextBlockShape'
import { ImagePlaceholderShapeUtil } from './ImagePlaceholderShape'

import { ButtonShapeTool } from '../tools/ButtonShapeTool'
import { InputShapeTool } from '../tools/InputShapeTool'
import { CardShapeTool } from '../tools/CardShapeTool'
import { TextBlockShapeTool } from '../tools/TextBlockShapeTool'
import { ImagePlaceholderShapeTool } from '../tools/ImagePlaceholderShapeTool'

import {
  DESIGN_CUSTOM_SHAPE_TYPES,
  getDefaultPropsForType,
  type DesignCustomShapeType,
} from './types'

export {
  DESIGN_CUSTOM_SHAPE_TYPES,
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
} from './types'

export { isDesignCustomShape } from './types'

export const allShapeUtils = [
  ButtonShapeUtil,
  InputShapeUtil,
  CardShapeUtil,
  TextBlockShapeUtil,
  ImagePlaceholderShapeUtil,
] as const

export const allTools = [
  ButtonShapeTool,
  InputShapeTool,
  CardShapeTool,
  TextBlockShapeTool,
  ImagePlaceholderShapeTool,
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
