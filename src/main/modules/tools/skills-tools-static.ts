// Pure-data module: contains the static skill-tool name registry that is safe
// to import statically from any process (no electron / no runtime-manager).
//
// `tool-registry` imports this rather than `skills-tools.ts` so that the
// static-names path resolves at bundle time without falling back to the
// hardcoded list that was triggering `Cannot find module '../tools/skills-tools'`
// noise in `ready-agent-metrics.log`.
//
// Phase 4: the 6 execution-control tool names (skill_get_state /
// skill_submit_* / skill_restart_from_step / skill_cancel_execution) were
// removed from the registry along with the skill_executions state machine.
//
// Stage B5 (skill-run-contract route): expose static-manifest-derived Zod
// schemas so `getToolInputSchemas()` can fall back to validation even when
// the runtime manager isn't ready. Without this, dispatch falls back to the
// static tool table (B1) but Zod validation is silently skipped — causing
// forced typed actions to dispatch with `{}` instead of failing as
// `input_validation`.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ZodObject, ZodRawShape } from 'zod'

import type { SkillParamDefinition } from '../../../shared/skill-execution-types'
import { paramListToZodObject } from './paramList-to-zod'

export const STATIC_SKILL_TOOL_NAMES_BY_ACTION: Record<string, string> = {
  'video-expert-analyzer:video_expert_pipeline': 'skill_video_expert_pipeline',
  'video-expert-analyzer:video_expert_ai_analyze': 'skill_video_expert_ai_analyze',
  'video-copy-analyzer:video_copy_analyze': 'skill_video_copy_analyze',
  'lets-go-rss:rss_add': 'skill_rss_add',
  'lets-go-rss:rss_update': 'skill_rss_update',
  'lets-go-rss:rss_status': 'skill_rss_status',
  'lets-go-rss:rss_list': 'skill_rss_list',
  'lets-go-rss:rss_stats': 'skill_rss_stats',
  'send-im:send_file': 'skill_send_im_file',
}

export function getStaticSkillToolNameForAction(skillId: string, actionName: string): string | null {
  return STATIC_SKILL_TOOL_NAMES_BY_ACTION[`${skillId}:${actionName}`] || null
}

export const STATIC_SKILL_ACTIONS_BY_TOOL_NAME: Record<string, { skillId: string; actionName: string }> = Object.fromEntries(
  Object.entries(STATIC_SKILL_TOOL_NAMES_BY_ACTION).map(([key, toolName]) => {
    const [skillId, actionName] = key.split(':')
    return [toolName, { skillId, actionName }]
  }),
)

// B Phase 1 — skill primitive names. Session gating can still prefilter the
// candidate list, but Stage 4 W3 SkillToolAuthorization is the final authority
// for model-visible exposure and execution admission. Names are included here
// so static-fallback tool enumeration still lists them when the runtime manager
// isn't ready yet (boot path).
const PRIMITIVE_TOOL_NAMES: string[] = [
  'skill_ask_user',
  'skill_compact_context',
  'skill_run_shell',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_patch_config',
  'skill_start_detached',
  'skill_inspect_detached',
  'skill_cancel_detached',
  // Phase 5.1 — generic run_state inspector for long multi-step skills.
  'skill_inspect_run_state',
]

/**
 * Full static tool list — skill_action + primitives. Boot-path callers
 * (ToolRegistry static fallback) use this unchanged; Stage 4 W3 authorization
 * filters model-visible and execution paths later in the chain.
 */
export const STATIC_SKILL_TOOL_NAMES: string[] = [
  ...Object.values(STATIC_SKILL_TOOL_NAMES_BY_ACTION),
  ...PRIMITIVE_TOOL_NAMES,
]

/**
 * Boot-safe subset (identical to STATIC_SKILL_TOOL_NAMES since Phase 4
 * retired the gated execution-control tools). Kept as a separate export for
 * backward compatibility with the tool-registry import site.
 */
export const STATIC_SKILL_TOOL_NAMES_BOOT_SAFE: string[] = STATIC_SKILL_TOOL_NAMES

// ---------------------------------------------------------------------------
// Static manifest schema metadata (Stage B5)
//
// The same `assets/embedded-skills/<id>/ready-skill.json` files the runtime
// manager loads. We re-read them lazily here so the registry / schema layer
// can derive Zod input schemas without taking a runtime-manager dependency.
// Pure module: only `node:fs` + `node:path` + Zod.
// ---------------------------------------------------------------------------

interface StaticSkillActionParams {
  skillId: string
  actionName: string
  toolName: string
  description: string
  visibility: string
  timeoutMs?: number
  params: SkillParamDefinition[]
}

let staticSkillActionParamsCache: Map<string, StaticSkillActionParams> | null = null

function readStaticSkillActionParams(): Map<string, StaticSkillActionParams> {
  if (staticSkillActionParamsCache) return staticSkillActionParamsCache
  const map = new Map<string, StaticSkillActionParams>()
  // Mirror tool-registry.ts: assets/embedded-skills lives at the cwd root.
  // Test runs (`npx tsx --test`) launch from the project root, so this works
  // for both production (electron-vite asar) and unit tests.
  const root = join(process.cwd(), 'assets', 'embedded-skills')
  if (!existsSync(root)) {
    staticSkillActionParamsCache = map
    return map
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(root, entry.name, 'ready-skill.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        id?: unknown
        actions?: unknown
        host_requirements?: { default_action_timeout_ms?: unknown }
      }
      const skillId = typeof manifest.id === 'string' ? manifest.id : entry.name
      const actions = Array.isArray(manifest.actions) ? manifest.actions : []
      for (const rawAction of actions) {
        if (!rawAction || typeof rawAction !== 'object') continue
        const action = rawAction as {
          name?: unknown
          description?: unknown
          params?: unknown
          visibility?: unknown
          timeoutMs?: unknown
          timeout_ms?: unknown
        }
        if (typeof action.name !== 'string') continue
        const aliasKey = `${skillId}:${action.name}`
        const toolName = STATIC_SKILL_TOOL_NAMES_BY_ACTION[aliasKey]
        if (!toolName) continue
        const params: SkillParamDefinition[] = Array.isArray(action.params)
          ? (action.params as unknown[])
              .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
              .map((p) => normalizeManifestParam(p))
              .filter((p): p is SkillParamDefinition => p !== null)
          : []
        map.set(toolName, {
          skillId,
          actionName: action.name,
          toolName,
          description: typeof action.description === 'string' && action.description.trim()
            ? action.description.trim()
            : `执行 ${action.name}`,
          visibility: typeof action.visibility === 'string' && action.visibility.trim()
            ? action.visibility.trim()
            : 'public',
          timeoutMs: parsePositiveTimeout(action.timeoutMs)
            || parsePositiveTimeout(action.timeout_ms)
            || parsePositiveTimeout(manifest.host_requirements?.default_action_timeout_ms),
          params,
        })
      }
    } catch {
      continue
    }
  }
  staticSkillActionParamsCache = map
  return map
}

function parsePositiveTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.max(1000, Math.round(value)) : undefined
}

function normalizeManifestParam(raw: Record<string, unknown>): SkillParamDefinition | null {
  if (typeof raw.name !== 'string' || !raw.name) return null
  return {
    name: raw.name,
    type: typeof raw.type === 'string' ? raw.type : 'string',
    description: typeof raw.description === 'string' ? raw.description : '',
    required: raw.required === true,
    enum: Array.isArray(raw.enum) ? raw.enum.filter((e): e is string => typeof e === 'string') : undefined,
    items: raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items)
      ? (raw.items as Record<string, unknown>)
      : undefined,
    additionalProperties: raw.additionalProperties === true ? true : undefined,
  }
}

export function getStaticSkillActionDefByToolName(toolName: string): StaticSkillActionParams | null {
  return readStaticSkillActionParams().get(toolName) || null
}

export function getStaticSkillActionDefBySkillAction(
  skillId: string,
  actionName?: string,
): StaticSkillActionParams | null {
  const entries = Array.from(readStaticSkillActionParams().values())
    .filter((entry) => entry.skillId === skillId)
  if (!actionName) return entries[0] || null
  return entries.find((entry) => entry.actionName === actionName) || null
}

/**
 * Static manifest-derived Zod schemas keyed by tool name. Built lazily on
 * first call, then cached for the process. Used by `getToolInputSchemas()`
 * as a fallback when `getSkillActionSchemas()` returns `{}` (runtime manager
 * unavailable / boot ordering).
 *
 * Pure: relies only on assets/embedded-skills/*\/ready-skill.json + Zod.
 */
export function getStaticSkillActionSchemas(): Record<string, ZodObject<ZodRawShape>> {
  const params = readStaticSkillActionParams()
  const out: Record<string, ZodObject<ZodRawShape>> = {}
  for (const [toolName, entry] of params.entries()) {
    try {
      out[toolName] = paramListToZodObject(entry.params)
    } catch {
      // Malformed manifest → skip. Static fallback should never crash the
      // schema registry.
    }
  }
  return out
}
