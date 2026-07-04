import type { ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { join } from 'path'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'

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
import { EMBEDDED_SKILLS, EMBEDDED_SKILL_IDS, type EmbeddedSkillId, type EmbeddedSkillManifest, getEmbeddedSkillManifest } from './manifest'
import type {
  SkillDefinition,
  SkillInputValue,
  SkillParamDefinition,
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
import type {
  SkillHostController,
} from './skill-host-controller'
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
  getPackagedSkillPythonBinDir,
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
  CUSTOM_VENV_MARKER,
  DOMESTIC_PIP_INDEX_URL,
  MAX_COMMAND_BUFFER,
  SCHEDULER_INTERVAL_MS,
  hashDirectoryContents,
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
// B8-D M2 (2026-07-05) — second batch, same shape: execution engine + python
// runtime provisioning extracted as constructor-injected delegate classes.
import { SkillExecutionEngine } from './skill-execution-engine'
import { PythonRuntimeProvisioner } from './python-runtime-provisioner'
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
  // B8-D M2 — second-batch delegated sub-services.
  private readonly executionEngine: SkillExecutionEngine
  private readonly pythonRuntime: PythonRuntimeProvisioner

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
    // B8-D M2 — python runtime provisioning + execution engine. Cross-service
    // dependencies stay lazy `this.*` delegate closures (same rule as M1), so
    // construction order among services does not matter. The manager keeps
    // same-name one-line delegates (getBaseEnv/ensurePythonVenv/...), which is
    // what keeps the M1 services' injected callbacks resolving to the moved
    // bodies without rewiring them.
    this.pythonRuntime = new PythonRuntimeProvisioner({
      venvRoot: this.venvRoot,
      runtimeBin: this.runtimeBin,
      cacheRoot: this.cacheRoot,
      pipCache: this.pipCache,
      packagedRuntimeRoot: this.packagedRuntimeRoot,
      packagedRuntimeManifest: this.packagedRuntimeManifest,
      buildFunasrNanoRuntimeEnv: () => this.buildFunasrNanoRuntimeEnv(),
      buildFunasrFallbackModelEnv: (funasrOptions) => this.buildFunasrFallbackModelEnv(funasrOptions),
      getSkillRuntimePath: (skillId) => this.getSkillRuntimePath(skillId),
    })
    this.executionEngine = new SkillExecutionEngine({
      runtimeRoot: this.runtimeRoot,
      outputsRoot: this.outputsRoot,
      ensureRuntimeDirs: () => this.ensureRuntimeDirs(),
      ensureSkillInstalled: (skillId) => this.ensureSkillInstalled(skillId),
      getSkillLoader: () => this.getSkillLoader(),
      getSkillRuntimePath: (skillId) => this.getSkillRuntimePath(skillId),
      getHostController: () => this.getHostController(),
      shouldPrepareSkillHost: (requirements) => this.shouldPrepareSkillHost(requirements),
      resolveConfiguredAgentContext: (definition) => this.resolveConfiguredAgentContext(definition),
      resolveExternalEnv: (definition) => this.resolveExternalEnv(definition),
      cleanupExportedVideoCookieFile: (cookiePath) => this.cleanupExportedVideoCookieFile(cookiePath),
      resolveOutputDir: (candidate, skillId, jobId) => this.resolveOutputDir(candidate, skillId, jobId),
      getBaseEnv: (envOptions) => this.getBaseEnv(envOptions),
      recordJobStart: (params) => this.recordJobStart(params),
      recordJobFinish: (jobId, result) => this.recordJobFinish(jobId, result),
      parseJson: (raw, fallback) => this.parseJson(raw, fallback),
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

  // B8-D M2 — delegates to SkillExecutionEngine (bodies, the Phase 5
  // child-runner alias rationale and the C6 overflow plumbing live in
  // skill-execution-engine.ts). Public call face (skills-tools / ipc-handler /
  // child runner duck-typing) is unchanged.
  async runSkillFromChildRunner(request: SkillRunRequest): Promise<SkillRunResult> {
    return this.executionEngine.runSkillFromChildRunner(request)
  }

  async runSkill(request: SkillRunRequest): Promise<SkillRunResult> {
    return this.executionEngine.runSkill(request)
  }

  // B8-D M2 — private delegate kept on the manager because
  // skill-runtime-structured-result.test.ts invokes it directly on the
  // manager instance (structured-result adjudication + missing-model-pack
  // signal tests). Body lives in skill-execution-engine.ts.
  private toDirectRunResult(
    skillId: string,
    actionName: string,
    executed: Parameters<SkillExecutionEngine['toDirectRunResult']>[2],
  ): SkillRunResult {
    return this.executionEngine.toDirectRunResult(skillId, actionName, executed)
  }

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

  // B8-D M2 — delegates to PythonRuntimeProvisioner (bodies, the Phase 1.3
  // rebuild/startup rationale docs and the version/ssl gate logic live in
  // python-runtime-provisioner.ts). getBaseEnv stays the shared env entry:
  // every `() => this.getBaseEnv()` / `() => this.ensurePythonVenv()` callback
  // injected into the M1 services (ModelPackManager / SkillHostPrep) keeps
  // resolving through these same-name delegates.
  private async ensurePythonVenv(options: { allowPackaged?: boolean } = {}): Promise<string> {
    return this.pythonRuntime.ensurePythonVenv(options)
  }

  // Phase 1.3 public startup hook (setupAgentIPC) — stable public face; the
  // structured-result wrapper body is in python-runtime-provisioner.ts.
  async ensurePythonRuntimeReady(): Promise<{
    ready: boolean
    pythonPath?: string
    version?: string
    error?: string
  }> {
    return this.pythonRuntime.ensurePythonRuntimeReady()
  }

  private getVenvPythonPath(): string {
    return this.pythonRuntime.getVenvPythonPath()
  }

  private async findPythonExecutable(): Promise<string> {
    return this.pythonRuntime.findPythonExecutable()
  }

  private async resolvePackagedPythonPath(): Promise<string | null> {
    return this.pythonRuntime.resolvePackagedPythonPath()
  }

  private assertPackagedRuntimeCoversEmbeddedSkill(skillId: EmbeddedSkillId): void {
    const covered = this.packagedRuntimeManifest?.embeddedSkillIds || []
    if (!covered.includes(skillId)) {
      throw new Error(`Packaged skill runtime does not declare dependency coverage for embedded skill: ${skillId}`)
    }
  }

  private readPythonRuntimeState(options: { allowPackaged?: boolean } = {}): PythonRuntimeState | null {
    return this.pythonRuntime.readPythonRuntimeState(options)
  }

  private async installRequirements(
    venvPython: string,
    requirementsPath: string,
    options: { allowPackaged?: boolean } = {},
  ): Promise<void> {
    return this.pythonRuntime.installRequirements(venvPython, requirementsPath, options)
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
    return this.pythonRuntime.linkIfFound(binaryName)
  }

  private getBaseEnv(options: { allowPackaged?: boolean } = {}): NodeJS.ProcessEnv {
    return this.pythonRuntime.getBaseEnv(options)
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

  // B8-D M2 — runPythonScript moved verbatim to python-runtime-provisioner.ts
  // (no manager-side callers, so no delegate is kept).
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
