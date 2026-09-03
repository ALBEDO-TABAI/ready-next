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
} from '../agent-control/tools-runtime/tool-result-types'

const MAX_REPORTED_ISSUES = 10
const SKILL_ARTIFACT_RELATIVE_PATH_TOOLS = new Set([
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
])

// R-WRITE — source keys the model commonly emits instead of `relativePath`.
// The alias only ever fills `relativePath` (its sole target); `content` has no
// synonym and is deliberately never aliased. `path/file/filePath` are unambiguous
// in-root source synonyms for ALL three artifact tools. `output_path/outputPath`
// read as the DESTINATION for skill_export_artifact (its `targetPath`), so they
// alias to relativePath ONLY for skill_write_artifact — otherwise an export's
// destination would be absorbed as its in-root source, degrading the rejection
// message (review finding). This never misroutes (targetPath is never aliased).
const SKILL_ARTIFACT_PATH_ALIAS_SOURCE_KEYS = ['path', 'file', 'filePath'] as const
const SKILL_WRITE_ONLY_PATH_ALIAS_SOURCE_KEYS = ['output_path', 'outputPath'] as const

// R-WRITE — canonical-form example per field, so a rejected skill-artifact
// write tells the model EXACTLY how each failed field should look. The raw zod
// message alone ("Required" / "Expected string, received undefined") was not
// actionable enough — in the incident the model ate two rejects and gave up
// with `content` still malformed behind the `relativePath` alias.
const SKILL_ARTIFACT_FIELD_GUIDANCE: Record<string, string> = {
  relativePath: '相对技能输出根的字符串，如 "报告.md" 或 "子目录/报告.md"；不要传目录，不要根外绝对路径',
  content: '要写入的完整字符串正文（缺省或非字符串即判失败；二进制请先 base64 再设 encoding）',
  encoding: 'utf-8 或 base64 二选一',
  mode: 'overwrite 或 append 二选一',
  targetPath: '要导出到的用户目标文件：绝对路径，或 @[文件夹名]/文件名，或本轮冻结的 logicalResourceId/文件名',
}

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

function normalizeSkillArtifactPathAlias(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!SKILL_ARTIFACT_RELATIVE_PATH_TOOLS.has(toolName)) return args
  if (
    typeof args.relativePath === 'string'
    && args.relativePath.trim().length > 0
  ) return args
  const sourceKeys = toolName === 'skill_write_artifact'
    ? [...SKILL_ARTIFACT_PATH_ALIAS_SOURCE_KEYS, ...SKILL_WRITE_ONLY_PATH_ALIAS_SOURCE_KEYS]
    : SKILL_ARTIFACT_PATH_ALIAS_SOURCE_KEYS
  for (const key of sourceKeys) {
    const candidate = args[key]
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return { ...args, relativePath: candidate }
    }
  }
  return args
}

function topLevelField(issue: ValidationIssueShape): string {
  return issue.path.length > 0 ? issue.path[0] : '(root)'
}

/**
 * R-WRITE — build the human-facing correction. For skill-artifact write/read/
 * export tools it names EVERY failed field (not just the first) and gives each
 * a canonical-form example, so the model can fix all malformed fields in ONE
 * retry instead of discovering them one reject at a time. Other tools keep the
 * original single-line firstIssue form. The full issue enumeration already
 * rides in `data.issues`; this only makes the enumeration actionable.
 */
function buildInputValidationCorrective(
  toolName: string,
  issues: ReadonlyArray<ValidationIssueShape>,
): { text: string; failedFields?: string[] } {
  const firstIssue = issues[0] || { path: [], code: 'invalid', message: '' }
  if (!SKILL_ARTIFACT_RELATIVE_PATH_TOOLS.has(toolName)) {
    const firstPathDisplay = firstIssue.path.length > 0 ? firstIssue.path.join('.') : '(root)'
    return { text: `工具 ${toolName} 输入校验失败：${firstPathDisplay} — ${firstIssue.message || '格式不合法'}` }
  }
  const failedFields: string[] = []
  for (const issue of issues) {
    const field = topLevelField(issue)
    if (!failedFields.includes(field)) failedFields.push(field)
  }
  const lines = failedFields.map((field) => {
    const message = issues.find((issue) => topLevelField(issue) === field)?.message || '格式不合法'
    const example = SKILL_ARTIFACT_FIELD_GUIDANCE[field]
    return `- ${field} — ${message}${example ? `；规范形态：${example}` : ''}`
  })
  const exportHint = toolName === 'skill_write_artifact'
    ? '\n要落到用户绝对目录：先用 relativePath 写到技能输出根，再用 skill_export_artifact 的 targetPath 导出。'
    : ''
  const text = `工具 ${toolName} 输入校验失败（${failedFields.length} 个字段）：\n${lines.join('\n')}${exportHint}`
  return { text, failedFields }
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

  const normalizedArgs = normalizeSkillArtifactPathAlias(toolName, args)
  const parsed = schema.safeParse(normalizedArgs)
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
  const corrective = buildInputValidationCorrective(toolName, issues)
  const output = createToolExecutionOutput(corrective.text, {
    shape: 'json',
    data: {
      errorKind: 'input_validation',
      toolName,
      issueCount: parsed.error.issues.length,
      issues,
      ...(corrective.failedFields ? { failedFields: corrective.failedFields } : {}),
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
