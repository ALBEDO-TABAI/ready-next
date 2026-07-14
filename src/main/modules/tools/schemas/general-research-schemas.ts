/**
 * Stage R — Zod input schemas for the `general_research` capability group.
 *
 * Spread into `STATIC_TOOL_INPUT_SCHEMAS` so the dispatch-time validator
 * (`tool-input-validator`) and the forced-action preflight share the same
 * source of truth (see `resolveToolInputSchemaForExecution` in
 * `tool-registry.ts`). Without this, model-issued args for the new web
 * tools would skip validation and reach the handlers raw.
 */

import type { ZodObject, ZodRawShape } from 'zod'

import { anySearchDomainsSchema } from '../builtins/anysearch-domains'
import { presentFileSchema } from '../builtins/present-file'
import { webClipUrlSchema } from '../builtins/web-clip-url'
import { webFetchSchema } from '../builtins/web-fetch'
import { webSearchSchema } from '../builtins/web-search'

export const GENERAL_RESEARCH_SCHEMAS: Record<string, ZodObject<ZodRawShape>> = {
  web_search_domains: anySearchDomainsSchema as unknown as ZodObject<ZodRawShape>,
  web_search: webSearchSchema as unknown as ZodObject<ZodRawShape>,
  web_fetch: webFetchSchema as unknown as ZodObject<ZodRawShape>,
  present_file: presentFileSchema as unknown as ZodObject<ZodRawShape>,
  web_clip_url: webClipUrlSchema as unknown as ZodObject<ZodRawShape>,
}
