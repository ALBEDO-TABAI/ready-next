import {
  createToolExecutionOutput,
  type ToolExecutionContextModifier,
  type ToolExecutionOutput,
} from '../agent-control/tools-runtime/tool-result-types'
import { BROWSER_TOOL_ERROR_KINDS } from '../agent-control/contracts/error-kinds'

const ERROR_KIND_TOKEN = /^[a-z][a-z0-9_:-]{0,80}$/

function canonicalErrorKind(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  return ERROR_KIND_TOKEN.test(raw) ? raw : null
}

function normalizeBrowserFailureData(data: Record<string, unknown>): Record<string, unknown> {
  const structured = { ...data }
  if (structured.ok !== false) return structured

  structured.errorKind =
    canonicalErrorKind(structured.errorKind)
    || canonicalErrorKind(structured.errorCode)
    || canonicalErrorKind(structured.failureKind)
    || canonicalErrorKind(structured.reason)
    || BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code
  return structured
}

export function createBrowserStructuredOutput(
  data: Record<string, unknown>,
  options?: {
    projectionPatch?: Record<string, unknown> | null
    contextModifier?: ToolExecutionContextModifier | null
  },
): ToolExecutionOutput {
  const structured = normalizeBrowserFailureData(data)
  return createToolExecutionOutput(JSON.stringify(structured, null, 2), {
    shape: 'json',
    data: structured,
    projectionPatch: options?.projectionPatch ?? null,
    contextModifier: options?.contextModifier ?? null,
  })
}

export function createBrowserFailureOutput(data: Record<string, unknown>): ToolExecutionOutput {
  return createBrowserStructuredOutput({ ok: false, ...data })
}

export function createBrowserStructuredJsonText(text: string): ToolExecutionOutput {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === 'object') {
      return createBrowserStructuredOutput(parsed as Record<string, unknown>)
    }
  } catch {
    // silent-catch: Fall through to a structured wrapper around the original text.
  }
  return createBrowserFailureOutput({
    errorKind: BROWSER_TOOL_ERROR_KINDS.browserToolFailed.code,
    message: text,
  })
}

export function stringifyBrowserJsonOrFailure(data: Record<string, unknown>): string | ToolExecutionOutput {
  if (data.ok === false) return createBrowserStructuredOutput(data)
  return JSON.stringify(data, null, 2)
}
