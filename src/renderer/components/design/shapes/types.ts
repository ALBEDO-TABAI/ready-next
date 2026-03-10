import type { TLBaseShape, TLShape } from 'tldraw'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type InputVariant = 'default' | 'filled'
export type ImageAspectRatio = '16:9' | '4:3' | '1:1'
export type SectionColumnCount = 1 | 2 | 3

export interface ButtonShapeProps {
  w: number
  h: number
  label: string
  variant: ButtonVariant
  cornerRadius: number
}

export interface InputShapeProps {
  w: number
  h: number
  label: string
  placeholder: string
  variant: InputVariant
}

export interface CardShapeProps {
  w: number
  h: number
  title: string
  padding: number
  hasShadow: boolean
}

export interface TextBlockShapeProps {
  w: number
  h: number
  content: string
  fontSize: number
  color: string
}

export interface ImagePlaceholderShapeProps {
  w: number
  h: number
  label: string
  aspectRatio: ImageAspectRatio
}

export interface PageHeaderShapeProps {
  w: number
  h: number
  eyebrow: string
  title: string
  meta: string
  actionLabel: string
}

export interface SectionBlockShapeProps {
  w: number
  h: number
  title: string
  description: string
  columns: SectionColumnCount
}

export interface StatCardShapeProps {
  w: number
  h: number
  label: string
  value: string
  delta: string
}

export interface ListItemShapeProps {
  w: number
  h: number
  title: string
  meta: string
  description: string
}

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'ui-button': ButtonShapeProps
    'ui-input': InputShapeProps
    'ui-card': CardShapeProps
    'ui-text-block': TextBlockShapeProps
    'ui-image-placeholder': ImagePlaceholderShapeProps
    'ui-page-header': PageHeaderShapeProps
    'ui-section-block': SectionBlockShapeProps
    'ui-stat-card': StatCardShapeProps
    'ui-list-item': ListItemShapeProps
  }
}

export type ButtonShape = TLBaseShape<'ui-button', ButtonShapeProps>
export type InputShape = TLBaseShape<'ui-input', InputShapeProps>
export type CardShape = TLBaseShape<'ui-card', CardShapeProps>
export type TextBlockShape = TLBaseShape<'ui-text-block', TextBlockShapeProps>
export type ImagePlaceholderShape = TLBaseShape<'ui-image-placeholder', ImagePlaceholderShapeProps>
export type PageHeaderShape = TLBaseShape<'ui-page-header', PageHeaderShapeProps>
export type SectionBlockShape = TLBaseShape<'ui-section-block', SectionBlockShapeProps>
export type StatCardShape = TLBaseShape<'ui-stat-card', StatCardShapeProps>
export type ListItemShape = TLBaseShape<'ui-list-item', ListItemShapeProps>

export type DesignCustomShape =
  | ButtonShape
  | InputShape
  | CardShape
  | TextBlockShape
  | ImagePlaceholderShape
  | PageHeaderShape
  | SectionBlockShape
  | StatCardShape
  | ListItemShape

export type DesignCustomShapeType = DesignCustomShape['type']

export const DESIGN_CUSTOM_SHAPE_TYPES: readonly DesignCustomShapeType[] = [
  'ui-button',
  'ui-input',
  'ui-card',
  'ui-text-block',
  'ui-image-placeholder',
  'ui-page-header',
  'ui-section-block',
  'ui-stat-card',
  'ui-list-item',
] as const

const DESIGN_CUSTOM_SHAPE_SET = new Set<string>(DESIGN_CUSTOM_SHAPE_TYPES)

export function isDesignCustomShape(shape: TLShape | null | undefined): shape is DesignCustomShape {
  return !!shape && DESIGN_CUSTOM_SHAPE_SET.has(shape.type)
}

export const BUTTON_DEFAULT_PROPS: ButtonShapeProps = {
  w: 120,
  h: 40,
  label: 'Button',
  variant: 'primary',
  cornerRadius: 10,
}

export const BUTTON_DEFAULT_PADDING = {
  horizontal: 14,
  vertical: 10,
} as const

export const INPUT_DEFAULT_PROPS: InputShapeProps = {
  w: 240,
  h: 56,
  label: 'Label',
  placeholder: 'Input placeholder',
  variant: 'default',
}

export const INPUT_DEFAULT_PADDING = {
  horizontal: 10,
  vertical: 8,
} as const

export const CARD_DEFAULT_PROPS: CardShapeProps = {
  w: 320,
  h: 200,
  title: 'Card Title',
  padding: 16,
  hasShadow: true,
}

export const TEXT_BLOCK_DEFAULT_PROPS: TextBlockShapeProps = {
  w: 240,
  h: 80,
  content: 'Headline or paragraph text goes here.',
  fontSize: 16,
  color: '#1A1A1A',
}

export const TEXT_BLOCK_DEFAULT_PADDING = {
  horizontal: 6,
  vertical: 6,
} as const

export const IMAGE_PLACEHOLDER_DEFAULT_PROPS: ImagePlaceholderShapeProps = {
  w: 200,
  h: 150,
  label: 'Image',
  aspectRatio: '4:3',
}

export const PAGE_HEADER_DEFAULT_PROPS: PageHeaderShapeProps = {
  w: 720,
  h: 132,
  eyebrow: 'Content System',
  title: 'Design a clear multi-level page header',
  meta: 'Updated 5 min ago · Team workspace',
  actionLabel: 'Primary Action',
}

export const PAGE_HEADER_DEFAULT_PADDING = {
  horizontal: 24,
  vertical: 18,
} as const

export const SECTION_BLOCK_DEFAULT_PROPS: SectionBlockShapeProps = {
  w: 720,
  h: 240,
  title: 'Section Block',
  description: 'Use this section to group related content, supporting decks, forms, or editorial modules.',
  columns: 3,
}

export const SECTION_BLOCK_DEFAULT_PADDING = {
  horizontal: 20,
  vertical: 18,
} as const

export const STAT_CARD_DEFAULT_PROPS: StatCardShapeProps = {
  w: 220,
  h: 140,
  label: 'Monthly Reach',
  value: '128.4K',
  delta: '+12.8%',
}

export const STAT_CARD_DEFAULT_PADDING = {
  horizontal: 18,
  vertical: 16,
} as const

export const LIST_ITEM_DEFAULT_PROPS: ListItemShapeProps = {
  w: 440,
  h: 94,
  title: 'Content Planning Sprint',
  meta: 'Brief · 12 items',
  description: 'Summaries, owner notes, and due dates stay aligned so long-form content blocks remain easy to scan.',
}

export const LIST_ITEM_DEFAULT_PADDING = {
  horizontal: 16,
  vertical: 14,
} as const

export function getDefaultPropsForType(type: DesignCustomShapeType): DesignCustomShape['props'] {
  switch (type) {
    case 'ui-button':
      return { ...BUTTON_DEFAULT_PROPS }
    case 'ui-input':
      return { ...INPUT_DEFAULT_PROPS }
    case 'ui-card':
      return { ...CARD_DEFAULT_PROPS }
    case 'ui-text-block':
      return { ...TEXT_BLOCK_DEFAULT_PROPS }
    case 'ui-image-placeholder':
      return { ...IMAGE_PLACEHOLDER_DEFAULT_PROPS }
    case 'ui-page-header':
      return { ...PAGE_HEADER_DEFAULT_PROPS }
    case 'ui-section-block':
      return { ...SECTION_BLOCK_DEFAULT_PROPS }
    case 'ui-stat-card':
      return { ...STAT_CARD_DEFAULT_PROPS }
    case 'ui-list-item':
      return { ...LIST_ITEM_DEFAULT_PROPS }
    default:
      return { ...TEXT_BLOCK_DEFAULT_PROPS }
  }
}
