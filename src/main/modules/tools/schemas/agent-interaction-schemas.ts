/**
 * Zod input schemas for the `agent_interaction` capability group.
 *
 * Spread into `STATIC_TOOL_INPUT_SCHEMAS` so dispatch-time validation
 * (`tool-input-validator`) and the forced-action preflight share one source
 * of truth (see `resolveToolInputSchemaForExecution` in `tool-registry.ts`).
 *
 * The tool itself is implemented in
 * `src/main/modules/tools/builtins/ask-user-questions.ts`; its `argsSchema`
 * is re-exported here to keep the registry import path uniform with the
 * `general_research` group (which exposes per-tool schemas the same way).
 */

import type { ZodObject, ZodRawShape } from 'zod'

import { askUserQuestionsSchema } from '../builtins/ask-user-questions'

export const AGENT_INTERACTION_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  ask_user_questions: askUserQuestionsSchema as unknown as ZodObject<ZodRawShape>,
}
