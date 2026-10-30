/** Persistent names only. Theme consumers own actual foreground/background color values. */
export const DOCUMENT_PALETTE = {
  default: '默认', gray: '灰色', brown: '棕色', orange: '橙色', yellow: '黄色',
  green: '绿色', blue: '蓝色', purple: '紫色', pink: '粉色', red: '红色',
} as const
export type DocumentColor = keyof typeof DOCUMENT_PALETTE
export function isDocumentColor(value: string): value is DocumentColor {
  return Object.prototype.hasOwnProperty.call(DOCUMENT_PALETTE, value)
}
