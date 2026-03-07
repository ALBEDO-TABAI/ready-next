import type { TLBaseShape, TLShape } from 'tldraw'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost'
export type InputVariant = 'default' | 'filled'
export type ImageAspectRatio = '16:9' | '4:3' | '1:1'

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

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    'ui-button': ButtonShapeProps
    'ui-input': InputShapeProps
    'ui-card': CardShapeProps
    'ui-text-block': TextBlockShapeProps
    'ui-image-placeholder': ImagePlaceholderShapeProps
  }
}

export type ButtonShape = TLBaseShape<'ui-button', ButtonShapeProps>
export type InputShape = TLBaseShape<'ui-input', InputShapeProps>
export type CardShape = TLBaseShape<'ui-card', CardShapeProps>
export type TextBlockShape = TLBaseShape<'ui-text-block', TextBlockShapeProps>
export type ImagePlaceholderShape = TLBaseShape<'ui-image-placeholder', ImagePlaceholderShapeProps>

export type DesignCustomShape =
  | ButtonShape
  | InputShape
  | CardShape
  | TextBlockShape
  | ImagePlaceholderShape

export type DesignCustomShapeType = DesignCustomShape['type']

export const DESIGN_CUSTOM_SHAPE_TYPES: readonly DesignCustomShapeType[] = [
  'ui-button',
  'ui-input',
  'ui-card',
  'ui-text-block',
  'ui-image-placeholder',
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

export const INPUT_DEFAULT_PROPS: InputShapeProps = {
  w: 240,
  h: 56,
  label: 'Label',
  placeholder: 'Input placeholder',
  variant: 'default',
}

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

export const IMAGE_PLACEHOLDER_DEFAULT_PROPS: ImagePlaceholderShapeProps = {
  w: 200,
  h: 150,
  label: 'Image',
  aspectRatio: '4:3',
}

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
    default:
      return { ...TEXT_BLOCK_DEFAULT_PROPS }
  }
}
