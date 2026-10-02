import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { z } from 'zod'
import type { RSSAnalysisJob } from '../database/records'
import { RSSReadAnalysisAssetsSchema, type RSSAnalysisAssetKind, type RSSReadAnalysisAssetsInput } from '../../../shared/rss-analysis-assets'
import { analysisTextPage, captureTextArtifact, readTextArtifact, ReportArtifact, resolveAnalysisArtifactPath } from './analysis-report'

const VideoArtifact = z.object({ jobId: z.string(), fileName: z.string(), bytes: z.number().int().nonnegative(), identity: z.string(), publishedAt: z.string().datetime() }).strict()
const Assets = z.object({ corrected_transcript: ReportArtifact.optional(), structured_transcript: ReportArtifact.optional(),
  source_article: ReportArtifact.optional(), scene_scores: ReportArtifact.optional(), source_video: VideoArtifact.nullable().optional() }).strict()
export type AnalysisAssetPaths = Partial<Record<RSSAnalysisAssetKind, string | null>>
type SavedAssets = z.infer<typeof Assets>

function metadata(job: RSSAnalysisJob): Record<string, unknown> {
  try { const value = JSON.parse(job.meta_json || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
function videoIdentity(path: string) {
  const file = statSync(path, { bigint: true })
  if (!file.isFile()) throw new Error('视频引用不是普通文件。')
  const identity = createHash('sha256').update([file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':')).digest('hex')
  return { bytes: Number(file.size), identity }
}

export function captureAnalysisAssets(job: RSSAnalysisJob, paths: AnalysisAssetPaths): SavedAssets {
  const assets: SavedAssets = {}
  for (const kind of Object.keys(paths) as RSSAnalysisAssetKind[]) {
    const path = paths[kind]
    if (kind === 'source_video') {
      if (!path) { assets.source_video = null; continue }
      const root = metadata(job).rootDir
      if (typeof root !== 'string') throw new Error('任务缺少素材目录身份。')
      const fileName = relative(resolve(root), resolve(path))
      assets.source_video = { jobId: job.id, fileName, ...videoIdentity(resolveAnalysisArtifactPath(root, fileName)), publishedAt: new Date().toISOString() }
    } else {
      if (!path) throw new Error('已生成的文字产物缺少文件。')
      assets[kind] = captureTextArtifact(job.id, job.output_dir, path)
    }
  }
  return Assets.parse(assets)
}

export function readAnalysisAssets(input: RSSReadAnalysisAssetsInput, getJob: (id: string) => RSSAnalysisJob | null) {
  const params = RSSReadAnalysisAssetsSchema.parse(input), job = getJob(params.jobId)
  if (!job) throw new Error('分析任务已不存在。')
  if (job.status !== 'success') throw new Error('分析任务尚未成功发布产物。')
  const meta = metadata(job), parsed = Assets.safeParse(meta.analysisAssets)
  const source = { jobId: job.id, itemId: job.item_id, title: job.title, sourceUrl: job.source_url,
    sourceRevision: typeof meta.sourceRevision === 'string' ? meta.sourceRevision : null }
  if (!parsed.success) return { ...source, state: 'unverifiable', reason: '此任务未保存可核验的补充产物身份；不会从旧文件清单猜测。' }
  const assets = parsed.data
  const inspect = (kind: RSSAnalysisAssetKind) => {
    const artifact = assets[kind]
    if (artifact === undefined) return { kind, state: 'not_applicable' }
    if (artifact === null) return { kind, state: 'not_saved', sourceUrl: job.source_url }
    if (artifact.jobId !== job.id) throw new Error('产物不属于此任务。')
    try {
      if (kind === 'source_video') {
        const video = VideoArtifact.parse(artifact)
        if (typeof meta.rootDir !== 'string') throw new Error('任务缺少素材目录身份。')
        const path = resolveAnalysisArtifactPath(meta.rootDir, video.fileName)
        if (videoIdentity(path).identity !== video.identity) return { kind, state: 'changed', verification: 'file_metadata', contentRead: false }
        return { kind, state: 'available', path, bytes: video.bytes, verification: 'file_metadata', contentRead: false, sourceUrl: job.source_url }
      }
      const textArtifact = ReportArtifact.parse(artifact)
      const text = readTextArtifact(job.output_dir, textArtifact)
      return { kind, state: 'available', revision: textArtifact.sha256, publishedAt: textArtifact.publishedAt,
        bytes: textArtifact.bytes, ...(params.kind === 'list' ? {} : analysisTextPage(text, params, textArtifact.sha256)) }
    } catch (error) {
      if (params.kind !== 'list') throw error
      return { kind, state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const result = params.kind === 'list' ? { entries: (Object.keys(assets) as RSSAnalysisAssetKind[]).map(inspect) } : inspect(params.kind)
  const current = getJob(job.id)
  if (!current || current.status !== 'success' || current.output_dir !== job.output_dir || current.meta_json !== job.meta_json) throw new Error('分析产物已变化或删除。')
  return { ...source, observedAt: new Date().toISOString(), ...result }
}
