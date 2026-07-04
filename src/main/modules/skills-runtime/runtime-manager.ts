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
import { EMBEDDED_SKILLS, type EmbeddedSkillId, type EmbeddedSkillManifest, getEmbeddedSkillManifest } from './manifest'
import type {
  SkillDefinition,
  SkillInputValue,
  SkillParamDefinition,
} from '../../../shared/skill-execution-types'
import {
  type RegisteredCustomSkill,
  importCustomSkillFolder,
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
  type SkillInstallRequest,
  type SkillInstallStatus,
  type SkillSourceProbe,
  type SkillSourceResolution,
  type SkillSourceSelfTestReport,
} from '../../../shared/skill-source-types'
import {
  DEFAULT_DOMESTIC_GITHUB_MIRROR_PREFIX,
  OVERSEAS_GITHUB_CODELOAD,
  resolveGithubRefToSha,
  type FetchLike,
  type LatencyProbe,
} from './skill-source-registry'

import {
  execFileAsync,
  EMBEDDED_SYNC_STATE_FILENAME,
  MAX_COMMAND_BUFFER,
  hashDirectoryContents,
  getInstallStatePath,
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
// B8-D M3 (2026-07-05) — final batch: remote-install pipeline (AbortController
// Maps + per-skill install lock migrate as exclusive state) and job scheduler
// (timer + running-schedule Set migrate as exclusive state).
import { SkillInstallPipeline } from './skill-install-pipeline'
import { SkillJobScheduler } from './skill-job-scheduler'
import type {
  SkillDeploySpawn,
  SkillTriggerType,
  SkillId,
  SkillState,
  SkillsRuntimeInfo,
  PythonRuntimeState,
  SkillsRuntimeManagerOptions,
  SkillInstallResult,
  SkillRunResult,
  SkillRunRequest,
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
  // One in-flight download per pack so packs download independently.
  // B8-D M1: the Maps stay declared here (model-pack-manager.test.ts pokes the
  // manager instance's properties directly) and are shared by reference with
  // the ModelPackManager sub-service, which owns all reads/writes.
  // B8-D M3: the skill-install AbortController Maps, the install lock Map and
  // the scheduler timer/running-Set had no such test pokes, so they migrated
  // into SkillInstallPipeline / SkillJobScheduler as exclusive state.
  private modelPackDownloads = new Map<ModelPackId, ChildProcessWithoutNullStreams>()
  private modelPackDownloadStatuses = new Map<ModelPackId, ModelPackDownloadStatus>()
  // Production dependency-deploy subprocess seam (venv + pip). Injected by value
  // into SkillInstallPipeline; tests override via installSkillFromSource's
  // `inject.deploySpawn`.
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
  // B8-D M3 — final-batch delegated sub-services.
  private readonly installPipeline: SkillInstallPipeline
  private readonly jobScheduler: SkillJobScheduler

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
    // B8-D M3 — install pipeline + job scheduler. Same lazy `this.*` closure
    // rule as M1/M2: the callbacks resolve through the manager's same-name
    // delegates at call time, so construction order among services does not
    // matter, and test monkey-patches on the manager instance
    // (getRawDatabase / listSkills / runSkill in skill-schedule-tick-outcome)
    // keep intercepting the injected paths.
    this.installPipeline = new SkillInstallPipeline({
      cacheRoot: this.cacheRoot,
      customSkillsRoot: this.customSkillsRoot,
      customVenvsRoot: this.customVenvsRoot,
      packagedRuntimeRoot: this.packagedRuntimeRoot,
      defaultDeploySpawn: this.defaultDeploySpawn,
      ensureRuntimeDirs: () => this.ensureRuntimeDirs(),
      probeEndpointLatency: (url) => this.probeEndpointLatency(url),
      importCustomSkill: (sourcePath) => this.importCustomSkill(sourcePath),
      removeCustomSkill: (skillId) => this.removeCustomSkill(skillId),
      getBaseEnv: (envOptions) => this.getBaseEnv(envOptions),
      resolvePackagedPythonPath: () => this.resolvePackagedPythonPath(),
      findPythonExecutable: () => this.findPythonExecutable(),
      ensurePythonVenv: (venvOptions) => this.ensurePythonVenv(venvOptions),
      readPythonRuntimeState: (stateOptions) => this.readPythonRuntimeState(stateOptions),
      ensureRuntimeToolchain: (toolchainOptions) => this.ensureRuntimeToolchain(toolchainOptions),
      installRequirements: (venvPython, requirementsPath, reqOptions) =>
        this.installRequirements(venvPython, requirementsPath, reqOptions),
      syncEmbeddedSkill: (manifest) => this.syncEmbeddedSkill(manifest),
      assertPackagedRuntimeCoversEmbeddedSkill: (skillId) => this.assertPackagedRuntimeCoversEmbeddedSkill(skillId),
    })
    this.jobScheduler = new SkillJobScheduler({
      getRawDatabase: () => this.getRawDatabase(),
      parseJson: (raw, fallback) => this.parseJson(raw, fallback),
      runSkill: (request) => this.runSkill(request),
      listSkills: () => this.listSkills(),
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

  // B8-D M3 — remote skill install (GitHub / tarball) delegates to
  // SkillInstallPipeline (bodies, the trustAck/staging/rollback lifecycle
  // rationale, the AbortController Maps, the per-skill install lock and the
  // custom-venv dependency-deploy cluster live in skill-install-pipeline.ts).
  // Both front doors (SkillsCenterPanel URL input and the agent install_skill
  // tool) keep funnelling through these manager methods unchanged.

  getSkillInstallStatus(requestId: string): SkillInstallStatus {
    return this.installPipeline.getSkillInstallStatus(requestId)
  }

  async resolveSkillSource(
    input: string,
    options: { requestId?: string; fetchImpl?: FetchLike } = {},
  ): Promise<SkillSourceResolution> {
    return this.installPipeline.resolveSkillSource(input, options)
  }

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
    return this.installPipeline.installSkillFromSource(request, onUpdate, inject)
  }

  cancelSkillInstall(requestId: string): SkillInstallStatus {
    return this.installPipeline.cancelSkillInstall(requestId)
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

  // B8-D M3 — cross-cluster install entry. The per-skill lock Map and the
  // embedded/custom installSkillInternal body live in skill-install-pipeline.ts;
  // the M1/M2 services' injected `ensureSkillInstalled` callbacks keep resolving
  // through this same-name delegate (M2 getBaseEnv 同款续接).
  async ensureSkillInstalled(skillId: SkillId, force = false): Promise<SkillInstallResult> {
    return this.installPipeline.ensureSkillInstalled(skillId, force)
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

  // B8-D M3 — jobs/schedules surface delegates to SkillJobScheduler (bodies,
  // the timer + running-schedule Set and the tick/retry semantics live in
  // skill-job-scheduler.ts). getRawDatabase and parseJson keep their bodies
  // here: skill-schedule-tick-outcome.test.ts monkey-patches them (and
  // listSkills / runSkill) as manager instance properties, and the scheduler's
  // injected lazy closures resolve through the patched members at call time.
  listJobs(limit = 80): SkillJobRecord[] {
    return this.jobScheduler.listJobs(limit)
  }

  listSchedules(): SkillScheduleRecord[] {
    return this.jobScheduler.listSchedules()
  }

  createSchedule(request: CreateSkillScheduleRequest): SkillScheduleRecord {
    return this.jobScheduler.createSchedule(request)
  }

  updateScheduleEnabled(scheduleId: string, enabled: boolean): SkillScheduleRecord | null {
    return this.jobScheduler.updateScheduleEnabled(scheduleId, enabled)
  }

  deleteSchedule(scheduleId: string): boolean {
    return this.jobScheduler.deleteSchedule(scheduleId)
  }

  private getRawDatabase(): DatabaseConnection | null {
    try {
      return getDatabase().getDatabase() as DatabaseConnection | null
    } catch {
      return null
    }
  }

  private parseJson<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  // B8-D M3 — private job-bookkeeping delegates. They stay as manager-level
  // methods because the M2 SkillExecutionEngine injection
  // (`recordJobStart/recordJobFinish` closures in the constructor above)
  // resolves through them, and runScheduledTask is invoked directly on the
  // manager instance by skill-schedule-tick-outcome.test.ts (M1
  // finalizeModelPackDownload 同款处理). Bodies live in skill-job-scheduler.ts.
  private recordJobStart(params: {
    skillId: SkillId
    action: string
    params?: Record<string, unknown>
    triggerType: SkillTriggerType
    scheduleId: string | null
  }): string {
    return this.jobScheduler.recordJobStart(params)
  }

  private recordJobFinish(jobId: string, result: SkillRunResult): void {
    this.jobScheduler.recordJobFinish(jobId, result)
  }

  private startScheduler(): void {
    this.jobScheduler.startScheduler()
  }

  private async runScheduledTask(schedule: SkillScheduleRow): Promise<void> {
    return this.jobScheduler.runScheduledTask(schedule)
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
