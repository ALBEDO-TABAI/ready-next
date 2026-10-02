import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { RSSAnalysisAction, RSSAnalysisJob } from '../database/records'
import { RSSReadAnalysisReportSchema, type RSSReadAnalysisReportInput, type RSSAnalysisReportPage } from '../../../shared/rss-analysis-report'

export const ReportArtifact = z.object({
  jobId: z.string().min(1), fileName: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(), publishedAt: z.string().datetime(),
}).strict()
export type RSSReportArtifact = z.infer<typeof ReportArtifact>

export function analysisReportName(action: RSSAnalysisAction): string {
  return action === 'copy' ? '文案分析报告.md' : '视觉分析总结.md'
}

export function resolveAnalysisArtifactPath(root: string, fileName: string): string {
  const directory = realpathSync(root), path = realpathSync(resolve(directory, fileName))
  const local = relative(directory, path)
  if (!local || local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local)) throw new Error('分析产物已移出任务目录。')
  return path
}

export function captureTextArtifact(jobId: string, directory: string, path: string): RSSReportArtifact {
  const fileName = relative(resolve(directory), resolve(path))
  const bytes = readFileSync(resolveAnalysisArtifactPath(directory, fileName))
  return { jobId, fileName,
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, publishedAt: new Date().toISOString() }
}

export function captureAnalysisReport(job: RSSAnalysisJob): RSSReportArtifact {
  return captureTextArtifact(job.id, job.output_dir, join(job.output_dir, analysisReportName(job.action)))
}

export function readTextArtifact(directory: string, artifact: RSSReportArtifact): string {
  const bytes = readFileSync(resolveAnalysisArtifactPath(directory, artifact.fileName))
  if (bytes.length !== artifact.bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error('分析产物文件已变化，无法继续读取原内容。')
  }
  return bytes.toString('utf8')
}

export function savedAnalysisReport(job: RSSAnalysisJob): RSSReportArtifact | null {
  try {
    const parsed = ReportArtifact.safeParse(JSON.parse(job.meta_json || '{}').reportArtifact)
    if (!parsed.success || parsed.data.jobId !== job.id || parsed.data.fileName !== analysisReportName(job.action)) return null
    return parsed.data
  } catch { return null }
}

/** Synchronous verification leaves no application mutation between receipt and file checks. */
export function readAnalysisReport(job: RSSAnalysisJob): { artifact: RSSReportArtifact; text: string } {
  if (job.status !== 'success') throw new Error('分析任务尚未成功发布报告。')
  const artifact = savedAnalysisReport(job)
  if (!artifact) throw new Error('历史报告没有可核验的保存记录，无法确认现有文件属于此任务。')
  if (!job.report_path || resolve(job.report_path) !== resolve(job.output_dir, artifact.fileName)) {
    throw new Error('分析报告路径与保存记录不一致。')
  }
  return { artifact, text: readTextArtifact(job.output_dir, artifact) }
}

export function analysisTextPage(text: string, params: { offset: number; length: number; expectedRevision?: string }, revision: string) {
  if ((params.offset > 0 && !params.expectedRevision) || (params.expectedRevision && params.expectedRevision !== revision)) throw new Error('产物续读版本缺失或不匹配。')
  const splitsSurrogate = (position: number) => /[\uD800-\uDBFF]/.test(text[position - 1] || '') && /[\uDC00-\uDFFF]/.test(text[position] || '')
  if (params.offset > text.length || splitsSurrogate(params.offset)) throw new Error('产物续读位置无效。')
  let end = Math.min(text.length, params.offset + params.length)
  if (splitsSurrogate(end)) end--
  return { text: text.slice(params.offset, end), offset: params.offset, totalLength: text.length, nextOffset: end < text.length ? end : null }
}

export function readAnalysisReportPage(input: RSSReadAnalysisReportInput, getJob: (id: string) => RSSAnalysisJob | null,
  sourceWarning: (job: RSSAnalysisJob) => string | null): RSSAnalysisReportPage {
  const params = RSSReadAnalysisReportSchema.parse(input)
  const job = getJob(params.jobId)
  if (!job) throw new Error('分析任务已不存在。')
  const { artifact, text } = readAnalysisReport(job)
  const page = analysisTextPage(text, params, artifact.sha256)
  const current = getJob(job.id)
  if (!current || current.status !== 'success' || current.output_dir !== job.output_dir || current.report_path !== job.report_path ||
    JSON.stringify(savedAnalysisReport(current)) !== JSON.stringify(artifact)) throw new Error('分析报告已变化或删除。')
  return { jobId: job.id, itemId: job.item_id, title: job.title, sourceUrl: job.source_url,
    sourceWarning: sourceWarning(job), revision: artifact.sha256, publishedAt: artifact.publishedAt,
    ...page }
}
