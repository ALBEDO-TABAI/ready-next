/**
 * Zod schemas for the 4 Phase 1 skill primitives. Kept separate from the tool
 * defs so dispatch validation can look them up by tool name, and so the
 * static schema registry in `tools/schemas/index.ts` has a single import
 * surface. Each param gets a `.describe()` call so the Zod → param-list
 * derivation carries rich descriptions through to the LLM-facing schemas.
 */

import { z } from 'zod'

const TRIMMED_STRING = z.string().trim().min(1)

export const SKILL_PRIMITIVE_SCHEMAS = {
  skill_ask_user: z.object({
    question: TRIMMED_STRING.describe('向用户展示的问题文本'),
    options: z
      .array(z.string())
      .max(12)
      .optional()
      .describe('可选预设按钮。每条 ≤ 60 字；用户可以选按钮或自由输入。'),
    placeholder: z
      .string()
      .max(200)
      .optional()
      .describe('自由输入框的 placeholder 文案'),
  }),
  skill_run_shell: z.object({
    command: TRIMMED_STRING.describe(
      '要在技能沙箱内执行的 shell 命令。受白名单限制，只允许 python / python3 / node / bash / sh / curl / cat / ls / head / tail / grep / find / mkdir / rm / cp / mv / echo / awk / sed。cwd 为技能 managedPath，env 含 CLAUDE_SKILL_DIR 和 CLAUDE_SKILL_OUTPUT_DIR。',
    ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('毫秒级超时，默认 60000，最大 600000 (10 分钟)'),
    stdin: z
      .string()
      .max(64_000)
      .optional()
      .describe('写入子进程标准输入的字符串（可选）'),
  }),
  skill_write_artifact: z.object({
    relativePath: TRIMMED_STRING.describe(
      '相对 artifact 根目录的路径。禁止绝对路径、..、SKILL.md / ready-skill.json / skill.workflow.json 等保留文件。',
    ),
    content: z.string().describe('写入内容（utf-8 默认；若是二进制请用 base64 编码并设置 encoding）'),
    encoding: z
      .enum(['utf-8', 'base64'])
      .optional()
      .describe('默认 utf-8；base64 用于二进制内容'),
  }),
  skill_read_artifact: z.object({
    relativePath: TRIMMED_STRING.describe('相对 artifact 根目录的路径'),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(1_048_576)
      .optional()
      .describe('最多读取字节数，默认 32768（32K），最大 1048576（1M）'),
  }),
} as const

export type SkillPrimitiveName = keyof typeof SKILL_PRIMITIVE_SCHEMAS
