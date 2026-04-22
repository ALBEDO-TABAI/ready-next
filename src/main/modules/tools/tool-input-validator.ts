/**
 * Pure tool-input validator (Phase 2 pilot).
 *
 * Given a toolName + raw args + a registry of Zod schemas, runs safeParse.
 * On failure, produces a ToolExecutionOutput with errorKind='input_validation'
 * so the model sees a structured tool_result it can react to — matching the
 * Phase 1 error contract. On success, returns the parsed (possibly coerced)
 * data that the handler should use as its new args.
 *
 * No electron imports — testable directly.
 */

import type { ZodObject, ZodRawShape } from 'zod'
import {
  createToolExecutionOutput,
  type ToolExecutionOutput,
} from '../agent-control/tool-result-types'

const MAX_REPORTED_ISSUES = 10

export interface ValidationIssueShape {
  path: string[]
  code: string
  message: string
}

export type ToolInputValidationOutcome =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false
      output: ToolExecutionOutput
      issueCount: number
      firstCode: string
      firstPath: string
    }

export function validateToolInput(
  toolName: string,
  args: Record<string, unknown>,
  schemas: Record<string, ZodObject<ZodRawShape>>,
): ToolInputValidationOutcome {
  const schema = schemas[toolName]
  if (!schema) {
    // No registered schema → passthrough. Other domains don't have schemas yet.
    return { ok: true, data: args }
  }

  const parsed = schema.safeParse(args)
  if (parsed.success) {
    return { ok: true, data: parsed.data as Record<string, unknown> }
  }

  const issues: ValidationIssueShape[] = parsed.error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => ({
      path: issue.path.map((segment) => String(segment)),
      code: String(issue.code || 'invalid'),
      message: String(issue.message || ''),
    }))
  const firstIssue = issues[0] || { path: [], code: 'invalid', message: '' }
  const firstPathDisplay = firstIssue.path.length > 0 ? firstIssue.path.join('.') : '(root)'
  const text = `工具 ${toolName} 输入校验失败：${firstPathDisplay} — ${firstIssue.message || '格式不合法'}`
  const output = createToolExecutionOutput(text, {
    shape: 'json',
    data: {
      errorKind: 'input_validation',
      toolName,
      issueCount: parsed.error.issues.length,
      issues,
    },
  })
  return {
    ok: false,
    output,
    issueCount: parsed.error.issues.length,
    firstCode: firstIssue.code,
    firstPath: firstIssue.path.join('.'),
  }
}
