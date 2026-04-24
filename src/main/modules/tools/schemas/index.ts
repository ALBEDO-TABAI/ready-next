/**
 * Unified Zod schema registry for tool dispatch-time input validation.
 *
 * Phase 2 pilot registered only the 6 skill execution-control tools. Phase 2.5
 * opens the gate to every domain: each per-domain PR spreads its own schema
 * map into STATIC_TOOL_INPUT_SCHEMAS here.
 *
 * tool-input-validator already passes through tools with no registered schema,
 * so tools from domains that haven't migrated yet are unaffected — they simply
 * skip validation until their schemas land.
 *
 * The `getToolInputSchemas()` accessor (not a const export) exists so PR 12 can
 * fold dynamic skill-action schemas in at call time without forcing cold-path
 * re-exports or cache invalidation gymnastics.
 *
 * Pure module — Zod + per-domain schema modules only, no electron.
 */

import type { ZodObject, ZodRawShape } from 'zod'

import { SKILL_CONTROL_SCHEMAS } from './skill-control-schemas'
import { MEMORY_SCHEMAS } from './memory-schemas'
import { RSS_SCHEMAS } from './rss-schemas'
import { CALENDAR_SCHEMAS } from './calendar-schemas'
import { SESSION_SCHEMAS } from './session-schemas'
import { FILE_MANAGEMENT_SCHEMAS } from './file-management-schemas'
import { DOCUMENT_SCHEMAS } from './document-schemas'
import { FEISHU_SCHEMAS } from './feishu-schemas'
import { BROWSER_INTERACTION_SCHEMAS } from './browser-interaction-schemas'
import { BROWSER_CONTENT_SCHEMAS } from './browser-content-schemas'
import { SYSTEM_SCHEMAS } from './system-schemas'
import { SKILL_PRIMITIVE_SCHEMAS } from '../skill-primitives/primitive-schemas'

const STATIC_TOOL_INPUT_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  ...SKILL_CONTROL_SCHEMAS,
  ...SKILL_PRIMITIVE_SCHEMAS,
  ...MEMORY_SCHEMAS,
  ...RSS_SCHEMAS,
  ...CALENDAR_SCHEMAS,
  ...SESSION_SCHEMAS,
  ...FILE_MANAGEMENT_SCHEMAS,
  ...DOCUMENT_SCHEMAS,
  ...FEISHU_SCHEMAS,
  ...BROWSER_INTERACTION_SCHEMAS,
  ...BROWSER_CONTENT_SCHEMAS,
  ...SYSTEM_SCHEMAS,
  // PR 12 folds in the dynamic skill-action schemas via getSkillActionSchemas().
}

export function getToolInputSchemas(): Record<string, ZodObject<ZodRawShape>> {
  return STATIC_TOOL_INPUT_SCHEMAS
}

export { SKILL_CONTROL_SCHEMAS } from './skill-control-schemas'
