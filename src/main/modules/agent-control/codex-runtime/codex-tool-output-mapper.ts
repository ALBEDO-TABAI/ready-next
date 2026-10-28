import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { redactModelVisibleToolText } from '../tools-runtime/model-visible-tool-output'
import { canonicalJson } from './codex-model-gateway-contract'

export type CodexDynamicToolResponseContent =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: 'inputAudio'; audioUrl: string }

export type CodexDynamicToolResponse = Readonly<{
  contentItems: CodexDynamicToolResponseContent[]
  success: boolean
}>

const SENSITIVE_FIELD = /^(?:api[_-]?key|token|id[_-]?token|auth[_-]?token|access[_-]?token|refresh[_-]?token|authorization|cookie|session[_-]?cookie|secret|client[_-]?secret|password|private[_-]?key|credential)$/i
const HOST_PATH_FIELD = /^(?:path|cwd|dir|directory|absolutePath|filePath|sourcePath|targetPath|outputDir|inputDir|workingDirectory)$/i

function normalizeSensitiveValues(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error('tool_sensitive_values_invalid')
  const normalized = [...new Set(values)].sort((left, right) => right.length - left.length)
  if (normalized.some((value) => typeof value !== 'string' || value.length < 4)) {
    throw new Error('tool_sensitive_values_invalid')
  }
  return normalized
}

function redactCodexToolText(text: string, sensitiveValues: readonly string[]): string {
  let redacted = redactModelVisibleToolText(text)
  for (const sensitiveValue of sensitiveValues) {
    redacted = redacted.split(sensitiveValue).join('[REDACTED]')
  }
  return redacted
    .replace(/Bearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED]')
    .replace(/\bfile:(?:(?:\/\/[^/\s"'`<>]*\/)|\/|%2f|[A-Za-z]:)[^\s"'`<>()[\]{}]*/gi, '[REDACTED]')
    .replace(/\b[A-Za-z]:[\\/](?:[^\s"'<>()[\]{},;]+[\\/]?)+/g, '[REDACTED]')
    .replace(/\\\\[^\s\\/]+[\\/][^\s"'<>()[\]{},;]+/g, '[REDACTED]')
    .replace(/(^|[^A-Za-z0-9_/:])\/(?!\/|\s)[^\s"'`<>()[\]{},;]+/gm, '$1[REDACTED]')
}

function redactCodexToolValue(
  value: unknown,
  sensitiveValues: readonly string[],
  key: string | null = null,
): unknown {
  if (key && SENSITIVE_FIELD.test(key)) return '[REDACTED]'
  if (key && HOST_PATH_FIELD.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactCodexToolText(value, sensitiveValues)
  if (Array.isArray(value)) return value.map((item) => redactCodexToolValue(item, sensitiveValues))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(
    ([childKey, child]) => [childKey, redactCodexToolValue(child, sensitiveValues, childKey)],
  ))
}

function dataUrl(data: string, mediaType: string): string {
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(mediaType)) {
    throw new Error('tool_media_type_invalid')
  }
  const prefix = `data:${mediaType};base64,`
  const encoded = data.startsWith('data:') ? data.slice(prefix.length) : data
  if (data.startsWith('data:') && !data.startsWith(prefix)) throw new Error('tool_media_data_url_invalid')
  const compact = encoded.replace(/=+$/, '')
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    || Buffer.from(encoded, 'base64').toString('base64').replace(/=+$/, '') !== compact) {
    throw new Error('tool_media_base64_invalid')
  }
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`
}

function outputSuccess(output: ToolExecutionOutput): boolean {
  if (output.data && (output.data.ok === false
    || (typeof output.data.errorKind === 'string' && output.data.errorKind.trim().length > 0))) {
    return false
  }
  if (output.envelope) return output.envelope.ok === true
  return true
}

function safeOutputSuccess(output: ToolExecutionOutput): boolean {
  try {
    return outputSuccess(output)
  } catch {
    // silent-catch: an output whose success fields cannot be read is reported as unsuccessful
    return false
  }
}

function mapReadyToolOutputUnsafe(
  output: ToolExecutionOutput,
  sensitiveValues: readonly string[] = [],
): CodexDynamicToolResponse {
  const normalizedSensitiveValues = normalizeSensitiveValues(sensitiveValues)
  if (output.interactionHint) throw new Error('tool_interaction_result_unresolved')
  const contentItems: CodexDynamicToolResponseContent[] = []
  for (const part of output.content || []) {
    if (part.type === 'text') {
      contentItems.push({ type: 'inputText', text: redactCodexToolText(part.text, normalizedSensitiveValues) })
    } else if (part.type === 'image') {
      contentItems.push({ type: 'inputImage', imageUrl: dataUrl(part.data, part.mediaType) })
    } else if (part.type === 'audio') {
      contentItems.push({ type: 'inputAudio', audioUrl: dataUrl(part.data, part.mediaType) })
    } else {
      throw new Error('tool_artifact_result_requires_resource_bridge')
    }
  }
  if (output.data || output.envelope || output.projectionPatch) {
    contentItems.push({
      type: 'inputText',
      text: canonicalJson({
        ...(output.envelope
          ? { envelope: redactCodexToolValue(output.envelope, normalizedSensitiveValues) }
          : {}),
        ...(output.data ? { data: redactCodexToolValue(output.data, normalizedSensitiveValues) } : {}),
        ...(output.projectionPatch
          ? { projectionPatch: redactCodexToolValue(output.projectionPatch, normalizedSensitiveValues) }
          : {}),
        ...(output.text ? { text: redactCodexToolText(output.text, normalizedSensitiveValues) } : {}),
      }),
    })
  } else if (output.text && !contentItems.some((item) => item.type === 'inputText')) {
    contentItems.push({ type: 'inputText', text: redactCodexToolText(output.text, normalizedSensitiveValues) })
  }
  if (contentItems.length === 0) contentItems.push({ type: 'inputText', text: '' })
  return { contentItems, success: outputSuccess(output) }
}

export function mapReadyToolOutput(
  output: ToolExecutionOutput,
  sensitiveValues: readonly string[] = [],
): CodexDynamicToolResponse {
  try {
    return mapReadyToolOutputUnsafe(output, sensitiveValues)
  } catch {
    // silent-catch: an unmappable tool payload is replaced by a payload-omitted notice for the model; success is still derived from the output
    return {
      contentItems: [{
        type: 'inputText',
        text: canonicalJson({
          noticeKind: 'tool_result_payload_omitted',
          message: 'The tool finished, but part of its result is unavailable through this runtime.',
        }),
      }],
      success: safeOutputSuccess(output),
    }
  }
}
