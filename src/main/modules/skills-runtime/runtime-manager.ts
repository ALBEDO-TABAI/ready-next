import type { ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { join, delimiter } from 'path'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'

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
  SkillDefinition,
  SkillInputValue,
  SkillParamDefinition,
  SkillRuntimeKind,
} from '../../../shared/skill-execution-types'
import {
  type RegisteredCustomSkill,
  getManagedCustomSkill,
  importCustomSkillFolder,
  loadCustomSkillManifestFromFolder,
  removeManagedCustomSkill,
  updateManagedCustomSkillDescription,
} from './custom-skill-registry'
import { SkillLoader } from './skill-loader'
import { scanSkillDirectory } from './skill-security-scanner'
// Phase 4: ExecutionStateStore / ExecutionCoordinator retired along with the
// skill_executions state machine. The imports (and the files) are removed in
// PR1-E.
import { logAgentMetric } from '../agent-control/metrics'
import type {
  SkillHostController,
  SpawnContextHandle,
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
import { RuntimeProvisioner, type RuntimeProvisionerDeps } from './runtime-provisioner'
import {
  downloadRuntimeArchive,
  extractRuntimeArchive,
  placeRuntimeExecutable,
  probeRuntimeBinary,
  sha256Buffer,
  realpathOrNull,
  readTextOrNull,
} from './runtime-provisioner-io'
import { getRuntimeAssets, resolveRuntimePlatformKey } from '../../../shared/runtime-asset-registry'
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
  detectMissingRuntimeDependency,
  type ModelPackDownloadRequest,
  type ModelPackDownloadStatus,
  type ModelPackId,
  type ModelPackSelfTestReport,
  type ModelPackStatus,
} from '../../../shared/model-pack-types'
import {
  assessSkillSourceRisk,
  createDefaultSkillInstallStatus,
  parseSkillSourceInput,
  type ModelSource,
  type SkillInstallProvenance,
  type SkillInstallRequest,
  type SkillInstallStatus,
  type SkillSource as SkillInstallSource,
  type SkillSourceProbe,
  type SkillSourceResolution,
  type SkillSourceSelfTestReport,
} from '../../../shared/skill-source-types'
import {
  DEFAULT_DOMESTIC_GITHUB_MIRROR_PREFIX,
  OVERSEAS_GITHUB_CODELOAD,
  extractCandidateSkillNames,
  extractCandidateSourcesFromDoc,
  fetchGithubRepoMetadata,
  resolveGithubRefToSha,
  resolveSkillTarballUrl,
  type FetchLike,
  type LatencyProbe,
} from './skill-source-registry'
import { fetchSkillToStaging } from './skill-source-fetcher'

import {
  execFileAsync,
  EMBEDDED_SYNC_STATE_FILENAME,
  PYTHON_RUNTIME_STATE_FILENAME,
  CUSTOM_VENV_MARKER,
  DOMESTIC_PIP_INDEX_URL,
  MAX_COMMAND_BUFFER,
  DIRECT_ACTION_INMEMORY_CAP,
  DEFAULT_TIMEOUT_MS,
  SCHEDULER_INTERVAL_MS,
  normalizeSkillRunStatus,
  mergeSkillRunStatus,
  hashDirectoryContents,
  truncateOutput,
  getInstallStatePath,
  requirementsDigest,
} from './runtime-manager-helpers'
// B8-D M1 (2026-07-05) — delegated sub-services extracted from this class
// (surgery map §2.3 D 表, 风险低组). Method bodies moved verbatim; this class
// keeps one-line delegates so the external call face (IPC / tools / tests) is
// unchanged. None of these files import runtime-manager (防环).
import { ModelPackManager } from './model-pack-manager'
import { MaintenanceSweeps } from './maintenance-sweeps'
import { ExternalEnvResolver } from './external-env-resolver'
import { SkillHostPrep } from './skill-host-prep'
import type {
  SkillDeploySpawn,
  SkillTriggerType,
  SkillId,
  SkillState,
  SkillsRuntimeInfo,
  SkillInstallState,
  PythonRuntimeState,
  SkillsRuntimeManagerOptions,
  SkillInstallResult,
  SkillRunResult,
  SkillRunRequest,
  SkillJobRow,
  SkillScheduleRow,
  DatabaseConnection,
  SkillJobRecord,
  SkillScheduleRecord,
  CreateSkillScheduleRequest,
} from './runtime-manager-types'

// B8-P (2026-07-05) — pure move: top-level constants / pure helpers now live
// in runtime-manager-helpers.ts, top-level types in runtime-manager-types.ts.
// Re-export the previously exported names so the external import face of this
// module is unchanged.
export type {
  SkillDeploySpawn,
  SkillId,
  SkillState,
  SkillsRuntimeInfo,
  SkillsRuntimeManagerOptions,
  SkillInstallResult,
  SkillRunResult,
  SkillRunRequest,
  SkillJobRecord,
  SkillScheduleRecord,
  CreateSkillScheduleRequest,
} from './runtime-manager-types'

export class SkillsRuntimeManager {
  private readonly runtimeRoot: string
  private readonly skillsRoot: string
  private readonly customSkillsRoot: string
  private readonly venvRoot: string
  // Per-skill overlay venvs (bundled-Python derived, --system-site-packages) for
  // source-installed Python skills. One dir per skillId so a skill's delta deps
  // never collide with another's; the bundled site-packages stays immutable.
  private readonly customVenvsRoot: string
  private readonly runtimeBin: string
  private readonly cacheRoot: string
  private readonly modelscopeCache: string
  private readonly pipCache: string
  private readonly outputsRoot: string
  private readonly packagedRuntimeRoot: string | null
  private readonly packagedRuntimeManifest: PackagedSkillRuntimeManifest | null
  private readonly embeddedSkillsRootOverride?: string
  private readonly externalServiceStore = new ExternalServiceStore()
  private readonly skillConfigurationStore = new SkillConfigurationStore()
  private readonly retiredEmbeddedSkillIdsOverride?: ReadonlySet<string>
  private loader: SkillLoader | null = null
  private runtimeProvisioner: RuntimeProvisioner | null = null
  private installLocks = new Map<SkillId, Promise<SkillInstallResult>>()
  private schedulerTimer: NodeJS.Timeout | null = null
  private runningScheduleIds = new Set<string>()
  // One in-flight download per pack so packs download independently.
  // B8-D M1: the Maps stay declared here (model-pack-manager.test.ts pokes the
  // manager instance's properties directly) and are shared by reference with
  // the ModelPackManager sub-service, which owns all reads/writes.
  private modelPackDownloads = new Map<ModelPackId, ChildProcessWithoutNullStreams>()
  private modelPackDownloadStatuses = new Map<ModelPackId, ModelPackDownloadStatus>()
  // Remote skill installs, keyed by an opaque requestId so multiple installs run
  // and cancel independently (the AbortController is the cancel handle, mirroring
  // the model-pack download Maps above).
  private skillInstalls = new Map<string, AbortController>()
  private skillInstallStatuses = new Map<string, SkillInstallStatus>()
  // Production dependency-deploy subprocess seam (venv + pip). Tests override via
  // installSkillFromSource's `inject.deploySpawn`.
  private readonly defaultDeploySpawn: SkillDeploySpawn = async (file, args, options) => {
    const { stdout, stderr } = await execFileAsync(file, args, { ...options, maxBuffer: MAX_COMMAND_BUFFER })
    return { stdout: String(stdout), stderr: String(stderr) }
  }

  // Phase 4: reference-skill hint TTL sweep runs independently of the retired
  // skill_executions state machine. Boot delay prevents blocking startup; the
  // hourly cadence matches the previous combined sweep.
  // B8-D M1: the constants stay declared here (tool-error-metrics-contract
  // pins this assignment text) and are injected by value into MaintenanceSweeps.
  private static readonly REFERENCE_HINT_BOOT_DELAY_MS = 30_000
  private static readonly REFERENCE_HINT_SWEEP_INTERVAL_MS = 60 * 60_000

  // B8-D M1 — delegated sub-services (constructed in the constructor after the
  // path fields they capture are assigned).
  private readonly modelPack: ModelPackManager
  private readonly maintenanceSweeps: MaintenanceSweeps
  private readonly externalEnv: ExternalEnvResolver
  private readonly skillHostPrep: SkillHostPrep

  constructor(options: SkillsRuntimeManagerOptions = {}) {
    this.runtimeRoot = options.runtimeRoot || join(app.getPath('userData'), 'skill-runtime')
    this.skillsRoot = join(this.runtimeRoot, 'skills')
    this.customSkillsRoot = join(this.runtimeRoot, 'custom-skills')
    this.venvRoot = join(this.runtimeRoot, 'python')
    this.customVenvsRoot = join(this.runtimeRoot, 'custom-venvs')
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
    this.retiredEmbeddedSkillIdsOverride = options.retiredEmbeddedSkillIds
    // B8-D M1 — wire the delegated sub-services. Cross-service dependencies go
    // through `this.*` delegate closures (lazy), so construction order among
    // the services does not matter; they only need the path fields above.
    this.modelPack = new ModelPackManager({
      runtimeRoot: this.runtimeRoot,
      cacheRoot: this.cacheRoot,
      modelPackDownloads: this.modelPackDownloads,
      modelPackDownloadStatuses: this.modelPackDownloadStatuses,
      ensureRuntimeDirs: () => this.ensureRuntimeDirs(),
      ensureSkillInstalled: (skillId) => this.ensureSkillInstalled(skillId),
      ensurePythonVenv: () => this.ensurePythonVenv(),
      getBaseEnv: () => this.getBaseEnv(),
    })
    this.externalEnv = new ExternalEnvResolver({
      runtimeRoot: this.runtimeRoot,
      packagedRuntimeRoot: this.packagedRuntimeRoot,
      externalServiceStore: this.externalServiceStore,
      skillConfigurationStore: this.skillConfigurationStore,
      buildFunasrNanoRuntimeEnv: () => this.buildFunasrNanoRuntimeEnv(),
      buildFunasrFallbackModelEnv: (funasrOptions) => this.buildFunasrFallbackModelEnv(funasrOptions),
    })
    this.skillHostPrep = new SkillHostPrep({
      runtimeRoot: this.runtimeRoot,
      hostControllerOverride: options.hostController,
      ensureRuntimeDirs: () => this.ensureRuntimeDirs(),
      ensurePythonVenv: () => this.ensurePythonVenv(),
      getBaseEnv: () => this.getBaseEnv(),
    })
    this.maintenanceSweeps = new MaintenanceSweeps({
      runtimeRoot: this.runtimeRoot,
      skillsRoot: this.skillsRoot,
      customSkillsRoot: this.customSkillsRoot,
      bootDelayMs: SkillsRuntimeManager.REFERENCE_HINT_BOOT_DELAY_MS,
      sweepIntervalMs: SkillsRuntimeManager.REFERENCE_HINT_SWEEP_INTERVAL_MS,
      retiredEmbeddedSkillIds: this.retiredEmbeddedSkillIdsOverride,
      ensureRuntimeDirs: () => this.ensureRuntimeDirs(),
      getHostController: () => this.getHostController(),
    })
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

  // B8-D M1 — delegate to SkillHostPrep (body in skill-host-prep.ts).
  private getHostController(): SkillHostController {
    return this.skillHostPrep.getHostController()
  }

  // B8-D M1 — delegates to MaintenanceSweeps (bodies + timer fields in
  // maintenance-sweeps.ts; start/stop pairing unchanged). The private
  // startReferenceHintSweep() / startOutputDirSweep() delegates keep the
  // constructor call sites and the sweep-independence tests unchanged.
  private startReferenceHintSweep(): void {
    this.maintenanceSweeps.startReferenceHintSweep()
  }

  stopReferenceHintSweep(): void {
    this.maintenanceSweeps.stopReferenceHintSweep()
  }

  private startOutputDirSweep(): void {
    this.maintenanceSweeps.startOutputDirSweep()
  }

  stopOutputDirSweep(): void {
    this.maintenanceSweeps.stopOutputDirSweep()
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

  // B8-D M1 — model-pack surface delegates to ModelPackManager (bodies in
  // model-pack-manager.ts; the download Maps stay declared on this class and
  // are shared by reference).
  getModelPackStatus(id: ModelPackId): ModelPackStatus {
    return this.modelPack.getModelPackStatus(id)
  }

  listModelPacks(): ModelPackStatus[] {
    return this.modelPack.listModelPacks()
  }

  async startModelPackDownload(
    request: ModelPackDownloadRequest,
    onUpdate?: (status: ModelPackStatus) => void,
  ): Promise<ModelPackStatus> {
    return this.modelPack.startModelPackDownload(request, onUpdate)
  }

  cancelModelPackDownload(id: ModelPackId): ModelPackStatus {
    return this.modelPack.cancelModelPackDownload(id)
  }

  // Diagnostic for the Settings supplementary-download feature — body (and
  // rationale comment) in model-pack-manager.ts. The optional-probe signature
  // preserves the injected-probe seam used by the network-free tests.
  async selfTestModelPacks(
    probe?: (url: string) => Promise<number | null>,
  ): Promise<ModelPackSelfTestReport> {
    return this.modelPack.selfTestModelPacks(probe)
  }

  // Diagnostic twin of selfTestModelPacks for the skill-source pipeline: proves
  // the 国内/国外 fetch surface is reachable, the provenance path (ref→SHA)
  // resolves, and the staging dir is writable+cleanable — all WITHOUT pulling a
  // tarball. The latency probe and fetch are injected so the test is network-free.
  async selfTestSkillSources(
    probe: (url: string) => Promise<number | null> = (url) => this.probeEndpointLatency(url),
    fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ): Promise<SkillSourceSelfTestReport> {
    this.ensureRuntimeDirs()
    const startedAt = new Date().toISOString()

    const probes: SkillSourceProbe[] = []
    const endpoints: Array<{ source: SkillSourceProbe['source']; endpoint: string }> = [
      { source: 'overseas', endpoint: OVERSEAS_GITHUB_CODELOAD },
      { source: 'domestic', endpoint: new URL(DEFAULT_DOMESTIC_GITHUB_MIRROR_PREFIX).origin },
    ]
    for (const { source, endpoint } of endpoints) {
      const latencyMs = await probe(endpoint)
      probes.push({ source, endpoint, reachable: latencyMs !== null, latencyMs })
    }

    // Provenance path: resolve a stable public repo's HEAD commit (no payload).
    let refResolveOk = false
    let refResolveDetail = ''
    try {
      const { sha, usedRef } = await resolveGithubRefToSha('octocat', 'Hello-World', undefined, fetchImpl)
      refResolveOk = /^[0-9a-f]{7,40}$/i.test(sha)
      refResolveDetail = refResolveOk
        ? `已解析 octocat/Hello-World@${usedRef} → ${sha.slice(0, 12)}`
        : `GitHub 未返回有效提交 SHA（${sha}）`
    } catch (error) {
      // silent-catch: an unreachable GitHub API IS the finding — surfaced as
      // refResolveOk=false with the message, never aborting the rest of the report.
      refResolveDetail = error instanceof Error ? error.message : String(error)
    }

    const staging = this.runSkillStagingScratchCheck()

    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      probes,
      anyReachable: probes.some((p) => p.reachable),
      refResolveOk,
      refResolveDetail,
      stagingOk: staging.ok,
      stagingDetail: staging.detail,
    }
  }

  // Proves the skill-staging filesystem path works: a scratch dir under the
  // writable cacheRoot (same root fetchSkillToStaging uses) is created, written,
  // and cleaned up — never touching a real install. Mirrors the model-pack
  // integrity scratch check but for the simpler staging-root invariant.
  private runSkillStagingScratchCheck(): { ok: boolean; detail: string } {
    const base = join(this.cacheRoot, 'skill-staging', `.selftest-${randomUUID()}`)
    const marker = join(base, 'extract', 'SKILL.md')
    try {
      mkdirSync(join(base, 'extract'), { recursive: true })
      writeFileSync(marker, 'selftest')
      if (!existsSync(marker)) {
        return { ok: false, detail: '暂存目录自检失败：写入后未能读到暂存文件' }
      }
      rmSync(base, { recursive: true, force: true })
      if (existsSync(base)) {
        return { ok: false, detail: '暂存目录自检失败：清理后仍残留暂存目录' }
      }
      return { ok: true, detail: '暂存目录创建与清理路径正常' }
    } catch (error) {
      // silent-catch: a filesystem failure during the scratch check IS the finding —
      // surfaced to the caller as stagingOk=false with this message; the finally
      // still removes the throwaway scratch dir.
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }

  // B8-D M1 — private model-pack delegates. These four stay as manager-level
  // methods because they are referenced from outside the extracted cluster:
  // finalizeModelPackDownload is bind()-driven by model-pack-manager.test.ts;
  // probeEndpointLatency feeds selfTestSkillSources / installSkillFromSource /
  // getRuntimeProvisioner; the FunASR env builders feed getBaseEnv and the
  // ExternalEnvResolver injection. Bodies live in model-pack-manager.ts.
  private finalizeModelPackDownload(id: ModelPackId, code: number | null): string | null {
    return this.modelPack.finalizeModelPackDownload(id, code)
  }

  private async probeEndpointLatency(url: string): Promise<number | null> {
    return this.modelPack.probeEndpointLatency(url)
  }

  private buildFunasrNanoRuntimeEnv(): Record<string, string> {
    return this.modelPack.buildFunasrNanoRuntimeEnv()
  }

  private buildFunasrFallbackModelEnv(options: { packaged: boolean }): Record<string, string> {
    return this.modelPack.buildFunasrFallbackModelEnv(options)
  }

  // B8-D M1 — external-env delegates to ExternalEnvResolver (bodies, plus the
  // in-cluster-only requiresExternalEnv / exportBrowserVideoCookies helpers,
  // in external-env-resolver.ts).
  private resolveConfiguredAgentContext(definition: SkillDefinition): AgentSpawnContext | null {
    return this.externalEnv.resolveConfiguredAgentContext(definition)
  }

  private async resolveExternalEnv(definition: SkillDefinition): Promise<Record<string, string>> {
    return this.externalEnv.resolveExternalEnv(definition)
  }

  private cleanupExportedVideoCookieFile(cookiePath: string | undefined): void {
    this.externalEnv.cleanupExportedVideoCookieFile(cookiePath)
  }

  // B8-D M1 — delegate to SkillHostPrep (body in skill-host-prep.ts).
  private shouldPrepareSkillHost(requirements: import('../../../shared/skill-host-contract').SkillHostRequirements | null): boolean {
    return this.skillHostPrep.shouldPrepareSkillHost(requirements)
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

  // B8-D M1 — delegate to SkillHostPrep (body in skill-host-prep.ts).
  async runEmbeddedPython(params: {
    code?: string
    scriptPath?: string
    args?: string[]
    cwd?: string
    timeoutMs?: number
  }): Promise<{ success: boolean; stdout: string; stderr: string; command: string[]; error?: string }> {
    return this.skillHostPrep.runEmbeddedPython(params)
  }

  // ===========================================================================
  // Remote skill install (GitHub / tarball) — one read-only resolver feeding a
  // single installer gated by a trustAck choke-point. Clones the model-pack
  // download lifecycle (optimistic publish → source auto-switch → streamed
  // progress → try/catch reset → finally cleanup). The resolver performs any
  // intermediate install-doc fetch as DATA only: it regex-mines candidate
  // download addresses and NEVER feeds the doc's prose back as instructions, and
  // it NEVER installs. Both front doors (the SkillsCenterPanel URL input and the
  // agent install_skill tool) funnel through installSkillFromSource.
  // ===========================================================================

  getSkillInstallStatus(requestId: string): SkillInstallStatus {
    return this.skillInstallStatuses.get(requestId) ?? createDefaultSkillInstallStatus(requestId)
  }

  // Read-only resolve: parse freeform input → candidate source, pin a GitHub ref
  // to an immutable commit SHA (provenance), and classify a trust tier + concrete
  // risk reasons. NEVER installs. When the input is a URL that is not itself a
  // skill source, it is treated as an install doc / store page: fetched as
  // untrusted DATA and regex-mined for candidate sources (viaInstallDoc=true), so
  // the redskill/口令 shape surfaces look-alike-domain + typosquat reasons.
  async resolveSkillSource(
    input: string,
    options: { requestId?: string; fetchImpl?: FetchLike } = {},
  ): Promise<SkillSourceResolution> {
    const requestId = options.requestId ?? randomUUID()
    const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init))
    const trimmed = (input ?? '').trim()
    const bundledSkillIds = [...EMBEDDED_SKILL_IDS]
    const candidateNames = new Set<string>(extractCandidateSkillNames(trimmed))

    const direct = parseSkillSourceInput(trimmed)
    let source: SkillInstallSource | null = direct.ok ? direct.source : null
    let candidates: SkillInstallSource[] = source ? [source] : []
    let viaInstallDoc = false
    let docHost: string | null = null

    if (!source && /^https?:\/\//i.test(trimmed)) {
      try {
        docHost = new URL(trimmed).hostname.toLowerCase()
      } catch {
        // silent-catch: an unparseable URL just leaves docHost null; the risk
        // assessment then skips the look-alike-domain check for this input.
        docHost = null
      }
      const docText = await this.fetchInstallDocText(trimmed, fetchImpl)
      for (const name of extractCandidateSkillNames(docText)) candidateNames.add(name)
      candidates = extractCandidateSourcesFromDoc(docText)
      source = candidates[0] ?? null
      viaInstallDoc = true
    }

    if (!source) {
      return {
        requestId,
        input: trimmed,
        source: null,
        provenance: null,
        risk: assessSkillSourceRisk({
          host: docHost,
          viaInstallDoc,
          candidateSkillNames: [...candidateNames],
          bundledSkillIds,
        }),
        requiresPython: null,
        license: null,
        installable: false,
        reason: direct.ok ? '未能从该来源解析出可安装的技能地址' : direct.reason,
        viaInstallDoc,
        candidates,
      }
    }

    let provenance: SkillInstallProvenance | null = null
    let license: string | null = null
    let hasCommitPin = false
    if (source.kind === 'github') {
      try {
        const pin = await resolveGithubRefToSha(source.owner, source.repo, source.ref, fetchImpl)
        source = { ...source, ref: pin.sha }
        provenance = { commitSha: pin.sha }
        hasCommitPin = true
      } catch {
        // silent-catch: an unpinnable ref becomes a no-commit-pin risk reason
        // (community tier) rather than a hard failure, so the user can still decide.
        hasCommitPin = false
      }
      const meta = await fetchGithubRepoMetadata(source.owner, source.repo, fetchImpl)
      license = meta.licenseSpdx
      candidateNames.add(source.repo)
    } else if (source.kind === 'tarball') {
      hasCommitPin = Boolean(source.sha256)
      provenance = source.sha256 ? { sha256: source.sha256 } : null
    }

    const installable = source.kind !== 'registry'
    const risk = assessSkillSourceRisk({
      source,
      host: docHost,
      viaInstallDoc,
      hasCommitPin,
      license,
      candidateSkillNames: [...candidateNames],
      bundledSkillIds,
    })

    return {
      requestId,
      input: trimmed,
      source,
      provenance,
      risk,
      requiresPython: null,
      license,
      installable,
      reason: installable ? null : 'registry 来源暂不支持（Phase 2）',
      viaInstallDoc,
      candidates: candidates.length ? candidates : [source],
    }
  }

  // The single installer. REQUIRES request.trustAck === true — neither front door
  // can install without an explicit user trust acknowledgement. Resolves the
  // concrete tarball URL (国内/国外 auto-switch), streams the download into a
  // staging dir under the writable cacheRoot, then hands the located skill folder
  // to importCustomSkill (the existing scan→copy→register gate). Python-dependency
  // skills are detected from the staged folder BEFORE registering so a failed dep
  // deploy never leaves a half-registered skill. Staging is always cleaned up.
  async installSkillFromSource(
    request: SkillInstallRequest,
    onUpdate?: (status: SkillInstallStatus) => void,
    inject: {
      fetchImpl?: FetchLike
      probeLatency?: LatencyProbe
      deploySpawn?: SkillDeploySpawn
      deployBasePython?: () => Promise<string>
    } = {},
  ): Promise<SkillInstallStatus> {
    this.ensureRuntimeDirs()
    const { requestId } = request
    if (request.trustAck !== true) {
      throw new Error('安装未确认：缺少用户授权（trustAck）')
    }
    if (request.source.kind === 'registry') {
      throw new Error('registry 来源暂不支持（Phase 2）')
    }
    if (this.skillInstalls.has(requestId)) {
      return this.getSkillInstallStatus(requestId)
    }

    const controller = new AbortController()
    this.skillInstalls.set(requestId, controller)
    const downloadSource: ModelSource = request.downloadSource ?? 'auto'
    const probeLatency: LatencyProbe = inject.probeLatency ?? ((url) => this.probeEndpointLatency(url))

    const publish = (): void => {
      onUpdate?.(this.getSkillInstallStatus(requestId))
    }
    const patch = (next: Partial<SkillInstallStatus>): void => {
      this.skillInstallStatuses.set(requestId, {
        ...this.getSkillInstallStatus(requestId),
        ...next,
        updatedAt: new Date().toISOString(),
      })
    }

    const startedAt = new Date().toISOString()
    this.skillInstallStatuses.set(requestId, {
      ...createDefaultSkillInstallStatus(requestId),
      phase: 'resolving',
      source: request.source,
      downloadSource,
      provenance: request.provenance ?? null,
      startedAt,
      updatedAt: startedAt,
      lastMessage: '正在准备安装…',
    })
    publish()

    let stagingRoot: string | null = null
    try {
      const resolvedTarball = await resolveSkillTarballUrl(request.source, downloadSource, probeLatency)
      patch({
        phase: 'downloading',
        lastMessage: `开始下载（来源：${this.describeSkillMirror(resolvedTarball.mirror)}）`,
      })
      publish()

      const stripComponents = request.source.kind === 'github' ? 1 : 0
      const subdir = request.source.kind === 'github' ? request.source.subdir : undefined
      const expectedSha256 = request.source.kind === 'tarball'
        ? request.source.sha256 ?? request.provenance?.sha256 ?? undefined
        : undefined

      const fetched = await fetchSkillToStaging({
        url: resolvedTarball.url,
        requestId,
        cacheRoot: this.cacheRoot,
        subdir,
        stripComponents,
        expectedSha256,
        signal: controller.signal,
        fetchImpl: inject.fetchImpl,
        onProgress: (progress) => {
          patch({
            phase: 'downloading',
            downloadedBytes: progress.downloadedBytes,
            totalBytes: progress.totalBytes,
            progressPercent: progress.percent,
          })
          publish()
        },
      })
      stagingRoot = fetched.stagingRoot

      // Detect Python-dependency skills from the STAGED folder before we copy +
      // register, so a deps-deploy failure cannot leave a half-registered skill.
      const requiresPython = this.stagedSkillRequiresPython(fetched.skillDir)

      patch({
        phase: 'scanning',
        license: fetched.license,
        requiresPython,
        provenance: { commitSha: request.provenance?.commitSha ?? null, sha256: fetched.sha256 },
        lastMessage: '正在安全扫描…',
      })
      publish()

      patch({ phase: 'installing', lastMessage: '正在安装…' })
      publish()
      const skill = this.importCustomSkill(fetched.skillDir)

      // Python-dependency skills: deploy deps into a per-skill bundled-Python
      // overlay venv (online pip; offline fences dropped). A deploy failure rolls
      // back the just-registered skill so we never half-install a Python skill
      // whose dependencies are absent.
      if (requiresPython) {
        patch({ phase: 'deploying-deps', lastMessage: '正在部署 Python 依赖…' })
        publish()
        try {
          await this.deploySkillRequirements(
            {
              skillId: skill.id,
              mirror: resolvedTarball.mirror,
              signal: controller.signal,
              onPhase: (message) => {
                patch({ phase: 'deploying-deps', lastMessage: message })
                publish()
              },
            },
            inject.deploySpawn ?? this.defaultDeploySpawn,
            inject.deployBasePython ?? (() => this.resolveCustomVenvBasePython()),
          )
        } catch (depError) {
          try {
            this.removeCustomSkill(skill.id)
          } catch {
            // silent-catch: a rollback cleanup failure must not mask the deploy
            // error that triggered it; the original depError is rethrown below.
          }
          throw depError instanceof Error ? depError : new Error(String(depError))
        }
      }

      const completedAt = new Date().toISOString()
      patch({
        phase: 'done',
        skillId: skill.id,
        progressPercent: 100,
        completedAt,
        lastMessage: `已安装：${skill.name}`,
      })
      publish()
      return this.getSkillInstallStatus(requestId)
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      const message = error instanceof Error ? error.message : String(error)
      patch({
        phase: aborted ? 'cancelled' : 'error',
        error: aborted ? null : message,
        completedAt: new Date().toISOString(),
        lastMessage: aborted ? '已取消安装' : message,
      })
      publish()
      if (aborted) return this.getSkillInstallStatus(requestId)
      throw error instanceof Error ? error : new Error(message)
    } finally {
      this.skillInstalls.delete(requestId)
      if (stagingRoot) {
        try {
          rmSync(stagingRoot, { recursive: true, force: true })
        } catch {
          // silent-catch: staging lives under the writable cacheRoot; a cleanup
          // failure leaves a tmp dir but must not mask the install result.
        }
      }
    }
  }

  cancelSkillInstall(requestId: string): SkillInstallStatus {
    const controller = this.skillInstalls.get(requestId)
    if (controller) {
      controller.abort()
      this.skillInstalls.delete(requestId)
      const now = new Date().toISOString()
      this.skillInstallStatuses.set(requestId, {
        ...this.getSkillInstallStatus(requestId),
        phase: 'cancelled',
        updatedAt: now,
        completedAt: now,
        lastMessage: '已取消安装',
      })
    }
    return this.getSkillInstallStatus(requestId)
  }

  private describeSkillMirror(mirror: 'domestic' | 'overseas' | 'direct'): string {
    if (mirror === 'domestic') return '国内镜像'
    if (mirror === 'overseas') return 'GitHub（国外）'
    return '直链'
  }

  // Best-effort: does the staged skill folder declare a Python runtime (skill- or
  // action-level) or carry a requirements file? Read-only manifest inspection of
  // the staged folder, no copy. A malformed manifest resolves to false (the
  // security scan in importCustomSkill remains the hard gate).
  private stagedSkillRequiresPython(skillDir: string): boolean {
    try {
      const manifest = loadCustomSkillManifestFromFolder(skillDir)
      if (manifest.runtime === 'python') return true
      if (manifest.requirementsFile) return true
      return manifest.actions.some((action) => action.runtime === 'python')
    } catch {
      // silent-catch: an unreadable staged manifest defaults to requiresPython=false
      // (the importCustomSkill security scan stays the hard gate either way).
      return false
    }
  }

  // Fetch an intermediate install doc / store page as DATA only, bounded so a
  // hostile page cannot exhaust memory. Any failure resolves to an empty string
  // (the caller then surfaces "no installable address found"). The returned text
  // is ONLY regex-mined for candidate URLs; its prose is never executed.
  private async fetchInstallDocText(url: string, fetchImpl: FetchLike): Promise<string> {
    try {
      const res = await fetchImpl(url, {})
      if (!res.ok) return ''
      const text = await res.text()
      return text.slice(0, 256 * 1024)
    } catch {
      // silent-catch: a failed doc fetch resolves to empty text; the caller then
      // surfaces "no installable address found" rather than throwing.
      return ''
    }
  }

  // ── Bundled-Python overlay-venv dependency deploy (Q2) ─────────────────────
  // A source-installed Python skill gets its requirements deployed into a
  // per-skill venv built from the bundled interpreter with --system-site-packages
  // (so only the *delta* deps download; the bundled ML stack is reused, immutable).
  // Online pip is an explicit user-initiated action: the packaged runtime's
  // offline fences are dropped for the install, mirroring buildModelPackDownloadEnv.
  // The SAME overlay venv is what the run path resolves (installSkillInternal →
  // peekCustomSkillVenv), so install-time and run-time interpreters are coherent.

  private getCustomSkillVenvDir(skillId: SkillId): string {
    return join(this.customVenvsRoot, skillId)
  }

  private getCustomVenvPython(venvDir: string): string {
    return process.platform === 'win32'
      ? join(venvDir, 'Scripts', 'python.exe')
      : join(venvDir, 'bin', 'python')
  }

  // Read-only: return a skill's overlay venv (python + venvId) iff it is fully
  // built (interpreter present + marker readable). Null otherwise — the caller
  // then falls back to the shared host venv (existing local-import skills).
  private peekCustomSkillVenv(skillId: SkillId): { venvPython: string; venvId: string } | null {
    const venvDir = this.getCustomSkillVenvDir(skillId)
    const venvPython = this.getCustomVenvPython(venvDir)
    const markerPath = join(venvDir, CUSTOM_VENV_MARKER)
    if (!existsSync(venvPython) || !existsSync(markerPath)) return null
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as { venvId?: string }
      if (!marker.venvId) return null
      return { venvPython, venvId: marker.venvId }
    } catch {
      return null
    }
  }

  // Prefer the bundled interpreter; fall back to host Python when no packaged
  // runtime is present (dev). The venv created from it inherits --system-site-
  // packages so only the delta deps download.
  private async resolveCustomVenvBasePython(): Promise<string> {
    let basePython: string | null = null
    try {
      basePython = await this.resolvePackagedPythonPath()
    } catch {
      // silent-catch: no packaged runtime (dev) just falls through to the host
      // Python resolution below; it is not an error in unpackaged environments.
      basePython = null
    }
    if (!basePython) basePython = await this.findPythonExecutable()
    return basePython
  }

  // Build (idempotently) a per-skill overlay venv from the resolved base Python.
  // Writes a marker carrying a fresh venvId so the install-state can pin to this
  // build. The base-Python resolver is injectable so tests stay hermetic.
  private async ensureCustomSkillVenv(
    skillId: SkillId,
    spawn: SkillDeploySpawn,
    resolveBasePython: () => Promise<string>,
  ): Promise<{ venvPython: string; venvId: string }> {
    const existing = this.peekCustomSkillVenv(skillId)
    if (existing) return existing

    const venvDir = this.getCustomSkillVenvDir(skillId)
    rmSync(venvDir, { recursive: true, force: true })
    mkdirSync(venvDir, { recursive: true })

    const basePython = await resolveBasePython()
    await spawn(
      basePython,
      ['-m', 'venv', '--system-site-packages', venvDir],
      { env: this.getBaseEnv({ allowPackaged: true }), timeout: 180_000 },
    )

    const venvPython = this.getCustomVenvPython(venvDir)
    const venvId = randomUUID()
    atomicWriteJson(join(venvDir, CUSTOM_VENV_MARKER), {
      venvId,
      basePython,
      createdAt: new Date().toISOString(),
    })
    return { venvPython, venvId }
  }

  // Online pip env: clone the (packaged) base env, drop the offline fences, and
  // apply the 国内/国外 switch to the pip index (consistent with the tarball mirror).
  private buildCustomSkillDeployEnv(mirror: 'domestic' | 'overseas' | 'direct'): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.getBaseEnv({ allowPackaged: true }) }
    delete env.PIP_NO_INDEX
    delete env.HF_HUB_OFFLINE
    delete env.TRANSFORMERS_OFFLINE
    delete env.MODELSCOPE_OFFLINE
    if (mirror === 'domestic') {
      env.PIP_INDEX_URL = DOMESTIC_PIP_INDEX_URL
      env.PIP_EXTRA_INDEX_URL = 'https://pypi.org/simple'
    }
    return env
  }

  // Deploy a registered Python skill's requirements into its overlay venv, then
  // record the install-state so the offline-by-default run path treats the deps
  // as installed (and reuses the overlay interpreter) without re-running pip.
  private async deploySkillRequirements(
    params: {
      skillId: string
      mirror: 'domestic' | 'overseas' | 'direct'
      signal?: AbortSignal
      onPhase: (message: string) => void
    },
    spawn: SkillDeploySpawn,
    resolveBasePython: () => Promise<string>,
  ): Promise<void> {
    const customSkill = getManagedCustomSkill(this.customSkillsRoot, params.skillId)
    if (!customSkill) {
      throw new Error('技能安装记录缺失，无法部署 Python 依赖')
    }
    const requirementsPath = customSkill.requirementsFile
      ? join(customSkill.managedPath, customSkill.requirementsFile)
      : ''

    params.onPhase('正在准备 Python 运行环境…')
    if (params.signal?.aborted) throw this.skillInstallAbortError()
    const overlay = await this.ensureCustomSkillVenv(customSkill.id, spawn, resolveBasePython)

    if (customSkill.requirementsFile && existsSync(requirementsPath)) {
      params.onPhase('正在在线安装依赖…')
      if (params.signal?.aborted) throw this.skillInstallAbortError()
      const env = this.buildCustomSkillDeployEnv(params.mirror)
      try {
        await spawn(
          overlay.venvPython,
          ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirementsPath],
          { env, signal: params.signal, timeout: 3_600_000 },
        )
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Python 依赖在线安装失败（请检查网络后重试）：${detail}`)
      }
    }

    const statePath = getInstallStatePath(customSkill.managedPath)
    const digest = customSkill.requirementsFile ? requirementsDigest(requirementsPath) : 'none'
    atomicWriteJson(statePath, {
      version: customSkill.version,
      requirementsDigest: digest,
      installedAt: new Date().toISOString(),
      venvId: overlay.venvId,
    } satisfies SkillInstallState)
  }

  private skillInstallAbortError(): Error {
    const error = new Error('安装已取消')
    error.name = 'AbortError'
    return error
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

  updateCustomSkillDescription(skillId: string, description: string, name?: string): SkillState {
    this.ensureRuntimeDirs()
    const record = updateManagedCustomSkillDescription(this.customSkillsRoot, skillId, description, name)
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
   * One-click runtime provisioner (download + configure Python/ffmpeg/core deps).
   * Real IO is wired here; orchestration/classification live in RuntimeProvisioner.
   * See docs/superpowers/plans/2026-06-23-one-click-runtime-provisioning-implementation.md
   */
  getRuntimeProvisioner(): RuntimeProvisioner {
    if (this.runtimeProvisioner) return this.runtimeProvisioner
    const platformKey = resolveRuntimePlatformKey(process.platform, process.arch)
    const isWindows = process.platform === 'win32'
    const provisionEnv = (): NodeJS.ProcessEnv => this.getBaseEnv({ allowPackaged: false })
    const deps: RuntimeProvisionerDeps = {
      runtimeRoot: this.runtimeRoot,
      platformKey,
      isWindows,
      listAssets: () => (platformKey ? getRuntimeAssets(platformKey) : []),
      fs: {
        exists: (path) => existsSync(path),
        readText: (path) => readTextOrNull(path),
        realpath: (path) => realpathOrNull(path),
        rmrf: (path) => rmSync(path, { recursive: true, force: true }),
        mkdirp: (path) => mkdirSync(path, { recursive: true }),
        placeExecutable: (src, dest) => placeRuntimeExecutable(src, dest),
        join: (...parts) => join(...parts),
      },
      getMirrorBase: () => {
        try {
          return getDatabase().getSetting('runtime_asset_mirror_base')?.trim() || null
        } catch {
          // silent-catch: settings DB unavailable just means no custom mirror this run.
          return null
        }
      },
      setSkillsPythonPath: (path) => {
        try {
          getDatabase().setSetting('skills_python_path', path)
        } catch {
          // silent-catch: if the DB write fails the provisioner re-probes and surfaces not-ready.
        }
      },
      probe: (url) => this.probeEndpointLatency(url),
      download: (url, onProgress, signal) => downloadRuntimeArchive(url, onProgress, signal, 800 * 1024 * 1024),
      sha256: (buffer) => sha256Buffer(buffer),
      extractArchive: (params) => extractRuntimeArchive(params),
      probeBinary: (path, kind, expectedArch) => probeRuntimeBinary(path, kind, provisionEnv(), expectedArch),
      rebuildVenvFromBase: async () => {
        await this.ensurePythonVenv({ allowPackaged: false })
      },
      probeVenvPython: async () => {
        const pythonPath = this.getVenvPythonPath()
        const result = await probeRuntimeBinary(pythonPath, 'python', provisionEnv())
        return { ok: result.ok, version: result.version, sslOk: result.sslOk, path: result.ok ? pythonPath : undefined }
      },
      installCoreDeps: async () => {
        const result = await this.ensureSkillInstalled('video-expert-analyzer')
        return { ready: result.success, missing: result.success ? [] : ['video-expert-analyzer'] }
      },
      coreDepsStatus: async () => {
        const pythonPath = this.getVenvPythonPath()
        if (!existsSync(pythonPath)) return { ready: false, missing: ['python'] }
        const mods = ['yt_dlp', 'scenedetect', 'numpy', 'PIL']
        try {
          const { stdout } = await execFileAsync(
            pythonPath,
            ['-c', `import importlib.util;mods=${JSON.stringify(mods)};print(','.join([m for m in mods if importlib.util.find_spec(m) is None]))`],
            { env: provisionEnv(), timeout: 20_000 },
          )
          const missing = stdout.trim() ? stdout.trim().split(',') : []
          return { ready: missing.length === 0, missing }
        } catch {
          // silent-catch: probe failure (venv mid-build) reads as not-ready, never throws.
          return { ready: false, missing: ['probe_failed'] }
        }
      },
      venvRootPath: () => this.venvRoot,
      pythonDistRoot: () => join(this.runtimeRoot, 'python-dist'),
    }
    this.runtimeProvisioner = new RuntimeProvisioner(deps)
    return this.runtimeProvisioner
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
        for (const cookiePath of new Set([
          externalEnv.READY_VIDEO_COOKIE_FILE,
          externalEnv.VIDEO_COOKIE_FILE,
          externalEnv.YOUTUBE_COOKIE_FILE,
        ])) {
          this.cleanupExportedVideoCookieFile(cookiePath)
        }
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
    const skill = this.listSkills().find((item) => item.id === request.skillId)
    if (!skill) {
      throw new Error(`Unknown skill: ${request.skillId}`)
    }
    const knownAction = skill.actions.some((action) => action.name === request.action)
    if (!knownAction) {
      throw new Error(`Unknown action: ${request.action}`)
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
      const result = await this.runSkill({
        skillId: schedule.skill_id,
        action: schedule.action,
        params,
        triggerType: 'schedule',
        scheduleId: schedule.id,
      })
      const db = this.getRawDatabase()
      if (!db) return
      const now = Date.now()
      if (!result.success) {
        const retryRunAt = new Date(now + 5 * 60_000).toISOString()
        db.prepare('UPDATE skills_schedules SET next_run_at = ?, updated_at = ? WHERE id = ?')
          .run(retryRunAt, new Date(now).toISOString(), schedule.id)
        return
      }
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
    // Interpreter precedence: a per-skill overlay venv (bundled-Python derived,
    // deps deployed online at install-from-source time) wins; skills imported
    // before overlay deploy existed fall back to the shared host venv. The SAME
    // venvPython feeds the run-time spawn (runDefinitionActionDirect), so resolving
    // it here keeps install and run coherent — no second interpreter source.
    const overlayVenv = requiresPython ? this.peekCustomSkillVenv(customSkill.id) : null
    const venvPython = requiresPython
      ? (overlayVenv?.venvPython ?? await this.ensurePythonVenv({ allowPackaged: false }))
      : undefined
    const venvId = requiresPython
      ? (overlayVenv?.venvId ?? this.readPythonRuntimeState({ allowPackaged: false })?.venvId)
      : undefined

    if (!force && existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8')) as SkillInstallState
        if (
          state.version === customSkill.version
          && state.requirementsDigest === digest
          && (!requiresPython || (state.venvId && state.venvId === venvId))
        ) {
          return { success: true, skillId: customSkill.id, skillPath: customSkill.managedPath, venvPython }
        }
      } catch {
        // continue to reinstall
      }
    }

    try {
      // Overlay-venv skills had their deps deployed online at install time (and
      // the run path is offline-by-default), so only the host-venv fallback runs
      // pip here. An overlay venv with stale deps refreshes via a fresh install.
      if (requiresPython && !overlayVenv) {
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
        venvId,
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

  // B8-D M1 — delegate to MaintenanceSweeps (body, rationale doc and the
  // one-shot `orphanCleanupRan` latch live in maintenance-sweeps.ts). Stays
  // public so tests keep invoking it deterministically.
  async cleanupOrphanedSkillArtifactsOnce(): Promise<void> {
    return this.maintenanceSweeps.cleanupOrphanedSkillArtifactsOnce()
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

// B8-P (2026-07-05) — pure move: the Phase 7 `startSkillChildRunAndWait`
// compatibility helper (banner, types, lazy-import body) now lives in
// start-skill-child-run-and-wait.ts. Re-exported so existing callers keep
// importing it from runtime-manager.
export {
  startSkillChildRunAndWait,
  type StartSkillChildRunAndWaitParams,
  type StartSkillChildRunAndWaitResult,
} from './start-skill-child-run-and-wait'
