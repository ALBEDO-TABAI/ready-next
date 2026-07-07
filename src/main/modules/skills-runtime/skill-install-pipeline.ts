import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'

import { atomicWriteJson } from '../agent-control/atomic-write'
import {
  EMBEDDED_SKILL_IDS,
  type EmbeddedSkillId,
  type EmbeddedSkillManifest,
  getEmbeddedSkillManifest,
} from './manifest'
import {
  getManagedCustomSkill,
  loadCustomSkillManifestFromFolder,
} from './custom-skill-registry'
import {
  assessSkillSourceRisk,
  createDefaultSkillInstallStatus,
  parseSkillSourceInput,
  type ModelSource,
  type SkillInstallProvenance,
  type SkillInstallRequest,
  type SkillInstallStatus,
  type SkillSource as SkillInstallSource,
  type SkillSourceResolution,
} from '../../../shared/skill-source-types'
import {
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
  CUSTOM_VENV_MARKER,
  DOMESTIC_PIP_INDEX_URL,
  getInstallStatePath,
  requirementsDigest,
} from './runtime-manager-helpers'
import type {
  PythonRuntimeState,
  SkillDeploySpawn,
  SkillId,
  SkillImportResult,
  SkillInstallResult,
  SkillInstallState,
  SkillState,
} from './runtime-manager-types'

// B8-D M3 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表, install pipeline 缝). Method bodies moved verbatim;
// the only edits are the mechanical `this.X` → `this.deps.X` rewrites for the
// injected dependency face below. The AbortController-per-request Maps, the
// per-skill install lock Map and their cancel/lock semantics move here as
// exclusive state (no test pokes the manager instance's properties, unlike the
// M1 model-pack Maps). Custom-skill CRUD (importCustomSkill/removeCustomSkill),
// embedded sync, python-runtime provisioning and the toolchain gate stay owned
// by their home clusters on the manager and are injected as callbacks so this
// file never imports runtime-manager (防环).

export interface SkillInstallPipelineDeps {
  cacheRoot: string
  customSkillsRoot: string
  customVenvsRoot: string
  packagedRuntimeRoot: string | null
  // Production dependency-deploy subprocess seam (venv + pip). Tests override
  // via installSkillFromSource's `inject.deploySpawn`.
  defaultDeploySpawn: SkillDeploySpawn
  ensureRuntimeDirs: () => void
  probeEndpointLatency: (url: string) => Promise<number | null>
  importCustomSkill: (sourcePath: string) => SkillImportResult
  removeCustomSkill: (skillId: string) => { removed: boolean }
  getBaseEnv: (options?: { allowPackaged?: boolean }) => NodeJS.ProcessEnv
  resolvePackagedPythonPath: () => Promise<string | null>
  findPythonExecutable: () => Promise<string>
  ensurePythonVenv: (options?: { allowPackaged?: boolean }) => Promise<string>
  readPythonRuntimeState: (options?: { allowPackaged?: boolean }) => PythonRuntimeState | null
  ensureRuntimeToolchain: (options?: { allowPackaged?: boolean }) => Promise<void>
  installRequirements: (
    venvPython: string,
    requirementsPath: string,
    options?: { allowPackaged?: boolean },
  ) => Promise<void>
  syncEmbeddedSkill: (manifest: EmbeddedSkillManifest) => string
  assertPackagedRuntimeCoversEmbeddedSkill: (skillId: EmbeddedSkillId) => void
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

export class SkillInstallPipeline {
  private installLocks = new Map<SkillId, Promise<SkillInstallResult>>()
  // Remote skill installs, keyed by an opaque requestId so multiple installs run
  // and cancel independently (the AbortController is the cancel handle, mirroring
  // the model-pack download Maps on the manager).
  private skillInstalls = new Map<string, AbortController>()
  private skillInstallStatuses = new Map<string, SkillInstallStatus>()

  constructor(private readonly deps: SkillInstallPipelineDeps) {}

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
    this.deps.ensureRuntimeDirs()
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
    const probeLatency: LatencyProbe = inject.probeLatency ?? ((url) => this.deps.probeEndpointLatency(url))

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
        cacheRoot: this.deps.cacheRoot,
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
      const { skill } = this.deps.importCustomSkill(fetched.skillDir)

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
            inject.deploySpawn ?? this.deps.defaultDeploySpawn,
            inject.deployBasePython ?? (() => this.resolveCustomVenvBasePython()),
          )
        } catch (depError) {
          try {
            this.deps.removeCustomSkill(skill.id)
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
    return join(this.deps.customVenvsRoot, skillId)
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
      basePython = await this.deps.resolvePackagedPythonPath()
    } catch {
      // silent-catch: no packaged runtime (dev) just falls through to the host
      // Python resolution below; it is not an error in unpackaged environments.
      basePython = null
    }
    if (!basePython) basePython = await this.deps.findPythonExecutable()
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
      { env: this.deps.getBaseEnv({ allowPackaged: true }), timeout: 180_000 },
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
    const env: NodeJS.ProcessEnv = { ...this.deps.getBaseEnv({ allowPackaged: true }) }
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
    const customSkill = getManagedCustomSkill(this.deps.customSkillsRoot, params.skillId)
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

  private async installSkillInternal(skillId: SkillId, force: boolean): Promise<SkillInstallResult> {
    const manifest = getEmbeddedSkillManifest(skillId)
    if (manifest) {
      this.deps.ensureRuntimeDirs()
      const skillPath = this.deps.syncEmbeddedSkill(manifest)
      const statePath = getInstallStatePath(skillPath)
      const requirementsPath = join(skillPath, manifest.requirementsFile)
      const digest = requirementsDigest(requirementsPath)
      const venvPython = await this.deps.ensurePythonVenv()
      const venvState = this.deps.readPythonRuntimeState()

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
        if (this.deps.packagedRuntimeRoot) {
          this.deps.assertPackagedRuntimeCoversEmbeddedSkill(manifest.id)
        } else {
          await this.deps.ensureRuntimeToolchain()
          if (existsSync(requirementsPath)) {
            await this.deps.installRequirements(venvPython, requirementsPath)
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

    const customSkill = getManagedCustomSkill(this.deps.customSkillsRoot, skillId)
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
      ? (overlayVenv?.venvPython ?? await this.deps.ensurePythonVenv({ allowPackaged: false }))
      : undefined
    const venvId = requiresPython
      ? (overlayVenv?.venvId ?? this.deps.readPythonRuntimeState({ allowPackaged: false })?.venvId)
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
        await this.deps.ensureRuntimeToolchain({ allowPackaged: false })
        if (customSkill.requirementsFile && existsSync(requirementsPath)) {
          await this.deps.installRequirements(venvPython, requirementsPath, { allowPackaged: false })
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
}
