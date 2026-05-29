import type { ModelPackDescriptor, ModelPackId, ModelProvider, ModelSource } from '../../../shared/model-pack-types'

// Concrete registry of on-demand model packs. Descriptors carry the per-provider
// coordinates the download flow needs; the renderer only ever sees the derived
// ModelPackStatus, never these repo ids.
//
// - funasr-nano is HuggingFace-native (the domestic route goes through the HF
//   mirror endpoint).
// - the paraformer ASR + ct-punc punctuation packs are ModelScope-native (the
//   overseas route still uses ModelScope, which is reachable globally).
export const MODEL_PACK_REGISTRY: Record<ModelPackId, ModelPackDescriptor> = {
  'funasr-nano': {
    id: 'funasr-nano',
    displayName: 'FunASR Nano · 语音识别主引擎',
    sizeEstimate: '≈2 GB',
    requiredFiles: ['model.pt', 'config.yaml'],
    targetSubdir: 'funasr-nano-2512',
    providers: [
      {
        provider: 'huggingface',
        repoId: 'FunAudioLLM/Fun-ASR-Nano-2512',
        mirrorEndpoint: 'https://hf-mirror.com',
      },
    ],
  },
  'funasr-fallback-asr': {
    id: 'funasr-fallback-asr',
    displayName: 'Paraformer · 语音识别备用引擎',
    sizeEstimate: '≈1 GB',
    requiredFiles: ['model.pt', 'config.yaml'],
    targetSubdir: 'funasr-fallback-asr',
    providers: [
      {
        provider: 'modelscope',
        repoId: 'iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
      },
    ],
  },
  'funasr-punc-ctc': {
    id: 'funasr-punc-ctc',
    displayName: '标点恢复 · ct-punc (中文)',
    sizeEstimate: '≈292 MB',
    requiredFiles: ['model.pt', 'config.yaml'],
    targetSubdir: 'funasr-punc-ctc',
    providers: [
      {
        provider: 'modelscope',
        repoId: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch',
      },
    ],
  },
}

export function getModelPackDescriptor(id: ModelPackId): ModelPackDescriptor {
  const descriptor = MODEL_PACK_REGISTRY[id]
  if (!descriptor) throw new Error(`unknown model pack: ${id}`)
  return descriptor
}

export function listModelPackDescriptors(): ModelPackDescriptor[] {
  return Object.values(MODEL_PACK_REGISTRY)
}

// A concrete download target: which provider, which repo id, and whether to
// route a HuggingFace fetch through the mirror endpoint.
export interface ResolvedModelProvider {
  provider: ModelProvider
  repoId: string
  mirrorEndpoint: string | null
}

// Deterministic resolution for explicit sources. 'auto' is handled by
// probeFastestModelProvider (which needs a network probe).
export function resolveExplicitModelProvider(
  descriptor: ModelPackDescriptor,
  source: 'domestic' | 'overseas',
): ResolvedModelProvider {
  const modelscope = descriptor.providers.find((p) => p.provider === 'modelscope')
  const huggingface = descriptor.providers.find((p) => p.provider === 'huggingface')
  if (source === 'domestic') {
    // Prefer ModelScope (domestic-native); for HF-only packs route via mirror.
    if (modelscope) return { provider: 'modelscope', repoId: modelscope.repoId, mirrorEndpoint: null }
    if (huggingface) {
      return { provider: 'huggingface', repoId: huggingface.repoId, mirrorEndpoint: huggingface.mirrorEndpoint ?? null }
    }
  } else {
    // Overseas: prefer HuggingFace direct; for MS-only packs ModelScope works globally.
    if (huggingface) return { provider: 'huggingface', repoId: huggingface.repoId, mirrorEndpoint: null }
    if (modelscope) return { provider: 'modelscope', repoId: modelscope.repoId, mirrorEndpoint: null }
  }
  throw new Error(`model pack ${descriptor.id} has no provider for source "${source}"`)
}

// Each probe candidate is an endpoint URL plus the provider it resolves to.
export interface ProviderProbeCandidate {
  url: string
  resolved: ResolvedModelProvider
}

const PROVIDER_ENDPOINTS = {
  modelscope: 'https://modelscope.cn',
  huggingface: 'https://huggingface.co',
} as const

// The endpoint a resolved provider actually fetches from: the HF mirror when one
// was chosen, otherwise the provider's canonical host. Shared by the download
// flow's probe and the self-test so both report the same URL.
export function resolvedProviderEndpoint(resolved: ResolvedModelProvider): string {
  return resolved.mirrorEndpoint ?? PROVIDER_ENDPOINTS[resolved.provider]
}

export function buildProviderProbeCandidates(descriptor: ModelPackDescriptor): ProviderProbeCandidate[] {
  const candidates: ProviderProbeCandidate[] = []
  for (const p of descriptor.providers) {
    if (p.provider === 'modelscope') {
      candidates.push({
        url: PROVIDER_ENDPOINTS.modelscope,
        resolved: { provider: 'modelscope', repoId: p.repoId, mirrorEndpoint: null },
      })
    } else {
      candidates.push({
        url: PROVIDER_ENDPOINTS.huggingface,
        resolved: { provider: 'huggingface', repoId: p.repoId, mirrorEndpoint: null },
      })
      if (p.mirrorEndpoint) {
        candidates.push({
          url: p.mirrorEndpoint,
          resolved: { provider: 'huggingface', repoId: p.repoId, mirrorEndpoint: p.mirrorEndpoint },
        })
      }
    }
  }
  return candidates
}

// Probe each candidate endpoint and return the fastest reachable provider. The
// latency probe is injected so this stays unit-testable without real network.
// If nothing is reachable, returns the first candidate so the download attempt
// surfaces a concrete network error rather than silently doing nothing.
export async function probeFastestModelProvider(
  descriptor: ModelPackDescriptor,
  probeLatency: (url: string) => Promise<number | null>,
): Promise<ResolvedModelProvider> {
  const candidates = buildProviderProbeCandidates(descriptor)
  if (candidates.length === 0) {
    throw new Error(`model pack ${descriptor.id} has no providers`)
  }
  const measured = await Promise.all(
    candidates.map(async (candidate) => ({ candidate, latency: await probeLatency(candidate.url) })),
  )
  const reachable = measured
    .filter((m): m is { candidate: ProviderProbeCandidate; latency: number } => m.latency !== null)
    .sort((a, b) => a.latency - b.latency)
  return (reachable[0]?.candidate ?? candidates[0]).resolved
}

// Resolve a user-facing ModelSource to a concrete provider. 'auto' runs the
// latency probe; explicit sources resolve deterministically.
export async function resolveModelProvider(
  descriptor: ModelPackDescriptor,
  source: ModelSource,
  probeLatency: (url: string) => Promise<number | null>,
): Promise<ResolvedModelProvider> {
  if (source === 'auto') return probeFastestModelProvider(descriptor, probeLatency)
  return resolveExplicitModelProvider(descriptor, source)
}

// Sentinel printed by the download script on a clean finish.
export const MODEL_PACK_DONE_MARKER = '__READY_MODEL_PACK_DONE__'

// Build the one-shot python download script for a provider. Both snapshot_download
// implementations resume by re-invoking against the same local_dir (file-level
// skip; HF additionally does byte-level resume), so cancel/restart keeps partials.
export function buildModelPackDownloadScript(provider: ModelProvider, repoId: string): string {
  const importLine = provider === 'modelscope'
    ? 'from modelscope import snapshot_download'
    : 'from huggingface_hub import snapshot_download'
  const downloadCall = provider === 'modelscope'
    ? `path = snapshot_download(${JSON.stringify(repoId)}, local_dir=str(target))`
    : `path = snapshot_download(${JSON.stringify(repoId)}, local_dir=str(target), max_workers=4)`
  return [
    'import json, pathlib, sys',
    importLine,
    'target = pathlib.Path(sys.argv[1]).expanduser().resolve()',
    'target.mkdir(parents=True, exist_ok=True)',
    downloadCall,
    `print(${JSON.stringify(MODEL_PACK_DONE_MARKER)} + json.dumps({"path": str(path)}, ensure_ascii=False), flush=True)`,
  ].join('\n')
}
