/**
 * Skill Host Contract — declarative manifest extension that lets a skill
 * describe what it needs from the Ready host (spawn config files, env vars,
 * shell allowlist extensions, action timeout, status detection, lifecycle
 * cleanup, concurrency model). Read by SkillHostController to provide a
 * generic skill-hosting environment so new skills can land with 0 changes
 * to Ready core code.
 *
 * Source of truth: agent-teams-1-video-flickering-valiant.md §3 Skill Host
 * Contract design. This file owns only the wire schema + types — the
 * controller, templater and integration live in
 * `src/main/modules/skills-runtime/`.
 */

import { z } from 'zod'

// SkillHostRequirements — the declarative contract a skill manifest can opt into.
// Read by SkillHostController to provide a generic skill-hosting environment.

export const SpawnConfigFileSchema = z.object({
  path: z.string().min(1), // template, e.g. "~/.config/${skill.id}/config.json"
  format: z.enum(['json', 'yaml', 'toml', 'ini']),
  fields: z.record(z.string(), z.string()), // JSON pointer -> template string
  preserve_existing: z.boolean().default(true),
})

export const SpawnSecondaryFileSchema = z.object({
  path: z.string().min(1),
  content_template: z.string(),
})

export const SpawnContextSchema = z
  .object({
    config_file: SpawnConfigFileSchema.optional(),
    secondary_files: z.array(SpawnSecondaryFileSchema).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()

export const StatusDetectionSchema = z
  .object({
    method: z.enum(['exit_code', 'stdout_json_line', 'sentinel_file']),
    file_path: z.string().optional(),
    json_field: z.string().optional(),
    blocked_values: z
      .array(z.string())
      .default(['blocked', 'pending_review', 'awaiting_input']),
    error_values: z.array(z.string()).default(['error', 'failed']),
  })
  .strict()

export const LifecycleSchema = z
  .object({
    on_uninstall_remove: z.array(z.string()).optional(),
  })
  .strict()

export const ConcurrencySchema = z
  .object({
    model: z.enum(['serialized', 'shared']).default('serialized'),
  })
  .strict()

export const RepairableConfigFileSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    path: z.string().min(1),
    format: z.literal('json'),
  })
  .strict()

export const ConfigRepairSchema = z
  .object({
    files: z.array(RepairableConfigFileSchema).min(1),
  })
  .strict()

export const SkillHostRequirementsSchema = z
  .object({
    manifest_version: z.literal(1).default(1),
    spawn_context: SpawnContextSchema.optional(),
    shell_allowlist_extensions: z
      .array(z.string().regex(/^[a-z0-9_-]+$/i))
      .optional(),
    default_action_timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(3_600_000)
      .optional(), // 1s - 1h
    status_detection: StatusDetectionSchema.optional(),
    lifecycle: LifecycleSchema.optional(),
    concurrency: ConcurrencySchema.optional(),
    config_repair: ConfigRepairSchema.optional(),
    /**
     * Action names from this skill's manifest that should be exposed to the LLM
     * even if their visibility is 'internal', BUT only when the reference-skill
     * hint is armed for this skill in the current session. Used by skills like
     * video-expert-analyzer that have internal-by-design typed actions which
     * should still be invokable on session resume.
     *
     * Action name format: lowercase a-z, 0-9, underscore. Match by exact string.
     */
    expose_when_hint_armed: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .optional(),
  })
  .strict()

export type SkillHostRequirements = z.infer<typeof SkillHostRequirementsSchema>
export type SpawnConfigFile = z.infer<typeof SpawnConfigFileSchema>
export type SpawnSecondaryFile = z.infer<typeof SpawnSecondaryFileSchema>
export type SpawnContext = z.infer<typeof SpawnContextSchema>
export type StatusDetection = z.infer<typeof StatusDetectionSchema>
export type Lifecycle = z.infer<typeof LifecycleSchema>
export type Concurrency = z.infer<typeof ConcurrencySchema>
export type RepairableConfigFile = z.infer<typeof RepairableConfigFileSchema>
export type ConfigRepair = z.infer<typeof ConfigRepairSchema>

// AgentSpawnContext — what Ready provides to the templater at spawn time.
// Filled by getCurrentAgentContext() (defined in B-arch-5).
export interface AgentSpawnContext {
  provider: string // e.g. 'kimi', 'anthropic', 'openai'
  model_id: string // e.g. 'kimi-k2', 'claude-opus-4-7'
  base_url: string
  api_key: string
  // Derived API style for downstream consumers (e.g. VEA's text_model_runtime).
  // Mapping is provider-knowledge that lives in Ready (not in skills), so
  // skills declare `"api": "${agent.api_kind}"` and Ready picks the right value.
  // Possible values: 'anthropic-messages' | 'openai-responses' | 'openai-completions'.
  api_kind: 'anthropic-messages' | 'openai-responses' | 'openai-completions'
  fallback_chain: ReadonlyArray<string> // ordered list of "${provider}/${model_id}" entries
  input_modes?: ReadonlyArray<'text' | 'image'> // model input modes Ready is willing to advertise to skills
}

export const RESERVED_TEMPLATE_VARIABLES = [
  'skill.id',
  'skill.name',
  'skill.assetRoot',
  'agent.provider',
  'agent.model_id',
  'agent.base_url',
  'agent.api_key',
  'agent.api_kind',
  'agent.fallback_chain',
  'agent.input_modes',
  'spawn.job_id',
  'spawn.tmp_dir',
  'spawn.timestamp',
  'output_dir',
  'env.HOME',
  'env.XDG_CONFIG_HOME',
] as const
export type TemplateVariable = (typeof RESERVED_TEMPLATE_VARIABLES)[number]
