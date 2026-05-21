import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  BrowserFastCardVideoTarget,
  FastCardResolveVideoRequest,
  FastCardResolveVideoResult,
  FastCardVideoMeta,
} from '../../../shared/fastcard'

const execFileAsync = promisify(execFile)

interface CommandResult {
  stdout: string
  stderr: string
}

interface VideoResolverDeps {
  runCommand?: (file: string, args: string[], options?: { timeout?: number; maxBuffer?: number }) => Promise<CommandResult>
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = String(value || '').trim()
    if (trimmed) return trimmed
  }
  return undefined
}

function safeNumber(value: unknown): number | undefined {
  const next = Number(value)
  return Number.isFinite(next) && next > 0 ? next : undefined
}

function urlIncludes(url: string, needles: string[]): boolean {
  const lower = url.toLowerCase()
  return needles.some((needle) => lower.includes(needle))
}

function platformFromUrl(url: string): string | undefined {
  if (urlIncludes(url, ['douyin.com', 'iesdouyin.com'])) return 'douyin'
  if (urlIncludes(url, ['xiaohongshu.com', 'xhslink.com'])) return 'xiaohongshu'
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host || undefined
  } catch {
    return undefined
  }
}

export function resolveDirectFastCardVideo(target: BrowserFastCardVideoTarget): FastCardVideoMeta | null {
  const directUrl = firstNonEmpty(target.videoUrl, ...(target.sources || []))
  if (!directUrl) return null
  return {
    originalUrl: directUrl,
    pageUrl: target.pageUrl,
    playableUrl: directUrl,
    downloadUrl: directUrl,
    posterUrl: target.posterUrl,
    title: target.title || target.pageTitle,
    platform: platformFromUrl(target.pageUrl || directUrl),
    parseStatus: 'not_needed',
  }
}

export function normalizeYtDlpVideoInfo(info: Record<string, unknown>, sourceUrl: string): FastCardVideoMeta {
  const requested = Array.isArray(info.requested_downloads) ? info.requested_downloads[0] as Record<string, unknown> | undefined : undefined
  const formats = Array.isArray(info.formats) ? info.formats as Array<Record<string, unknown>> : []
  const formatWithUrl = formats.find((format) => typeof format.url === 'string' && format.url)
  const playableUrl = firstNonEmpty(
    requested?.url as string | undefined,
    info.url as string | undefined,
    formatWithUrl?.url as string | undefined,
    sourceUrl,
  )
  return {
    originalUrl: sourceUrl,
    pageUrl: sourceUrl,
    playableUrl,
    downloadUrl: playableUrl,
    posterUrl: firstNonEmpty(info.thumbnail as string | undefined, info.display_thumbnail as string | undefined),
    title: firstNonEmpty(info.title as string | undefined, info.fulltitle as string | undefined),
    author: firstNonEmpty(info.uploader as string | undefined, info.channel as string | undefined, info.creator as string | undefined),
    platform: firstNonEmpty(info.extractor_key as string | undefined, info.extractor as string | undefined, platformFromUrl(sourceUrl)),
    durationSeconds: safeNumber(info.duration),
    parseStatus: playableUrl ? 'resolved' : 'failed',
    error: playableUrl ? undefined : 'yt-dlp 未返回可用链接',
  }
}

function normalizeDouyinInfo(info: Record<string, unknown>, sourceUrl: string): FastCardVideoMeta {
  const playableUrl = firstNonEmpty(info.video_url as string | undefined, info.play_url as string | undefined)
  return {
    originalUrl: sourceUrl,
    pageUrl: firstNonEmpty(info.resolved_url as string | undefined, sourceUrl),
    playableUrl,
    downloadUrl: playableUrl,
    posterUrl: firstNonEmpty(info.cover_url as string | undefined),
    title: firstNonEmpty(info.title as string | undefined),
    author: firstNonEmpty(info.author as string | undefined, info.uploader as string | undefined),
    platform: 'douyin',
    parseStatus: playableUrl ? 'resolved' : 'failed',
    error: playableUrl ? undefined : '抖音解析未返回视频链接',
  }
}

function normalizeXiaohongshuInfo(info: Record<string, unknown>, sourceUrl: string): FastCardVideoMeta {
  const playableUrl = firstNonEmpty(info.video_url as string | undefined)
  return {
    originalUrl: sourceUrl,
    pageUrl: firstNonEmpty(info.url as string | undefined, info.resolved_url as string | undefined, sourceUrl),
    playableUrl,
    downloadUrl: playableUrl,
    posterUrl: firstNonEmpty(info.cover_url as string | undefined),
    title: firstNonEmpty(info.title as string | undefined),
    author: firstNonEmpty(info.uploader as string | undefined, info.author as string | undefined),
    platform: 'xiaohongshu',
    parseStatus: playableUrl ? 'resolved' : 'failed',
    error: playableUrl ? undefined : '小红书解析未返回视频链接',
  }
}

function findSkillScript(name: string): string | null {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string }
  const roots = [
    process.cwd(),
    processWithResources.resourcesPath,
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    const candidates = [
      join(root, 'assets', 'embedded-skills', 'video-expert-analyzer', 'scripts', name),
      join(root, 'embedded-skills', 'video-expert-analyzer', 'scripts', name),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

async function defaultRunCommand(file: string, args: string[], options?: { timeout?: number; maxBuffer?: number }): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: options?.timeout || 15_000,
    maxBuffer: options?.maxBuffer || 2 * 1024 * 1024,
  })
  return { stdout, stderr }
}

async function runJsonCommand(
  deps: VideoResolverDeps,
  candidates: Array<{ file: string; args: string[] }>,
  timeout = 15_000,
): Promise<Record<string, unknown>> {
  const runCommand = deps.runCommand || defaultRunCommand
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      const result = await runCommand(candidate.file, candidate.args, { timeout, maxBuffer: 4 * 1024 * 1024 })
      return JSON.parse(result.stdout) as Record<string, unknown>
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'command_failed'))
}

async function resolveWithYtDlp(url: string, deps: VideoResolverDeps): Promise<FastCardVideoMeta> {
  const info = await runJsonCommand(deps, [
    { file: 'yt-dlp', args: ['--dump-single-json', '--no-download', '--no-warnings', url] },
    { file: 'python3', args: ['-m', 'yt_dlp', '--dump-single-json', '--no-download', '--no-warnings', url] },
    { file: 'python', args: ['-m', 'yt_dlp', '--dump-single-json', '--no-download', '--no-warnings', url] },
  ])
  return normalizeYtDlpVideoInfo(info, url)
}

async function resolveWithDouyin(url: string, deps: VideoResolverDeps): Promise<FastCardVideoMeta> {
  const script = findSkillScript('download_douyin.py')
  if (!script) throw new Error('未找到抖音解析脚本')
  const py = `
import importlib.util, json, sys
path, url = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("ready_douyin", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
resolved = mod.get_redirect_url(url)
render = mod.extract_render_data(resolved)
video = mod.extract_video_url(render) if render else None
print(json.dumps({"resolved_url": resolved, "video_url": video}, ensure_ascii=False))
`
  const info = await runJsonCommand(deps, [
    { file: 'python3', args: ['-c', py, script, url] },
    { file: 'python', args: ['-c', py, script, url] },
  ])
  return normalizeDouyinInfo(info, url)
}

async function resolveWithXiaohongshu(url: string, deps: VideoResolverDeps): Promise<FastCardVideoMeta> {
  const script = findSkillScript('xiaohongshu_downloader.py')
  if (!script) throw new Error('未找到小红书解析脚本')
  const py = `
import importlib.util, json, sys
path, url = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("ready_xhs", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
downloader = mod.XiaohongshuDownloader()
info = downloader.get_note_info(url)
print(json.dumps(info, ensure_ascii=False))
`
  const info = await runJsonCommand(deps, [
    { file: 'python3', args: ['-c', py, script, url] },
    { file: 'python', args: ['-c', py, script, url] },
  ])
  return normalizeXiaohongshuInfo(info, url)
}

function failedVideo(target: BrowserFastCardVideoTarget, error: string): FastCardVideoMeta {
  const originalUrl = firstNonEmpty(target.videoUrl, ...(target.sources || []), target.pageUrl)
  return {
    originalUrl,
    pageUrl: target.pageUrl,
    posterUrl: target.posterUrl,
    title: target.title || target.pageTitle,
    platform: platformFromUrl(target.pageUrl || originalUrl || ''),
    parseStatus: 'failed',
    error,
  }
}

export async function resolveFastCardVideo(
  request: FastCardResolveVideoRequest,
  deps: VideoResolverDeps = {},
): Promise<FastCardResolveVideoResult> {
  const direct = resolveDirectFastCardVideo(request.target)
  if (direct) return { video: direct }

  const pageUrl = firstNonEmpty(request.target.pageUrl)
  if (!pageUrl) return { video: failedVideo(request.target, '没有可解析的视频或页面链接') }

  try {
    if (urlIncludes(pageUrl, ['douyin.com', 'iesdouyin.com'])) {
      return { video: await resolveWithDouyin(pageUrl, deps) }
    }
    if (urlIncludes(pageUrl, ['xiaohongshu.com', 'xhslink.com'])) {
      return { video: await resolveWithXiaohongshu(pageUrl, deps) }
    }
    return { video: await resolveWithYtDlp(pageUrl, deps) }
  } catch (error) {
    return { video: failedVideo(request.target, error instanceof Error ? error.message : String(error)) }
  }
}
