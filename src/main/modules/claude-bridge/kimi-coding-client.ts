import { randomUUID } from 'crypto'
import { Buffer } from 'node:buffer'

import type { AIModelConfig } from '../../../shared/ai-providers'
import { parseJsonResponse } from '../openai-responses'
import { annotateFallbackResult, type ExecutionFallbackInfo, resolveFallbackPlan } from './execution-fallback-policy'
import { sanitizeOpenAICompatibleMessageHistory } from './openai-history-sanitization'
import { resolveRegisteredToolNamesLazily } from './tool-registry-bridge'
import { extractOpenAIMessageText } from './openai-message-text'
import { buildProviderHttpError, parseRetryAfterHeader } from './provider-terminal-error'

export interface KimiCodingSessionLike {
  messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string | Array<Record<string, unknown>> }>
}

export class KimiCodingClient {
  constructor(private readonly deps: {
    fetchWithTimeout: (
      url: string,
      init: RequestInit,
      signal: AbortSignal,
      label: string,
      timeoutMs?: number,
    ) => Promise<Response>
    log: (message: string) => void
  }) {}

  async requestSimple(params: {
    session: KimiCodingSessionLike
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    hasVideoInputs?: boolean
    buildVideoFrameFallbackMessages?: () => Promise<KimiCodingSessionLike['messages']>
    assignFallbackMessages?: (messages: KimiCodingSessionLike['messages']) => void
    fallbackToAnthropic?: (
      params: { messagesOverride?: KimiCodingSessionLike['messages'] },
    ) => Promise<{ text: string; fallback?: ExecutionFallbackInfo }>
    timeoutMs?: number
  }): Promise<{ text: string; fallback?: ExecutionFallbackInfo }> {
    try {
      return { text: await this.requestSimpleOnce(params) }
    } catch (error) {
      const fallbackPlan = resolveFallbackPlan({
        mode: 'kimi_coding',
        error,
      })
      if (!fallbackPlan.shouldRetry) {
        throw error
      }
      if (!params.fallbackToAnthropic) {
        this.deps.log('Kimi Coding request failed, retrying once with shared fallback policy')
        return annotateFallbackResult({
          text: await this.requestSimpleOnce(params),
        }, {
          kind: 'kimi_coding_retry',
          attempts: 1,
        })
      }
      this.deps.log('Kimi coding OpenAI path failed, retrying with Anthropic-compatible path through shared fallback policy')
      let messagesOverride: KimiCodingSessionLike['messages'] | undefined
      if (params.hasVideoInputs && params.buildVideoFrameFallbackMessages) {
        messagesOverride = await params.buildVideoFrameFallbackMessages()
        params.assignFallbackMessages?.(messagesOverride)
      }
      const fallbackResponse = await params.fallbackToAnthropic({ messagesOverride })
      return annotateFallbackResult({
        text: fallbackResponse.text,
      }, {
        kind: 'kimi_coding_retry',
        attempts: 1,
      })
    }
  }

  async serializeMessages(
    messages: KimiCodingSessionLike['messages'],
    v1Base: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Array<Record<string, unknown>>> {
    const serialized: Array<Record<string, unknown>> = []
    const sanitizedMessages = sanitizeOpenAICompatibleMessageHistory(
      messages,
      { validToolNames: resolveRegisteredToolNamesLazily() },
    ) as KimiCodingSessionLike['messages']

    for (const msg of sanitizedMessages) {
      const raw = msg as unknown as Record<string, unknown>
      const role = typeof raw.role === 'string' ? raw.role : 'user'

      if (!Array.isArray(msg.content)) {
        serialized.push({
          ...raw,
          role,
          content: msg.content,
        })
        continue
      }

      const contentParts: Array<Record<string, unknown>> = []
      const uploadedVideoUrls: string[] = []
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue

        if (block.type === 'text') {
          contentParts.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' })
          continue
        }
        if (block.type === 'image' && block.source) {
          const source = block.source as { media_type?: string; data?: string }
          if (typeof source.data === 'string' && source.data.length > 0) {
            const mediaType = source.media_type || 'image/png'
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${source.data}` },
            })
          }
          continue
        }
        if (block.type === 'video' && block.source) {
          const source = block.source as Record<string, unknown>
          let videoUrl = ''
          if (source.type === 'url' && typeof source.url === 'string' && source.url.startsWith('ms://')) {
            videoUrl = source.url
          } else if (typeof source.data === 'string' && source.data.length > 0) {
            const mediaType = typeof source.media_type === 'string' ? source.media_type : 'video/mp4'
            videoUrl = await this.uploadVideoToFiles(v1Base, apiKey, source.data, mediaType, signal)
            source.type = 'url'
            source.url = videoUrl
            delete source.data
          }

          if (videoUrl) {
            uploadedVideoUrls.push(videoUrl)
          } else {
            contentParts.push({ type: 'text', text: '[视频附件已接收，但上传失败。]' })
          }
          continue
        }

        contentParts.push(block)
      }

      serialized.push({
        ...raw,
        role,
        content: contentParts.length > 0 ? contentParts : [{ type: 'text', text: '' }],
      })

      for (const videoUrl of uploadedVideoUrls) {
        const toolCallId = `tool_${randomUUID().replace(/-/g, '').slice(0, 24)}`
        serialized.push({
          role: 'assistant',
          content: '我先读取视频附件。',
          reasoning_content: '需要先读取用户上传的视频附件并理解其内容。',
          tool_calls: [{
            id: toolCallId,
            type: 'function',
            function: {
              name: 'ReadMediaFile',
              arguments: JSON.stringify({ video_url: videoUrl }),
            },
          }],
        })
        serialized.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: [
            { type: 'text', text: '<video path="upload.mp4">' },
            { type: 'video_url', video_url: { url: videoUrl } },
            { type: 'text', text: '</video>' },
          ],
        })
      }
    }

    return serialized
  }

  async uploadVideoToFiles(
    v1Base: string,
    apiKey: string,
    videoBase64: string,
    mediaType: string,
    signal: AbortSignal,
  ): Promise<string> {
    const url = `${v1Base}/files`
    const binary = Buffer.from(videoBase64, 'base64')
    if (binary.length === 0) {
      throw new Error('video payload is empty')
    }

    const filename = `upload.${this.extensionFromVideoMediaType(mediaType)}`
    const boundary = `----ready-${randomUUID().replace(/-/g, '')}`
    const prefix = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="purpose"\r\n\r\nvideo\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mediaType}\r\n\r\n`,
      'utf-8',
    )
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8')
    const body = Buffer.concat([prefix, binary, suffix])

    this.deps.log(`POST ${url}, purpose=video, bytes=${binary.length}`)
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': this.getUserAgent(),
      },
      body,
      signal,
    }, signal, 'kimi file upload')

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw buildProviderHttpError({
        httpStatus: resp.status,
        errorBody: errBody,
        messagePrefix: 'upload video failed:',
        retryAfterSeconds: parseRetryAfterHeader(resp.headers.get('retry-after')),
      })
    }

    const json = await parseJsonResponse(resp, { requestUrl: url }) as { id?: string }
    if (!json.id) throw new Error('upload video failed: missing file id')
    const msUrl = `ms://${json.id}`
    this.deps.log(`uploaded video to kimi files: ${msUrl}`)
    return msUrl
  }

  getUserAgent(): string {
    return process.env.READY_KIMI_CODING_USER_AGENT?.trim() || 'KimiCLI/1.14.0'
  }

  resolveV1Base(baseUrl: string): string {
    const normalized = baseUrl.replace(/\/+$/, '')
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
  }

  private resolveModel(config: AIModelConfig, baseUrl: string): string {
    const rawModel = (config.model || '').trim()
    if (rawModel && rawModel !== '__custom__' && rawModel !== 'custom') {
      return rawModel
    }
    if (baseUrl.replace(/\/+$/, '').includes('api.kimi.com/coding')) {
      return 'kimi-for-coding'
    }
    return 'claude-haiku-3-5-20241022'
  }

  private extensionFromVideoMediaType(mediaType: string): string {
    const value = mediaType.toLowerCase()
    if (value.includes('webm')) return 'webm'
    if (value.includes('quicktime')) return 'mov'
    if (value.includes('x-matroska') || value.includes('mkv')) return 'mkv'
    if (value.includes('x-msvideo') || value.includes('avi')) return 'avi'
    if (value.includes('x-m4v') || value.includes('m4v')) return 'm4v'
    return 'mp4'
  }

  private async requestSimpleOnce(params: {
    session: KimiCodingSessionLike
    config: AIModelConfig
    baseUrl: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<string> {
    const v1Base = this.resolveV1Base(params.baseUrl)
    const url = `${v1Base}/chat/completions`
    const model = this.resolveModel(params.config, params.baseUrl)
    const messages = await this.serializeMessages(params.session.messages, v1Base, params.config.apiKey, params.signal)

    this.deps.log(`POST ${url}, model=${model}, stream=false, kimiCoding=true`)
    const resp = await this.deps.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.config.apiKey}`,
        'x-api-key': params.config.apiKey,
        'User-Agent': this.getUserAgent(),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: params.signal,
    }, params.signal, 'kimi coding simple', params.timeoutMs)

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw buildProviderHttpError({
        httpStatus: resp.status,
        errorBody: errBody,
        retryAfterSeconds: parseRetryAfterHeader(resp.headers.get('retry-after')),
      })
    }

    const json = await parseJsonResponse(resp, { requestUrl: url }) as {
      choices?: Array<{ message?: { content?: string | Array<Record<string, unknown>> } }>
    }
    return extractOpenAIMessageText(json.choices?.[0]?.message?.content)
  }
}
