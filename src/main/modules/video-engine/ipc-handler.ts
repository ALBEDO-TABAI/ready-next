import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { promisify } from 'util'
import { basename, join, dirname } from 'path'
import { tmpdir } from 'os'

const execFileAsync = promisify(execFile)

// --- Types ---

interface VideoInfo {
  duration: number
  width: number
  height: number
  codec: string
  fps: number
  bitrate: number
  audioCodec: string | null
  format: string
  size: number
}

interface TrimOptions {
  input: string
  start: number
  end: number
  output: string
}

interface TranscodeOptions {
  input: string
  output: string
  codec?: string
  resolution?: string
  bitrate?: string
  audioCodec?: string
  audioBitrate?: string
}

interface ExtractFrameOptions {
  input: string
  timestamp: number
  output?: string
}

interface ExtractAudioOptions {
  input: string
  output?: string
  format?: string
}

interface TimelineClipInput {
  source: string
  start: number
  end?: number
}

interface RenderTimelineOptions {
  output: string
  width: number
  height: number
  fps: number
  duration: number
  tracks?: {
    video?: unknown[]
    subtitle?: unknown[]
    audio?: unknown[]
  }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'svg'])

function toTimelineClip(input: unknown): TimelineClipInput | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const source = typeof obj.source === 'string' ? obj.source : undefined
  if (!source) return null

  const startRaw = typeof obj.start === 'number' ? obj.start : 0
  const endRaw = typeof obj.end === 'number' ? obj.end : undefined
  const start = Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0
  const end = Number.isFinite(endRaw ?? NaN) ? Math.max(start + 0.1, endRaw as number) : undefined
  return { source, start, end }
}

function clipDurationSeconds(clip: TimelineClipInput, fallbackDuration: number): number {
  const end = clip.end ?? (clip.start + fallbackDuration)
  return Math.max(0.1, end - clip.start)
}

function isImagePath(path: string): boolean {
  const ext = (path.split('.').pop() || '').toLowerCase()
  return IMAGE_EXTS.has(ext)
}

function toSafeConcatLine(path: string): string {
  return `file '${path.replace(/'/g, `'\\''`)}'`
}

async function ensureVideoSegment(
  ffmpeg: string,
  source: string | null,
  output: string,
  duration: number,
  width: number,
  height: number,
  fps: number,
): Promise<void> {
  const safeDuration = Math.max(0.1, duration)
  if (!source) {
    await execFileAsync(ffmpeg, [
      '-f', 'lavfi',
      '-i', `color=c=black:s=${width}x${height}:r=${fps}:d=${safeDuration}`,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-y',
      output,
    ], { timeout: 600_000 })
    return
  }

  const args: string[] = []
  if (isImagePath(source)) {
    args.push('-loop', '1', '-i', source)
  } else {
    args.push('-i', source)
  }

  args.push(
    '-t', String(safeDuration),
    '-r', String(fps),
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-y',
    output,
  )

  await execFileAsync(ffmpeg, args, { timeout: 600_000 })
}

// --- FFmpeg/FFprobe path detection ---

let cachedFfmpegPath: string | null = null
let cachedFfprobePath: string | null = null

const COMMON_FFMPEG_PATHS = [
  '/usr/local/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/bin/ffmpeg'
]

const COMMON_FFPROBE_PATHS = [
  '/usr/local/bin/ffprobe',
  '/opt/homebrew/bin/ffprobe',
  '/usr/bin/ffprobe'
]

async function findExecutable(name: string, commonPaths: string[]): Promise<string | null> {
  // Try `which` first
  try {
    const { stdout } = await execFileAsync('which', [name])
    const path = stdout.trim()
    if (path && existsSync(path)) return path
  } catch {
    // which failed, try common paths
  }

  for (const p of commonPaths) {
    if (existsSync(p)) return p
  }

  return null
}

async function getFfmpegPath(): Promise<string> {
  if (cachedFfmpegPath) return cachedFfmpegPath
  const path = await findExecutable('ffmpeg', COMMON_FFMPEG_PATHS)
  if (!path) throw new Error('ffmpeg not found. Please install ffmpeg (brew install ffmpeg)')
  cachedFfmpegPath = path
  return path
}

async function getFfprobePath(): Promise<string> {
  if (cachedFfprobePath) return cachedFfprobePath
  const path = await findExecutable('ffprobe', COMMON_FFPROBE_PATHS)
  if (!path) throw new Error('ffprobe not found. Please install ffmpeg (brew install ffmpeg)')
  cachedFfprobePath = path
  return path
}

// --- IPC Setup ---

export function setupVideoIPC(): void {
  // Get video info via ffprobe
  ipcMain.handle('video:get-info', async (_, inputPath: string) => {
    try {
      if (!existsSync(inputPath)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }

      const ffprobe = await getFfprobePath()

      const { stdout } = await execFileAsync(ffprobe, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        inputPath
      ])

      const probe = JSON.parse(stdout)
      const videoStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'video')
      const audioStream = probe.streams?.find((s: { codec_type: string }) => s.codec_type === 'audio')
      const format = probe.format

      if (!videoStream) {
        return { success: false, error: 'No video stream found', errorCode: 'NO_VIDEO_STREAM' }
      }

      // Parse fps from r_frame_rate (e.g. "30/1" or "24000/1001")
      let fps = 0
      if (videoStream.r_frame_rate) {
        const parts = videoStream.r_frame_rate.split('/')
        fps = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(parts[0])
        fps = Math.round(fps * 100) / 100
      }

      const info: VideoInfo = {
        duration: parseFloat(format?.duration ?? '0'),
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        codec: videoStream.codec_name ?? 'unknown',
        fps,
        bitrate: parseInt(format?.bit_rate ?? '0', 10),
        audioCodec: audioStream?.codec_name ?? null,
        format: format?.format_name ?? 'unknown',
        size: parseInt(format?.size ?? '0', 10)
      }

      return { success: true, data: info }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'PROBE_ERROR' }
    }
  })

  // Extract a single frame at a given timestamp
  ipcMain.handle('video:extract-frame', async (_, options: ExtractFrameOptions) => {
    try {
      const { input, timestamp, output } = options

      if (!existsSync(input)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }

      const ffmpeg = await getFfmpegPath()

      const outputPath = output ?? join(
        dirname(input),
        `${basename(input, '.' + input.split('.').pop())}_frame_${timestamp}s.png`
      )

      await execFileAsync(ffmpeg, [
        '-ss', String(timestamp),
        '-i', input,
        '-frames:v', '1',
        '-y',
        outputPath
      ])

      if (!existsSync(outputPath)) {
        return { success: false, error: 'Frame extraction failed — output file not created', errorCode: 'EXTRACT_FAILED' }
      }

      return { success: true, path: outputPath }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'EXTRACT_ERROR' }
    }
  })

  // Trim a video file
  ipcMain.handle('video:trim', async (_, options: TrimOptions) => {
    try {
      const { input, start, end, output } = options

      if (!existsSync(input)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }

      if (start >= end) {
        return { success: false, error: 'Start time must be less than end time', errorCode: 'INVALID_RANGE' }
      }

      const ffmpeg = await getFfmpegPath()

      await execFileAsync(ffmpeg, [
        '-i', input,
        '-ss', String(start),
        '-to', String(end),
        '-c', 'copy',
        '-y',
        output
      ])

      if (!existsSync(output)) {
        return { success: false, error: 'Trim failed — output file not created', errorCode: 'TRIM_FAILED' }
      }

      return { success: true, path: output }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'TRIM_ERROR' }
    }
  })

  // Transcode / convert between formats
  ipcMain.handle('video:transcode', async (_, options: TranscodeOptions) => {
    try {
      const { input, output, codec, resolution, bitrate, audioCodec, audioBitrate } = options

      if (!existsSync(input)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }

      const ffmpeg = await getFfmpegPath()

      const args: string[] = ['-i', input]

      if (codec) {
        args.push('-c:v', codec)
      }
      if (resolution) {
        args.push('-s', resolution)
      }
      if (bitrate) {
        args.push('-b:v', bitrate)
      }
      if (audioCodec) {
        args.push('-c:a', audioCodec)
      }
      if (audioBitrate) {
        args.push('-b:a', audioBitrate)
      }

      args.push('-y', output)

      await execFileAsync(ffmpeg, args, { timeout: 600_000 })

      if (!existsSync(output)) {
        return { success: false, error: 'Transcode failed — output file not created', errorCode: 'TRANSCODE_FAILED' }
      }

      return { success: true, path: output }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'TRANSCODE_ERROR' }
    }
  })

  // Extract audio track from video
  ipcMain.handle('video:extract-audio', async (_, options: ExtractAudioOptions) => {
    try {
      const { input, output, format } = options

      if (!existsSync(input)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }

      const ffmpeg = await getFfmpegPath()

      const audioFormat = format ?? 'mp3'
      const outputPath = output ?? join(
        dirname(input),
        `${basename(input, '.' + input.split('.').pop())}_audio.${audioFormat}`
      )

      const args: string[] = [
        '-i', input,
        '-vn',
        '-y',
        outputPath
      ]

      await execFileAsync(ffmpeg, args)

      if (!existsSync(outputPath)) {
        return { success: false, error: 'Audio extraction failed — output file not created', errorCode: 'AUDIO_EXTRACT_FAILED' }
      }

      return { success: true, path: outputPath }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'AUDIO_EXTRACT_ERROR' }
    }
  })

  // Render timeline (Remotion-ready API surface with FFmpeg fallback implementation)
  ipcMain.handle('video:render-timeline', async (_, options: RenderTimelineOptions) => {
    try {
      const ffmpeg = await getFfmpegPath()
      const videoClips = Array.isArray(options?.tracks?.video) ? options.tracks?.video || [] : []
      const audioClips = Array.isArray(options?.tracks?.audio) ? options.tracks?.audio || [] : []
      const subtitleClips = Array.isArray(options?.tracks?.subtitle) ? options.tracks?.subtitle || [] : []

      const width = Math.max(16, Math.floor(options.width || 1080))
      const height = Math.max(16, Math.floor(options.height || 1920))
      const fps = Math.max(1, Math.floor(options.fps || 30))
      const totalDuration = Math.max(0.1, options.duration || 1)
      const output = options.output

      if (!output) {
        return { success: false, error: 'Missing output path', errorCode: 'INVALID_OPTIONS' }
      }

      const parsedVideoClips = videoClips
        .map(toTimelineClip)
        .filter((clip): clip is TimelineClipInput => Boolean(clip))
        .sort((a, b) => a.start - b.start)
      const parsedAudioClips = audioClips
        .map(toTimelineClip)
        .filter((clip): clip is TimelineClipInput => Boolean(clip))
        .sort((a, b) => a.start - b.start)

      const validVideoClips = parsedVideoClips.filter((clip) => existsSync(clip.source))
      const validAudioClips = parsedAudioClips.filter((clip) => existsSync(clip.source))

      if (validVideoClips.length === 0 && validAudioClips.length === 0) {
        return {
          success: false,
          error: 'No renderable source clips found in timeline.',
          errorCode: 'NO_SOURCE_CLIP',
        }
      }

      const tempDir = mkdtempSync(join(tmpdir(), 'ready-render-'))

      try {
        const segmentPaths: string[] = []
        let segmentIndex = 0
        let cursor = 0

        for (const clip of validVideoClips) {
          if (clip.start > cursor + 0.02) {
            const gapPath = join(tempDir, `segment-${segmentIndex++}-gap.mp4`)
            await ensureVideoSegment(ffmpeg, null, gapPath, clip.start - cursor, width, height, fps)
            segmentPaths.push(gapPath)
            cursor = clip.start
          }

          const duration = clipDurationSeconds(clip, totalDuration)
          const segmentPath = join(tempDir, `segment-${segmentIndex++}.mp4`)
          await ensureVideoSegment(ffmpeg, clip.source, segmentPath, duration, width, height, fps)
          segmentPaths.push(segmentPath)
          cursor = Math.max(cursor, clip.start + duration)
        }

        if (cursor < totalDuration - 0.02) {
          const tailPath = join(tempDir, `segment-${segmentIndex++}-tail.mp4`)
          await ensureVideoSegment(ffmpeg, null, tailPath, totalDuration - cursor, width, height, fps)
          segmentPaths.push(tailPath)
        }

        if (segmentPaths.length === 0) {
          const blankPath = join(tempDir, 'segment-blank.mp4')
          await ensureVideoSegment(ffmpeg, null, blankPath, totalDuration, width, height, fps)
          segmentPaths.push(blankPath)
        }

        const concatListPath = join(tempDir, 'segments.txt')
        writeFileSync(concatListPath, `${segmentPaths.map((path) => toSafeConcatLine(path)).join('\n')}\n`, 'utf-8')

        const timelineVideoPath = join(tempDir, 'timeline-video.mp4')
        await execFileAsync(ffmpeg, [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatListPath,
          '-r', String(fps),
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-an',
          '-y',
          timelineVideoPath,
        ], { timeout: 600_000 })

        let mixedAudioPath: string | null = null
        if (validAudioClips.length > 0) {
          mixedAudioPath = join(tempDir, 'timeline-audio.m4a')
          const inputArgs: string[] = []
          const filterParts: string[] = []
          const mixLabels: string[] = []

          validAudioClips.forEach((clip, index) => {
            const duration = clipDurationSeconds(clip, totalDuration)
            const delayMs = Math.max(0, Math.round(clip.start * 1000))
            inputArgs.push('-i', clip.source)
            filterParts.push(
              `[${index}:a]atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[a${index}]`
            )
            mixLabels.push(`[a${index}]`)
          })

          const filter = `${filterParts.join(';')};${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0[aout]`
          await execFileAsync(ffmpeg, [
            ...inputArgs,
            '-filter_complex', filter,
            '-map', '[aout]',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-y',
            mixedAudioPath,
          ], { timeout: 600_000 })
        }

        const hasSubtitleHints = subtitleClips.length > 0
        if (mixedAudioPath && existsSync(mixedAudioPath)) {
          await execFileAsync(ffmpeg, [
            '-i', timelineVideoPath,
            '-i', mixedAudioPath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-shortest',
            '-movflags', '+faststart',
            '-y',
            output,
          ], { timeout: 600_000 })
        } else {
          await execFileAsync(ffmpeg, [
            '-i', timelineVideoPath,
            '-c:v', 'copy',
            '-an',
            '-movflags', '+faststart',
            '-y',
            output,
          ], { timeout: 600_000 })
        }

        if (!existsSync(output)) {
          return { success: false, error: 'Timeline render failed — output file not created', errorCode: 'RENDER_FAILED' }
        }

        return {
          success: true,
          path: output,
          warning: hasSubtitleHints ? 'Subtitle burning is not enabled in FFmpeg fallback yet.' : undefined,
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'RENDER_ERROR' }
    }
  })
}
