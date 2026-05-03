import { execFile } from 'child_process'
import { promisify } from 'util'
import { createHash, randomUUID } from 'crypto'
import { createRequire } from 'module'
import { join, delimiter } from 'path'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'

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
const { app } = electronModule
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
// Phase 4: ExecutionStateStore / ExecutionCoordinator retired along with the
// skill_executions state machine. The imports (and the files) are removed in
// PR1-E.
import { sweepExpiredReferenceSkillHints } from '../agent-control/skill-reference-hints'
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
  buildReadyPythonCandidates,
  isSupportedReadyPythonVersion,
  parsePythonVersionText,
  type PythonVersionInfo,
} from './python-runtime-version'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'

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
  updatedAt: string
}

export interface SkillsRuntimeManagerOptions {
  runtimeRoot?: string
  embeddedSkillsRoot?: string
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
  private readonly embeddedSkillsRootOverride?: string
  private readonly hostControllerOverride?: SkillHostController
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
      installed: existsSync(statePath),
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

  /**
   * Phase 1 gap fix — exposes the shared venv bin dir so `skill_run_shell`
   * can prepend it to PATH. Mirrors the calculation in `getBaseEnv()` so
   * primitives and the legacy workflow runner see the same Python env.
   * Returns the path unconditionally; a non-existent entry in PATH is
   * harmless, and pre-installing the venv on every boot just to satisfy
   * this getter would add startup latency for no gain.
   */
  getSharedVenvBinDir(): string {
    return process.platform === 'win32'
      ? join(this.venvRoot, 'Scripts')
      : join(this.venvRoot, 'bin')
  }

  getRuntimeBinDir(): string {
    return this.runtimeBin
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

      // B-arch-4 — Skill Host Contract wiring. When the skill manifest declares
      // host_requirements, prepare the declarative spawn environment (config
      // file write, secondary files, env overrides, mutex acquisition) BEFORE
      // running the action; restore exactly once on completion. Skills that
      // don't opt into the contract bypass the wrap entirely so we don't pay
      // the agent-context read cost when there's nothing to do.
      const controller = this.getHostController()
      const hostRequirements = resolved.definition.hostRequirements ?? null
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
      const preparedOutputDir = hostRequirements
        ? this.resolveOutputDir(requestedOutputDir, resolved.definition.id, jobId)
        : undefined
      const actionParams = preparedOutputDir && action.inputMode === 'json' && !requestedOutputDir
        ? { ...(request.params || {}), outputDir: preparedOutputDir }
        : (request.params || {})
      if (hostRequirements) {
        spawnHandle = await controller.prepareSpawnContext(
          resolved.definition.id,
          resolved.definition.name,
          skillAssetRoot,
          hostRequirements,
          jobId,
          preparedOutputDir,
          request.agentContext ?? null,
        )
      }

      const mergedEnv = {
        ...(spawnHandle?.envOverrides || {}),
        READY_SKILL_TASK_ID: jobId,
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
        result = await this.runDirectScript(definition.id, skillPath, action, venvPython, [entryPath, ...args], timeoutMs, envOverrides, signal)
      } else if (action.runtime === 'node') {
        result = await this.runDirectScript(definition.id, skillPath, action, 'node', [entryPath, ...args], timeoutMs, envOverrides, signal)
      } else {
        result = await this.runDirectScript(definition.id, skillPath, action, entryPath, args, timeoutMs, envOverrides, signal)
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
      ...this.getBaseEnv(),
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

    return {
      success: structured ? structured.ok : executed.success,
      skillId,
      action: actionName,
      stdout: [executed.stdout, extraStdout].filter(Boolean).join('\n').trim(),
      stderr: executed.stderr,
      outputDir: executed.outputDir,
      outputs: Object.keys(stringOutputs).length > 0 ? stringOutputs : undefined,
      command: executed.command,
      error: structured?.ok ? undefined : (structured?.error?.message || executed.error),
      status: normalizeSkillRunStatus(structured?.status, structured?.ok),
      mode: 'direct',
      stdoutArtifactPath: executed.stdoutArtifactPath,
      stderrArtifactPath: executed.stderrArtifactPath,
      stdoutArtifactError: executed.stdoutArtifactError,
      stderrArtifactError: executed.stderrArtifactError,
    }
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
        await this.ensureRuntimeToolchain()
        if (existsSync(requirementsPath)) {
          await this.installRequirements(venvPython, requirementsPath)
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
    const venvPython = requiresPython ? await this.ensurePythonVenv() : undefined
    const venvState = requiresPython ? this.readPythonRuntimeState() : null

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
        await this.ensureRuntimeToolchain()
        if (customSkill.requirementsFile && existsSync(requirementsPath)) {
          await this.installRequirements(venvPython, requirementsPath)
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

  private async ensurePythonVenv(): Promise<string> {
    const pythonPath = this.getVenvPythonPath()
    let previousVersionText: string | null = null
    if (existsSync(pythonPath)) {
      const version = await this.getPythonVersion(pythonPath)
      if (isSupportedReadyPythonVersion(version)) {
        if (!this.readPythonRuntimeState()?.venvId) {
          await this.writePythonRuntimeState(pythonPath)
        }
        return pythonPath
      }
      // Phase 1.3 — capture the bad version BEFORE rmSync so the metric +
      // log can show what we replaced. Old behavior was a silent rm + rebuild.
      previousVersionText = await this.getPythonVersionText(pythonPath)
      console.warn(
        `[SkillsRuntimeManager] Python venv version unsupported (${previousVersionText || 'unknown'}); rebuilding to a Ready-supported version.`,
      )
      rmSync(this.venvRoot, { recursive: true, force: true })
    }

    const basePython = await this.findPythonExecutable()
    await execFileAsync(basePython, ['-m', 'venv', this.venvRoot], {
      timeout: 180_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(),
    })

    const venvPython = this.getVenvPythonPath()
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      timeout: 300_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(),
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
      console.log(`[SkillsRuntimeManager] Python runtime ready: ${version} at ${pythonPath}`)
      // Phase 5.2 — observability counterpart to `python_runtime_rebuilt`.
      // Always emit so we can count total boots and detect "ensurePythonVenv
      // succeeded but no rebuilt event" (i.e. healthy boot). Pair with the
      // rebuilt metric to compute rebuild rate.
      logAgentMetric('python_runtime_ready', {
        version,
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
    for (const candidate of candidates) {
      try {
        const version = await this.getPythonVersion(candidate)
        if (!isSupportedReadyPythonVersion(version)) continue
        return candidate
      } catch {
        // Continue trying candidates.
      }
    }
    throw new Error('Python runtime not found. Please install Python 3.9-3.12 or set setting key `skills_python_path`.')
  }

  private readPythonRuntimeState(): PythonRuntimeState | null {
    try {
      const statePath = join(this.venvRoot, PYTHON_RUNTIME_STATE_FILENAME)
      return JSON.parse(readFileSync(statePath, 'utf-8')) as PythonRuntimeState
    } catch {
      return null
    }
  }

  private async writePythonRuntimeState(venvPython: string, basePython = venvPython): Promise<PythonRuntimeState> {
    const version = await this.getPythonVersionText(venvPython)
    const state: PythonRuntimeState = {
      venvId: randomUUID(),
      pythonPath: basePython,
      pythonVersion: version || 'unknown',
      updatedAt: new Date().toISOString(),
    }
    atomicWriteJson(join(this.venvRoot, PYTHON_RUNTIME_STATE_FILENAME), state)
    return state
  }

  private async getPythonVersion(pythonBin: string): Promise<PythonVersionInfo | null> {
    const versionText = await this.getPythonVersionText(pythonBin)
    return parsePythonVersionText(versionText || '')
  }

  private async getPythonVersionText(pythonBin: string): Promise<string | null> {
    try {
      const { stdout, stderr } = await execFileAsync(pythonBin, ['--version'], { timeout: 10_000, maxBuffer: 1_000_000 })
      return `${stdout} ${stderr}`.trim()
    } catch {
      return null
    }
  }

  private async installRequirements(venvPython: string, requirementsPath: string): Promise<void> {
    await execFileAsync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath], {
      timeout: 3_600_000,
      maxBuffer: MAX_COMMAND_BUFFER,
      env: this.getBaseEnv(),
    })
  }

  private async ensureRuntimeToolchain(): Promise<void> {
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

  private getBaseEnv(): NodeJS.ProcessEnv {
    const venvBinDir = process.platform === 'win32'
      ? join(this.venvRoot, 'Scripts')
      : join(this.venvRoot, 'bin')
    return {
      ...process.env,
      PATH: [this.runtimeBin, venvBinDir, process.env.PATH || ''].join(delimiter),
      PIP_CACHE_DIR: this.pipCache,
      XDG_CACHE_HOME: this.cacheRoot,
      MODELSCOPE_CACHE: this.modelscopeCache,
      HF_HOME: join(this.cacheRoot, 'huggingface'),
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
} from '../agent-control/skill-child-run-types'

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
  const childRunner = await import('../agent-control/skill-child-runner')

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
