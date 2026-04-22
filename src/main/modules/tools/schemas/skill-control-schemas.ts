/**
 * Zod schemas for the 6 skill execution-control tools (Phase 2 pilot).
 *
 * These schemas are the single source of truth for argument shape on the
 * dispatch path (tool-input-validator.ts) AND for the LLM-facing
 * SkillParamDefinition[] used by getSkillAnthropicTools / getSkillOpenAITools.
 * Drift between the two is prevented by zod-param-derivation.ts + its test,
 * and locked by the golden-snapshot test.
 *
 * Pure module — no electron, no runtime-manager, only Zod + shared types.
 */

import { z } from 'zod'

/**
 * executionId is an opaque string today (UUID from randomUUID). Phase 4 may
 * switch to a type-prefixed format (`e-xxxxxxxx`). We accept any non-empty
 * trimmed string — strictness is future work.
 */
export const SkillExecutionIdSchema = z.string().trim().min(1).describe('execution ID')

const InputsRecord = z
  .record(z.string(), z.unknown())
  .describe('输入对象，例如 {"forceSubtitleMode":"funasr"}')

const OutputsRecord = z
  .record(z.string(), z.unknown())
  .describe('可选结构化 outputs 对象')

/**
 * confirmed is intentionally lenient: the existing asBoolean helper in
 * skills-tools.ts accepts `true / false / 'true' / 'false' / '1' / '0' / 1 / 0`.
 * We preserve the exact semantics so LLMs that serialize booleans as strings
 * keep working. Do NOT substitute z.coerce.boolean() — it treats the string
 * "false" as truthy, which would silently flip rejections into confirmations.
 */
const LenientBoolean = z
  .union([
    z.boolean(),
    z.literal('true').transform(() => true),
    z.literal('false').transform(() => false),
    z.literal('1').transform(() => true),
    z.literal('0').transform(() => false),
    z.literal(1).transform(() => true),
    z.literal(0).transform(() => false),
  ])
  .describe('是否确认继续')

export const SkillGetStateSchema = z.object({
  executionId: SkillExecutionIdSchema.optional().describe('可选，execution ID'),
  skillId: z.string().trim().min(1).optional().describe('可选，限定 skill ID'),
})

export const SkillSubmitInputSchema = z.object({
  executionId: SkillExecutionIdSchema,
  inputs: InputsRecord,
})

export const SkillSubmitConfirmationSchema = z.object({
  executionId: SkillExecutionIdSchema,
  stepId: z.string().trim().min(1).describe('当前 confirmation step ID'),
  confirmed: LenientBoolean,
})

export const SkillSubmitAgentResultSchema = z.object({
  executionId: SkillExecutionIdSchema,
  stepId: z.string().trim().min(1).describe('当前 agent_task step ID'),
  textContent: z.string().optional().describe('生成的正文内容'),
  outputs: OutputsRecord.optional(),
})

export const SkillRestartFromStepSchema = z.object({
  executionId: SkillExecutionIdSchema,
  stepId: z.string().trim().min(1).describe('要重跑的 step ID'),
  inputs: InputsRecord.optional().describe('可选，覆盖输入对象'),
})

export const SkillCancelExecutionSchema = z.object({
  executionId: SkillExecutionIdSchema,
})

export type SkillControlToolName =
  | 'skill_get_state'
  | 'skill_submit_input'
  | 'skill_submit_confirmation'
  | 'skill_submit_agent_result'
  | 'skill_restart_from_step'
  | 'skill_cancel_execution'

export const SKILL_CONTROL_SCHEMAS: Record<SkillControlToolName, z.ZodObject<z.ZodRawShape>> = {
  skill_get_state: SkillGetStateSchema,
  skill_submit_input: SkillSubmitInputSchema,
  skill_submit_confirmation: SkillSubmitConfirmationSchema,
  skill_submit_agent_result: SkillSubmitAgentResultSchema,
  skill_restart_from_step: SkillRestartFromStepSchema,
  skill_cancel_execution: SkillCancelExecutionSchema,
}
