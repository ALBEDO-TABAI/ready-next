// Model-pack contracts: the unified on-demand model download surface.
//
// Generalizes the former FunASR-Nano-specific download flow into a registry of
// packs. Each pack installs into the writable runtime root and can be fetched
// from a domestic (ModelScope) or overseas (HuggingFace) provider, with an
// "auto" source that probes reachability at download start. The download flow
// resumes partial files (snapshot_download), verifies required files on close,
// and atomically installs into place.

export type ModelPackId = 'funasr-nano' | 'funasr-fallback-asr' | 'funasr-punc-ctc'

export const MODEL_PACK_IDS: readonly ModelPackId[] = [
  'funasr-nano',
  'funasr-fallback-asr',
  'funasr-punc-ctc',
]

// User-selectable download source. 'auto' resolves to the fastest reachable
// provider at download start; the explicit values pin a provider.
export type ModelSource = 'auto' | 'domestic' | 'overseas'

export const MODEL_SOURCES: readonly ModelSource[] = ['auto', 'domestic', 'overseas']

// Concrete provider behind a ModelSource. domestic -> modelscope, overseas -> huggingface.
export type ModelProvider = 'modelscope' | 'huggingface'

// Per-provider download coordinates. A pack declares only the providers that
// actually carry it (Nano is HuggingFace-native; the iic/* ASR + punctuation
// models are ModelScope-native). The download script is selected per provider.
export interface ModelPackProviderCoordinate {
  provider: ModelProvider
  // Repository id as that provider's snapshot_download expects it.
  repoId: string
  // For a huggingface provider, route through this mirror endpoint (HF_ENDPOINT)
  // when the domestic-friendly HF route is chosen (e.g. https://hf-mirror.com).
  mirrorEndpoint?: string
}

export interface ModelPackDescriptor {
  id: ModelPackId
  displayName: string
  // Human-facing size estimate, e.g. "≈292 MB".
  sizeEstimate: string
  // Files that must exist under the target dir for the pack to count as installed.
  requiredFiles: readonly string[]
  // Directory name under <runtimeRoot>/models where the pack installs.
  targetSubdir: string
  // Providers that carry this pack. Source resolution decides which is used.
  providers: readonly ModelPackProviderCoordinate[]
}

// Mirrors the former FunasrNanoModelDownloadStatus, plus the resolved source/provider.
export interface ModelPackDownloadStatus {
  running: boolean
  // The source the user requested for the active or most recent run.
  source: ModelSource | null
  // The provider 'auto'/explicit source resolved to for that run.
  resolvedProvider: ModelProvider | null
  targetDir: string | null
  startedAt: string | null
  updatedAt: string | null
  completedAt: string | null
  error: string | null
  lastMessage: string | null
  progressPercent: number | null
}

export interface ModelPackStatus {
  id: ModelPackId
  displayName: string
  sizeEstimate: string
  // Absolute install dir under the writable runtime root.
  targetDir: string
  available: boolean
  missingFiles: string[]
  download: ModelPackDownloadStatus
}

// Streamed over the modelPacks:downloadUpdate channel during a download.
export interface ModelPackDownloadUpdate {
  id: ModelPackId
  status: ModelPackStatus
}

// Request payload for starting a download. Source defaults to 'auto'.
export interface ModelPackDownloadRequest {
  id: ModelPackId
  source?: ModelSource
}

// Canonical Settings section id for the Models & Runtime page. Shared so the
// missing-dependency signal (main) and the Settings router (renderer) agree on
// one deep-link target.
export const MODELS_RUNTIME_SETTINGS_SECTION = 'models-runtime'

// Generic "missing runtime dependency" signal. Any feature whose on-demand
// model/dependency is absent emits this so the renderer can deep-link the user
// into Settings › Models & Runtime to download the missing pack(s). The first
// consumer is subtitle extraction, but the shape is feature-agnostic.
export interface MissingRuntimeDependency {
  // Stable feature key, e.g. 'video-subtitle-extraction'.
  feature: string
  missingPacks: ModelPackId[]
  // Settings section the renderer routes to; defaults to MODELS_RUNTIME_SETTINGS_SECTION.
  settingsSection: string
}

// Marker the subtitle extractor prints to stderr when required local models are
// absent in packaged (offline) mode. Kept in lockstep with the Python constant
// of the same name in both extract_subtitle_funasr.py copies; the marker line is:
//   __READY_ASR_MODEL_PACK_MISSING__ {"feature":"...","missing":["asr","punc"]}
export const ASR_MODEL_PACK_MISSING_MARKER = '__READY_ASR_MODEL_PACK_MISSING__'

// Maps the Python-reported role names to the concrete packs that satisfy them.
const ASR_MODEL_PACK_ROLE_TO_ID: Record<string, ModelPackId> = {
  asr: 'funasr-fallback-asr',
  punc: 'funasr-punc-ctc',
}

// Scans combined process output (stdout+stderr) for the structured missing-model
// marker and, if present, returns the generic missing-dependency signal the
// renderer surfaces. Returns null when the marker is absent. Faithful to what
// the Python emits; if the payload is unparseable the marker alone still signals
// a missing subtitle dependency (with the full fallback pack set so the user can
// recover).
export function detectMissingRuntimeDependency(
  output: string | null | undefined,
): MissingRuntimeDependency | null {
  if (!output) return null
  const markerIndex = output.indexOf(ASR_MODEL_PACK_MISSING_MARKER)
  if (markerIndex === -1) return null

  const afterMarker = output.slice(markerIndex + ASR_MODEL_PACK_MISSING_MARKER.length)
  const lineEnd = afterMarker.indexOf('\n')
  const payloadText = (lineEnd === -1 ? afterMarker : afterMarker.slice(0, lineEnd)).trim()

  let feature = 'video-subtitle-asr'
  const packs = new Set<ModelPackId>()
  try {
    const parsed = JSON.parse(payloadText) as { feature?: unknown; missing?: unknown }
    if (typeof parsed.feature === 'string' && parsed.feature.trim()) {
      feature = parsed.feature.trim()
    }
    if (Array.isArray(parsed.missing)) {
      for (const role of parsed.missing) {
        if (typeof role !== 'string') continue
        const packId = ASR_MODEL_PACK_ROLE_TO_ID[role.trim()]
        if (packId) packs.add(packId)
      }
    }
  } catch {
    // Marker present but payload unparseable: still signal, with the full
    // subtitle fallback pack set so the user can recover.
  }

  if (packs.size === 0) {
    packs.add('funasr-fallback-asr')
    packs.add('funasr-punc-ctc')
  }

  return {
    feature,
    missingPacks: [...packs],
    settingsSection: MODELS_RUNTIME_SETTINGS_SECTION,
  }
}

// ---------------------------------------------------------------------------
// Download self-test: a lightweight diagnostic that proves the supplementary
// download feature is reachable + correct WITHOUT pulling full weights. It
// probes each source's endpoint reachability/latency, validates the provider
// coordinates resolve, and exercises the integrity/atomic-install path on a
// scratch file. Surfaced in Settings › Models & Runtime.
// ---------------------------------------------------------------------------

export interface ModelPackSourceProbe {
  // The user-facing source this probe represents.
  source: Exclude<ModelSource, 'auto'>
  provider: ModelProvider
  endpoint: string
  reachable: boolean
  latencyMs: number | null
  // True when the provider coordinates resolved and the download script built.
  coordinatesOk: boolean
}

export interface ModelPackSelfTestEntry {
  id: ModelPackId
  displayName: string
  probes: ModelPackSourceProbe[]
  // At least one source endpoint was reachable.
  anyReachable: boolean
  // The integrity/atomic-rename + resume-preserve scratch check passed.
  integrityOk: boolean
  integrityDetail: string
}

export interface ModelPackSelfTestReport {
  startedAt: string
  finishedAt: string
  entries: ModelPackSelfTestEntry[]
}

export function createDefaultModelPackDownloadStatus(): ModelPackDownloadStatus {
  return {
    running: false,
    source: null,
    resolvedProvider: null,
    targetDir: null,
    startedAt: null,
    updatedAt: null,
    completedAt: null,
    error: null,
    lastMessage: null,
    progressPercent: null,
  }
}
