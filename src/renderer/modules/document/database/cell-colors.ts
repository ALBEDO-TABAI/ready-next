import type { DatabaseField } from '../../../../shared/document-database'

const PALETTE = ['gray', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'brown', 'red'] as const
export type Color = typeof PALETTE[number]

/** A stable color per option: its place in the field's options (so 未开始 / 进行中 / 完成 read gray, blue, green). */
export function optionColor(field: DatabaseField, value: string): Color {
  const index = field.options?.indexOf(value) ?? -1
  if (index >= 0) return PALETTE[index % PALETTE.length]
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

/** A select reads as a status when the definition says so, or when the field is called 状态 / Status. */
export const isStatusField = (field: DatabaseField): boolean =>
  (field as { display?: unknown }).display === 'status' || /^(状态|status)$/i.test(field.name.trim())
