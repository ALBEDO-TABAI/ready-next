/**
 * P1.7 — Preset 加载、扫描、自动选择。
 *
 * 输入：embedded skill 的 preset 目录（`<assetsRoot>/embedded-skills/
 * obsidian-web-clip/assets/presets/`），或调用方提供的 explicit preset 文件。
 *
 * 关键约束：
 * - 任何 preset 含 `{{prompt:"..."}}` 或 `{{"..."}}` 占位被标记
 *   `requiresInterpreter = true`。
 * - auto 选择跳过 `requiresInterpreter` preset；显式选 + 默认 `force = false`
 *   时返 `requires_interpreter` 错误（让 caller 抛 ToolDomainError）。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import type { ClipPreset, PresetProperty } from './preset-types'

// `\\?"` so we match both plain `{{"..."}}` and the backslash-escaped form
// `{{\"...\"}}` that some bundled presets use (chatgpt/youtube/gemini).
const PROMPT_PLACEHOLDER_RE = /\{\{\s*(prompt:)?\s*\\?"[\s\S]*?\\?"\s*(\|[^}]*)?\s*\}\}/

export class PresetLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'PresetLoadError'
  }
}

export class PresetSelectionError extends Error {
  constructor(
    public readonly reason:
      | 'preset_not_found'
      | 'requires_interpreter'
      | 'no_default_preset',
    public readonly presetId: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'PresetSelectionError'
  }
}

export function loadAllPresets(presetDir: string): ClipPreset[] {
  if (!existsSync(presetDir)) return []
  const entries = readdirSync(presetDir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .sort()
  const presets: ClipPreset[] = []
  for (const file of entries) {
    const filePath = join(presetDir, file)
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) continue
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const fileId = basename(file, extname(file))
      presets.push(normalizePreset(parsed, fileId))
    } catch (err) {
      // Skip malformed presets but surface a structured error string the
      // caller can include in diagnostics.
      throw new PresetLoadError(`Failed to load preset ${file}: ${(err as Error).message}`, err)
    }
  }
  return presets
}

export function loadPresetFile(filePath: string): ClipPreset {
  const resolved = resolve(filePath)
  const raw = readFileSync(resolved, 'utf8')
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const fileId = basename(resolved, extname(resolved))
  return normalizePreset(parsed, fileId)
}

export function selectPreset(
  presets: ClipPreset[],
  options: {
    explicitName?: string | null
    pageUrl: string
    allowInterpreterRequired: boolean
  },
): ClipPreset {
  const { explicitName, pageUrl, allowInterpreterRequired } = options

  if (explicitName && explicitName !== 'auto') {
    const match = presets.find((p) => p.fileId.toLowerCase() === explicitName.toLowerCase())
    if (!match) {
      throw new PresetSelectionError(
        'preset_not_found',
        explicitName,
        `Preset not found: ${explicitName}`,
      )
    }
    if (match.requiresInterpreter && !allowInterpreterRequired) {
      throw new PresetSelectionError(
        'requires_interpreter',
        match.fileId,
        `Preset ${match.fileId} contains LLM placeholders ({{"..."}} / {{prompt:"..."}}). Phase 1 has no LLM interpreter; pass force_render_with_placeholders=true to render placeholders literally, or wait for Phase 2.`,
      )
    }
    return match
  }

  // Auto trigger: when a preset's trigger matches the page URL, that's
  // the user's expressed preference. If that preset requires an
  // interpreter we have NOT shipped (Phase 1), silently dropping back to
  // article-clipper is degrading — the user expected (e.g.) the YouTube
  // preset and would get a generic article. Surface this as a structured
  // refusal; the caller surfaces "use force_render_with_placeholders=true
  // or wait for Phase 2 or pass an explicit preset" guidance.
  //
  // `allowInterpreterRequired=true` (force_render_with_placeholders) keeps
  // the trigger match because the user opted in to literal placeholders.
  const triggerHit = presets.find((p) =>
    p.triggers.some((t) => typeof t === 'string' && t && pageUrl.startsWith(t)),
  )
  if (triggerHit) {
    if (triggerHit.requiresInterpreter && !allowInterpreterRequired) {
      throw new PresetSelectionError(
        'requires_interpreter',
        triggerHit.fileId,
        `Auto-selected preset ${triggerHit.fileId} matches URL ${pageUrl} but contains LLM placeholders. Phase 1 has no LLM interpreter; pass force_render_with_placeholders=true to render literally, choose a different preset explicitly, or wait for Phase 2.`,
      )
    }
    return triggerHit
  }

  const defaultPreset = presets.find((p) => p.fileId === 'article-clipper' && !p.requiresInterpreter)
  if (!defaultPreset) {
    throw new PresetSelectionError(
      'no_default_preset',
      null,
      'Default preset article-clipper.json not found or marked requires_interpreter.',
    )
  }
  return defaultPreset
}

function normalizePreset(raw: Record<string, unknown>, fileId: string): ClipPreset {
  const rawProperties = Array.isArray(raw.properties) ? (raw.properties as Record<string, unknown>[]) : []
  const properties: PresetProperty[] = rawProperties.map((p) => ({
    name: String(p.name || ''),
    value: String(p.value || ''),
    type: normalizePropertyType(String(p.type || 'text')),
  }))
  const triggers = Array.isArray(raw.triggers) ? (raw.triggers as unknown[]).filter((t) => typeof t === 'string') as string[] : []
  const preset: ClipPreset = {
    schemaVersion: typeof raw.schemaVersion === 'string' ? (raw.schemaVersion as string) : undefined,
    name: String(raw.name || fileId),
    behavior: typeof raw.behavior === 'string' ? (raw.behavior as string) : undefined,
    noteContentFormat: typeof raw.noteContentFormat === 'string' ? (raw.noteContentFormat as string) : '{{content}}',
    noteNameFormat: typeof raw.noteNameFormat === 'string' ? (raw.noteNameFormat as string) : '{{title}}',
    path: typeof raw.path === 'string' ? (raw.path as string) : '',
    properties,
    triggers,
    requiresInterpreter: false,
    fileId,
  }
  preset.requiresInterpreter = detectInterpreterRequired(preset)
  return preset
}

function normalizePropertyType(raw: string): PresetProperty['type'] {
  const normalized = raw.toLowerCase()
  if (normalized === 'multitext' || normalized === 'date' || normalized === 'number' || normalized === 'checkbox') {
    return normalized
  }
  return 'text'
}

export function detectInterpreterRequired(preset: ClipPreset): boolean {
  if (hasPromptPlaceholder(preset.noteContentFormat)) return true
  if (hasPromptPlaceholder(preset.noteNameFormat)) return true
  if (hasPromptPlaceholder(preset.path)) return true
  for (const property of preset.properties) {
    if (hasPromptPlaceholder(property.value)) return true
  }
  return false
}

export function hasPromptPlaceholder(text: string): boolean {
  if (!text) return false
  return PROMPT_PLACEHOLDER_RE.test(text)
}
