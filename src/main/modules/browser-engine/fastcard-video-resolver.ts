import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  BrowserFastCardVideoTarget,
  FastCardResolveVideoRequest,
  FastCardResolveVideoResult,
  FastCardVideoMeta,
} from '../../../shared/fastcard'

const execFileAsync = promisify(execFile)
const electronModule = (() => {
  try {
    return createRequire(import.meta.url)('electron') as { app?: { getPath(name: string): string } }
  } catch {
    return {} as { app?: { getPath(name: string): string } }
  }
})()

interface CommandResult {
  stdout: string
  stderr: string
}

interface CommandOptions {
  timeout?: number
  maxBuffer?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface CommandCandidate {
  file: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface VideoResolverDeps {
  runCommand?: (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>
  pythonCandidates?: string[]
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

function isSameUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href
  } catch {
    return left === right
  }
}

function isYouTubePageUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
    return (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com'))
      && !host.includes('googlevideo.com')
  } catch {
    return false
  }
}

function usableYtDlpMediaUrl(value: unknown, sourceUrl: string): string | undefined {
  const url = String(value || '').trim()
  if (!/^https?:\/\//i.test(url)) return undefined
  if (isSameUrl(url, sourceUrl)) return undefined
  if (isYouTubePageUrl(url)) return undefined
  return url
}

function ytDlpFormatHasVideo(format: Record<string, unknown>): boolean {
  const vcodec = String(format.vcodec || '').toLowerCase()
  return (vcodec && vcodec !== 'none')
    || Boolean(format.width)
    || Boolean(format.height)
    || String(format.resolution || '').toLowerCase().includes('x')
}

function ytDlpFormatHasAudio(format: Record<string, unknown>): boolean {
  const acodec = String(format.acodec || '').toLowerCase()
  return (acodec && acodec !== 'none')
    || Number(format.abr || 0) > 0
    || Number(format.asr || 0) > 0
}

function ytDlpFormatScore(format: Record<string, unknown>): number {
  const height = Number(format.height || 0)
  const tbr = Number(format.tbr || format.bitrate || 0)
  if (ytDlpFormatHasVideo(format) && ytDlpFormatHasAudio(format)) return 300_000_000 + height * 1_000 + tbr
  if (ytDlpFormatHasVideo(format)) return 200_000_000 + height * 1_000 + tbr
  if (ytDlpFormatHasAudio(format)) return 100_000_000 + tbr
  return tbr
}

function bestYtDlpFormatUrl(formats: Array<Record<string, unknown>>, sourceUrl: string): string | undefined {
  return [...formats]
    .filter((format) => usableYtDlpMediaUrl(format.url, sourceUrl))
    .filter((format) => ytDlpFormatHasVideo(format))
    .sort((a, b) => ytDlpFormatScore(b) - ytDlpFormatScore(a))
    .map((format) => usableYtDlpMediaUrl(format.url, sourceUrl))
    .find(Boolean)
}

function ytDlpRecords(records: unknown): Array<Record<string, unknown>> {
  return Array.isArray(records)
    ? records.filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === 'object')
    : []
}

function firstYtDlpRecordUrl(records: unknown, sourceUrl: string): string | undefined {
  for (const record of ytDlpRecords(records)) {
    const url = usableYtDlpMediaUrl(record.url, sourceUrl)
    if (url) return url
  }
  return undefined
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
  const formats = Array.isArray(info.formats) ? info.formats as Array<Record<string, unknown>> : []
  const playableUrl = firstNonEmpty(
    firstYtDlpRecordUrl(info.requested_downloads, sourceUrl),
    bestYtDlpFormatUrl(ytDlpRecords(info.requested_formats), sourceUrl),
    usableYtDlpMediaUrl(info.url, sourceUrl),
    bestYtDlpFormatUrl(formats, sourceUrl),
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

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const item = String(value || '').trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function electronUserDataPath(): string | null {
  try {
    return electronModule.app?.getPath('userData') || null
  } catch {
    return null
  }
}

function skillRuntimeRootCandidates(): string[] {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string }
  const userData = electronUserDataPath()
  const home = homedir()
  return uniqueStrings([
    process.env.READY_VIDEO_RESOLVER_SKILL_RUNTIME_ROOT,
    process.env.READY_SKILL_RUNTIME_ROOT,
    process.env.READY_PACKAGED_SKILL_RUNTIME_ROOT,
    process.env.READY_RELEASE_SKILL_RUNTIME_ROOT,
    processWithResources.resourcesPath ? join(processWithResources.resourcesPath, 'skill-runtime') : undefined,
    userData ? join(userData, 'skill-runtime') : undefined,
    process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Ready', 'skill-runtime') : undefined,
    process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'Ready', 'skill-runtime') : undefined,
    process.platform !== 'darwin' && process.platform !== 'win32' ? join(home, '.config', 'Ready', 'skill-runtime') : undefined,
  ]).filter((candidate) => existsSync(candidate))
}

function skillRuntimeBinDir(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'python', 'Scripts')
    : join(root, 'python', 'bin')
}

function skillRuntimePythonCandidates(): string[] {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return skillRuntimeRootCandidates().flatMap((root) => {
    const sharedBin = skillRuntimeBinDir(root)
    const customBin = process.platform === 'win32'
      ? join(root, 'custom-venvs', 'video-expert-analyzer', 'Scripts')
      : join(root, 'custom-venvs', 'video-expert-analyzer', 'bin')
    return [
      join(customBin, `python${suffix}`),
      join(sharedBin, `python${suffix}`),
      join(sharedBin, `python3${suffix}`),
    ]
  }).filter((candidate) => existsSync(candidate))
}

function pythonCandidates(deps: VideoResolverDeps): string[] {
  return uniqueStrings([
    ...(deps.pythonCandidates || []),
    ...skillRuntimePythonCandidates(),
    'python3',
    'python',
  ])
}

function toolCandidates(tool: string): string[] {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']
  const runtimeTools = skillRuntimeRootCandidates().flatMap((root) => {
    const runtimeBin = join(root, 'bin')
    const pythonBin = skillRuntimeBinDir(root)
    return suffixes.flatMap((suffix) => [
      join(runtimeBin, `${tool}${suffix}`),
      join(pythonBin, `${tool}${suffix}`),
    ])
  }).filter((candidate) => existsSync(candidate))
  return uniqueStrings([...runtimeTools, tool])
}

function commandEnv(file: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  if (file.includes('/') || file.includes('\\')) {
    env.PATH = [dirname(file), env.PATH || ''].join(delimiter)
  }
  return env
}

function parseJsonStdout(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    const line = trimmed
      .split(/\r?\n/)
      .map((item) => item.trim())
      .reverse()
      .find((item) => item.startsWith('{') && item.endsWith('}'))
    if (line) return JSON.parse(line) as Record<string, unknown>
    throw new Error('命令未输出 JSON')
  }
}

function compactOutput(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 500)
}

function formatCommandFailure(candidate: CommandCandidate, error: unknown): string {
  const err = error as Error & { stdout?: string; stderr?: string }
  const parts = [`${candidate.file}: ${err?.message || String(error)}`]
  const stderr = compactOutput(err?.stderr)
  const stdout = compactOutput(err?.stdout)
  if (stderr) parts.push(`stderr=${stderr}`)
  if (stdout) parts.push(`stdout=${stdout}`)
  return parts.join(' ')
}

async function defaultRunCommand(file: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: options?.timeout || 15_000,
    maxBuffer: options?.maxBuffer || 2 * 1024 * 1024,
    cwd: options?.cwd,
    env: options?.env,
  })
  return { stdout, stderr }
}

async function runJsonCommand(
  deps: VideoResolverDeps,
  candidates: CommandCandidate[],
  timeout = 15_000,
): Promise<Record<string, unknown>> {
  const runCommand = deps.runCommand || defaultRunCommand
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      const result = await runCommand(candidate.file, candidate.args, {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        cwd: candidate.cwd,
        env: candidate.env,
      })
      return parseJsonStdout(result.stdout)
    } catch (error) {
      failures.push(formatCommandFailure(candidate, error))
    }
  }
  throw new Error(failures.length ? failures.join(' | ') : 'command_failed')
}

async function resolveWithYtDlp(url: string, deps: VideoResolverDeps): Promise<FastCardVideoMeta> {
  const info = await runJsonCommand(deps, [
    ...toolCandidates('yt-dlp').map((file) => ({
      file,
      args: ['--dump-single-json', '--no-download', '--no-warnings', url],
      env: commandEnv(file),
    })),
    ...pythonCandidates(deps).map((file) => ({
      file,
      args: ['-m', 'yt_dlp', '--dump-single-json', '--no-download', '--no-warnings', url],
      env: commandEnv(file),
    })),
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
  const info = await runJsonCommand(
    deps,
    pythonCandidates(deps).map((file) => ({
      file,
      args: ['-c', py, script, url],
      cwd: dirname(script),
      env: commandEnv(file),
    })),
  )
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
  const info = await runJsonCommand(
    deps,
    pythonCandidates(deps).map((file) => ({
      file,
      args: ['-c', py, script, url],
      cwd: dirname(script),
      env: commandEnv(file),
    })),
  )
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
