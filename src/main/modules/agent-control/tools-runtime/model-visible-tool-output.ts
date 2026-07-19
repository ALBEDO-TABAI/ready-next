import { redactHostPaths } from '../../tools/skill-primitives/host-path-redactor'
import {
  normalizeToolExecutionOutput,
  type ToolExecutionOutput,
  type ToolExecutionResultLike,
} from './tool-result-types'

function redactModelVisibleValue(value: unknown): unknown {
  if (typeof value === 'string') return redactHostPaths(value)
  if (Array.isArray(value)) return value.map((item) => redactModelVisibleValue(item))
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactModelVisibleValue(item)
  }
  return out
}

export function redactModelVisibleToolText(text: string): string {
  return redactHostPaths(text)
}

function textDuplicatesData(text: string, data: unknown): boolean {
  if (!text || !data || typeof data !== 'object') return false
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(data)
  } catch {
    // silent-catch: non-JSON text cannot duplicate structured data, so keep both representations.
    return false
  }
}

export function buildModelVisibleToolResultPayload(output: ToolExecutionOutput): Record<string, unknown> {
  const normalized = normalizeToolExecutionOutput(output)
  const text = redactModelVisibleToolText(normalized.text)
  const data = redactModelVisibleValue(normalized.data)
  return {
    ...(!textDuplicatesData(text, data) && text ? { text } : {}),
    ...(data ? { data } : {}),
    ...(normalized.projectionPatch
      ? { projectionPatch: redactModelVisibleValue(normalized.projectionPatch) }
      : {}),
    ...(normalized.framePatch
      ? { framePatch: redactModelVisibleValue(normalized.framePatch) }
      : {}),
    ...(normalized.interactionHint ? { interactionHint: normalized.interactionHint } : {}),
    ...(normalized.content?.length
      ? {
          content: normalized.content.map((part) => part.type === 'image'
            ? { type: 'image', mediaType: part.mediaType, detail: part.detail || 'auto' }
            : redactModelVisibleValue(part)),
        }
      : {}),
  }
}

export function serializeToolExecutionOutputForModel(output: ToolExecutionResultLike): string {
  const normalized = normalizeToolExecutionOutput(output)
  const redactedText = redactModelVisibleToolText(normalized.text)
  if (redactedText) {
    return redactedText
  }
  if (normalized.projectionPatch) {
    return JSON.stringify(redactModelVisibleValue(normalized.projectionPatch))
  }
  if (normalized.shape === 'json' && normalized.data && !normalized.text) {
    return JSON.stringify(redactModelVisibleValue(normalized.data))
  }
  return redactedText
}
