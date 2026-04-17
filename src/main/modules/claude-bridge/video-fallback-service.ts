import { execFile } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

import { getWhichCommand } from '../../utils/platform'

const execFileAsync = promisify(execFile)

export interface VideoFallbackMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<Record<string, unknown>>
}

export class VideoFallbackService {
  private cachedFfmpegPath: string | null = null

  constructor(private readonly deps: {
    log: (message: string) => void
  }) {}

  async buildVideoFrameFallbackMessages(messages: VideoFallbackMessage[]): Promise<VideoFallbackMessage[]> {
    const fallbackMessages: VideoFallbackMessage[] = []

    for (const message of messages) {
      if (!Array.isArray(message.content)) {
        fallbackMessages.push(message)
        continue
      }

      const convertedBlocks: Array<Record<string, unknown>> = []
      for (const block of message.content) {
        if (block?.type !== 'video') {
          convertedBlocks.push(block)
          continue
        }

        const source = block.source as { data?: string; media_type?: string } | undefined
        const data = typeof source?.data === 'string' ? source.data : ''
        const mediaType = typeof source?.media_type === 'string' ? source.media_type : 'video/mp4'
        if (!data) {
          convertedBlocks.push({ type: 'text', text: '[视频附件存在，但无法读取二进制内容。]' })
          continue
        }

        const frameImages = await this.extractFramesFromVideoBase64(data, mediaType)
        if (frameImages.length === 0) {
          convertedBlocks.push({ type: 'text', text: '[当前接口暂不可直接解析视频块，自动提帧失败。请提供视频关键信息或简述需要分析的片段。]' })
          continue
        }

        convertedBlocks.push({ type: 'text', text: `[已自动提取 ${frameImages.length} 帧供模型理解视频内容]` })
        for (const frameBase64 of frameImages) {
          convertedBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: frameBase64,
            },
          })
        }
      }

      fallbackMessages.push({ ...message, content: convertedBlocks })
    }

    return fallbackMessages
  }

  async extractFramesFromVideoBase64(videoBase64: string, mediaType: string): Promise<string[]> {
    const ffmpeg = await this.getFfmpegPath().catch(() => null)
    if (!ffmpeg) {
      this.deps.log('ffmpeg not found, cannot extract frames for video fallback')
      return []
    }

    const inputExt = this.extensionFromVideoMediaType(mediaType)
    const tempDir = mkdtempSync(join(tmpdir(), 'ready-video-fallback-'))
    const inputPath = join(tempDir, `input.${inputExt}`)
    const framePattern = join(tempDir, 'frame-%02d.jpg')
    try {
      const buffer = Buffer.from(videoBase64, 'base64')
      writeFileSync(inputPath, buffer)
      await execFileAsync(ffmpeg, [
        '-y',
        '-i', inputPath,
        '-vf', 'fps=1,scale=960:-2',
        '-frames:v', '3',
        framePattern,
      ], { timeout: 120_000 })

      const frames: string[] = []
      for (let i = 1; i <= 3; i++) {
        const framePath = join(tempDir, `frame-0${i}.jpg`)
        if (!existsSync(framePath)) continue
        const frame = readFileSync(framePath)
        frames.push(frame.toString('base64'))
      }
      return frames
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.log(`extractFramesFromVideoBase64 failed: ${msg}`)
      return []
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }

  getFfmpegPath(): Promise<string> {
    if (this.cachedFfmpegPath && existsSync(this.cachedFfmpegPath)) {
      return Promise.resolve(this.cachedFfmpegPath)
    }

    return (async () => {
      try {
        const { stdout } = await execFileAsync(getWhichCommand(), ['ffmpeg'])
        const candidate = stdout.trim().split('\n')[0]
        if (candidate && existsSync(candidate)) {
          this.cachedFfmpegPath = candidate
          return candidate
        }
      } catch {
        // ignore
      }

      const commonPaths = [
        '/opt/homebrew/bin/ffmpeg',
        '/usr/local/bin/ffmpeg',
        '/usr/bin/ffmpeg',
      ]
      for (const candidate of commonPaths) {
        if (existsSync(candidate)) {
          this.cachedFfmpegPath = candidate
          return candidate
        }
      }

      throw new Error('ffmpeg not found')
    })()
  }

  extensionFromVideoMediaType(mediaType: string): string {
    const value = mediaType.toLowerCase()
    if (value.includes('webm')) return 'webm'
    if (value.includes('quicktime')) return 'mov'
    if (value.includes('x-matroska') || value.includes('mkv')) return 'mkv'
    if (value.includes('x-msvideo') || value.includes('avi')) return 'avi'
    if (value.includes('x-m4v') || value.includes('m4v')) return 'm4v'
    return 'mp4'
  }
}
