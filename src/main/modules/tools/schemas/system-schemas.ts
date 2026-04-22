/**
 * Zod schemas for the 2 system domain tools (Phase 2.5 PR 11).
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

export const SystemRunEmbeddedPythonSchema = z.object({
  code: z.string().optional().describe('可选，直接执行的 Python 代码'),
  scriptPath: z.string().optional().describe('可选，要执行的 Python 脚本绝对路径'),
  args: z.array(z.string()).optional().describe('可选，脚本参数数组'),
  cwd: z.string().optional().describe('可选，执行目录'),
  timeoutMs: z.number().optional().describe('可选，超时时间毫秒'),
})

export const SystemRunOpenclawSchema = z.object({
  command: z.string().describe('完整命令，例如 openclaw pairing approve feishu FNXQH9PN'),
})

export type SystemToolName = 'system_run_embedded_python' | 'system_run_openclaw'

export const SYSTEM_SCHEMAS: Record<SystemToolName, z.ZodObject<z.ZodRawShape>> = {
  system_run_embedded_python: SystemRunEmbeddedPythonSchema,
  system_run_openclaw: SystemRunOpenclawSchema,
}
