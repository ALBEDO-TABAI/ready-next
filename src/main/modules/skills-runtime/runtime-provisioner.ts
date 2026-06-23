// RuntimeProvisioner — orchestrates the one-click "下载并配置运行时" flow:
// download → sha256 verify → guarded extract → connect (python venv takeover /
// ffmpeg atomic place) → core-dep prewarm. All IO is injected so the orchestration
// (source loop, error classification, venv-rebuild decision) is unit-testable.
//
// Plan: docs/superpowers/plans/2026-06-23-one-click-runtime-provisioning-implementation.md

import {
  isRuntimeAssetPinned,
  isRuntimeIntegrityError,
  selectRuntimeSourceOrder,
  classifyProvisionFailure,
  parsePyvenvCfg,
  venvNeedsRebuild,
  type RuntimeAsset,
  type RuntimePlatformKey,
  type RuntimeSourceAttempt,
  type ProvisionErrorKind,
} from '../../../shared/runtime-asset-registry'
import type {
  RuntimeComponentStatus,
  RuntimeStatus,
  RuntimeProvisionProgress,
  RuntimeProvisionErrorKind,
} from '../../../shared/runtime-provision-types'

export type {
  RuntimeComponentStatus,
  RuntimeStatus,
  RuntimeProvisionProgress,
  RuntimeProvisionErrorKind,
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

export class RuntimeProvisioner {
  private inFlight: AbortController | null = null

  constructor(private readonly deps: RuntimeProvisionerDeps) {}

  isProvisioning(): boolean {
    return this.inFlight !== null
  }

  cancel(): void {
    this.inFlight?.abort()
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
    const ffmpegPath = deps.fs.join(deps.runtimeRoot, 'bin', deps.isWindows ? 'ffmpeg.exe' : 'ffmpeg')
    const ffprobePath = deps.fs.join(deps.runtimeRoot, 'bin', deps.isWindows ? 'ffprobe.exe' : 'ffprobe')

    const [py, ff, fp, core] = await Promise.all([
      deps.probeVenvPython(),
      deps.probeBinary(ffmpegPath, 'ffmpeg', ffmpegAsset?.expectedArch),
      deps.probeBinary(ffprobePath, 'ffprobe'),
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
    onProgress: (p: RuntimeProvisionProgress) => void,
  ): Promise<RuntimeStatus> {
    if (this.inFlight) throw new RuntimeProvisionError('cancelled', '运行时配置已在进行中', undefined)
    const { deps } = this
    if (!deps.platformKey) {
      throw new RuntimeProvisionError('all_sources_unreachable' as ProvisionErrorKind, '当前平台暂不支持自动配置运行时', undefined)
    }
    const controller = new AbortController()
    this.inFlight = controller
    try {
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
      for (const asset of assets) {
        if (controller.signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id)
        if (current && this.assetAlreadyReady(asset, current)) continue
        await this.provisionAsset(asset, controller.signal, onProgress)
      }

      // Python venv takeover (C10) + core-dep prewarm. Wrap so a venv/pip failure
      //   returns a structured provision error instead of escaping as an infra
      //   throw (the IPC layer needs a kind to render, not a raw stack).
      try {
        onProgress({ phase: 'venv', message: 'building venv' })
        await this.takeOverVenv()
        onProgress({ phase: 'deps', message: 'installing core deps' })
        await deps.installCoreDeps()
      } catch (error) {
        if (controller.signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消')
        throw new RuntimeProvisionError('runtime_setup_failed', `运行时初始化失败（venv/依赖）：${errMsg(error)}`)
      }

      onProgress({ phase: 'done' })
      return await this.getStatus()
    } finally {
      this.inFlight = null
    }
  }

  private assetAlreadyReady(asset: RuntimeAsset, status: RuntimeStatus): boolean {
    if (asset.id === 'ffmpeg') return status.ffmpeg.ready && status.ffprobe.ready
    if (asset.id === 'python') return Boolean(this.deps.fs.exists(this.deps.fs.join(this.deps.pythonDistRoot(), asset.pythonRelPath || '')))
    return false
  }

  private async provisionAsset(
    asset: RuntimeAsset,
    signal: AbortSignal,
    onProgress: (p: RuntimeProvisionProgress) => void,
  ): Promise<void> {
    const { deps } = this
    onProgress({ assetId: asset.id, phase: 'probe' })
    const order = await selectRuntimeSourceOrder(asset, deps.getMirrorBase(), deps.probe)
    const attempts: RuntimeSourceAttempt[] = []

    for (const url of order) {
      if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id, attempts)
      let buffer: Buffer
      try {
        onProgress({ assetId: asset.id, phase: 'download' })
        buffer = await deps.download(url, (received, total) => onProgress({ assetId: asset.id, phase: 'download', receivedBytes: received, totalBytes: total }), signal)
      } catch (error) {
        if (signal.aborted) throw new RuntimeProvisionError('cancelled', '已取消', asset.id, attempts)
        // A size-cap/corrupt-stream failure is an integrity problem (a mirror has
        //   the same bad asset) — only genuine network/HTTP failures are unreachable.
        const failureKind = isRuntimeIntegrityError(error) ? 'integrity' : 'unreachable'
        attempts.push({ url, ok: false, failureKind, reason: errMsg(error) })
        continue
      }
      onProgress({ assetId: asset.id, phase: 'verify' })
      if (deps.sha256(buffer) !== asset.sha256) {
        attempts.push({ url, ok: false, failureKind: 'integrity', reason: 'sha256 不匹配' })
        continue
      }
      const extractDir = deps.fs.join(deps.runtimeRoot, asset.id === 'python' ? 'python-dist' : '.runtime-ffmpeg-extract')
      try {
        onProgress({ assetId: asset.id, phase: 'extract' })
        deps.fs.rmrf(extractDir)
        deps.fs.mkdirp(extractDir)
        await deps.extractArchive({ buffer, archiveKind: asset.archiveKind, destDir: extractDir, sizeCap: Math.floor(asset.expectedUncompressedBytes * SIZE_CAP_SAFETY) })
      } catch (error) {
        attempts.push({ url, ok: false, failureKind: 'integrity', reason: `解包失败：${errMsg(error)}` })
        continue
      }
      try {
        onProgress({ assetId: asset.id, phase: 'connect' })
        await this.connectAsset(asset, extractDir)
      } catch (error) {
        attempts.push({ url, ok: false, failureKind: 'integrity', reason: `接通失败：${errMsg(error)}` })
        continue
      }
      return // success
    }
    const kind = classifyProvisionFailure(attempts)
    throw new RuntimeProvisionError(kind, this.failureMessage(kind, asset, attempts), asset.id, attempts)
  }

  private failureMessage(kind: ProvisionErrorKind, asset: RuntimeAsset, attempts: RuntimeSourceAttempt[]): string {
    const lines = attempts.map((a) => `  - ${a.url}: ${a.reason || '失败'}`).join('\n')
    if (kind === 'all_sources_unreachable') {
      return `所有源都连接失败（${asset.id}）。可在下方填自定义镜像后重试。\n${lines}`
    }
    return `运行时资产校验失败（${asset.id}，疑似钉死值过期或资产被污染）。换镜像通常无效。\n${lines}`
  }

  private async connectAsset(asset: RuntimeAsset, extractDir: string): Promise<void> {
    const { deps } = this
    if (asset.id === 'python') {
      const interp = deps.fs.join(extractDir, asset.pythonRelPath || '')
      if (!deps.fs.exists(interp)) throw new Error(`解包后未找到 Python：${asset.pythonRelPath}`)
      deps.setSkillsPythonPath(interp)
      return
    }
    // ffmpeg: place both binaries atomically into runtime bin (0.7#4)
    const binDir = deps.fs.join(deps.runtimeRoot, 'bin')
    deps.fs.mkdirp(binDir)
    for (const which of ['ffmpeg', 'ffprobe'] as const) {
      const rel = asset.ffmpegRelPaths?.[which]
      if (!rel) throw new Error(`ffmpeg 资产缺少 ${which} 相对路径`)
      const src = deps.fs.join(extractDir, rel)
      if (!deps.fs.exists(src)) throw new Error(`解包后未找到 ${which}：${rel}`)
      const dest = deps.fs.join(binDir, deps.isWindows ? `${which}.exe` : which)
      const existing = await deps.probeBinary(dest, which === 'ffmpeg' ? 'ffmpeg' : 'ffprobe', asset.expectedArch)
      if (deps.fs.exists(dest) && !existing.ok) deps.fs.rmrf(dest) // remove stale/broken/wrong-arch
      deps.fs.placeExecutable(src, dest)
    }
    // architecture check (C6)
    const verify = await deps.probeBinary(deps.fs.join(binDir, deps.isWindows ? 'ffmpeg.exe' : 'ffmpeg'), 'ffmpeg', asset.expectedArch)
    if (!verify.ok || verify.archOk === false) throw new Error('ffmpeg 架构校验未通过')
  }

  /** C10: rebuild venv if its base no longer resolves under python-dist. */
  private async takeOverVenv(): Promise<void> {
    const { deps } = this
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
  }
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
