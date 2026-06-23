// Runtime asset registry + pure provisioning helpers.
//
// The thin installer ships no Python/ffmpeg; the in-app "下载并配置运行时" button
// self-provisions a pinned standalone CPython + static ffmpeg/ffprobe into the
// writable skill-runtime dir. See:
//   docs/superpowers/plans/2026-06-23-one-click-runtime-provisioning-implementation.md
//
// IMPORTANT (plan §0.6 / P0): `sha256` values are PLACEHOLDERS until
// scripts/pin-runtime-assets.mjs runs on a networked machine and fills real
// digests. `isRuntimeAssetPinned` gates that; the registry gate must NOT enter
// the verify chain while any asset is unpinned (avoids "非空即过" fake-pass).

export type RuntimePlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64'
export type RuntimeAssetId = 'python' | 'ffmpeg'

export interface RuntimeAssetSource {
  url: string
  kind: 'primary' | 'mirror'
}

export interface RuntimeAsset {
  id: RuntimeAssetId
  platform: RuntimePlatformKey
  version: string
  /** Real digest filled by P0 pin script; equals RUNTIME_ASSET_PLACEHOLDER_SHA until then. */
  sha256: string
  /** Bare archive filename — used to build a user-mirror URL `${base}/${platform}/${filename}`. */
  filename: string
  /** GitHub primary + 国内 mirror (probe-ranked, except a user mirror which is forced first). */
  sources: RuntimeAssetSource[]
  archiveKind: 'tar.gz' | 'zip'
  /** Size-cap basis for the extraction guard (×safety factor). */
  expectedUncompressedBytes: number
  /** python only: interpreter path relative to the python-dist extract root. */
  pythonRelPath?: string
  /** ffmpeg only: both binaries relative to the extract root. */
  ffmpegRelPaths?: { ffmpeg: string; ffprobe: string }
  /** ffmpeg only: expected arch for the C6 architecture check. */
  expectedArch?: 'arm64' | 'x64'
}

export const RUNTIME_PLATFORM_KEYS: readonly RuntimePlatformKey[] = [
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
]

/** Sentinel digest meaning "not yet pinned by P0". */
export const RUNTIME_ASSET_PLACEHOLDER_SHA = 'PENDING_P0_PIN'

export type ProvisionErrorKind = 'all_sources_unreachable' | 'asset_integrity_failed' | 'unsupported_platform'

// --- Pinned coordinates (versions/URLs are real; sha256 filled by P0). ---
// Python: astral-sh/python-build-standalone `install_only` (relocatable). The
//   archive expands to a top-level `python/` dir.
// ffmpeg: win = BtbN/FFmpeg-Builds win64-gpl (bin/ffmpeg.exe + ffprobe.exe);
//   mac = a combined static gpl build (P0 confirms exact host + layout).
const PBS_TAG = '20240814'
const PY_VER = '3.11.9'
const GHPROXY = 'https://ghproxy.net/' // 国内可达镜像前缀（P0 复核连通性）

function pbs(triple: string): RuntimeAsset['sources'] {
  const file = `cpython-${PY_VER}+${PBS_TAG}-${triple}-install_only.tar.gz`
  const gh = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${file}`
  return [
    { url: gh, kind: 'primary' },
    { url: `${GHPROXY}${gh}`, kind: 'mirror' },
  ]
}

export const RUNTIME_ASSET_REGISTRY: readonly RuntimeAsset[] = [
  {
    id: 'python', platform: 'darwin-arm64', version: PY_VER, sha256: RUNTIME_ASSET_PLACEHOLDER_SHA,
    filename: `cpython-${PY_VER}+${PBS_TAG}-aarch64-apple-darwin-install_only.tar.gz`,
    sources: pbs('aarch64-apple-darwin'), archiveKind: 'tar.gz',
    expectedUncompressedBytes: 320 * 1024 * 1024, pythonRelPath: 'python/bin/python3',
  },
  {
    id: 'python', platform: 'darwin-x64', version: PY_VER, sha256: RUNTIME_ASSET_PLACEHOLDER_SHA,
    filename: `cpython-${PY_VER}+${PBS_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
    sources: pbs('x86_64-apple-darwin'), archiveKind: 'tar.gz',
    expectedUncompressedBytes: 320 * 1024 * 1024, pythonRelPath: 'python/bin/python3',
  },
  {
    id: 'python', platform: 'win32-x64', version: PY_VER, sha256: RUNTIME_ASSET_PLACEHOLDER_SHA,
    filename: `cpython-${PY_VER}+${PBS_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    sources: pbs('x86_64-pc-windows-msvc'), archiveKind: 'tar.gz',
    expectedUncompressedBytes: 320 * 1024 * 1024, pythonRelPath: 'python/python.exe',
  },
  {
    id: 'ffmpeg', platform: 'win32-x64', version: 'btbn-latest-gpl', sha256: RUNTIME_ASSET_PLACEHOLDER_SHA,
    filename: 'ffmpeg-master-latest-win64-gpl.zip', archiveKind: 'zip', expectedArch: 'x64',
    expectedUncompressedBytes: 220 * 1024 * 1024,
    ffmpegRelPaths: { ffmpeg: 'ffmpeg-master-latest-win64-gpl/bin/ffmpeg.exe', ffprobe: 'ffmpeg-master-latest-win64-gpl/bin/ffprobe.exe' },
    sources: [
      { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', kind: 'primary' },
      { url: `${GHPROXY}https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip`, kind: 'mirror' },
    ],
  },
  // mac ffmpeg: P0 confirms exact static-build host + sha + internal layout.
  {
    id: 'ffmpeg', platform: 'darwin-arm64', version: 'static-gpl', sha256: RUNTIME_ASSET_PLACEHOLDER_SHA,
    filename: 'ffmpeg-ffprobe-darwin-arm64.zip', archiveKind: 'zip', expectedArch: 'arm64',
    expectedUncompressedBytes: 180 * 1024 * 1024,
    ffmpegRelPaths: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    sources: [{ url: 'https://ready-runtime.invalid/darwin-arm64/ffmpeg-ffprobe-darwin-arm64.zip', kind: 'primary' }],
  },
  {
    id: 'ffmpeg', platform: 'darwin-x64', version: 'static-gpl', sha256: RUNTIME_ASSET_PLACEHOLDER_SHA,
    filename: 'ffmpeg-ffprobe-darwin-x64.zip', archiveKind: 'zip', expectedArch: 'x64',
    expectedUncompressedBytes: 180 * 1024 * 1024,
    ffmpegRelPaths: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    sources: [{ url: 'https://ready-runtime.invalid/darwin-x64/ffmpeg-ffprobe-darwin-x64.zip', kind: 'primary' }],
  },
]

export function resolveRuntimePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): RuntimePlatformKey | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : null
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : null
  return null
}

export function getRuntimeAssets(platform: RuntimePlatformKey): RuntimeAsset[] {
  return RUNTIME_ASSET_REGISTRY.filter((a) => a.platform === platform)
}

export function isRuntimeAssetPinned(asset: RuntimeAsset): boolean {
  return /^[0-9a-f]{64}$/i.test(asset.sha256)
}

// --- Pure provisioning helpers (no fs/network; injected deps → unit-testable) ---

/** Build the forced user-mirror URL for an asset, or null when no mirror configured. */
export function buildMirrorUrl(asset: RuntimeAsset, mirrorBase: string | null | undefined): string | null {
  const base = String(mirrorBase || '').trim().replace(/\/+$/, '')
  if (!base) return null
  return `${base}/${asset.platform}/${asset.filename}`
}

/**
 * Ordered source URLs to attempt: a configured user mirror is FORCED first (not
 * probe-sorted, C9/0.8#9); the registry sources follow by ascending probe
 * latency (unreachable → null sorts last but is NOT dropped, C4).
 */
export async function selectRuntimeSourceOrder(
  asset: RuntimeAsset,
  mirrorBase: string | null | undefined,
  probe: (url: string) => Promise<number | null>,
): Promise<string[]> {
  const forced: string[] = []
  const mirror = buildMirrorUrl(asset, mirrorBase)
  if (mirror) forced.push(mirror)
  const probed = await Promise.all(
    asset.sources.map(async (s, index) => ({ url: s.url, index, latency: await probe(s.url) })),
  )
  const ranked = probed
    .slice()
    .sort((a, b) => {
      if (a.latency === null && b.latency === null) return a.index - b.index
      if (a.latency === null) return 1
      if (b.latency === null) return -1
      return a.latency - b.latency
    })
    .map((p) => p.url)
  const seen = new Set<string>()
  return [...forced, ...ranked].filter((url) => (seen.has(url) ? false : (seen.add(url), true)))
}

/**
 * Tag a download error as an integrity failure (corrupt/oversized asset) rather
 * than a network failure, so the source loop classifies it correctly (a too-big
 * download is not a "source unreachable" → don't suggest a mirror).
 */
export function markRuntimeIntegrityError(error: Error): Error {
  ;(error as Error & { runtimeIntegrity?: boolean }).runtimeIntegrity = true
  return error
}

export function isRuntimeIntegrityError(error: unknown): boolean {
  return Boolean((error as { runtimeIntegrity?: boolean } | null)?.runtimeIntegrity)
}

export type SourceFailureKind = 'unreachable' | 'integrity'
export interface RuntimeSourceAttempt {
  url: string
  ok: boolean
  failureKind?: SourceFailureKind
  reason?: string
}

/**
 * Classify an asset's overall failure AFTER every source has been tried and none
 * connected/verified (C4/0.9#1): any integrity failure (downloaded but bad
 * hash/archive/arch) → asset_integrity_failed; otherwise all were connection
 * failures → all_sources_unreachable.
 */
export function classifyProvisionFailure(attempts: RuntimeSourceAttempt[]): Extract<ProvisionErrorKind, 'all_sources_unreachable' | 'asset_integrity_failed'> {
  const anyIntegrity = attempts.some((a) => !a.ok && a.failureKind === 'integrity')
  return anyIntegrity ? 'asset_integrity_failed' : 'all_sources_unreachable'
}

/** Parse a venv pyvenv.cfg into key→value (executable/home/version…). */
export function parsePyvenvCfg(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^([^=]+)=(.*)$/)
    if (m) map.set(m[1].trim(), m[2].trim())
  }
  return map
}

/**
 * Decide whether the existing venv must be rebuilt to take over the freshly
 * downloaded Python (C10/0.9#2). Caller resolves `venvBaseRealpath` (realpath of
 * pyvenv.cfg `executable` || `home`) and `pythonDistRealpath` first — this
 * predicate is a normalized prefix test, NOT a raw string compare.
 */
export function venvNeedsRebuild(params: {
  venvExists: boolean
  venvBaseRealpath: string | null
  pythonDistRealpath: string
}): boolean {
  if (!params.venvExists) return true
  if (!params.venvBaseRealpath) return true
  const base = params.venvBaseRealpath
  const dist = params.pythonDistRealpath.replace(/[\\/]+$/, '')
  return !(base === dist || base.startsWith(`${dist}/`) || base.startsWith(`${dist}\\`))
}

/**
 * Extraction guard: on top of skill-source-fetcher's abs-path/`..` checks, ADD a
 * symlink-target check (0.8#10/0.9#3). Throws on any escaping entry.
 */
export function assertSafeRuntimeArchiveEntry(
  entry: string,
  opts: { isSymlink?: boolean; linkTarget?: string } = {},
): void {
  const normalized = entry.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`运行时压缩包含绝对路径条目，已拒绝：${entry}`)
  }
  if (normalized.split('/').some((seg) => seg === '..')) {
    throw new Error(`运行时压缩包含越界路径（..），已拒绝：${entry}`)
  }
  if (opts.isSymlink) {
    const target = String(opts.linkTarget || '').replace(/\\/g, '/')
    if (!target) throw new Error(`运行时压缩包含无目标符号链接，已拒绝：${entry}`)
    if (target.startsWith('/') || /^[a-zA-Z]:/.test(target) || target.split('/').some((seg) => seg === '..')) {
      throw new Error(`运行时压缩包含越界符号链接，已拒绝：${entry} -> ${opts.linkTarget}`)
    }
  }
}
