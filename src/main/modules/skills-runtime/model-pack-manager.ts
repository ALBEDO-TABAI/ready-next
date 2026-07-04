import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import {
  MODEL_PACK_IDS,
  createDefaultModelPackDownloadStatus,
  type ModelPackDownloadRequest,
  type ModelPackDownloadStatus,
  type ModelPackId,
  type ModelPackSelfTestEntry,
  type ModelPackSelfTestReport,
  type ModelPackSourceProbe,
  type ModelPackStatus,
} from '../../../shared/model-pack-types'
import {
  buildModelPackDownloadScript,
  getModelPackDescriptor,
  reduceDownloadProgressChunk,
  resolveExplicitModelProvider,
  resolveModelProvider,
  resolvedProviderEndpoint,
  type ResolvedModelProvider,
} from './model-pack-registry'
import type { SkillId, SkillInstallResult } from './runtime-manager-types'

// B8-D M1 (2026-07-05) — delegated extraction from SkillsRuntimeManager
// (surgery map §2.3 D 表, 缝 A). Method bodies moved verbatim; the only edits
// are the mechanical `this.X` → `this.deps.X` rewrites for the injected
// dependency face below. SkillsRuntimeManager keeps one-line delegates so the
// external call face (IPC handler, Settings UI, tests) is unchanged.

export interface ModelPackManagerDeps {
  runtimeRoot: string
  cacheRoot: string
  /**
   * Shared by reference with SkillsRuntimeManager: the Maps stay declared on
   * the manager because model-pack-manager.test.ts reaches into the manager
   * instance's `modelPackDownloads` / `modelPackDownloadStatuses` properties
   * directly. One in-flight download per pack so packs download independently.
   */
  modelPackDownloads: Map<ModelPackId, ChildProcessWithoutNullStreams>
  modelPackDownloadStatuses: Map<ModelPackId, ModelPackDownloadStatus>
  ensureRuntimeDirs: () => void
  ensureSkillInstalled: (skillId: SkillId) => Promise<SkillInstallResult>
  ensurePythonVenv: () => Promise<string>
  getBaseEnv: () => NodeJS.ProcessEnv
}

export class ModelPackManager {
  constructor(private readonly deps: ModelPackManagerDeps) {}

  getModelPackStatus(id: ModelPackId): ModelPackStatus {
    this.deps.ensureRuntimeDirs()
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
    this.deps.ensureRuntimeDirs()
    const { id } = request
    const descriptor = getModelPackDescriptor(id)
    if (this.deps.modelPackDownloads.has(id)) {
      return this.getModelPackStatus(id)
    }

    const source = request.source ?? 'auto'
    const targetDir = this.getModelPackTargetDir(id)
    const partialDir = this.getModelPackPartialDir(id)

    if (this.getMissingModelPackFiles(id, targetDir).length === 0) {
      const now = new Date().toISOString()
      this.deps.modelPackDownloadStatuses.set(id, {
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

    const publish = (): void => {
      onUpdate?.(this.getModelPackStatus(id))
    }
    const patch = (next: Partial<ModelPackDownloadStatus>): void => {
      this.deps.modelPackDownloadStatuses.set(id, { ...this.getModelPackDownloadState(id), ...next })
    }

    // Publish an optimistic running status immediately so the click registers in
    // the UI before the (possibly slow) runtime install + venv build + source
    // probe run; otherwise the row sits idle for seconds and feels unresponsive.
    const startedAt = new Date().toISOString()
    this.deps.modelPackDownloadStatuses.set(id, {
      ...createDefaultModelPackDownloadStatus(),
      running: true,
      source,
      targetDir,
      startedAt,
      updatedAt: startedAt,
      lastMessage: '正在准备运行时…',
    })
    publish()

    let resolved: ResolvedModelProvider
    let python: string
    try {
      const install = await this.deps.ensureSkillInstalled('video-expert-analyzer')
      if (!install.success) {
        throw new Error(install.error || '无法准备视频分析运行时')
      }
      python = await this.deps.ensurePythonVenv()
      patch({ updatedAt: new Date().toISOString(), lastMessage: '正在选择下载来源…' })
      publish()
      resolved = await resolveModelProvider(descriptor, source, (url) => this.probeEndpointLatency(url))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      patch({
        running: false,
        updatedAt: new Date().toISOString(),
        completedAt: null,
        error: message,
        lastMessage: message,
      })
      publish()
      throw error instanceof Error ? error : new Error(message)
    }

    mkdirSync(partialDir, { recursive: true })
    patch({
      resolvedProvider: resolved.provider,
      updatedAt: new Date().toISOString(),
      lastMessage: `开始下载 ${descriptor.displayName}（来源：${this.describeModelProvider(resolved)}）`,
    })

    const script = buildModelPackDownloadScript(resolved.provider, resolved.repoId)
    const env = this.buildModelPackDownloadEnv(resolved)
    const child = spawn(python, ['-c', script, partialDir], { cwd: this.deps.runtimeRoot, env })
    this.deps.modelPackDownloads.set(id, child)

    // tqdm emits in-place bar frames separated by carriage returns; reduce each
    // chunk to the latest frame + a monotonic headline percent so progress moves
    // smoothly instead of looking frozen on stale frames (see reducer comment).
    let sawAggregateBar = false
    const ingest = (chunk: Buffer): void => {
      const current = this.getModelPackDownloadState(id)
      const frame = reduceDownloadProgressChunk(chunk.toString('utf8'), {
        percent: current.progressPercent,
        sawAggregateBar,
      })
      sawAggregateBar = frame.sawAggregateBar
      if (frame.message === null) return
      patch({
        updatedAt: new Date().toISOString(),
        lastMessage: frame.message,
        progressPercent: frame.percent,
      })
      publish()
    }

    child.stdout.on('data', ingest)
    child.stderr.on('data', ingest)
    child.on('error', (error) => {
      this.deps.modelPackDownloads.delete(id)
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
      this.deps.modelPackDownloads.delete(id)
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
    const child = this.deps.modelPackDownloads.get(id)
    if (child) {
      child.kill()
      this.deps.modelPackDownloads.delete(id)
      this.deps.modelPackDownloadStatuses.set(id, {
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
    this.deps.ensureRuntimeDirs()
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
    const base = join(this.deps.runtimeRoot, 'models', `.selftest-${randomUUID()}`)
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
    return join(this.deps.runtimeRoot, 'models', getModelPackDescriptor(id).targetSubdir)
  }

  private getModelPackPartialDir(id: ModelPackId): string {
    return `${this.getModelPackTargetDir(id)}.partial`
  }

  private getModelPackDownloadState(id: ModelPackId): ModelPackDownloadStatus {
    return this.deps.modelPackDownloadStatuses.get(id) ?? createDefaultModelPackDownloadStatus()
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
  finalizeModelPackDownload(id: ModelPackId, code: number | null): string | null {
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
  async probeEndpointLatency(url: string): Promise<number | null> {
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
  buildFunasrNanoRuntimeEnv(): Record<string, string> {
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
  buildFunasrFallbackModelEnv(options: { packaged: boolean }): Record<string, string> {
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
      ...this.deps.getBaseEnv(),
      HF_HOME: join(this.deps.cacheRoot, 'huggingface'),
      XDG_CACHE_HOME: this.deps.cacheRoot,
      MODELSCOPE_CACHE: join(this.deps.cacheRoot, 'modelscope'),
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
}
