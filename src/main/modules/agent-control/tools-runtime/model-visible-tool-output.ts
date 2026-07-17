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

export function buildModelVisibleToolResultPayload(output: ToolExecutionOutput): Record<string, unknown> {
  const normalized = normalizeToolExecutionOutput(output)
  return {
    text: redactModelVisibleToolText(normalized.text),
    shape: normalized.shape,
    data: redactModelVisibleValue(normalized.data),
    projectionPatch: redactModelVisibleValue(normalized.projectionPatch),
    framePatch: redactModelVisibleValue(normalized.framePatch),
    interactionHint: normalized.interactionHint,
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
