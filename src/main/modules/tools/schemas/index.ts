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

// Phase 4: SKILL_CONTROL_SCHEMAS retired along with the skill_executions
// state machine. Skill primitives keep their own schemas below.
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
import { getStaticSkillActionSchemas } from '../skills-tools-static'

const STATIC_TOOL_INPUT_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
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
  // Stage B5 — static manifest-derived skill-action schemas. Spread BEFORE
  // the per-domain entries so any name collision (in practice none — skill_*
  // names are namespaced) is overridden by the curated static maps.
  //
  // Phase 2 (B child-loop): admission no longer happens through this map
  // alone. `resolveToolInputSchemaForExecution()` in tool-registry.ts
  // consults this static map first, then falls back to the dynamic
  // getSkillActionSchemas() cache for tools the static map does not cover.
  // tool-executor / turn-engine / turn-frame-steering all consume that one
  // resolver, so dispatch-time and forced-preflight admission see the same
  // schemas. This accessor stays callable for tests and any legacy callers.
  ...getStaticSkillActionSchemas(),
}

export function getToolInputSchemas(): Record<string, ZodObject<ZodRawShape>> {
  return STATIC_TOOL_INPUT_SCHEMAS
}
