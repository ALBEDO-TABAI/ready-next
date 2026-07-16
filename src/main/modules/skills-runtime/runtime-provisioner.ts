// RuntimeProvisioner — orchestrates the one-click "下载并配置运行时" flow:
// download → sha256 verify → guarded extract → connect (python venv takeover /
// ffmpeg atomic place) → core-dep prewarm. All IO is injected so the orchestration
// (source loop, error classification, venv-rebuild decision) is unit-testable.
//
// Plan: docs/superpowers/plans/2026-06-23-one-click-runtime-provisioning-implementation.md
// Recovery: docs/superpowers/plans/2026-07-15-packaged-provider-runtime-recovery-implementation.md

import { randomUUID } from 'node:crypto'
import {
  isRuntimeAssetPinned,
  isRuntimeIntegrityError,
  selectRuntimeSourceOrder,
  classifyProvisionFailure,
  findRuntimeAssetOutput,
  parsePyvenvCfg,
  venvNeedsRebuild,
  type RuntimeAsset,
  type RuntimeAssetArchive,
  type RuntimePlatformKey,
  type RuntimeSourceAttempt,
  type ProvisionErrorKind,
} from '../../../shared/runtime-asset-registry'
import type {
  RuntimeComponentStatus,
  RuntimeStatus,
  RuntimeProvisionProgress,
  RuntimeProvisionErrorKind,
  RuntimeProvisionTaskSnapshot,
} from '../../../shared/runtime-provision-types'

export type {
  RuntimeComponentStatus,
  RuntimeStatus,
  RuntimeProvisionProgress,
  RuntimeProvisionErrorKind,
  RuntimeProvisionTaskSnapshot,
} from '../../../shared/runtime-provision-types'

export class RuntimeProvisionError extends Error {
  constructor(
    readonly kind: RuntimeProvisionErrorKind,
    message: string,
    readonly assetId?: RuntimeAsset['id'],
    readonly attempts?: RuntimeSourceAttempt[],
  ) {
    super(message)
    this.name = 'RuntimeProvisionError'
  }
}

export interface RuntimeProvisionerFs {
  exists(path: string): boolean
  readText(path: string): string | null
  realpath(path: string): string | null
  rmrf(path: string): void
  mkdirp(path: string): void
  /** Atomic place of an extracted binary: copy to a temp sibling then rename; chmod 0755; mac de-quarantine. */
  placeExecutable(srcPath: string, destPath: string): void
  join(...parts: string[]): string
}

export interface RuntimeProvisionerDeps {
  runtimeRoot: string
  platformKey: RuntimePlatformKey | null
  isWindows: boolean
  /** Assets for this platform (real wiring → getRuntimeAssets; tests inject pinned). */
  listAssets(): RuntimeAsset[]
  fs: RuntimeProvisionerFs
  getMirrorBase(): string | null
  setSkillsPythonPath(path: string): void
  probe(url: string): Promise<number | null>
  /** Download archive bytes; MUST throw on connection/HTTP failure (→ unreachable). */
  download(url: string, onProgress: (received: number, total: number | null) => void, signal: AbortSignal): Promise<Buffer>
  sha256(buffer: Buffer): string
  /** Extract to destDir applying assertSafeRuntimeArchiveEntry per entry + size cap; throw on violation (→ integrity). */
  extractArchive(params: { buffer: Buffer; archiveKind: 'tar.gz' | 'zip'; destDir: string; sizeCap: number }): Promise<void>
  /** Real probe of an on-disk binary; { ok:false } when missing/unrunnable/wrong arch. */
  probeBinary(path: string, kind: 'python' | 'ffmpeg' | 'ffprobe', expectedArch?: 'arm64' | 'x64'): Promise<{ ok: boolean; version?: string; sslOk?: boolean; archOk?: boolean; detail?: string }>
  /** rm venvRoot (when needed) + ensurePythonVenv from skills_python_path. */
  rebuildVenvFromBase(): Promise<void>
  /** Probe the venv python (post-venv) — drives status.python. */
  probeVenvPython(): Promise<{ ok: boolean; version?: string; sslOk?: boolean; path?: string }>
  /** Prewarm VEA core pip deps (no torch). */
  installCoreDeps(): Promise<{ ready: boolean; missing: string[] }>
  /** Non-mutating core-dep readiness check (drives status.coreDeps, C1). */
  coreDepsStatus(): Promise<{ ready: boolean; missing: string[] }>
  venvRootPath(): string
  pythonDistRoot(): string
}

const SIZE_CAP_SAFETY = 1.5

interface ActiveProvision {
  runId: string
  controller: AbortController
  promise: Promise<RuntimeStatus>
}

export class RuntimeProvisioner {
  private active: ActiveProvision | null = null
  private snapshot: RuntimeProvisionTaskSnapshot = {
    runId: null,
    revision: 0,
    state: 'idle',
    updatedAt: Date.now(),
  }
  private readonly snapshotListeners = new Set<(snapshot: RuntimeProvisionTaskSnapshot) => void>()
  private readonly progressListeners = new Set<(progress: RuntimeProvisionProgress) => void>()

  constructor(private readonly deps: RuntimeProvisionerDeps) {}

  isProvisioning(): boolean {
    return this.active !== null
  }

  getProvisionSnapshot(): RuntimeProvisionTaskSnapshot {
    return cloneSnapshot(this.snapshot)
  }

  subscribeProvisionSnapshot(listener: (snapshot: RuntimeProvisionTaskSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  cancel(): RuntimeProvisionTaskSnapshot {
    if (!this.active) return this.getProvisionSnapshot()
    if (this.snapshot.state === 'running') {
      this.publishSnapshot({ state: 'cancelling' })
      this.active.controller.abort()
    }
    return this.getProvisionSnapshot()
  }

  async getStatus(): Promise<RuntimeStatus> {
    const { deps } = this
    const platformSupported = deps.platformKey !== null
    if (!platformSupported) {
      const off: RuntimeComponentStatus = { ready: false, detail: 'unsupported_platform' }
      return { platformSupported: false, python: off, ffmpeg: off, ffprobe: off, coreDeps: off, overallReady: false }
    }
    const assets = deps.listAssets()
    const ffmpegAsset = assets.find((a) => a.id === 'ffmpeg')
    const ffmpegOutput = findRuntimeAssetOutput(ffmpegAsset, 'ffmpeg')
    const ffprobeOutput = findRuntimeAssetOutput(ffmpegAsset, 'ffprobe')
    const ffmpegPath = deps.fs.join(deps.runtimeRoot, 'bin', deps.isWindows ? 'ffmpeg.exe' : 'ffmpeg')
    const ffprobePath = deps.fs.join(deps.runtimeRoot, 'bin', deps.isWindows ? 'ffprobe.exe' : 'ffprobe')

    const [py, ff, fp, core] = await Promise.all([
      deps.probeVenvPython(),
      deps.probeBinary(ffmpegPath, 'ffmpeg', ffmpegOutput?.expectedArch),
      deps.probeBinary(ffprobePath, 'ffprobe', ffprobeOutput?.expectedArch),
      deps.coreDepsStatus(),
    ])

    const python = { ready: py.ok, version: py.version, sslOk: py.sslOk, path: py.path, detail: py.ok ? undefined : 'python_not_ready' }
    const ffmpeg = { ready: ff.ok, archOk: ff.archOk, path: ff.ok ? ffmpegPath : undefined, detail: ff.detail }
    const ffprobe = { ready: fp.ok, path: fp.ok ? ffprobePath : undefined, detail: fp.detail }
    const coreDeps = { ready: core.ready, missing: core.missing }
    return {
      platformSupported: true,
      python, ffmpeg, ffprobe, coreDeps,
      overallReady: python.ready && ffmpeg.ready && ffprobe.ready && coreDeps.ready,
    }
  }

  async provision(
    opts: { force?: boolean },
    onProgress: (p: RuntimeProvisionProgress) => void = () => {},
  ): Promise<RuntimeStatus> {
    if (this.active) return this.joinProvision(this.active.promise, onProgress)

    const runId = randomUUID()
    const controller = new AbortController()
    const startedAt = Date.now()
    this.publishSnapshot({
      runId,
      state: 'running',
      progress: { phase: 'probe' },
      startedAt,
      finishedAt: undefined,
      errorKind: undefined,
      error: undefined,
      result: undefined,
    })

    const promise = this.runProvision(opts, controller.signal, runId)
      .then((result) => {
        this.publishSnapshot({
          state: 'succeeded',
          result,
          errorKind: undefined,
          error: undefined,
          finishedAt: Date.now(),
        })
        return result
      })
      .catch((error: unknown) => {
        const normalized = this.normalizeFailure(error, controller.signal)
        this.publishSnapshot({
          state: normalized.kind === 'cancelled' ? 'cancelled' : 'failed',
          errorKind: normalized.kind,
          error: normalized.message,
          finishedAt: Date.now(),
        })
        throw normalized
      })
      .finally(() => {
        if (this.active?.runId === runId) this.active = null
      })

    this.active = { runId, controller, promise }
    return this.joinProvision(promise, onProgress)
  }

  private async runProvision(opts: { force?: boolean }, signal: AbortSignal, runId: string): Promise<RuntimeStatus> {
    const { deps } = this
    if (!deps.platformKey) {
      throw new RuntimeProvisionError('all_sources_unreachable' as ProvisionErrorKind, '当前平台暂不支持自动配置运行时', undefined)
    }
    const assets = deps.listAssets()
    const unpinned = assets.filter((a) => !isRuntimeAssetPinned(a))
    if (unpinned.length > 0) {
      throw new RuntimeProvisionError(
        'assets_not_pinned',
        '运行时资产尚未发布真实校验值（待 P0 钉死），暂不能下载。',
        unpinned[0].id,
      )
    }
    const current = opts.force ? null : await this.getStatus()
    this.throwIfAborted(signal)
    for (const asset of assets) {
      this.throwIfAborted(signal, asset.id)
      if (current && await this.assetAlreadyReady(asset, current)) continue
      await this.provisionAsset(asset, signal, runId)
    }

    try {
      this.publishProgress(runId, { phase: 'venv', message: 'building venv' })
      await this.takeOverVenv(signal)
      this.throwIfAborted(signal)
      this.publishProgress(runId, { phase: 'deps', message: 'installing core deps' })
      const coreDeps = await deps.installCoreDeps()
      this.throwIfAborted(signal)
      if (!coreDeps.ready) {
        throw new RuntimeProvisionError(
          'runtime_setup_failed',
          `核心依赖安装后仍未就绪：${coreDeps.missing.join('、') || '未知依赖'}`,
        )
      }
    } catch (error) {
      if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消')
      if (error instanceof RuntimeProvisionError) throw error
      throw new RuntimeProvisionError('runtime_setup_failed', `运行时初始化失败（venv/依赖）：${errMsg(error)}`)
    }

    const status = await this.getStatus()
    this.throwIfAborted(signal)
    if (!status.overallReady) {
      const missing = [
        !status.python.ready && 'Python',
        !status.ffmpeg.ready && 'ffmpeg',
        !status.ffprobe.ready && 'ffprobe',
        !status.coreDeps.ready && '核心依赖',
      ].filter(Boolean).join('、')
      throw new RuntimeProvisionError('runtime_setup_failed', `配置结束后仍有组件未就绪：${missing}`)
    }
    this.publishProgress(runId, { phase: 'done' })
    return status
  }

  private async assetAlreadyReady(asset: RuntimeAsset, status: RuntimeStatus): Promise<boolean> {
    if (asset.id === 'ffmpeg') return status.ffmpeg.ready && status.ffprobe.ready
    const pythonOutput = findRuntimeAssetOutput(asset, 'python')
    if (asset.id === 'python' && pythonOutput) {
      const pythonPath = this.deps.fs.join(this.deps.pythonDistRoot(), pythonOutput.relPath)
      if (!this.deps.fs.exists(pythonPath)) return false
      const probe = await this.deps.probeBinary(pythonPath, 'python', pythonOutput.expectedArch)
      return probe.ok && probe.sslOk !== false
    }
    return false
  }

  private async provisionAsset(
    asset: RuntimeAsset,
    signal: AbortSignal,
    runId: string,
  ): Promise<void> {
    for (const archive of asset.archives) {
      await this.provisionArchive(asset, archive, signal, runId)
    }
  }

  private async provisionArchive(
    asset: RuntimeAsset,
    archive: RuntimeAssetArchive,
    signal: AbortSignal,
    runId: string,
  ): Promise<void> {
    const { deps } = this
    this.publishProgress(runId, { assetId: asset.id, phase: 'probe' })
    const order = await selectRuntimeSourceOrder(asset, archive, deps.getMirrorBase(), deps.probe)
    this.throwIfAborted(signal, asset.id)
    const attempts: RuntimeSourceAttempt[] = []

    for (const url of order) {
      if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id, attempts)
      let buffer: Buffer
      try {
        this.publishProgress(runId, { assetId: asset.id, phase: 'download' })
        buffer = await deps.download(url, (received, total) => this.publishProgress(runId, { assetId: asset.id, phase: 'download', receivedBytes: received, totalBytes: total }), signal)
      } catch (error) {
        if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id, attempts)
        // A size-cap/corrupt-stream failure is an integrity problem (a mirror has
        //   the same bad asset) — only genuine network/HTTP failures are unreachable.
        const failureKind = isRuntimeIntegrityError(error) ? 'integrity' : 'unreachable'
        attempts.push({ url, ok: false, failureKind, reason: errMsg(error) })
        continue
      }
      this.throwIfAborted(signal, asset.id)
      this.publishProgress(runId, { assetId: asset.id, phase: 'verify' })
      if (deps.sha256(buffer) !== archive.sha256) {
        attempts.push({ url, ok: false, failureKind: 'integrity', reason: 'sha256 不匹配' })
        continue
      }
      const extractDir = asset.id === 'python'
        ? deps.pythonDistRoot()
        : deps.fs.join(deps.runtimeRoot, '.runtime-ffmpeg-extract', archive.filename.replace(/[^a-zA-Z0-9._-]/g, '_'))
      try {
        this.publishProgress(runId, { assetId: asset.id, phase: 'extract' })
        deps.fs.rmrf(extractDir)
        deps.fs.mkdirp(extractDir)
        await deps.extractArchive({ buffer, archiveKind: archive.archiveKind, destDir: extractDir, sizeCap: Math.floor(archive.expectedUncompressedBytes * SIZE_CAP_SAFETY) })
        this.throwIfAborted(signal, asset.id)
      } catch (error) {
        if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id, attempts)
        // silent-catch: extract failure is recorded as a structured attempt before trying the next source
        attempts.push({ url, ok: false, failureKind: 'integrity', reason: `解包失败：${errMsg(error)}` })
        continue
      }
      try {
        this.publishProgress(runId, { assetId: asset.id, phase: 'connect' })
        await this.connectArchiveOutputs(archive, extractDir, signal)
      } catch (error) {
        if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id, attempts)
        // silent-catch: connect failure is recorded as a structured attempt before trying the next source
        attempts.push({ url, ok: false, failureKind: 'integrity', reason: `接通失败：${errMsg(error)}` })
        continue
      }
      return // success
    }
    const kind = classifyProvisionFailure(attempts)
    throw new RuntimeProvisionError(kind, this.failureMessage(kind, asset, archive, attempts), asset.id, attempts)
  }

  private failureMessage(kind: ProvisionErrorKind, asset: RuntimeAsset, archive: RuntimeAssetArchive, attempts: RuntimeSourceAttempt[]): string {
    const lines = attempts.map((a) => `  - ${a.url}: ${a.reason || '失败'}`).join('\n')
    if (kind === 'all_sources_unreachable') {
      return `所有源都连接失败（${asset.id}/${archive.filename}）。可在下方填自定义镜像后重试。\n${lines}`
    }
    return `运行时资产校验失败（${asset.id}/${archive.filename}，疑似钉死值过期或资产被污染）。换镜像通常无效。\n${lines}`
  }

  private async connectArchiveOutputs(archive: RuntimeAssetArchive, extractDir: string, signal: AbortSignal): Promise<void> {
    const { deps } = this
    for (const output of archive.outputs) {
      this.throwIfAborted(signal)
      if (output.kind === 'python') {
        const interp = deps.fs.join(extractDir, output.relPath)
        if (!deps.fs.exists(interp)) throw new Error(`解包后未找到 Python：${output.relPath}`)
        deps.setSkillsPythonPath(interp)
        continue
      }
      const binDir = deps.fs.join(deps.runtimeRoot, 'bin')
      deps.fs.mkdirp(binDir)
      const src = deps.fs.join(extractDir, output.relPath)
      if (!deps.fs.exists(src)) throw new Error(`解包后未找到 ${output.kind}：${output.relPath}`)
      const dest = deps.fs.join(binDir, deps.isWindows ? `${output.kind}.exe` : output.kind)
      const existing = await deps.probeBinary(dest, output.kind, output.expectedArch)
      this.throwIfAborted(signal)
      if (deps.fs.exists(dest) && !existing.ok) deps.fs.rmrf(dest) // remove stale/broken/wrong-arch
      deps.fs.placeExecutable(src, dest)
      const verify = await deps.probeBinary(dest, output.kind, output.expectedArch)
      this.throwIfAborted(signal)
      if (!verify.ok || verify.archOk === false) throw new Error(`${output.kind} 架构校验未通过`)
    }
  }

  /** C10: rebuild venv if its base no longer resolves under python-dist. */
  private async takeOverVenv(signal: AbortSignal): Promise<void> {
    const { deps } = this
    this.throwIfAborted(signal)
    const venvRoot = deps.venvRootPath()
    const venvExists = deps.fs.exists(venvRoot)
    const pyvenvCfg = venvExists ? deps.fs.readText(deps.fs.join(venvRoot, 'pyvenv.cfg')) : null
    const cfg = pyvenvCfg ? parsePyvenvCfg(pyvenvCfg) : null
    const baseRaw = cfg?.get('executable') || cfg?.get('home') || null
    const venvBaseRealpath = baseRaw ? deps.fs.realpath(baseRaw) : null
    const pythonDistRealpath = deps.fs.realpath(deps.pythonDistRoot()) || deps.pythonDistRoot()
    const needRebuild = venvNeedsRebuild({ venvExists, venvBaseRealpath, pythonDistRealpath })
    if (needRebuild) {
      deps.fs.rmrf(venvRoot)
    }
    await deps.rebuildVenvFromBase()
    this.throwIfAborted(signal)
  }

  private joinProvision(
    promise: Promise<RuntimeStatus>,
    onProgress: (progress: RuntimeProvisionProgress) => void,
  ): Promise<RuntimeStatus> {
    this.progressListeners.add(onProgress)
    const latest = this.snapshot.progress
    if (latest) safelyNotifyProgress(onProgress, latest)
    return promise.finally(() => this.progressListeners.delete(onProgress))
  }

  private publishProgress(runId: string, progress: RuntimeProvisionProgress): void {
    if (this.snapshot.runId !== runId) return
    if (this.snapshot.state !== 'running' && this.snapshot.state !== 'cancelling') return
    for (const listener of this.progressListeners) safelyNotifyProgress(listener, progress)
    this.publishSnapshot({
      state: this.snapshot.state === 'cancelling' ? 'cancelling' : 'running',
      progress,
    })
  }

  private publishSnapshot(patch: Partial<RuntimeProvisionTaskSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
      updatedAt: Date.now(),
    }
    const snapshot = this.getProvisionSnapshot()
    for (const listener of this.snapshotListeners) {
      try {
        listener(snapshot)
      } catch {
        // silent-catch: a broken observer must not interrupt the Main-owned provision task.
      }
    }
  }

  private throwIfAborted(signal: AbortSignal, assetId?: RuntimeAsset['id']): void {
    if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', assetId)
  }

  private normalizeFailure(error: unknown, signal: AbortSignal): RuntimeProvisionError {
    if (signal.aborted) return new RuntimeProvisionError('cancelled', '已取消')
    if (error instanceof RuntimeProvisionError) return error
    return new RuntimeProvisionError('runtime_setup_failed', `运行时配置失败：${errMsg(error)}`)
  }
}

function safelyNotifyProgress(
  listener: (progress: RuntimeProvisionProgress) => void,
  progress: RuntimeProvisionProgress,
): void {
  try {
    listener({ ...progress })
  } catch {
    // silent-catch: a stale renderer/caller callback must not interrupt the provision task.
  }
}

function cloneSnapshot(snapshot: RuntimeProvisionTaskSnapshot): RuntimeProvisionTaskSnapshot {
  return {
    ...snapshot,
    progress: snapshot.progress ? { ...snapshot.progress } : undefined,
    result: snapshot.result ? {
      ...snapshot.result,
      python: { ...snapshot.result.python },
      ffmpeg: { ...snapshot.result.ffmpeg },
      ffprobe: { ...snapshot.result.ffprobe },
      coreDeps: {
        ...snapshot.result.coreDeps,
        missing: snapshot.result.coreDeps.missing ? [...snapshot.result.coreDeps.missing] : undefined,
      },
    } : undefined,
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
