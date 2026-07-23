// B8-P (2026-07-05) — pure move of runtime-manager.ts top-level types (HEAD
// lines 168–177, 220–221, 245–461). No behavior change; runtime-manager.ts
// re-exports the previously exported names so the external import face is
// unchanged.
import type {
  SkillActionDefinition,
  SkillChildLoopDefinition,
  SkillExecutionMode,
  SkillSource,
} from '../../../shared/skill-execution-types'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import type { MissingRuntimeDependency } from '../../../shared/model-pack-types'
import type { SkillHostController } from './skill-host-controller'

// Injectable subprocess seam for the dependency-deploy path (venv build + pip).
// Production binds it to execFile; tests inject a fake to assert the invocation
// shape + env (offline flags deleted) without a real Python/network.
export type SkillDeploySpawn = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>

export type SkillRunStatus = NonNullable<SkillRunResult['status']>

export type SkillTriggerType = 'manual' | 'tool' | 'schedule'
export type SkillId = string

export interface SkillState {
  id: SkillId
  name: string
  description: string
  version: string
  installed: boolean
  installStatePath: string
  source: SkillSource
  manifestValid: boolean
  defaultAction?: string
  actions: SkillActionDefinition[]
  executionMode: SkillExecutionMode
  managedPath?: string
  sourcePath?: string
  /**
   * B-arch-4 — pass-through of the validated host_requirements block from the
   * compiled SkillDefinition. The dispatch layer (skills-tools.ts) reads this
   * to compute the effective shell allowlist for skill_run_shell.
   */
  hostRequirements?: import('../../../shared/skill-host-contract').SkillHostRequirements
  /** Agent Skills `metadata.requires.bins`, validated as bare executable names. */
  requiredBins?: string[]
  childLoop?: SkillChildLoopDefinition
  /** Embedded manifest tool contract used to admit the selected skill's capability groups. */
  allowedTools?: string[]
  capabilitySurface?: {
    composition: 'additive' | 'exclusive'
    exclusiveScope?: 'owner'
  }
  configuration?: import('../../../shared/skill-configuration').SkillConfigurationDefinition
}

/**
 * P2-4 + P2-5 — result of importing a custom skill folder: the registered skill plus
 * non-blocking import metadata surfaced to the skills center. `ignoredFields` lists spec
 * fields Ready deliberately did not honor (e.g. `allowed-tools` — downloaded skills carry no
 * tool authorization); `warnings` are author advisories (e.g. an oversized SKILL.md).
 */
export interface SkillImportResult {
  skill: SkillState
  ignoredFields: string[]
  warnings: string[]
}

export interface SkillsRuntimeInfo {
  runtimeRoot: string
  skillsRoot: string
  customSkillsRoot: string
  outputsRoot: string
  venvRoot: string
}

export interface SkillInstallState {
  version: string
  requirementsDigest: string
  installedAt: string
  venvId?: string
}

export interface PythonRuntimeState {
  venvId: string
  pythonPath: string
  pythonVersion: string
  pythonSslVersion: string
  updatedAt: string
  packaged?: boolean
}

export interface SkillsRuntimeManagerOptions {
  runtimeRoot?: string
  embeddedSkillsRoot?: string
  packagedRuntimeRoot?: string | null
  startBackgroundTasks?: boolean
  /**
   * B-arch-4 — inject a SkillHostController for tests. Production path uses
   * the singleton (`getSkillHostController()`) so prepare/restore + status
   * detection apply uniformly across every skill run.
   */
  hostController?: SkillHostController
  /**
   * B-arch-4 — override the retired-embedded-skill allowlist for tests. The
   * production constant is `RETIRED_EMBEDDED_SKILL_IDS` (currently just
   * `'video-expert-analyzer'`), which is still embedded today and therefore
   * exercises only the no-op branch in real boot. Tests inject a synthetic
   * id matching their fixture so the cleanup branch runs deterministically.
   */
  retiredEmbeddedSkillIds?: ReadonlySet<string>
}

export interface SkillInstallResult {
  success: boolean
  skillId: SkillId
  skillPath?: string
  venvPython?: string
  error?: string
}

export interface SkillRunResult {
  success: boolean
  skillId: SkillId
  action: string
  jobId?: string
  stdout: string
  stderr: string
  outputDir?: string
  outputs?: Record<string, string>
  command: string[]
  error?: string
  // Phase 4: 'workflow' mode retired along with the skill_executions state
  // machine. Reference skills still return mode='reference' (inlined SKILL.md
  // guidance); everything else is 'direct' (subprocess or in-process action).
  mode?: 'direct' | 'reference'
  /**
   * B-arch-4 — populated by `SkillHostController.detectStatus`. When the skill
   * declares `host_requirements.status_detection` (stdout JSON / sentinel file),
   * this can be 'blocked' even if exit_code is 0 (the run is paused waiting on
   * the user). Without host_requirements, defaults to 'done' on success and
   * 'error' on failure (mirrors the legacy mapping in skills-tools.ts:477).
   */
  status?: 'done' | 'error' | 'blocked'
  /**
   * C6 — when stdout/stderr exceeded the in-memory cap (1 MiB per stream),
   * the surplus is appended to a per-action artifact under
   * `<runtimeRoot>/outputs/<skillId>/.logs/skill-action-<id>-<stream>.txt`.
   * The in-memory `stdout`/`stderr` carries a clear truncation marker pointing
   * at this path. `*ArtifactError` is set instead when the disk write itself
   * failed (mkdir / append errors); the command result is still returned
   * intact so a single log spill never breaks a long-running skill.
   */
  stdoutArtifactPath?: string
  stderrArtifactPath?: string
  stdoutArtifactError?: string
  stderrArtifactError?: string
  /**
   * Phase 1 (model packs) — set when the run failed because an on-demand model
   * pack/dependency is absent (the subtitle extractor printed the structured
   * `__READY_ASR_MODEL_PACK_MISSING__` marker). Detected once in `runSkill` so
   * every caller (inline + child-loop) carries the same signal; the renderer
   * uses it to deep-link the user into Settings › Models & Runtime.
   */
  missingRuntimeDependency?: MissingRuntimeDependency
}

export interface SkillRunRequest {
  skillId: SkillId
  action: string
  params?: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
  triggerType?: SkillTriggerType
  scheduleId?: string
  env?: Record<string, string>
  sessionId?: string
  executionMode?: 'auto' | 'workflow' | 'direct'
  agentContext?: AgentSpawnContext | null
}

export interface SkillJobRow {
  id: string
  skill_id: SkillId
  action: string
  params_json: string | null
  status: string
  trigger_type: SkillTriggerType
  schedule_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  stdout: string | null
  stderr: string | null
  output_dir: string | null
  error: string | null
  command_json: string | null
}

export interface SkillScheduleRow {
  id: string
  skill_id: SkillId
  action: string
  params_json: string | null
  interval_minutes: number
  next_run_at: string
  last_run_at: string | null
  enabled: number
  created_at: string
  updated_at: string
}

export interface DatabaseStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

export interface DatabaseConnection {
  prepare(sql: string): DatabaseStatement
}

export interface SkillJobRecord {
  id: string
  skillId: SkillId
  action: string
  status: string
  triggerType: SkillTriggerType
  scheduleId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  stdout: string
  stderr: string
  outputDir: string | null
  error: string | null
  command: string[]
}

export interface SkillScheduleRecord {
  id: string
  skillId: SkillId
  action: string
  params: Record<string, unknown>
  intervalMinutes: number
  nextRunAt: string
  lastRunAt: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateSkillScheduleRequest {
  skillId: SkillId
  action: string
  params?: Record<string, unknown>
  intervalMinutes: number
  startAt?: string
}
