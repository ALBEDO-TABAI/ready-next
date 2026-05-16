/**
 * P1.7 — Preset 类型与扫描结果。
 *
 * Preset 字段语义沿用 Obsidian Web Clipper 原协议（properties / noteContentFormat
 * / noteNameFormat / path / triggers），新增的运行期标记：
 *
 * - `requiresInterpreter`：preset 在 noteContentFormat / properties[].value /
 *   noteNameFormat / path 中含 `{{prompt:"..."}}` 或 `{{"..."}}` 占位 ⇒ 必须
 *   通过 LLM interpreter 解析。Phase 1 没有 interpreter，所以遇到该 preset：
 *     - auto 选择 ⇒ 跳过
 *     - 显式选择 ⇒ 抛 `clip_preset_render_failed { reason: 'requires_interpreter' }`
 *     - 显式选择 + `force_render_with_placeholders=true` ⇒ 渲染时把占位写成
 *       `[placeholder: "<原始指令>"]` 字面块，前置 `frontmatter.warning =
 *       'rendered with placeholders'`。
 */

export type PresetPropertyType = 'text' | 'multitext' | 'date' | 'number' | 'checkbox'

export interface PresetProperty {
  name: string
  value: string
  type: PresetPropertyType
}

export interface ClipPreset {
  schemaVersion?: string
  name: string
  behavior?: string
  noteContentFormat: string
  noteNameFormat: string
  path: string
  properties: PresetProperty[]
  triggers: string[]
  /** Computed at load time; see header. */
  requiresInterpreter: boolean
  /** Original file basename without extension; used as stable id. */
  fileId: string
}

export interface PresetSelectionResult {
  preset: ClipPreset
  source: 'explicit_file' | 'explicit_name' | 'auto_trigger' | 'default'
}
