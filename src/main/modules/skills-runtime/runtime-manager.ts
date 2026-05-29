import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promisify } from 'util'
import { createHash, randomUUID } from 'crypto'
import { createRequire } from 'module'
import { join, delimiter } from 'path'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'

// See database.ts for the full rationale. Electron's Node entry is a CJS
// string-export, so ESM `import { app } from 'electron'` breaks tsx/ESM tests
// that transitively load this file (e.g. via tool-registry → skills-tools →
// runtime-manager). `createRequire(...)('electron')` succeeds in both the real
// Electron runtime (named members populated) and in plain Node (destructuring
// a string yields `undefined`, which is caught by downstream try/catch when a
// method such as `app.getPath` is actually invoked).
const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch { return {} as typeof import('electron') }
})()
const { app, session } = electronModule
import { getDatabase } from '../database'
import { atomicWriteJson } from '../agent-control/atomic-write'
import { getWhichCommand } from '../../utils/platform'
import { EMBEDDED_SKILLS, EMBEDDED_SKILL_IDS, type EmbeddedSkillId, type EmbeddedSkillManifest, getEmbeddedSkillManifest } from './manifest'
import type {
  SkillActionDefinition,
  SkillActionResult,
  SkillChildLoopDefinition,
  SkillDefinition,
  SkillExecutionMode,
  SkillInputValue,
  SkillParamDefinition,
  SkillRuntimeKind,
  SkillSource,
} from '../../../shared/skill-execution-types'
import {
  type RegisteredCustomSkill,
  getManagedCustomSkill,
  importCustomSkillFolder,
  listManagedCustomSkills,
  removeManagedCustomSkill,
  updateManagedCustomSkillDescription,
} from './custom-skill-registry'
import { SkillLoader } from './skill-loader'
import { scanSkillDirectory } from './skill-security-scanner'
// Phase 4: ExecutionStateStore / ExecutionCoordinator retired along with the
// skill_executions state machine. The imports (and the files) are removed in
// PR1-E.
import { sweepExpiredReferenceSkillHints } from '../agent-control/skills/skill-reference-hints'
import { logAgentMetric } from '../agent-control/metrics'
import {
  sweepChildRunLogs,
  sweepOutputDirs,
} from './output-dir-sweep'
import {
  getSkillHostController,
  type SkillHostController,
  type SpawnContextHandle,
} from './skill-host-controller'
import { spawnWithTreeKill, type SpawnWithTreeKillError } from '../process-cleanup/spawn-with-tree-kill'
import {
  buildReadyPythonRuntimeNotFoundMessage,
  buildReadyPythonCandidates,
  isSupportedReadyPythonSslVersion,
  isSupportedReadyPythonVersion,
  parsePythonVersionText,
  type PythonVersionInfo,
} from './python-runtime-version'
import {
  buildPackagedSkillRuntimeEnv,
  getPackagedSkillPythonBinDir,
  getPackagedSkillPythonPath,
  getPackagedSkillRuntimeBinDir,
  getPackagedSkillRuntimeToolCandidates,
  readPackagedSkillRuntimeManifest,
  resolvePackagedSkillRuntimeRoot,
  type PackagedSkillRuntimeManifest,
} from './packaged-runtime'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import { ExternalServiceStore } from '../settings-engine/external-service-store'
import { SkillConfigurationStore } from './skill-configuration-store'
import type { SkillConfigurationUpdateInput, SkillConfigurationView } from '../../../shared/skill-configuration'
import {
  MODEL_PACK_IDS,
  createDefaultModelPackDownloadStatus,
  detectMissingRuntimeDependency,
  type MissingRuntimeDependency,
  type ModelPackDownloadRequest,
  type ModelPackDownloadStatus,
  type ModelPackId,
  type ModelPackSelfTestEntry,
  type ModelPackSelfTestReport,
  type ModelPackSourceProbe,
  type ModelPackStatus,
} from '../../../shared/model-pack-types'
import {
  MODEL_PACK_DONE_MARKER,
  buildModelPackDownloadScript,
  getModelPackDescriptor,
  resolveExplicitModelProvider,
  resolveModelProvider,
  resolvedProviderEndpoint,
  type ResolvedModelProvider,
} from './model-pack-registry'

const execFileAsync = promisify(execFile)

const INSTALL_STATE_FILENAME = '.ready-install-state.json'
const EMBEDDED_SYNC_STATE_FILENAME = '.ready-embedded-sync-state.json'
const PYTHON_RUNTIME_STATE_FILENAME = '.ready-python-runtime-state.json'
const MAX_COMMAND_BUFFER = 24 * 1024 * 1024
/**
 * C6 — per-stream in-memory cap before output spills to a `.logs/` artifact
 * under `<runtimeRoot>/outputs/<skillId>/`. Long-running video / audio skills
 * (e.g. ffmpeg progress, scenedetect noise) routinely produce tens of MiB of
 * stderr; buffering it all in the renderer's tool-result envelope blows the
 * IPC payload and historically caused OOM. 1 MiB matches the run-shell
 * primitive's "first 8K + spill" pattern but with a higher in-memory ceiling
 * because direct actions return their result to the LLM only once (vs.
 * repeatedly through chat), so we can afford a bigger inline preview.
 */
const DIRECT_ACTION_INMEMORY_CAP = 1 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000
const SCHEDULER_INTERVAL_MS = 60_000
type SkillRunStatus = NonNullable<SkillRunResult['status']>

function normalizeSkillRunStatus(value: unknown, ok?: boolean): SkillRunStatus | undefined {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['blocked', 'pending_review', 'awaiting_input'].includes(status)) return 'blocked'
  if (['failed', 'failure', 'error'].includes(status)) return 'error'
  if (['completed', 'success', 'done'].includes(status)) return 'done'
  if (ok === false) return 'error'
  if (ok === true) return 'done'
  return undefined
}

function mergeSkillRunStatus(
  current: SkillRunStatus | undefined,
  detected: SkillRunStatus,
): SkillRunStatus {
  if (current === 'blocked' || current === 'error') return current
  if (detected === 'blocked' || detected === 'error') return detected
  return current || detected
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

/**
 * B-arch-4 — explicit allowlist of embedded skill ids that have been retired
 * (or are slated to be) and whose stale on-disk artifacts should be cleaned
 * up via the host controller on app launch. Adding an id here is a deliberate
 * "yes please cleanup" signal — without this gate, the orphan sweep would
 * pick up any folder that's not in the current `EMBEDDED_SKILLS` list, which
 * is dangerous if a custom-skill manifest hasn't been re-imported yet.
 *
 * Initially contains `'video-expert-analyzer'` per plan §3.4. The skill is
 * still embedded today, so this is effectively a no-op until/unless we drop
 * it from EMBEDDED_SKILLS.
 */
const RETIRED_EMBEDDED_SKILL_IDS: ReadonlySet<string> = new Set(['video-expert-analyzer'])

type SkillTriggerType = 'manual' | 'tool' | 'schedule'
export type SkillId = string

function hashDirectoryContents(root: string): string {
  const hash = createHash('sha256')
  const visit = (dir: string, relativePrefix = ''): void => {
    for (const entry of readdirSync(dir).sort()) {
      const absolute = join(dir, entry)
      const relative = relativePrefix ? `${relativePrefix}/${entry}` : entry
      const stat = statSync(absolute)
      if (stat.isDirectory()) {
        hash.update(`dir:${relative}\n`)
        visit(absolute, relative)
        continue
      }
      if (!stat.isFile()) continue
      hash.update(`file:${relative}:${stat.size}\n`)
      hash.update(readFileSync(absolute))
      hash.update('\n')
    }
  }
  visit(root)
  return hash.digest('hex')
}

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
  childLoop?: SkillChildLoopDefinition
  configuration?: import('../../../shared/skill-configuration').SkillConfigurationDefinition
}

export interface SkillsRuntimeInfo {
  runtimeRoot: string
  skillsRoot: string
  customSkillsRoot: string
  outputsRoot: string
  venvRoot: string
}

interface SkillInstallState {
  version: string
  requirementsDigest: string
  installedAt: string
  venvId?: string
}

interface PythonRuntimeState {
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

interface SkillJobRow {
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

interface SkillScheduleRow {
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

interface DatabaseStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

interface DatabaseConnection {
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

function asString(value: unknown): string | null {

  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.toLowerCase().trim()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
  }
  return null
}

function truncateOutput(content: string, max = 18_000): string {
  if (content.length <= max) return content
  return `${content.slice(0, max)}\n...[truncated ${content.length - max} chars]`
}

function getInstallStatePath(skillPath: string): string {
  return join(skillPath, INSTALL_STATE_FILENAME)
}

function requirementsDigest(requirementsPath: string): string {
  if (!existsSync(requirementsPath)) return 'missing'
  const content = readFileSync(requirementsPath, 'utf-8')
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash) + content.charCodeAt(i)
    hash |= 0
  }
  return `${content.length}:${hash}`
}

export class SkillsRuntimeManager {
  private readonly runtimeRoot: string
  private readonly skillsRoot: string
  private readonly customSkillsRoot: string
  private readonly venvRoot: string
  private readonly runtimeBin: string
  private readonly cacheRoot: string
  private readonly modelscopeCache: string
  private readonly pipCache: string
  private readonly outputsRoot: string
  private readonly packagedRuntimeRoot: string | null
  private readonly packagedRuntimeManifest: PackagedSkillRuntimeManifest | null
  private readonly embeddedSkillsRootOverride?: string
  private readonly hostControllerOverride?: SkillHostController
  private readonly externalServiceStore = new ExternalServiceStore()
  private readonly skillConfigurationStore = new SkillConfigurationStore()
  private readonly retiredEmbeddedSkillIdsOverride?: ReadonlySet<string>
  private loader: SkillLoader | null = null
  private installLocks = new Map<SkillId, Promise<SkillInstallResult>>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private referenceHintBootTimer: NodeJS.Timeout | null = null
  private referenceHintIntervalTimer: NodeJS.Timeout | null = null
  private outputDirSweepBootTimer: NodeJS.Timeout | null = null
  private outputDirSweepIntervalTimer: NodeJS.Timeout | null = null
  private runningScheduleIds = new Set<string>()
  private orphanCleanupRan = false
  // One in-flight download per pack so packs download independently.
  private modelPackDownloads = new Map<ModelPackId, ChildProcessWithoutNullStreams>()
  private modelPackDownloadStatuses = new Map<ModelPackId, ModelPackDownloadStatus>()

  // Phase 4: reference-skill hint TTL sweep runs independently of the retired
  // skill_executions state machine. Boot delay prevents blocking startup; the
  // hourly cadence matches the previous combined sweep.
  private static readonly REFERENCE_HINT_BOOT_DELAY_MS = 30_000
  private static readonly REFERENCE_HINT_SWEEP_INTERVAL_MS = 60 * 60_000

  constructor(options: SkillsRuntimeManagerOptions = {}) {
    this.runtimeRoot = options.runtimeRoot || join(app.getPath('userData'), 'skill-runtime')
    this.skillsRoot = join(this.runtimeRoot, 'skills')
    this.customSkillsRoot = join(this.runtimeRoot, 'custom-skills')
    this.venvRoot = join(this.runtimeRoot, 'python')
    this.runtimeBin = join(this.runtimeRoot, 'bin')
    this.cacheRoot = join(this.runtimeRoot, 'cache')
    this.modelscopeCache = join(this.cacheRoot, 'modelscope')
    this.pipCache = join(this.cacheRoot, 'pip')
    this.outputsRoot = join(this.runtimeRoot, 'outputs')
    this.packagedRuntimeRoot = resolvePackagedSkillRuntimeRoot(
      (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
      options.packagedRuntimeRoot,
    )
    this.packagedRuntimeManifest = this.packagedRuntimeRoot
      ? readPackagedSkillRuntimeManifest(this.packagedRuntimeRoot)
      : null
    this.embeddedSkillsRootOverride = options.embeddedSkillsRoot
    this.hostControllerOverride = options.hostController
    this.retiredEmbeddedSkillIdsOverride = options.retiredEmbeddedSkillIds
    if (options.startBackgroundTasks !== false) {
      this.startScheduler()
      this.startReferenceHintSweep()
      this.startOutputDirSweep()
      // B-arch-4 — best-effort one-shot orphan cleanup. Failures must not block
      // boot, so swallow + log internally. Test mode (startBackgroundTasks=false)
      // skips this so tests don't accidentally rm fixture skill dirs.
      void this.cleanupOrphanedSkillArtifactsOnce().catch((error) => {
        console.warn('[SkillsRuntimeManager] orphan cleanup failed:', error instanceof Error ? error.message : String(error))
      })
    }
  }

  private getHostController(): SkillHostController {
    return this.hostControllerOverride ?? getSkillHostController()
  }

  /**
   * Phase 4 — prune idle reference-skill hints on an independent cadence now
   * that the skill_executions state machine (and its TTL sweep) is retired.
   * Runs once 30s after boot to avoid blocking startup, then hourly.
   * Best-effort; a failure logs to stderr and the next tick retries. The
   * metric name changed from `skill_executions_ttl_swept` to
   * `skill_reference_hint_ttl_swept` — see CHANGELOG.md.
   */
  private startReferenceHintSweep(): void {
    if (this.referenceHintBootTimer || this.referenceHintIntervalTimer) {
      console.warn('[SkillsRuntimeManager] reference-hint sweep already running; start skipped')
      return
    }
    const sweep = (): void => {
      try {
        sweepExpiredReferenceSkillHints()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[SkillsRuntimeManager] reference-hint sweep failed:', message)
      }
    }
    this.referenceHintBootTimer = setTimeout(
      sweep,
      SkillsRuntimeManager.REFERENCE_HINT_BOOT_DELAY_MS,
    )
    this.referenceHintIntervalTimer = setInterval(
      sweep,
      SkillsRuntimeManager.REFERENCE_HINT_SWEEP_INTERVAL_MS,
    )
  }

  stopReferenceHintSweep(): void {
    if (this.referenceHintBootTimer) {
      clearTimeout(this.referenceHintBootTimer)
      this.referenceHintBootTimer = null
    }
    if (this.referenceHintIntervalTimer) {
      clearInterval(this.referenceHintIntervalTimer)
      this.referenceHintIntervalTimer = null
    }
  }

  private startOutputDirSweep(): void {
    if (this.outputDirSweepBootTimer || this.outputDirSweepIntervalTimer) {
      console.warn('[SkillsRuntimeManager] outputDir sweep already running; start skipped')
      return
    }
    const sweep = (): void => {
      void (async () => {
        try {
          await sweepOutputDirs({
            runtimeRoot: this.runtimeRoot,
            retentionDays: envNumber('READY_OUTPUT_DIR_RETENTION_DAYS', 7),
            legacyGraceDays: envNumber('READY_OUTPUT_DIR_LEGACY_GRACE_DAYS', 30),
          })
          await sweepChildRunLogs({
            runtimeRoot: this.runtimeRoot,
            retentionDays: envNumber('READY_CHILD_RUN_LOG_RETENTION_DAYS', 30),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[SkillsRuntimeManager] outputDir sweep failed:', message)
        }
      })()
    }
    this.outputDirSweepBootTimer = setTimeout(
      sweep,
      SkillsRuntimeManager.REFERENCE_HINT_BOOT_DELAY_MS,
    )
    this.outputDirSweepIntervalTimer = setInterval(
      sweep,
      SkillsRuntimeManager.REFERENCE_HINT_SWEEP_INTERVAL_MS,
    )
  }

  stopOutputDirSweep(): void {
    if (this.outputDirSweepBootTimer) {
      clearTimeout(this.outputDirSweepBootTimer)
      this.outputDirSweepBootTimer = null
    }
    if (this.outputDirSweepIntervalTimer) {
      clearInterval(this.outputDirSweepIntervalTimer)
      this.outputDirSweepIntervalTimer = null
    }
  }

  private getSkillLoader(): SkillLoader {
    if (!this.loader) {
      this.loader = new SkillLoader(this.resolveEmbeddedSkillsRoot(), this.customSkillsRoot)
    }
    return this.loader
  }

  private toSkillState(definition: SkillDefinition): SkillState {
    const skillPath = definition.source === 'embedded'
      ? this.getSkillRuntimePath(definition.id)
      : (definition.managedPath || definition.sourcePath)
    const statePath = getInstallStatePath(skillPath)
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      installed: definition.source === 'embedded' ? true : existsSync(statePath),
      installStatePath: statePath,
      source: definition.source,
      manifestValid: definition.manifestValid,
      defaultAction: definition.defaultAction,
      actions: definition.actions,
      executionMode: definition.executionMode,
      managedPath: definition.source === 'embedded' ? skillPath : definition.managedPath,
      sourcePath: definition.sourcePath,
      hostRequirements: definition.hostRequirements,
      childLoop: definition.childLoop,
      configuration: definition.configuration,
    }
  }

  listSkills(): SkillState[] {
    this.ensureRuntimeDirs()
    const loader = this.getSkillLoader()
    return [
      ...loader.listEmbeddedSkills().map((definition) => {
        const manifest = getEmbeddedSkillManifest(definition.id)
        if (manifest) this.syncEmbeddedSkill(manifest)
        return this.toSkillState(definition)
      }),
      ...loader.listCustomSkills().map((definition) => this.toSkillState(definition)),
    ]
  }

  getSkillConfiguration(skillId: SkillId): SkillConfigurationView | null {
    this.ensureRuntimeDirs()
    const definition = this.getSkillLoader().loadSkill(skillId)
    if (!definition) return null
    return this.skillConfigurationStore.getView(definition)
  }

  updateSkillConfiguration(input: SkillConfigurationUpdateInput): SkillConfigurationView {
    this.ensureRuntimeDirs()
    const definition = this.getSkillLoader().loadSkill(input.skillId)
    if (!definition) throw new Error(`Unknown skill: ${input.skillId}`)
    return this.skillConfigurationStore.updateValues(definition, input)
  }

  getRuntimeInfo(): SkillsRuntimeInfo {
    this.ensureRuntimeDirs()
    return {
      runtimeRoot: this.runtimeRoot,
      skillsRoot: this.skillsRoot,
      customSkillsRoot: this.customSkillsRoot,
      outputsRoot: this.outputsRoot,
      venvRoot: this.venvRoot,
    }
  }

  getModelPackStatus(id: ModelPackId): ModelPackStatus {
    this.ensureRuntimeDirs()
    const descriptor = getModelPackDescriptor(id)
    const targetDir = this.getModelPackTargetDir(id)
    const missingFiles = this.getMissingModelPackFiles(id, targetDir)
    return {
      id,
      displayName: descriptor.displayName,
      sizeEstimate: descriptor.sizeEstimate,
      targetDir,
      available: missingFiles.length === 0,
      missingFiles,
      download: { ...this.getModelPackDownloadState(id) },
    }
  }

  listModelPacks(): ModelPackStatus[] {
    return MODEL_PACK_IDS.map((id) => this.getModelPackStatus(id))
  }

  async startModelPackDownload(
    request: ModelPackDownloadRequest,
    onUpdate?: (status: ModelPackStatus) => void,
  ): Promise<ModelPackStatus> {
    this.ensureRuntimeDirs()
    const { id } = request
    const descriptor = getModelPackDescriptor(id)
    if (this.modelPackDownloads.has(id)) {
      return this.getModelPackStatus(id)
    }

    const source = request.source ?? 'auto'
    const targetDir = this.getModelPackTargetDir(id)
    const partialDir = this.getModelPackPartialDir(id)

    if (this.getMissingModelPackFiles(id, targetDir).length === 0) {
      const now = new Date().toISOString()
      this.modelPackDownloadStatuses.set(id, {
        ...createDefaultModelPackDownloadStatus(),
        source,
        targetDir,
        startedAt: now,
        updatedAt: now,
        completedAt: now,
        lastMessage: '模型已存在',
        progressPercent: 100,
      })
      return this.getModelPackStatus(id)
    }

    const install = await this.ensureSkillInstalled('video-expert-analyzer')
    if (!install.success) {
      throw new Error(install.error || '无法准备视频分析运行时')
    }
    const python = await this.ensurePythonVenv()
    const resolved = await resolveModelProvider(descriptor, source, (url) => this.probeEndpointLatency(url))

    mkdirSync(partialDir, { recursive: true })
    const now = new Date().toISOString()
    this.modelPackDownloadStatuses.set(id, {
      running: true,
      source,
      resolvedProvider: resolved.provider,
      targetDir,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      lastMessage: `开始下载 ${descriptor.displayName}（来源：${this.describeModelProvider(resolved)}）`,
      progressPercent: null,
    })

    const script = buildModelPackDownloadScript(resolved.provider, resolved.repoId)
    const env = this.buildModelPackDownloadEnv(resolved)
    const child = spawn(python, ['-c', script, partialDir], { cwd: this.runtimeRoot, env })
    this.modelPackDownloads.set(id, child)

    const publish = (): void => {
      onUpdate?.(this.getModelPackStatus(id))
    }
    const patch = (next: Partial<ModelPackDownloadStatus>): void => {
      this.modelPackDownloadStatuses.set(id, { ...this.getModelPackDownloadState(id), ...next })
    }
    const ingest = (chunk: Buffer): void => {
      const lines = chunk.toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const lastLine = lines[lines.length - 1]
      if (!lastLine) return
      patch({
        updatedAt: new Date().toISOString(),
        lastMessage: lastLine.startsWith(MODEL_PACK_DONE_MARKER) ? lastLine.slice(MODEL_PACK_DONE_MARKER.length) : lastLine,
        progressPercent: this.parseDownloadProgressPercent(lastLine) ?? this.getModelPackDownloadState(id).progressPercent,
      })
      publish()
    }

    child.stdout.on('data', ingest)
    child.stderr.on('data', ingest)
    child.on('error', (error) => {
      this.modelPackDownloads.delete(id)
      patch({
        running: false,
        updatedAt: new Date().toISOString(),
        completedAt: null,
        error: error.message,
        lastMessage: error.message,
      })
      publish()
    })
    child.on('close', (code) => {
      this.modelPackDownloads.delete(id)
      const completedAt = new Date().toISOString()
      const installError = this.finalizeModelPackDownload(id, code)
      const success = installError === null
      patch({
        running: false,
        updatedAt: completedAt,
        completedAt,
        error: installError,
        lastMessage: installError || `${descriptor.displayName} 已准备好`,
        progressPercent: success ? 100 : this.getModelPackDownloadState(id).progressPercent,
      })
      publish()
    })

    publish()
    return this.getModelPackStatus(id)
  }

  cancelModelPackDownload(id: ModelPackId): ModelPackStatus {
    const child = this.modelPackDownloads.get(id)
    if (child) {
      child.kill()
      this.modelPackDownloads.delete(id)
      this.modelPackDownloadStatuses.set(id, {
        ...this.getModelPackDownloadState(id),
        running: false,
        updatedAt: new Date().toISOString(),
        lastMessage: '已取消下载（已保留断点，可继续）',
      })
    }
    return this.getModelPackStatus(id)
  }

  // Lightweight diagnostic for the Settings supplementary-download feature: per
  // pack × per source it resolves the provider coordinates, probes the endpoint
  // for reachability/latency, and confirms the download script builds — proving
  // the 国内/国外 auto-switch is wired correctly WITHOUT pulling any weights. It
  // also exercises the resume-preserve + atomic-install path on a scratch dir
  // (never touching real packs). The latency probe is injected so the test is
  // network-free; endpoint URLs are de-duplicated within a run.
  async selfTestModelPacks(
    probe: (url: string) => Promise<number | null> = (url) => this.probeEndpointLatency(url),
  ): Promise<ModelPackSelfTestReport> {
    this.ensureRuntimeDirs()
    const startedAt = new Date().toISOString()
    const latencyByUrl = new Map<string, number | null>()
    const probeOnce = async (url: string): Promise<number | null> => {
      if (latencyByUrl.has(url)) return latencyByUrl.get(url) ?? null
      const latency = await probe(url)
      latencyByUrl.set(url, latency)
      return latency
    }

    const entries: ModelPackSelfTestEntry[] = []
    for (const id of MODEL_PACK_IDS) {
      const descriptor = getModelPackDescriptor(id)
      const probes: ModelPackSourceProbe[] = []
      for (const source of ['domestic', 'overseas'] as const) {
        let coordinatesOk = false
        let endpoint = ''
        let provider: ModelPackSourceProbe['provider'] = 'modelscope'
        let latencyMs: number | null = null
        try {
          const resolved = resolveExplicitModelProvider(descriptor, source)
          provider = resolved.provider
          endpoint = resolvedProviderEndpoint(resolved)
          const script = buildModelPackDownloadScript(resolved.provider, resolved.repoId)
          coordinatesOk = resolved.repoId.length > 0 && script.includes(resolved.repoId)
          latencyMs = await probeOnce(endpoint)
        } catch {
          // silent-catch: a source with no provider or a script-build failure is
          // a self-test finding, captured as coordinatesOk=false on this probe
          // row; it must not abort the rest of the report.
          coordinatesOk = false
        }
        probes.push({
          source,
          provider,
          endpoint,
          reachable: latencyMs !== null,
          latencyMs,
          coordinatesOk,
        })
      }
      const integrity = this.runModelPackIntegrityScratchCheck(descriptor.requiredFiles)
      entries.push({
        id,
        displayName: descriptor.displayName,
        probes,
        anyReachable: probes.some((p) => p.reachable),
        integrityOk: integrity.ok,
        integrityDetail: integrity.detail,
      })
    }

    return { startedAt, finishedAt: new Date().toISOString(), entries }
  }

  // Proves the resume-preserve + atomic-install filesystem path works in this
  // environment, on a throwaway scratch dir under models/ — mirroring
  // finalizeModelPackDownload's semantics (incomplete partial is detected and
  // kept; a complete partial renames into place and the partial disappears)
  // without ever touching a real pack dir.
  private runModelPackIntegrityScratchCheck(
    requiredFiles: readonly string[],
  ): { ok: boolean; detail: string } {
    const base = join(this.runtimeRoot, 'models', `.selftest-${randomUUID()}`)
    const partial = `${join(base, 'pack')}.partial`
    const target = join(base, 'pack')
    const missingIn = (dir: string): string[] =>
      requiredFiles.filter((file) => {
        try {
          return !statSync(join(dir, file)).isFile()
        } catch {
          // silent-catch: an absent path is exactly a missing required file.
          return true
        }
      })
    try {
      mkdirSync(partial, { recursive: true })
      // Resume-preserve: an incomplete partial must be detected as missing files
      // and the partial dir kept (so a re-invocation resumes), never installed.
      if (requiredFiles.length > 0) {
        writeFileSync(join(partial, requiredFiles[0]), 'selftest')
      }
      if (missingIn(partial).length === 0 && requiredFiles.length > 1) {
        return { ok: false, detail: '完整性自检异常：不完整下载未被识别为缺失' }
      }
      if (!existsSync(partial)) {
        return { ok: false, detail: '断点续传自检失败：未完成的下载目录被提前删除' }
      }
      // Atomic install: a complete partial renames into place; partial disappears.
      for (const file of requiredFiles) writeFileSync(join(partial, file), 'selftest')
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      renameSync(partial, target)
      const installedMissing = missingIn(target)
      if (installedMissing.length > 0) {
        return { ok: false, detail: `原子安装自检失败：安装目录缺少 ${installedMissing.join('、')}` }
      }
      if (existsSync(partial)) {
        return { ok: false, detail: '原子安装自检失败：安装后仍残留未完成目录' }
      }
      return { ok: true, detail: '断点续传与原子安装路径正常' }
    } catch (error) {
      // silent-catch: a filesystem failure during the scratch check IS the finding —
      // it is surfaced to the caller as integrityOk=false with this message in the
      // self-test report (not swallowed), and one pack's failure must not abort the
      // rest of the report; the finally still removes the throwaway scratch dir.
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  private getModelPackTargetDir(id: ModelPackId): string {
    return join(this.runtimeRoot, 'models', getModelPackDescriptor(id).targetSubdir)
  }

  private getModelPackPartialDir(id: ModelPackId): string {
    return `${this.getModelPackTargetDir(id)}.partial`
  }

  private getModelPackDownloadState(id: ModelPackId): ModelPackDownloadStatus {
    return this.modelPackDownloadStatuses.get(id) ?? createDefaultModelPackDownloadStatus()
  }

  private getMissingModelPackFiles(id: ModelPackId, targetDir: string): string[] {
    return getModelPackDescriptor(id).requiredFiles.filter((file) => {
      try {
        return !statSync(join(targetDir, file)).isFile()
      } catch {
        // silent-catch: statSync throws (ENOENT) when the path is absent; an absent path is exactly a missing required model file, so report it as missing.
        return true
      }
    })
  }

  // Atomic install on a clean download: verify the partial dir holds every
  // required file, then swap it into place. A non-zero exit keeps the partial
  // dir so a re-invocation of snapshot_download resumes. Returns an error string
  // on failure, or null on a successful install.
  private finalizeModelPackDownload(id: ModelPackId, code: number | null): string | null {
    const targetDir = this.getModelPackTargetDir(id)
    const partialDir = this.getModelPackPartialDir(id)
    if (code !== 0) {
      return `下载进程以退出码 ${code ?? 'null'} 结束（已保留断点，可继续）`
    }
    const missing = this.getMissingModelPackFiles(id, partialDir)
    if (missing.length > 0) {
      return `下载已结束但缺少必要文件：${missing.join('、')}`
    }
    try {
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
      renameSync(partialDir, targetDir)
      return null
    } catch (error) {
      // silent-catch: a rename/cleanup failure is surfaced to the caller as the
      // returned error string (which becomes the pack's download error in status/UI),
      // and the partial dir is intentionally left in place so a re-invocation resumes.
      return error instanceof Error ? error.message : String(error)
    }
  }

  private describeModelProvider(resolved: ResolvedModelProvider): string {
    if (resolved.provider === 'modelscope') return 'ModelScope（国内）'
    return resolved.mirrorEndpoint ? 'HuggingFace 镜像（国内）' : 'HuggingFace（国外）'
  }

  // Reachability/latency probe used by 'auto' source resolution. A HEAD request
  // with a short deadline; failures (timeout/DNS/offline) resolve to null so the
  // provider resolver treats the endpoint as unreachable and tries the next one.
  private async probeEndpointLatency(url: string): Promise<number | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2500)
    const start = Date.now()
    try {
      await fetch(url, { method: 'HEAD', signal: controller.signal })
      return Date.now() - start
    } catch {
      // silent-catch: a probe miss just means this endpoint is not a viable 'auto' source; resolveModelProvider treats null as unreachable and falls back to the next candidate. There is no user-facing state to surface for a single probe failure.
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // Nano runtime env (registry-derived). The model id always points the Python
  // loader at the right repo; the absolute dir is injected only when the pack is
  // actually installed so offline mode resolves the local weights, while dev
  // mode (pack absent) can still fall through to its own resolution.
  private buildFunasrNanoRuntimeEnv(): Record<string, string> {
    const descriptor = getModelPackDescriptor('funasr-nano')
    const repoId = descriptor.providers.find((p) => p.provider === 'huggingface')?.repoId
      ?? descriptor.providers[0].repoId
    const env: Record<string, string> = {
      READY_FUNASR_NANO_MODEL_ID: repoId,
      READY_FUNASR_NANO_AUTO_DOWNLOAD: '0',
    }
    const modelDir = this.getModelPackTargetDir('funasr-nano')
    if (this.getMissingModelPackFiles('funasr-nano', modelDir).length === 0) {
      env.READY_FUNASR_NANO_MODEL_DIR = modelDir
    }
    return env
  }

  // Fallback ASR + punctuation env. Mirrors the Nano bridge: model ids are
  // always exported (so the Python defaults stay in sync with the registry),
  // absolute dirs only when each pack is installed. In packaged mode we also set
  // REQUIRE_LOCAL_MODELS so the Python side emits a structured missing-pack
  // signal instead of silently reaching for the network shorthands.
  private buildFunasrFallbackModelEnv(options: { packaged: boolean }): Record<string, string> {
    const asr = getModelPackDescriptor('funasr-fallback-asr')
    const punc = getModelPackDescriptor('funasr-punc-ctc')
    const env: Record<string, string> = {
      READY_FUNASR_ASR_MODEL_ID: asr.providers[0].repoId,
      READY_FUNASR_PUNC_MODEL_ID: punc.providers[0].repoId,
    }
    const asrDir = this.getModelPackTargetDir('funasr-fallback-asr')
    if (this.getMissingModelPackFiles('funasr-fallback-asr', asrDir).length === 0) {
      env.READY_FUNASR_ASR_MODEL_DIR = asrDir
    }
    const puncDir = this.getModelPackTargetDir('funasr-punc-ctc')
    if (this.getMissingModelPackFiles('funasr-punc-ctc', puncDir).length === 0) {
      env.READY_FUNASR_PUNC_MODEL_DIR = puncDir
    }
    if (options.packaged) {
      env.READY_FUNASR_REQUIRE_LOCAL_MODELS = '1'
    }
    return env
  }

  // Online download env for a resolved provider: start from the base env, drop
  // every offline flag, point caches at the writable runtime cache, and route
  // HuggingFace through the mirror endpoint when the domestic HF route is chosen.
  private buildModelPackDownloadEnv(resolved: ResolvedModelProvider): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...this.getBaseEnv(),
      HF_HOME: join(this.cacheRoot, 'huggingface'),
      XDG_CACHE_HOME: this.cacheRoot,
      MODELSCOPE_CACHE: join(this.cacheRoot, 'modelscope'),
    }
    delete env.HF_HUB_OFFLINE
    delete env.TRANSFORMERS_OFFLINE
    delete env.MODELSCOPE_OFFLINE
    delete env.PIP_NO_INDEX
    if (resolved.provider === 'huggingface' && resolved.mirrorEndpoint) {
      env.HF_ENDPOINT = resolved.mirrorEndpoint
    }
    return env
  }

  private parseDownloadProgressPercent(line: string): number | null {
    const match = line.match(/(\d{1,3})%\|/)
      || line.match(/(\d{1,3})%/)
    if (!match) return null
    const parsed = Number(match[1])
    if (!Number.isFinite(parsed)) return null
    return Math.max(0, Math.min(100, parsed))
  }

  private resolveConfiguredAgentContext(definition: SkillDefinition): AgentSpawnContext | null {
    if (definition.id !== 'video-expert-analyzer') return null
    const values = this.skillConfigurationStore.getValues(definition)
    const serviceId = values.serviceBindings.visionModel || 'vision-model-default'
    return this.externalServiceStore.buildVisionAgentContext(serviceId)
  }

  private requiresExternalEnv(definition: SkillDefinition): boolean {
    return definition.id === 'lets-go-rss'
      || definition.id === 'video-copy-analyzer'
      || definition.id === 'video-expert-analyzer'
      || Boolean(definition.configuration?.serviceBindings?.length)
  }

  private async resolveExternalEnv(definition: SkillDefinition): Promise<Record<string, string>> {
    if (!this.requiresExternalEnv(definition)) return {}
    // U0.2 — fail-fast: previously these catches swallowed config-load failures
    // and let the sub-agent start with a partial / empty env, which consumed
    // VEA / RSS budget before crashing deep in the long task. Throwing here
    // makes the failure surface immediately as a blocked task projection.
    let env: Record<string, string>
    try {
      env = this.externalServiceStore.getSkillExternalEnv(definition.id)
    } catch (err) {
      logAgentMetric('runtime.config.load_failed', {
        skillId: definition.id,
        source: 'external_service_store',
      })
      throw new Error(
        `SkillRuntimeConfigError(external_service_unavailable): cannot resolve external env for ${definition.id} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (
      definition.id !== 'lets-go-rss'
      && definition.id !== 'video-copy-analyzer'
      && definition.id !== 'video-expert-analyzer'
    ) {
      return env
    }

    let values
    try {
      values = this.skillConfigurationStore.getValues(definition)
    } catch (err) {
      logAgentMetric('runtime.config.load_failed', {
        skillId: definition.id,
        source: 'skill_configuration_store',
      })
      throw new Error(
        `SkillRuntimeConfigError(skill_configuration_corrupt): cannot read skill configuration for ${definition.id} — ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (definition.id === 'lets-go-rss') {
      const serviceId = values.serviceBindings.rsshub || 'rsshub-default'
      const rsshub = this.externalServiceStore.getRuntimeService(serviceId)
      if (rsshub?.enabled && rsshub.baseUrl) {
        env.RSSHUB_BASE_URL = rsshub.baseUrl.replace(/\/+$/, '')
      }
    }

    if (definition.id === 'video-copy-analyzer' || definition.id === 'video-expert-analyzer') {
      const serviceId = values.serviceBindings.bilibili || 'bilibili-default'
      const bilibili = this.externalServiceStore.getRuntimeService(serviceId)
      if (bilibili?.enabled) {
        if (bilibili.secrets.sessdata) env.BILIBILI_SESSDATA = bilibili.secrets.sessdata
        if (bilibili.secrets.biliJct) env.BILIBILI_BILI_JCT = bilibili.secrets.biliJct
        const cookieFile = bilibili.options.cookieFile
        if (typeof cookieFile === 'string' && cookieFile.trim()) env.BILIBILI_COOKIE_FILE = cookieFile.trim()
      }
      const youtubeCookieFile = await this.exportBrowserYoutubeCookies()
      if (youtubeCookieFile) env.YOUTUBE_COOKIE_FILE = youtubeCookieFile
      Object.assign(
        env,
        this.buildFunasrNanoRuntimeEnv(),
        this.buildFunasrFallbackModelEnv({ packaged: !!this.packagedRuntimeRoot }),
      )
    }

    return env
  }

  private async exportBrowserYoutubeCookies(): Promise<string | null> {
    if (!session?.fromPartition) return null
    try {
      const browserSession = session.fromPartition('persist:browser')
      const cookies = await browserSession.cookies.get({})
      const scoped = cookies.filter((cookie) => {
        const domain = String(cookie.domain || '').toLowerCase()
        return domain === 'youtube.com'
          || domain.endsWith('.youtube.com')
          || domain === 'google.com'
          || domain.endsWith('.google.com')
      })
      if (scoped.length === 0) return null
      const cookiePath = join(this.runtimeRoot, `.ready-youtube-cookies-${randomUUID()}.txt`)
      const lines = [
        '# Netscape HTTP Cookie File',
        ...scoped.map((cookie) => {
          const domain = String(cookie.domain || '')
          const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
          const path = cookie.path || '/'
          const secure = cookie.secure ? 'TRUE' : 'FALSE'
          const expires = typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)
            ? Math.floor(cookie.expirationDate)
            : 0
          return [
            domain,
            includeSubdomains,
            path,
            secure,
            String(expires),
            cookie.name,
            cookie.value,
          ].join('\t')
        }),
      ]
      writeFileSync(cookiePath, `${lines.join('\n')}\n`, { encoding: 'utf-8', mode: 0o600 })
      return cookiePath
    } catch (error) {
      logAgentMetric('runtime.youtube_cookie_export_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private cleanupExportedYoutubeCookieFile(cookiePath: string | undefined): void {
    if (!cookiePath || !cookiePath.startsWith(this.runtimeRoot) || !cookiePath.includes('.ready-youtube-cookies-')) return
    try {
      rmSync(cookiePath, { force: true })
    } catch {
      // silent-catch: best-effort cleanup for a per-run temporary cookie export.
    }
  }

  private shouldPrepareSkillHost(requirements: import('../../../shared/skill-host-contract').SkillHostRequirements | null): boolean {
    return Boolean(requirements?.spawn_context || requirements?.concurrency)
  }

  /**
   * Phase 1 gap fix — exposes the shared venv bin dir so `skill_run_shell`
   * can prepend it to PATH. Mirrors the calculation in `getBaseEnv()` so
   * primitives and the legacy workflow runner see the same Python env.
   * Returns the path unconditionally; a non-existent entry in PATH is
   * harmless, and pre-installing the venv on every boot just to satisfy
   * this getter would add startup latency for no gain.
   */
  getSharedVenvBinDir(options: { allowPackaged?: boolean } = {}): string {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged && this.packagedRuntimeRoot) {
      return getPackagedSkillPythonBinDir(this.packagedRuntimeRoot)
    }
    return process.platform === 'win32'
      ? join(this.venvRoot, 'Scripts')
      : join(this.venvRoot, 'bin')
  }

  getRuntimeBinDir(options: { allowPackaged?: boolean } = {}): string {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged && this.packagedRuntimeRoot) {
      return getPackagedSkillRuntimeBinDir(this.packagedRuntimeRoot)
    }
    return this.runtimeBin
  }

  getRuntimeEnv(options: { allowPackaged?: boolean } = {}): NodeJS.ProcessEnv {
    return this.getBaseEnv(options)
  }

  // Phase 4: the skill_executions state machine is retired. The following
  // APIs have been removed along with the private store/coordinator getters:
  //   listExecutions / getExecution / submitExecutionInput /
  //   submitExecutionConfirmation / submitExecutionAgentResult /
  //   restartExecutionFromStep / cancelExecution / getExecutionStore /
  //   getExecutionCoordinator / executeWorkflowRuntimeAction /
  //   toWorkflowRunResult
  //
  // All skill actions now run through runDefinitionActionDirect (direct
  // subprocess) or tryInlineReferenceSkillDoc (SKILL.md load). Progress
  // tracking moves to the in-memory SkillTaskTracker in PR2.

  async runEmbeddedPython(params: {
    code?: string
    scriptPath?: string
    args?: string[]
    cwd?: string
    timeoutMs?: number
  }): Promise<{ success: boolean; stdout: string; stderr: string; command: string[]; error?: string }> {
    this.ensureRuntimeDirs()
    const venvPython = await this.ensurePythonVenv()
    let scriptPath = params.scriptPath || ''
    if (!scriptPath) {
      const code = String(params.code || '').trim()
      if (!code) {
        return { success: false, stdout: '', stderr: '', command: [], error: 'Missing code or scriptPath' }
      }
      const scriptDir = join(this.runtimeRoot, 'tmp-python')
      mkdirSync(scriptDir, { recursive: true })
      scriptPath = join(scriptDir, `ready-embedded-${randomUUID()}.py`)
      writeFileSync(scriptPath, `${code}\n`, 'utf-8')
    }
    const command = [venvPython, scriptPath, ...((params.args || []).map((item) => String(item)))]
    try {
      const { stdout, stderr } = await execFileAsync(venvPython, [scriptPath, ...((params.args || []).map((item) => String(item)))], {
        cwd: params.cwd || this.runtimeRoot,
        timeout: Math.max(1_000, params.timeoutMs || DEFAULT_TIMEOUT_MS),
        maxBuffer: MAX_COMMAND_BUFFER,
        env: this.getBaseEnv(),
      })
      return {
        success: true,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        command,
        error: err.message,
      }
    }
  }

  importCustomSkill(sourcePath: string): SkillState {
    this.ensureRuntimeDirs()
    // Stage S W11.2 — security scan BEFORE we copy the user's skill folder
    // into the managed customSkillsRoot. Critical issues (rm -rf /, curl|sh,
    // path traversal, …) hard-block install — we surface a structured Error
    // with all issues in the message so the IPC layer can show them to the
    // user.
    const scan = scanSkillDirectory(sourcePath)
    if (!scan.ok) {
      const summary = scan.issues
        .filter((issue) => issue.severity === 'critical')
        .slice(0, 5)
        .map((issue) => `${issue.pattern} @ ${issue.file}${issue.excerpt ? ` :: ${issue.excerpt}` : ''}`)
        .join('; ')
      throw new Error(`Skill 安全扫描失败: ${summary || '未通过安全检查'}`)
    }
    const record = importCustomSkillFolder(sourcePath, this.customSkillsRoot)
    const definition = this.getSkillLoader().loadSkill(record.id, record.managedPath)
    return this.toSkillState(definition || {
      id: record.id,
      name: record.name,
      description: record.description,
      version: record.version,
      source: 'custom',
      sourcePath: record.sourcePath,
      managedPath: record.managedPath,
      manifestPath: record.manifestPath,
      requirementsFile: record.requirementsFile,
      defaultAction: record.defaultAction,
      actions: record.actions,
      executionMode: record.execution?.mode || 'direct',
      workflow: undefined,
      manifestValid: true,
    })
  }

  removeCustomSkill(skillId: string): { removed: boolean } {
    this.ensureRuntimeDirs()
    return { removed: removeManagedCustomSkill(this.customSkillsRoot, skillId) }
  }

  updateCustomSkillDescription(skillId: string, description: string): SkillState {
    this.ensureRuntimeDirs()
    const record = updateManagedCustomSkillDescription(this.customSkillsRoot, skillId, description)
    const definition = this.getSkillLoader().loadSkill(record.id, record.managedPath)
    return this.toSkillState(definition || {
      id: record.id,
      name: record.name,
      description: record.description,
      version: record.version,
      source: 'custom',
      sourcePath: record.sourcePath,
      managedPath: record.managedPath,
      manifestPath: record.manifestPath,
      requirementsFile: record.requirementsFile,
      defaultAction: record.defaultAction,
      actions: record.actions,
      executionMode: record.execution?.mode || 'direct',
      workflow: undefined,
      manifestValid: true,
    })
  }

  async ensureSkillInstalled(skillId: SkillId, force = false): Promise<SkillInstallResult> {
    if (!force) {
      const ongoing = this.installLocks.get(skillId)
      if (ongoing) return ongoing
    }

    const installTask = this.installSkillInternal(skillId, force)
      .finally(() => {
        this.installLocks.delete(skillId)
      })
    this.installLocks.set(skillId, installTask)
    return installTask
  }

  /**
   * Phase 5 — child-runner internal entry. The skill child runner calls
   * this so its inner action dispatch can never accidentally trip a
   * recursive child-loop wrap (Team 5). For now it's a thin alias of
   * `runSkill`; the wrap routing for "should this be wrapped in a child
   * run?" lives upstream in `skills-tools.ts` (Team 6) anyway, so this
   * method just provides a stable surface the runner can rely on as
   * upstream wrap routing evolves.
   */
  async runSkillFromChildRunner(request: SkillRunRequest): Promise<SkillRunResult> {
    return this.runSkill(request)
  }

  async runSkill(request: SkillRunRequest): Promise<SkillRunResult> {
    const triggerType = request.triggerType || 'manual'
    const jobId = this.recordJobStart({
      skillId: request.skillId,
      action: request.action,
      params: request.params,
      triggerType,
      scheduleId: request.scheduleId || null,
    })
    const finish = (result: SkillRunResult): SkillRunResult => {
      const withJobId = { ...result, jobId }
      this.recordJobFinish(jobId, withJobId)
      return withJobId
    }

    try {
      const resolved = await this.resolveSkillForExecution(request.skillId)
      if (!resolved) {
        return finish(this.invalidParams(request.skillId, request.action, `Unknown skill: ${request.skillId}`))
      }

      const action = resolved.definition.actions.find((item) => item.name === request.action)
      if (!action) {
        return finish(this.invalidParams(resolved.definition.id, request.action, `Unknown action: ${request.action}`))
      }

      // Phase 4: workflow-start branch retired. All skill actions now run
      // through runDefinitionActionDirect. Callers that still pass
      // executionMode='workflow' get a direct run — the requested semantics
      // mapped 1:1 onto direct runs for Phase 2/3 migrated embedded skills
      // anyway, since there are no skill.workflow.json files left.

      // B-arch-4 — Skill Host Contract wiring. Only requirements that need a
      // real host wrapper prepare the declarative spawn environment (config
      // file write, secondary files, env overrides, mutex acquisition) BEFORE
      // running the action. Timeout-only manifests still flow through
      // getEffectiveActionTimeout / detectStatus, but skip the agent-context
      // read cost.
      const controller = this.getHostController()
      const hostRequirements = resolved.definition.hostRequirements ?? null
      const shouldPrepareHost = this.shouldPrepareSkillHost(hostRequirements)
      const skillAssetRoot = resolved.installResult.skillPath || ''
      const effectiveTimeout = Math.max(
        3_000,
        controller.getEffectiveActionTimeout(
          hostRequirements,
          request.timeoutMs || action.timeoutMs,
          DEFAULT_TIMEOUT_MS,
        ),
      )

      let spawnHandle: SpawnContextHandle | null = null
      const rawOutputDir = request.params?.outputDir
      const requestedOutputDir = typeof rawOutputDir === 'string' && rawOutputDir.trim()
        ? rawOutputDir.trim()
        : null
      const actionDeclaresOutputDir = action.inputMode === 'json'
        && action.params.some((param) => param.name === 'outputDir')
      const shouldPrepareOutputDir = shouldPrepareHost || Boolean(requestedOutputDir) || actionDeclaresOutputDir
      const preparedOutputDir = shouldPrepareOutputDir
        ? this.resolveOutputDir(requestedOutputDir, resolved.definition.id, jobId)
        : undefined
      let actionParams = preparedOutputDir && action.inputMode === 'json' && !requestedOutputDir
        ? { ...(request.params || {}), outputDir: preparedOutputDir }
        : (request.params || {})
      const childRunContext = request.params?.__childRunContext && typeof request.params.__childRunContext === 'object'
        ? request.params.__childRunContext as Record<string, unknown>
        : null
      const childRunId = typeof childRunContext?.childRunId === 'string' && childRunContext.childRunId.trim()
        ? childRunContext.childRunId.trim()
        : ''
      const configuredAgentContext = this.resolveConfiguredAgentContext(resolved.definition)
      const effectiveAgentContext = configuredAgentContext ?? request.agentContext ?? null
      if (shouldPrepareHost) {
        spawnHandle = await controller.prepareSpawnContext(
          resolved.definition.id,
          resolved.definition.name,
          skillAssetRoot,
          hostRequirements,
          jobId,
          preparedOutputDir,
          effectiveAgentContext,
        )
      }

      const externalEnv = await this.resolveExternalEnv(resolved.definition)
      const mergedEnv = {
        ...(spawnHandle?.envOverrides || {}),
        ...externalEnv,
        READY_SKILL_TASK_ID: jobId,
        ...(childRunId ? { READY_SKILL_CHILD_RUN_ID: childRunId } : {}),
        ...(request.env || {}),
      }

      try {
        const result = await this.runDefinitionActionDirect(
          resolved.definition,
          action,
          actionParams,
          effectiveTimeout,
          mergedEnv,
          resolved.installResult.venvPython,
          hostRequirements,
          request.signal,
          preparedOutputDir,
        )
        return finish(result)
      } finally {
        this.cleanupExportedYoutubeCookieFile(externalEnv.YOUTUBE_COOKIE_FILE)
        if (spawnHandle) {
          try {
            await controller.restoreSpawnContext(spawnHandle)
          } catch (error) {
            console.warn(
              '[SkillsRuntimeManager] restoreSpawnContext failed for',
              resolved.definition.id,
              ':',
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      }
    } catch (error) {
      return finish(this.invalidParams(
        request.skillId,
        request.action,
        error instanceof Error ? error.message : String(error),
      ))
    }
  }

  private invalidParams(skillId: SkillId, action: string, error: string): SkillRunResult {
    return {
      success: false,
      skillId,
      action,
      stdout: '',
      stderr: '',
      command: [],
      error,
      status: 'error',
    }
  }

  private buildActionArgs(params: Record<string, unknown>, action: SkillActionDefinition): string[] {
    const args = [...(action.baseArgs || [])]
    if (action.inputMode === 'json') {
      if (Object.keys(params).length > 0) {
        args.push('--payload-json', JSON.stringify(params))
      }
      return args
    }
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue
      const flag = `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`
      if (typeof value === 'boolean') {
        if (value) args.push(flag)
        continue
      }
      if (Array.isArray(value)) {
        for (const entry of value) {
          args.push(flag, String(entry))
        }
        continue
      }
      if (typeof value === 'object') {
        args.push(flag, JSON.stringify(value))
        continue
      }
      args.push(flag, String(value))
    }
    return args
  }

  private async resolveSkillForExecution(skillId: SkillId): Promise<{ definition: SkillDefinition; installResult: SkillInstallResult } | null> {
    this.ensureRuntimeDirs()
    const installResult = await this.ensureSkillInstalled(skillId)
    if (!installResult.success || !installResult.skillPath) {
      if (installResult.error && !installResult.error.startsWith(`Unknown skill: ${skillId}`)) {
        throw new Error(`Skill install failed for ${skillId}: ${installResult.error}`)
      }
      return null
    }
    const definition = this.getSkillLoader().loadSkill(skillId, installResult.skillPath)
    if (!definition) {
      return null
    }
    return { definition, installResult }
  }

  private async runDefinitionActionDirect(
    definition: SkillDefinition,
    action: SkillActionDefinition,
    params: Record<string, unknown>,
    timeoutMs: number,
    envOverrides?: Record<string, string>,
    venvPython?: string,
    hostRequirements?: import('../../../shared/skill-host-contract').SkillHostRequirements | null,
    signal?: AbortSignal,
    preparedOutputDir?: string,
  ): Promise<SkillRunResult> {
    const skillPath = definition.source === 'embedded'
      ? this.getSkillRuntimePath(definition.id)
      : (definition.managedPath || definition.sourcePath)
    const entryPath = join(skillPath, action.entry)

    let result: SkillRunResult
    if (action.runtime === 'reference') {
      // Reference skills are advisory/guidance loads — readFileSync of SKILL.md
      // with no subprocess, no side-effects, no execution state to track. The
      // previous implementation faked `command: ['read', path]` which caused
      // formatRunResult to wrap the content in "Command: read .../SKILL.md\n
      // STDOUT:\n..." — confusing the model into thinking a shell executed and
      // sometimes triggering a follow-up `skill_get_state` probe for an
      // execution that never exists. `mode: 'reference'` lets formatRunResult
      // render the file content with a compact guidance header instead.
      try {
        const stdout = readFileSync(entryPath, 'utf-8')
        result = {
          success: true,
          skillId: definition.id,
          action: action.name,
          stdout: truncateOutput(stdout),
          stderr: '',
          command: [],
          mode: 'reference',
        }
      } catch (error) {
        result = {
          success: false,
          skillId: definition.id,
          action: action.name,
          stdout: '',
          stderr: '',
          command: [],
          error: error instanceof Error ? error.message : String(error),
          mode: 'reference',
        }
      }
    } else {
      const args = this.buildActionArgs(params, action)
      if (action.runtime === 'python') {
        if (!venvPython) {
          return this.invalidParams(definition.id, action.name, 'Python skill runtime is unavailable')
        }
        result = await this.runDirectScript(
          definition.id,
          skillPath,
          action,
          venvPython,
          [entryPath, ...args],
          timeoutMs,
          envOverrides,
          signal,
          definition.source === 'embedded',
        )
      } else if (action.runtime === 'node') {
        result = await this.runDirectScript(
          definition.id,
          skillPath,
          action,
          'node',
          [entryPath, ...args],
          timeoutMs,
          envOverrides,
          signal,
          definition.source === 'embedded',
        )
      } else {
        result = await this.runDirectScript(
          definition.id,
          skillPath,
          action,
          entryPath,
          args,
          timeoutMs,
          envOverrides,
          signal,
          definition.source === 'embedded',
        )
      }
    }

    // B-arch-4 — backfill SkillRunResult.status via the host controller's
    // detectStatus. Without host_requirements this defaults to exit_code
    // mapping (success → 'done', failure → 'error'), preserving legacy
    // semantics. With host_requirements declaring `status_detection`, the
    // controller can return 'blocked' even when exitCode === 0 — e.g. a
    // staged pipeline that wrote `{"status":"blocked"}` to its sentinel
    // file because it's waiting on a user decision. Reference actions go
    // through this path too so a reference skill that declares
    // status_detection still benefits from the override (rare but allowed).
    try {
      const controller = this.getHostController()
      const inferredExitCode = result.success ? 0 : 1
      const status = await controller.detectStatus(
        hostRequirements ?? null,
        { exitCode: inferredExitCode, stdout: result.stdout || '', stderr: result.stderr || '' },
        result.outputDir || preparedOutputDir,
      )
      result.status = mergeSkillRunStatus(result.status, status.status)
    } catch (error) {
      // detectStatus must never break the skill run — fall back to legacy
      // success-mapping. Telemetry surfaces via the warn log.
      console.warn(
        '[SkillsRuntimeManager] detectStatus failed for',
        definition.id,
        action.name,
        ':',
        error instanceof Error ? error.message : String(error),
      )
      result.status = result.status || (result.success ? 'done' : 'error')
    }
    if (!result.outputDir && preparedOutputDir) {
      result.outputDir = preparedOutputDir
    }
    return result
  }

  private async runDirectScript(
    skillId: SkillId,
    cwd: string,
    action: SkillActionDefinition,
    commandBin: string,
    commandArgs: string[],
    timeoutMs: number,
    envOverrides?: Record<string, string>,
    signal?: AbortSignal,
    allowPackagedRuntime?: boolean,
  ): Promise<SkillRunResult> {
    const executed = await this.executeProcessWithStructuredResult({
      skillId,
      actionName: action.name,
      runtime: action.runtime,
      cwd,
      commandBin,
      commandArgs,
      timeoutMs,
      envOverrides,
      signal,
      allowPackagedRuntime,
      preferStructuredResult: true,
    })
    return this.toDirectRunResult(skillId, action.name, executed)
  }

  // Phase 4: executeWorkflowRuntimeAction removed along with the
  // skill_executions state machine. All skill actions run through
  // runDefinitionActionDirect now.

  private createStructuredResultPath(skillId: string, actionName: string): string {
    const dir = join(this.runtimeRoot, 'results')
    mkdirSync(dir, { recursive: true })
    return join(dir, `${skillId}-${actionName}-${randomUUID()}.json`)
  }

  private async executeProcessWithStructuredResult(params: {
    skillId: string
    actionName: string
    runtime: SkillRuntimeKind
    cwd: string
    commandBin: string
    commandArgs: string[]
    timeoutMs: number
    envOverrides?: Record<string, string>
    signal?: AbortSignal
    allowPackagedRuntime?: boolean
    preferStructuredResult: boolean
  }): Promise<{
    success: boolean
    stdout: string
    stderr: string
    command: string[]
    error?: string
    outputDir?: string
    structuredResult?: SkillActionResult
    /**
     * C6 — populated when stdout/stderr exceeded the in-memory cap and surplus
     * was spilled to a per-action `.logs/` artifact under
     * `<runtimeRoot>/outputs/<skillId>/`. `*Error` is populated instead when
     * the disk write itself failed; the command result is still returned in
     * either case so the caller never sees a thrown error from a log spill.
     */
    stdoutArtifactPath?: string
    stderrArtifactPath?: string
    stdoutArtifactError?: string
    stderrArtifactError?: string
  }> {
    const command = [params.commandBin, ...params.commandArgs]
    const resultPath = params.preferStructuredResult ? this.createStructuredResultPath(params.skillId, params.actionName) : null
    const env = {
      ...this.getBaseEnv({ allowPackaged: params.allowPackagedRuntime ?? true }),
      ...(params.envOverrides || {}),
      ...(resultPath ? { READY_SKILL_RESULT_PATH: resultPath } : {}),
    }

    // C6 — overflow-to-disk plumbing. We pre-compute the per-stream artifact
    // paths under `<outputsRoot>/<skillId>/.logs/` and lazy-create the directory
    // on the first spilled chunk (so skills whose output stays under 1 MiB
    // never touch the filesystem). The sinks close over the dir-creation state
    // so a single mkdir failure short-circuits subsequent appends without
    // taking the command down with it.
    const logId = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const logsDir = join(this.outputsRoot, params.skillId, '.logs')
    const stdoutLogPath = join(logsDir, `skill-action-${logId}-stdout.txt`)
    const stderrLogPath = join(logsDir, `skill-action-${logId}-stderr.txt`)

    let logsDirReady: boolean | null = null // null = untried; true = ok; false = mkdir failed
    let logsDirError: string | null = null
    const ensureLogsDir = (): boolean => {
      if (logsDirReady !== null) return logsDirReady
      try {
        mkdirSync(logsDir, { recursive: true })
        logsDirReady = true
      } catch (err) {
        logsDirReady = false
        logsDirError = err instanceof Error ? err.message : String(err)
        console.warn('[SkillsRuntimeManager] failed to create skill log dir', logsDir, ':', logsDirError)
      }
      return logsDirReady
    }

    let stdoutWritten = false
    let stderrWritten = false
    let stdoutWriteError: string | null = null
    let stderrWriteError: string | null = null

    const stdoutSink = (chunk: string): void => {
      if (!ensureLogsDir()) {
        if (!stdoutWriteError) stdoutWriteError = logsDirError || 'logs directory unavailable'
        return
      }
      try {
        appendFileSync(stdoutLogPath, chunk, 'utf-8')
        stdoutWritten = true
      } catch (err) {
        if (!stdoutWriteError) stdoutWriteError = err instanceof Error ? err.message : String(err)
      }
    }
    const stderrSink = (chunk: string): void => {
      if (!ensureLogsDir()) {
        if (!stderrWriteError) stderrWriteError = logsDirError || 'logs directory unavailable'
        return
      }
      try {
        appendFileSync(stderrLogPath, chunk, 'utf-8')
        stderrWritten = true
      } catch (err) {
        if (!stderrWriteError) stderrWriteError = err instanceof Error ? err.message : String(err)
      }
    }

    // NOTE: switched from execFileAsync's built-in `timeout` to spawnWithTreeKill
    // because execFile only sends SIGTERM to the immediate child. Skill scripts
    // routinely fork ffmpeg / yt-dlp / browsers, and those grandchildren get
    // orphaned on timeout. The shared helper spawns with `detached:true` on
    // Unix so we can `process.kill(-pid, SIGTERM)` the whole group, then
    // escalate to SIGKILL after a 5s grace. Windows falls back to `child.kill`
    // (no process groups). Return shape kept identical for upstream callers.
    //
    // C6 — also wires per-stream caps + sinks so output beyond 1 MiB per
    // stream spills to `<outputsRoot>/<skillId>/.logs/skill-action-<id>-<stream>.txt`
    // instead of buffering up to 24 MiB in memory (or worse, OOMing on a
    // multi-hour ffmpeg run).
    // Truncate first, THEN append the marker — `truncateOutput` (the legacy
    // 18K-char head used by tool-result envelopes) would otherwise eat the
    // marker because `raw` is up to 1 MiB.
    const buildResultStdout = (raw: string, overflowed: boolean): string => {
      const head = truncateOutput(raw)
      if (!overflowed) return head
      const target = stdoutWritten
        ? `(... output truncated; full log at: ${stdoutLogPath})`
        : stdoutWriteError
          ? `(... output truncated; overflow log write failed: ${stdoutWriteError})`
          : `(... output truncated)`
      return `${head}\n${target}`
    }
    const buildResultStderr = (raw: string, overflowed: boolean): string => {
      const head = truncateOutput(raw)
      if (!overflowed) return head
      const target = stderrWritten
        ? `(... output truncated; full log at: ${stderrLogPath})`
        : stderrWriteError
          ? `(... output truncated; overflow log write failed: ${stderrWriteError})`
          : `(... output truncated)`
      return `${head}\n${target}`
    }

    try {
      const result = await spawnWithTreeKill(params.commandBin, params.commandArgs, {
        cwd: params.cwd,
        env,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        maxBuffer: MAX_COMMAND_BUFFER,
        inMemoryStdoutCap: DIRECT_ACTION_INMEMORY_CAP,
        inMemoryStderrCap: DIRECT_ACTION_INMEMORY_CAP,
        stdoutOverflowSink: stdoutSink,
        stderrOverflowSink: stderrSink,
      })
      const structuredResult = resultPath && existsSync(resultPath)
        ? this.parseJson<SkillActionResult>(readFileSync(resultPath, 'utf-8'), undefined as never)
        : undefined
      const outputDir = structuredResult?.outputs && typeof structuredResult.outputs.outputDir === 'string'
        ? structuredResult.outputs.outputDir
        : undefined
      return {
        success: true,
        stdout: buildResultStdout(result.stdout || structuredResult?.logs.stdout || '', result.stdoutOverflowed),
        stderr: buildResultStderr(result.stderr || structuredResult?.logs.stderr || '', result.stderrOverflowed),
        command,
        outputDir,
        structuredResult,
        stdoutArtifactPath: stdoutWritten ? stdoutLogPath : undefined,
        stderrArtifactPath: stderrWritten ? stderrLogPath : undefined,
        stdoutArtifactError: result.stdoutOverflowed && !stdoutWritten ? (stdoutWriteError ?? undefined) : undefined,
        stderrArtifactError: result.stderrOverflowed && !stderrWritten ? (stderrWriteError ?? undefined) : undefined,
      }
    } catch (error) {
      const err = error as SpawnWithTreeKillError
      const structuredResult = resultPath && existsSync(resultPath)
        ? this.parseJson<SkillActionResult>(readFileSync(resultPath, 'utf-8'), undefined as never)
        : undefined
      const outputDir = structuredResult?.outputs && typeof structuredResult.outputs.outputDir === 'string'
        ? structuredResult.outputs.outputDir
        : undefined
      return {
        success: structuredResult?.ok || false,
        stdout: buildResultStdout((err.stdout as string | undefined) || structuredResult?.logs.stdout || '', err.stdoutOverflowed === true),
        stderr: buildResultStderr((err.stderr as string | undefined) || structuredResult?.logs.stderr || '', err.stderrOverflowed === true),
        command,
        outputDir,
        structuredResult,
        error: params.runtime === 'node' && err.message.includes('ENOENT')
          ? 'Node.js runtime not found. Please install Node.js or use python/shell based custom skills.'
          : (structuredResult?.error?.message || err.message),
        stdoutArtifactPath: stdoutWritten ? stdoutLogPath : undefined,
        stderrArtifactPath: stderrWritten ? stderrLogPath : undefined,
        stdoutArtifactError: err.stdoutOverflowed && !stdoutWritten ? (stdoutWriteError ?? undefined) : undefined,
        stderrArtifactError: err.stderrOverflowed && !stderrWritten ? (stderrWriteError ?? undefined) : undefined,
      }
    }
  }

  private toDirectRunResult(
    skillId: string,
    actionName: string,
    executed: {
      success: boolean
      stdout: string
      stderr: string
      command: string[]
      error?: string
      outputDir?: string
      structuredResult?: SkillActionResult
      stdoutArtifactPath?: string
      stderrArtifactPath?: string
      stdoutArtifactError?: string
      stderrArtifactError?: string
    },
  ): SkillRunResult {
    const structured = executed.structuredResult
    const success = structured ? structured.ok === true : executed.success
    const outputs = structured?.outputs || {}
    const stringOutputs = Object.fromEntries(
      Object.entries(outputs)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
    ) as Record<string, string>
    const extraStdout = [
      typeof outputs.outputDir === 'string' ? `Output directory: ${outputs.outputDir}` : '',
      ...Object.entries(outputs)
        .filter(([key, value]) => key !== 'outputDir' && typeof value === 'string' && value.length > 0)
        .map(([key, value]) => `${key}: ${value}`),
    ].filter(Boolean).join('\n')

    const result: SkillRunResult = {
      success,
      skillId,
      action: actionName,
      stdout: [executed.stdout, extraStdout].filter(Boolean).join('\n').trim(),
      stderr: executed.stderr,
      outputDir: executed.outputDir,
      outputs: Object.keys(stringOutputs).length > 0 ? stringOutputs : undefined,
      command: executed.command,
      error: success ? undefined : (structured?.error?.message || executed.error),
      status: normalizeSkillRunStatus(structured?.status, success),
      mode: 'direct',
      stdoutArtifactPath: executed.stdoutArtifactPath,
      stderrArtifactPath: executed.stderrArtifactPath,
      stdoutArtifactError: executed.stdoutArtifactError,
      stderrArtifactError: executed.stderrArtifactError,
    }

    // Phase 1 (model packs) — single detection point for the structured
    // `__READY_ASR_MODEL_PACK_MISSING__` marker the subtitle extractor prints
    // when required on-demand models are absent in packaged (offline) mode.
    // Every typed-action caller (inline `video_copy_analyze` + child-loop
    // `video_expert_pipeline`) builds its result here, so both surface the same
    // signal. The detailed subprocess error stays in `stderr`; we rewrite
    // `error` to actionable guidance that points the user at the download page.
    if (!result.success) {
      const missing = detectMissingRuntimeDependency(`${result.stdout}\n${result.stderr}`)
      if (missing) {
        result.missingRuntimeDependency = missing
        result.error = '缺少字幕识别所需的本地语音模型，请前往「设置 › 模型与运行时」下载后重试。'
      }
    }

    return result
  }

  // Phase 4: toWorkflowRunResult removed along with the skill_executions
  // state machine.

  listJobs(limit = 80): SkillJobRecord[] {
    const db = this.getRawDatabase()
    if (!db) return []
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    const rows = db.prepare('SELECT * FROM skills_jobs ORDER BY created_at DESC LIMIT ?').all<SkillJobRow>(safeLimit)
    return rows.map((row) => this.mapJobRow(row))
  }

  listSchedules(): SkillScheduleRecord[] {
    const db = this.getRawDatabase()
    if (!db) return []
    const rows = db.prepare('SELECT * FROM skills_schedules ORDER BY created_at DESC').all<SkillScheduleRow>()
    return rows.map((row) => this.mapScheduleRow(row))
  }

  createSchedule(request: CreateSkillScheduleRequest): SkillScheduleRecord {
    const knownSkill = this.listSkills().some((skill) => skill.id === request.skillId)
    if (!knownSkill) {
      throw new Error(`Unknown skill: ${request.skillId}`)
    }

    const db = this.getRawDatabase()
    if (!db) {
      throw new Error('Database not available')
    }

    const intervalMinutes = Math.max(1, Math.floor(request.intervalMinutes))
    const nowIso = new Date().toISOString()
    const parsedStart = request.startAt ? new Date(request.startAt).getTime() : Number.NaN
    const firstRunIso = Number.isFinite(parsedStart)
      ? new Date(parsedStart).toISOString()
      : new Date(Date.now() + intervalMinutes * 60_000).toISOString()
    const id = randomUUID()
    db.prepare(`
      INSERT INTO skills_schedules (
        id, skill_id, action, params_json, interval_minutes, next_run_at, last_run_at, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
    `).run(
      id,
      request.skillId,
      request.action,
      JSON.stringify(request.params || {}),
      intervalMinutes,
      firstRunIso,
      nowIso,
      nowIso,
    )
    this.runSchedulerTickSoon()
    const created = db.prepare('SELECT * FROM skills_schedules WHERE id = ?').all<SkillScheduleRow>(id)[0]
    if (!created) {
      throw new Error('Failed to create schedule')
    }
    return this.mapScheduleRow(created)
  }

  updateScheduleEnabled(scheduleId: string, enabled: boolean): SkillScheduleRecord | null {
    const db = this.getRawDatabase()
    if (!db) return null
    db.prepare('UPDATE skills_schedules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), scheduleId)
    const row = db.prepare('SELECT * FROM skills_schedules WHERE id = ?').all<SkillScheduleRow>(scheduleId)[0]
    if (!row) return null
    this.runSchedulerTickSoon()
    return this.mapScheduleRow(row)
  }

  deleteSchedule(scheduleId: string): boolean {
    const db = this.getRawDatabase()
    if (!db) return false
    db.prepare('DELETE FROM skills_schedules WHERE id = ?').run(scheduleId)
    this.runningScheduleIds.delete(scheduleId)
    return true
  }

  private getRawDatabase(): DatabaseConnection | null {
    try {
      return getDatabase().getDatabase() as DatabaseConnection | null
    } catch {
      return null
    }
  }

  private mapJobRow(row: SkillJobRow): SkillJobRecord {
    return {
      id: row.id,
      skillId: row.skill_id,
      action: row.action,
      status: row.status,
      triggerType: row.trigger_type,
      scheduleId: row.schedule_id,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      stdout: row.stdout || '',
      stderr: row.stderr || '',
      outputDir: row.output_dir,
      error: row.error,
      command: row.command_json ? this.parseJson<string[]>(row.command_json, []) : [],
    }
  }

  private mapScheduleRow(row: SkillScheduleRow): SkillScheduleRecord {
    return {
      id: row.id,
      skillId: row.skill_id,
      action: row.action,
      params: this.parseJson<Record<string, unknown>>(row.params_json || '{}', {}),
      intervalMinutes: row.interval_minutes,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private parseJson<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private recordJobStart(params: {
    skillId: SkillId
    action: string
    params?: Record<string, unknown>
    triggerType: SkillTriggerType
    scheduleId: string | null
  }): string {
    const db = this.getRawDatabase()
    if (!db) return randomUUID()
    const id = randomUUID()
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO skills_jobs (
        id, skill_id, action, params_json, status, trigger_type, schedule_id, created_at, started_at
      ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      id,
      params.skillId,
      params.action,
      JSON.stringify(params.params || {}),
      params.triggerType,
      params.scheduleId,
      now,
      now,
    )
    return id
  }

  private recordJobFinish(jobId: string, result: SkillRunResult): void {
    const db = this.getRawDatabase()
    if (!db) return
    const now = new Date().toISOString()
    const started = db.prepare('SELECT started_at FROM skills_jobs WHERE id = ?').all<{ started_at: string | null }>(jobId)[0]
    const durationMs = started?.started_at ? Math.max(0, Date.now() - new Date(started.started_at).getTime()) : null
    db.prepare(`
      UPDATE skills_jobs
      SET
        status = ?,
        finished_at = ?,
        duration_ms = ?,
        stdout = ?,
        stderr = ?,
        output_dir = ?,
        error = ?,
        command_json = ?
      WHERE id = ?
    `).run(
      result.success ? 'success' : 'failed',
      now,
      durationMs,
      result.stdout,
      result.stderr,
      result.outputDir || null,
      result.error || null,
      JSON.stringify(result.command || []),
      jobId,
    )
  }

  private startScheduler(): void {
    if (this.schedulerTimer) return
    this.schedulerTimer = setInterval(() => {
      void this.tickSchedules()
    }, SCHEDULER_INTERVAL_MS)
    this.runSchedulerTickSoon()
  }

  private runSchedulerTickSoon(): void {
    setTimeout(() => {
      void this.tickSchedules()
    }, 300)
  }

  private async tickSchedules(): Promise<void> {
    const db = this.getRawDatabase()
    if (!db) return
    const nowIso = new Date().toISOString()
    const due = db.prepare(`
      SELECT * FROM skills_schedules
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 20
    `).all<SkillScheduleRow>(nowIso)
    for (const schedule of due) {
      if (this.runningScheduleIds.has(schedule.id)) continue
      this.runningScheduleIds.add(schedule.id)
      void this.runScheduledTask(schedule)
    }
  }

  private async runScheduledTask(schedule: SkillScheduleRow): Promise<void> {
    try {
      const params = this.parseJson<Record<string, unknown>>(schedule.params_json || '{}', {})
      await this.runSkill({
        skillId: schedule.skill_id,
        action: schedule.action,
        params,
        triggerType: 'schedule',
        scheduleId: schedule.id,
      })
      const db = this.getRawDatabase()
      if (!db) return
      const now = Date.now()
      const nextRunAt = new Date(now + Math.max(1, schedule.interval_minutes) * 60_000).toISOString()
      db.prepare(`
        UPDATE skills_schedules
        SET last_run_at = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?
      `).run(new Date(now).toISOString(), nextRunAt, new Date(now).toISOString(), schedule.id)
    } catch {
      // Keep scheduler resilient. Failure details are recorded in skills_jobs.
      const db = this.getRawDatabase()
      if (!db) return
      const retryRunAt = new Date(Date.now() + 5 * 60_000).toISOString()
      db.prepare('UPDATE skills_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(retryRunAt, new Date().toISOString(), schedule.id)
    } finally {
      this.runningScheduleIds.delete(schedule.id)
    }
  }

  private async installSkillInternal(skillId: SkillId, force: boolean): Promise<SkillInstallResult> {
    const manifest = getEmbeddedSkillManifest(skillId)
    if (manifest) {
      this.ensureRuntimeDirs()
      const skillPath = this.syncEmbeddedSkill(manifest)
      const statePath = getInstallStatePath(skillPath)
      const requirementsPath = join(skillPath, manifest.requirementsFile)
      const digest = requirementsDigest(requirementsPath)
      const venvPython = await this.ensurePythonVenv()
      const venvState = this.readPythonRuntimeState()

      if (!force && existsSync(statePath)) {
        try {
          const state = JSON.parse(readFileSync(statePath, 'utf-8')) as SkillInstallState
          if (
            state.version === manifest.version
            && state.requirementsDigest === digest
            && state.venvId
            && state.venvId === venvState?.venvId
          ) {
            return { success: true, skillId: manifest.id, skillPath, venvPython }
          }
        } catch {
          // Invalid state file, continue to reinstall.
        }
      }

      try {
        if (this.packagedRuntimeRoot) {
          this.assertPackagedRuntimeCoversEmbeddedSkill(manifest.id)
        } else {
          await this.ensureRuntimeToolchain()
          if (existsSync(requirementsPath)) {
            await this.installRequirements(venvPython, requirementsPath)
          }
        }
        const state: SkillInstallState = {
          version: manifest.version,
          requirementsDigest: digest,
          installedAt: new Date().toISOString(),
          venvId: venvState?.venvId,
        }
        atomicWriteJson(statePath, state)
        return { success: true, skillId: manifest.id, skillPath, venvPython }
      } catch (error) {
        return {
          success: false,
          skillId: manifest.id,
          skillPath,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    const customSkill = getManagedCustomSkill(this.customSkillsRoot, skillId)
    if (!customSkill) {
      return { success: false, skillId, error: `Unknown skill: ${skillId}` }
    }

    const statePath = getInstallStatePath(customSkill.managedPath)
    const requiresPython = customSkill.runtime === 'python' || customSkill.actions.some((action) => action.runtime === 'python')
    const requirementsPath = customSkill.requirementsFile ? join(customSkill.managedPath, customSkill.requirementsFile) : ''
    const digest = customSkill.requirementsFile ? requirementsDigest(requirementsPath) : 'none'
    const venvPython = requiresPython ? await this.ensurePythonVenv({ allowPackaged: false }) : undefined
    const venvState = requiresPython ? this.readPythonRuntimeState({ allowPackaged: false }) : null

    if (!force && existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8')) as SkillInstallState
        if (
          state.version === customSkill.version
          && state.requirementsDigest === digest
          && (!requiresPython || (state.venvId && state.venvId === venvState?.venvId))
        ) {
          return { success: true, skillId: customSkill.id, skillPath: customSkill.managedPath, venvPython }
        }
      } catch {
        // continue to reinstall
      }
    }

    try {
      if (requiresPython) {
        if (!venvPython) {
          throw new Error('Python skill runtime is unavailable')
        }
        await this.ensureRuntimeToolchain({ allowPackaged: false })
        if (customSkill.requirementsFile && existsSync(requirementsPath)) {
          await this.installRequirements(venvPython, requirementsPath, { allowPackaged: false })
        }
      }
      const state: SkillInstallState = {
        version: customSkill.version,
        requirementsDigest: digest,
        installedAt: new Date().toISOString(),
        venvId: venvState?.venvId,
      }
      atomicWriteJson(statePath, state)
      return { success: true, skillId: customSkill.id, skillPath: customSkill.managedPath, venvPython }
    } catch (error) {
      return {
        success: false,
        skillId: customSkill.id,
        skillPath: customSkill.managedPath,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private ensureRuntimeDirs(): void {
    mkdirSync(this.runtimeRoot, { recursive: true })
    mkdirSync(this.skillsRoot, { recursive: true })
    mkdirSync(this.customSkillsRoot, { recursive: true })
    mkdirSync(this.runtimeBin, { recursive: true })
    mkdirSync(this.cacheRoot, { recursive: true })
    mkdirSync(this.modelscopeCache, { recursive: true })
    mkdirSync(this.pipCache, { recursive: true })
    mkdirSync(this.outputsRoot, { recursive: true })
  }

  private resolveEmbeddedSkillsRoot(): string {
    if (this.embeddedSkillsRootOverride) return this.embeddedSkillsRootOverride
    const candidates = [
      join(process.resourcesPath, 'embedded-skills'),
      join(app.getAppPath(), 'assets', 'embedded-skills'),
      join(process.cwd(), 'assets', 'embedded-skills'),
    ]
    const found = candidates.find((candidate) => existsSync(candidate))
    if (!found) {
      throw new Error(`Embedded skills directory not found. Checked: ${candidates.join(', ')}`)
    }
    return found
  }

  private syncEmbeddedSkill(manifest: EmbeddedSkillManifest): string {
    const sourceRoot = this.resolveEmbeddedSkillsRoot()
    const source = join(sourceRoot, manifest.id)
    if (!existsSync(source)) {
      throw new Error(`Embedded skill source missing: ${source}`)
    }
    const destination = this.getSkillRuntimePath(manifest.id)
    const syncStatePath = join(destination, EMBEDDED_SYNC_STATE_FILENAME)
    const sourceHash = hashDirectoryContents(source)
    const currentSyncState = (() => {
      try {
        return JSON.parse(readFileSync(syncStatePath, 'utf-8')) as { version?: string; sourceHash?: string }
      } catch {
        return null
      }
    })()
    if (
      currentSyncState?.version === manifest.version
      && currentSyncState?.sourceHash === sourceHash
      && existsSync(join(destination, 'SKILL.md'))
      && existsSync(join(destination, 'ready-skill.json'))
    ) {
      return destination
    }
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    cpSync(source, destination, { recursive: true, force: true })
    atomicWriteJson(
      syncStatePath,
      {
        version: manifest.version,
        sourceHash,
        sourcePath: source,
        syncedAt: new Date().toISOString(),
      },
    )
    return destination
  }

  private getSkillRuntimePath(skillId: SkillId): string {
    return join(this.skillsRoot, skillId)
  }

  private async ensurePythonVenv(options: { allowPackaged?: boolean } = {}): Promise<string> {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged) {
      const packagedPythonPath = await this.resolvePackagedPythonPath()
      if (packagedPythonPath) return packagedPythonPath
    }

    const pythonPath = this.getVenvPythonPath()
    let previousVersionText: string | null = null
    if (existsSync(pythonPath)) {
      const version = await this.getPythonVersion(pythonPath)
      const sslVersionText = await this.getPythonSslVersionText(pythonPath)
      if (isSupportedReadyPythonVersion(version) && isSupportedReadyPythonSslVersion(sslVersionText)) {
        const state = this.readPythonRuntimeState({ allowPackaged })
        if (!state?.venvId || !state.pythonSslVersion) {
          await this.writePythonRuntimeState(pythonPath)
        }
        return pythonPath
      }
      // Phase 1.3 — capture the bad version BEFORE rmSync so the metric +
      // log can show what we replaced. Old behavior was a silent rm + rebuild.
      const versionText = await this.getPythonVersionText(pythonPath)
      previousVersionText = `${versionText || 'unknown'} / ${sslVersionText || 'ssl unknown'}`
      console.warn(
        `[SkillsRuntimeManager] Python venv runtime unsupported (${previousVersionText || 'unknown'}); rebuilding to a Ready-supported runtime.`,
      )
      rmSync(this.venvRoot, { recursive: true, force: true })
    }

    const basePython = await this.findPythonExecutable()
    await execFileAsync(basePython, ['-m', 'venv', this.venvRoot], {
      timeout: 180_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv({ allowPackaged }),
    })

    const venvPython = this.getVenvPythonPath()
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      timeout: 300_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv({ allowPackaged }),
    })
    const state = await this.writePythonRuntimeState(venvPython, basePython)
    if (previousVersionText) {
      // Phase 1.3 — only emit on real rebuild (existing-but-bad → fresh).
      logAgentMetric('python_runtime_rebuilt', {
        previousVersion: previousVersionText,
        newVersion: state.pythonVersion,
        venvId: state.venvId,
      })
    }
    return venvPython
  }

  /**
   * Phase 1.3 — public wrapper used by app startup to proactively detect a
   * stale (e.g. 3.14) venv and rebuild it BEFORE the first skill_run_shell
   * call hits a confused interpreter. Returns a small status snapshot so the
   * caller can log "Python ready: 3.12.x" once during boot.
   *
   * Background: `ensurePythonVenv` previously only ran on first install/run,
   * so a host that had Python 3.14 from a prior install never saw a rebuild
   * until a Python skill was triggered, and even then the rmSync was silent.
   * Calling this from `setupAgentIPC` after `runtime.start()` makes the
   * version invariant a startup contract instead of a lazy invariant.
   *
   * Best-effort: any failure is swallowed and reported via the returned
   * `error` field so it cannot block boot.
   */
  async ensurePythonRuntimeReady(): Promise<{
    ready: boolean
    pythonPath?: string
    version?: string
    error?: string
  }> {
    try {
      const pythonPath = await this.ensurePythonVenv()
      const state = this.readPythonRuntimeState()
      const version = state?.pythonVersion || (await this.getPythonVersionText(pythonPath)) || 'unknown'
      const sslVersion = state?.pythonSslVersion || (await this.getPythonSslVersionText(pythonPath)) || 'unknown ssl'
      console.log(`[SkillsRuntimeManager] Python runtime ready: ${version} / ${sslVersion} at ${pythonPath}`)
      // Phase 5.2 — observability counterpart to `python_runtime_rebuilt`.
      // Always emit so we can count total boots and detect "ensurePythonVenv
      // succeeded but no rebuilt event" (i.e. healthy boot). Pair with the
      // rebuilt metric to compute rebuild rate.
      logAgentMetric('python_runtime_ready', {
        version,
        sslVersion,
        pythonPath,
        venvId: state?.venvId ?? null,
        configuredAt: state?.updatedAt ?? null,
      })
      return { ready: true, pythonPath, version }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[SkillsRuntimeManager] Python runtime not ready: ${message}`)
      logAgentMetric('python_runtime_not_ready', {
        error: message,
      })
      return { ready: false, error: message }
    }
  }

  private getVenvPythonPath(): string {
    if (process.platform === 'win32') {
      return join(this.venvRoot, 'Scripts', 'python.exe')
    }
    return join(this.venvRoot, 'bin', 'python')
  }

  private async findPythonExecutable(): Promise<string> {
    let configured: string | undefined
    try {
      configured = getDatabase().getSetting('skills_python_path')
    } catch {
      configured = undefined
    }
    const candidates = buildReadyPythonCandidates(configured, process.env)
    let sawSslIncompatibleCandidate = false
    for (const candidate of candidates) {
      try {
        const version = await this.getPythonVersion(candidate)
        if (!isSupportedReadyPythonVersion(version)) continue
        const sslVersionText = await this.getPythonSslVersionText(candidate)
        if (!isSupportedReadyPythonSslVersion(sslVersionText)) {
          sawSslIncompatibleCandidate = true
          continue
        }
        return candidate
      } catch {
        // Continue trying candidates.
      }
    }
    throw new Error(buildReadyPythonRuntimeNotFoundMessage({ sawSslIncompatibleCandidate }))
  }

  private async resolvePackagedPythonPath(): Promise<string | null> {
    if (!this.packagedRuntimeRoot) return null
    const pythonPath = getPackagedSkillPythonPath(this.packagedRuntimeRoot)
    if (!existsSync(pythonPath)) {
      throw new Error(`Packaged Python runtime is missing: ${pythonPath}`)
    }
    const runtimeEnv = this.getBaseEnv({ allowPackaged: true })
    const version = await this.getPythonVersion(pythonPath, runtimeEnv)
    const sslVersionText = await this.getPythonSslVersionText(pythonPath, runtimeEnv)
    if (!isSupportedReadyPythonVersion(version)) {
      throw new Error(`Packaged Python runtime has unsupported version: ${await this.getPythonVersionText(pythonPath, runtimeEnv) || 'unknown'}`)
    }
    if (!isSupportedReadyPythonSslVersion(sslVersionText)) {
      throw new Error(`Packaged Python runtime has unsupported OpenSSL: ${sslVersionText || 'unknown'}`)
    }
    return pythonPath
  }

  private assertPackagedRuntimeCoversEmbeddedSkill(skillId: EmbeddedSkillId): void {
    const covered = this.packagedRuntimeManifest?.embeddedSkillIds || []
    if (!covered.includes(skillId)) {
      throw new Error(`Packaged skill runtime does not declare dependency coverage for embedded skill: ${skillId}`)
    }
  }

  private readPythonRuntimeState(options: { allowPackaged?: boolean } = {}): PythonRuntimeState | null {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged && this.packagedRuntimeRoot) {
      const manifest = this.packagedRuntimeManifest
      return {
        venvId: `packaged:${manifest?.runtimeId || manifest?.createdAt || 'unknown'}`,
        pythonPath: getPackagedSkillPythonPath(this.packagedRuntimeRoot),
        pythonVersion: manifest?.pythonVersion || 'packaged',
        pythonSslVersion: manifest?.pythonSslVersion || 'packaged',
        updatedAt: manifest?.createdAt || 'packaged',
        packaged: true,
      }
    }
    try {
      const statePath = join(this.venvRoot, PYTHON_RUNTIME_STATE_FILENAME)
      return JSON.parse(readFileSync(statePath, 'utf-8')) as PythonRuntimeState
    } catch {
      return null
    }
  }

  private async writePythonRuntimeState(venvPython: string, basePython = venvPython): Promise<PythonRuntimeState> {
    const version = await this.getPythonVersionText(venvPython)
    const sslVersion = await this.getPythonSslVersionText(venvPython)
    const state: PythonRuntimeState = {
      venvId: randomUUID(),
      pythonPath: basePython,
      pythonVersion: version || 'unknown',
      pythonSslVersion: sslVersion || 'unknown',
      updatedAt: new Date().toISOString(),
    }
    atomicWriteJson(join(this.venvRoot, PYTHON_RUNTIME_STATE_FILENAME), state)
    return state
  }

  private async getPythonVersion(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<PythonVersionInfo | null> {
    const versionText = await this.getPythonVersionText(pythonBin, env)
    return parsePythonVersionText(versionText || '')
  }

  private async getPythonVersionText(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000, env })
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  private async getPythonSslVersionText(pythonBin: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(
        pythonBin,
        ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'],
        { timeout: 10_000, maxBuffer: 1_000_000, env },
      )
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  private async installRequirements(
    venvPython: string,
    requirementsPath: string,
    options: { allowPackaged?: boolean } = {},
  ): Promise<void> {
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], {
      timeout: 3_600_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(options),
    })
  }

  private async ensureRuntimeToolchain(options: { allowPackaged?: boolean } = {}): Promise<void> {
    const allowPackaged = options.allowPackaged ?? true
    if (allowPackaged && this.packagedRuntimeRoot) {
      for (const binaryName of ['ffmpeg', 'ffprobe']) {
        const candidates = getPackagedSkillRuntimeToolCandidates(this.packagedRuntimeRoot, binaryName)
        if (!candidates.some((candidate) => existsSync(candidate))) {
          throw new Error(`Packaged skill runtime is missing required binary: ${binaryName}`)
        }
      }
      return
    }
    await this.linkIfFound('ffmpeg')
    await this.linkIfFound('ffprobe')
  }

  private async linkIfFound(binaryName: string): Promise<void> {
    const destination = join(this.runtimeBin, binaryName)
    if (existsSync(destination)) return

    try {
      const { stdout } = await execFileAsync(getWhichCommand(), [binaryName], { timeout: 10_000 })
      // Windows 'where' may return multiple lines, take the first one
      const source = stdout.trim().split('\n')[0]
      if (!source) return
      symlinkSync(source, destination)
    } catch {
      // Keep silent: certain skills can still run without this binary.
    }
  }

  private getBaseEnv(options: { allowPackaged?: boolean } = {}): NodeJS.ProcessEnv {
    const usePackaged = (options.allowPackaged ?? true) && !!this.packagedRuntimeRoot
    if (usePackaged && this.packagedRuntimeRoot) {
      return {
        ...buildPackagedSkillRuntimeEnv(this.packagedRuntimeRoot),
        ...this.buildFunasrNanoRuntimeEnv(),
        ...this.buildFunasrFallbackModelEnv({ packaged: true }),
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      }
    }
    const venvBinDir = process.platform === 'win32'
      ? join(this.venvRoot, 'Scripts')
      : join(this.venvRoot, 'bin')
    return {
      ...process.env,
      PATH: [this.runtimeBin, venvBinDir, process.env.PATH || ''].join(delimiter),
      PIP_CACHE_DIR: this.pipCache,
      XDG_CACHE_HOME: this.cacheRoot,
      MODELSCOPE_CACHE: join(this.cacheRoot, 'modelscope'),
      HF_HOME: join(this.cacheRoot, 'huggingface'),
      ...this.buildFunasrNanoRuntimeEnv(),
      ...this.buildFunasrFallbackModelEnv({ packaged: false }),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    }
  }

  private resolveOutputDir(candidate: string | null, skillId: SkillId, jobId?: string): string {
    const outputDir = candidate || join(this.outputsRoot, skillId, jobId || randomUUID())
    mkdirSync(outputDir, { recursive: true })
    return outputDir
  }

  /**
   * B-arch-4 — one-shot orphan-skill artifact cleanup. Scans the runtime
   * skills directory for sub-folders that are NOT in the current embedded
   * manifest list AND NOT registered in the custom-skill registry. Each
   * candidate is then gated against `RETIRED_EMBEDDED_SKILL_IDS` (a small
   * explicit allowlist of ids we know used to ship embedded but no longer do)
   * before invoking `controller.cleanupSkillArtifacts`. This avoids
   * accidentally rm'ing a custom skill the user is actively using or an
   * embedded skill we're about to re-add.
   *
   * Logs every action — including no-ops — so a curious operator can verify
   * the sweep ran. Idempotent: only runs once per process. Marked `public` so
   * tests can invoke it deterministically without relying on the constructor
   * side-effect; production callers should not invoke it directly (the
   * constructor handles it under `startBackgroundTasks !== false`).
   */
  async cleanupOrphanedSkillArtifactsOnce(): Promise<void> {
    if (this.orphanCleanupRan) return
    this.orphanCleanupRan = true
    this.ensureRuntimeDirs()
    const controller = this.getHostController()
    const customIds = new Set<string>(
      listManagedCustomSkills(this.customSkillsRoot).map((skill) => skill.id),
    )

    let dirNames: string[]
    try {
      dirNames = readdirSync(this.skillsRoot)
    } catch (error) {
      console.warn('[SkillsRuntimeManager] orphan cleanup: failed to scan skills root:', error instanceof Error ? error.message : String(error))
      return
    }

    const candidates: string[] = []
    for (const name of dirNames) {
      if (EMBEDDED_SKILL_IDS.has(name as EmbeddedSkillId)) continue
      if (customIds.has(name)) continue
      try {
        if (!statSync(join(this.skillsRoot, name)).isDirectory()) continue
      } catch {
        continue
      }
      candidates.push(name)
    }

    if (candidates.length === 0) {
      console.log('[SkillsRuntimeManager] orphan cleanup: no candidates found')
      return
    }

    const retiredIds = this.retiredEmbeddedSkillIdsOverride ?? RETIRED_EMBEDDED_SKILL_IDS
    for (const skillId of candidates) {
      const isRetired = retiredIds.has(skillId)
      if (!isRetired) {
        console.log('[SkillsRuntimeManager] orphan cleanup: skipping', skillId, '(not in RETIRED_EMBEDDED_SKILL_IDS)')
        continue
      }
      const skillAssetRoot = join(this.skillsRoot, skillId)
      try {
        const result = await controller.cleanupSkillArtifacts(skillId, skillId, skillAssetRoot, null)
        console.log(
          '[SkillsRuntimeManager] orphan cleanup: ran cleanupSkillArtifacts for',
          skillId,
          '— removed:',
          result.removedPaths.length,
          'errors:',
          result.errors.length,
        )
      } catch (error) {
        console.warn(
          '[SkillsRuntimeManager] orphan cleanup: cleanupSkillArtifacts threw for',
          skillId,
          ':',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  private async runPythonScript(
    manifest: EmbeddedSkillManifest,
    venvPython: string,
    scriptRelativePath: string,
    scriptArgs: string[],
    timeoutMs: number,
    outputDir?: string,
    envOverrides?: Record<string, string>,
  ): Promise<SkillRunResult> {
    const skillPath = this.getSkillRuntimePath(manifest.id)
    const scriptPath = join(skillPath, scriptRelativePath)
    const command = [venvPython, scriptPath, ...scriptArgs]

    try {
      const { stdout, stderr } = await execFileAsync(venvPython, [scriptPath, ...scriptArgs], {
        cwd: skillPath,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_BUFFER,
        env: {
          ...this.getBaseEnv(),
          ...(envOverrides || {}),
        },
      })
      return {
        success: true,
        skillId: manifest.id,
        action: scriptRelativePath,
        stdout: truncateOutput(stdout || ''),
        stderr: truncateOutput(stderr || ''),
        outputDir,
        command,
      }
    } catch (error) {
      const err = error as Error & { stdout?: string; stderr?: string }
      return {
        success: false,
        skillId: manifest.id,
        action: scriptRelativePath,
        stdout: truncateOutput(err.stdout || ''),
        stderr: truncateOutput(err.stderr || ''),
        outputDir,
        command,
        error: err.message,
      }
    }
  }
}

let runtimeManager: SkillsRuntimeManager | null = null

export function getSkillsRuntimeManager(): SkillsRuntimeManager {
  if (!runtimeManager) {
    runtimeManager = new SkillsRuntimeManager()
  }
  return runtimeManager
}

/**
 * Stage Q (Stage 11) — test-only: override the singleton so integration
 * tests can drive `executeSkillTool` against synthetic skills without
 * needing a real skills tree on disk. Production code MUST NOT call this.
 * Pass `null` to restore lazy-init behavior.
 */
export function __setSkillsRuntimeManagerForTests(
  override: SkillsRuntimeManager | Pick<SkillsRuntimeManager, 'listSkills'> | null,
): void {
  runtimeManager = (override as SkillsRuntimeManager | null)
}

// ────────────────────────────────────────────────────────────────────────
// Phase 7 — `startSkillChildRunAndWait` compatibility helper.
//
// Product callers (e.g. `item-analysis-manager.ts`) historically awaited
// `runSkill` for VEA long actions. After Phase 6/7 those actions are
// child-loop owned; the runtime helper below preserves the await-style
// contract: launch a child run, block until its close event, and return
// the structured close + childRunId. RSS visual analysis keeps its
// existing flow — internally the long work is now child-owned.
//
// The helper is a thin wrapper around `startSkillChildRun` /
// `getSkillChildRunCloseEvent` from `agent-control/skill-child-runner.ts`.
// We import lazily inside the function body to avoid a hard cycle between
// runtime-manager and the child-runner module (the runner's
// SkillChildRunnerConfig already depends on this file).
// ────────────────────────────────────────────────────────────────────────

import type {
  SkillChildCloseEvent,
  SkillChildRunStatus,
} from '../agent-control/skills/skill-child-run-types'

export interface StartSkillChildRunAndWaitParams {
  skillId: string
  action: string
  params: Record<string, unknown>
  scopeId?: string | null
  sessionId?: string | null
  /** Hard upper bound on observer wait time. When elapsed the helper
   *  returns `status:'running'` with observerTimeout metadata; it does
   *  not cancel or mutate the child run. Set null/undefined for no timeout. */
  timeoutMs?: number
  triggerType?: 'tool' | 'product' | 'agent'
}

export interface StartSkillChildRunAndWaitResult {
  childRunId: string
  /** Final status from the close event, or `running` when only this
   *  observer timed out while the child continues in the background. */
  status: Exclude<SkillChildRunStatus, 'queued'>
  closeEvent: SkillChildCloseEvent | null
  observerTimeout?: {
    elapsedMs: number
  } | null
  /** True only when `closeEvent.status === 'completed'`. Provided as a
   *  convenience so existing product code doesn't have to re-derive it. */
  success: boolean
}

/**
 * Phase 7 — launch a skill child run and await its close event.
 *
 * Single-flight semantics are honored: when the underlying runner returns
 * `'reused'` the helper waits on the existing child's close event. A
 * `'recoverable_paused'` / `'failed'` / `'killed'` / `'completed'` close
 * that arrives synchronously on launch is also forwarded immediately.
 */
export async function startSkillChildRunAndWait(
  params: StartSkillChildRunAndWaitParams,
): Promise<StartSkillChildRunAndWaitResult> {
  // Lazy require to break the runtime-manager ⇄ skill-child-runner cycle.
  const childRunner = await import('../agent-control/skills/skill-child-runner')

  const launch = await childRunner.startSkillChildRun({
    scopeId: params.scopeId ?? null,
    sessionId: params.sessionId ?? null,
    skillId: params.skillId,
    action: params.action,
    requestedInput: params.params,
    parentNextHint: 'wait_for_close_event',
    triggerType: params.triggerType ?? 'product',
  })

  // Synchronous launch refusal (no driver, nested-child, queued, infra
  // error). Forward the close event verbatim — caller decides retry.
  if (launch.closeEvent) {
    return {
      childRunId: launch.childRunId,
      status: launch.closeEvent.status,
      closeEvent: launch.closeEvent,
      success: launch.closeEvent.status === 'completed',
    }
  }

  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : null

  const waitResult = await childRunner.waitForSkillChildRunClose(launch.childRunId, { timeoutMs })
  if (waitResult.kind === 'closed') {
    return {
      childRunId: launch.childRunId,
      status: waitResult.closeEvent.status,
      closeEvent: waitResult.closeEvent,
      success: waitResult.closeEvent.status === 'completed',
      observerTimeout: null,
    }
  }

  return {
    childRunId: launch.childRunId,
    status: 'running',
    closeEvent: null,
    success: false,
    observerTimeout: {
      elapsedMs: waitResult.elapsedMs,
    },
  }
}
