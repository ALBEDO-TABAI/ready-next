// 设置页预览（?preview=settings）的分面板 mock：只在无 electronAPI 的浏览器预览里装载。
// 键是 electronAPI 的命名空间，值里的方法会合并进 installSettingsPreviewMocks 的同名命名空间。
import type { ModelPackSelfTestReport, ModelPackStatus } from '../../../shared/model-pack-types'
import { createDefaultModelPackDownloadStatus } from '../../../shared/model-pack-types'
import type { RuntimeProvisionTaskSnapshot, RuntimeStatus } from '../../../shared/runtime-provision-types'
import type { SkillSourceSelfTestReport } from '../../../shared/skill-source-types'

const RUNTIME_ROOT = '~/Library/Application Support/Ready/runtime/models'
const isoAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

// 运行时部分就绪：Python / ffmpeg 已装，ffprobe 与核心依赖仍缺。
const runtimeStatus: RuntimeStatus = {
  platformSupported: true,
  python: { ready: true, version: '3.11.9' },
  ffmpeg: { ready: true },
  ffprobe: { ready: false },
  coreDeps: { ready: false, missing: ['video-expert-analyzer', 'yt-dlp'] },
  overallReady: false,
}

const idleProvision: RuntimeProvisionTaskSnapshot = { runId: null, revision: 0, state: 'idle', updatedAt: Date.now() }

const modelPacks: ModelPackStatus[] = [
  {
    id: 'funasr-nano',
    displayName: 'FunASR Nano 语音识别',
    sizeEstimate: '约 1.1 GB',
    targetDir: `${RUNTIME_ROOT}/funasr-nano`,
    available: true,
    missingFiles: [],
    download: { ...createDefaultModelPackDownloadStatus(), completedAt: isoAgo(60 * 26), lastMessage: '已从 HuggingFace 镜像安装' },
  },
  {
    id: 'funasr-fallback-asr',
    displayName: 'Paraformer 降级识别',
    sizeEstimate: '约 860 MB',
    targetDir: `${RUNTIME_ROOT}/funasr-fallback-asr`,
    available: false,
    missingFiles: ['model.pt'],
    download: {
      ...createDefaultModelPackDownloadStatus(),
      running: true,
      source: 'auto',
      resolvedProvider: 'modelscope',
      startedAt: isoAgo(3),
      updatedAt: isoAgo(0),
      lastMessage: 'ModelScope 国内节点 · 断点续传中',
      progressPercent: 42,
    },
  },
  {
    id: 'funasr-punc-ctc',
    displayName: 'CT-Transformer 标点恢复',
    sizeEstimate: '约 280 MB',
    targetDir: `${RUNTIME_ROOT}/funasr-punc-ctc`,
    available: false,
    missingFiles: ['model.pt', 'config.yaml'],
    download: createDefaultModelPackDownloadStatus(),
  },
]

const selfTestReport: ModelPackSelfTestReport = {
  startedAt: isoAgo(1),
  finishedAt: isoAgo(0),
  entries: modelPacks.map((pack, index) => ({
    id: pack.id,
    displayName: pack.displayName,
    anyReachable: true,
    integrityOk: true,
    integrityDetail: '原子安装与断点续传路径正常',
    probes: [
      { source: 'domestic' as const, provider: 'modelscope' as const, endpoint: 'modelscope.cn', reachable: true, latencyMs: 38 + index * 7, coordinatesOk: true },
      { source: 'overseas' as const, provider: 'huggingface' as const, endpoint: 'huggingface.co', reachable: index !== 2, latencyMs: index !== 2 ? 212 + index * 30 : null, coordinatesOk: true },
    ],
  })),
}

const skillSourceReport: SkillSourceSelfTestReport = {
  startedAt: isoAgo(1),
  finishedAt: isoAgo(0),
  anyReachable: true,
  probes: [
    { source: 'domestic', endpoint: 'gitee.com', reachable: true, latencyMs: 46 },
    { source: 'overseas', endpoint: 'codeload.github.com', reachable: true, latencyMs: 248 },
  ],
  refResolveOk: true,
  refResolveDetail: 'main → 4f2c91a',
  stagingOk: true,
  stagingDetail: '暂存目录可读写',
}

export const previewNamespaces: Record<string, Record<string, unknown>> = {
  skills: {
    getSkillRuntimeStatus: async () => ({ success: true, data: runtimeStatus }),
    getSkillRuntimeProvisionState: async () => ({ success: true, data: idleProvision }),
    getSkillRuntimeMirror: async () => ({ success: true, data: '' }),
    onSkillRuntimeProvisionUpdate: () => () => undefined,
    provisionSkillRuntime: async () => ({
      success: true,
      data: {
        runId: 'preview-runtime',
        revision: 1,
        state: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        progress: { assetId: 'python', phase: 'download', receivedBytes: 18_000_000, totalBytes: 42_000_000 },
      } satisfies RuntimeProvisionTaskSnapshot,
    }),
    cancelSkillRuntimeProvision: async () => ({ success: true, data: { ...idleProvision, state: 'cancelled', revision: 2 } }),
    setSkillRuntimeMirror: async () => ({ success: true }),
    listModelPacks: async () => ({ success: true, data: modelPacks }),
    onModelPackDownloadUpdate: () => () => undefined,
    startModelPackDownload: async ({ id }: { id: string }) => ({ success: true, data: modelPacks.find((pack) => pack.id === id) }),
    cancelModelPackDownload: async ({ id }: { id: string }) => ({ success: true, data: modelPacks.find((pack) => pack.id === id) }),
    selfTestModelPacks: async () => ({ success: true, data: selfTestReport }),
    selfTestSkillSources: async () => ({ success: true, data: skillSourceReport }),
  },
}
