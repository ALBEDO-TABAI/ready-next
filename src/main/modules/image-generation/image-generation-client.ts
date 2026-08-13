import { basename } from 'path'
import type { RuntimeExternalServiceConfig } from '../../../shared/external-services'
import {
  IMAGE_GENERATION_MAX_OUTPUT_BYTES,
  IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
  type ImageGenerationProtocol,
} from '../../../shared/image-generation'

const MAX_JSON_RESPONSE_BYTES = Math.ceil(IMAGE_GENERATION_MAX_OUTPUT_BYTES * 1.5) + 1024 * 1024
const GENERATED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
])

export interface ImageGenerationClientConfig {
  serviceId: string
  protocol: ImageGenerationProtocol
  baseUrl: string
  apiKey: string
  model: string
  size?: string
  aspectRatio?: string
  imageSize?: string
}

export interface ImageGenerationReferenceInput {
  name: string
  mimeType: string
  bytes: Uint8Array
}

export interface ImageGenerationClientRequest {
  config: ImageGenerationClientConfig
  prompt: string
  references?: ImageGenerationReferenceInput[]
  size?: string
  aspectRatio?: string
  imageSize?: string
  signal?: AbortSignal
}

export interface GeneratedImageBytes {
  bytes: Uint8Array
  mimeType: string
  extension: string
}

export interface ImageGenerationClientDependencies {
  fetch?: typeof fetch
  timeoutMs?: number
}

function optionString(options: Record<string, unknown>, key: string): string {
  const value = options[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function resolveImageGenerationClientConfig(
  service: RuntimeExternalServiceConfig,
): ImageGenerationClientConfig {
  if (service.kind !== 'image-generation') {
    throw new Error('所选服务不是 AI 生图服务')
  }
  if (!service.enabled) throw new Error('AI 生图服务未启用')
  const baseUrl = String(service.baseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(service.secrets.apiKey || '').trim()
  const model = optionString(service.options, 'model')
  const protocol = optionString(service.options, 'protocol')
  if (!baseUrl) throw new Error('缺少服务地址')
  if (!apiKey) throw new Error('缺少 API Key')
  if (!model) throw new Error('缺少模型名')
  if (protocol !== 'openai-images' && protocol !== 'gemini-generate-content') {
    throw new Error('生图协议配置无效')
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('服务地址格式无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('服务地址必须是 http 或 https')
  }
  return {
    serviceId: service.id,
    protocol,
    baseUrl,
    apiKey,
    model,
    size: optionString(service.options, 'size') || undefined,
    aspectRatio: optionString(service.options, 'aspectRatio') || undefined,
    imageSize: optionString(service.options, 'imageSize') || undefined,
  }
}

function buildVersionedEndpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/v\d+(?:beta)?$/i.test(base)) return `${base}/${suffix.replace(/^\/+/, '')}`
  return `${base}/v1/${suffix.replace(/^\/+/, '')}`
}

export function buildImageGenerationEndpoint(
  config: Pick<ImageGenerationClientConfig, 'baseUrl' | 'protocol' | 'model'>,
  hasReferences: boolean,
): string {
  if (config.protocol === 'openai-images') {
    return buildVersionedEndpoint(config.baseUrl, hasReferences ? 'images/edits' : 'images/generations')
  }
  return buildVersionedEndpoint(config.baseUrl, `models/${encodeURIComponent(config.model)}:generateContent`)
}

function sanitizeUploadName(value: string, index: number): string {
  // eslint-disable-next-line no-control-regex -- normalize an untrusted upload filename before multipart use
  const name = basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-').trim()
  return name || `reference-${index + 1}.png`
}

function contentLengthExceeds(response: Response, maxBytes: number): boolean {
  const raw = response.headers.get('content-length')
  if (!raw) return false
  const value = Number(raw)
  return Number.isFinite(value) && value > maxBytes
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (contentLengthExceeds(response, maxBytes)) throw new Error('服务返回内容过大')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > maxBytes) throw new Error('服务返回内容过大')
  return bytes
}

function parseJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid object')
    return value as Record<string, unknown>
  } catch {
    throw new Error('服务返回了无法识别的数据')
  }
}

function upstreamErrorMessage(body: Record<string, unknown>): string | null {
  const error = body.error && typeof body.error === 'object'
    ? body.error as Record<string, unknown>
    : null
  const raw = typeof error?.message === 'string'
    ? error.message
    : typeof body.message === 'string'
      ? body.message
      : ''
  const normalized = raw.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 280) : null
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = parseJson(await readLimitedBody(response, MAX_JSON_RESPONSE_BYTES))
  if (!response.ok) {
    const detail = upstreamErrorMessage(body)
    throw new Error(`生图服务请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`)
  }
  return body
}

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12
    && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF'
    && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6) {
    const signature = new TextDecoder().decode(bytes.slice(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4, 12)).includes('ftypavif')) return 'image/avif'
  return null
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/avif') return 'avif'
  return 'png'
}

function validateGeneratedBytes(bytes: Uint8Array, declaredMimeType?: string): GeneratedImageBytes {
  if (bytes.byteLength === 0) throw new Error('生图服务没有返回图片内容')
  if (bytes.byteLength > IMAGE_GENERATION_MAX_OUTPUT_BYTES) throw new Error('生成图片超过 32 MB 上限')
  const detected = detectImageMime(bytes)
  const declared = String(declaredMimeType || '').split(';')[0].trim().toLowerCase()
  const mimeType = detected || (GENERATED_IMAGE_MIME_TYPES.has(declared) ? declared : '')
  if (!mimeType || !GENERATED_IMAGE_MIME_TYPES.has(mimeType) || !detected) {
    throw new Error('服务返回的内容不是受支持的图片')
  }
  return { bytes, mimeType, extension: extensionForMime(mimeType) }
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim().replace(/^data:[^;]+;base64,/, '')
  if (!normalized) throw new Error('生图服务返回了空图片')
  try {
    return new Uint8Array(Buffer.from(normalized, 'base64'))
  } catch {
    throw new Error('生图服务返回的图片编码无效')
  }
}

async function downloadReturnedImage(
  urlValue: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<GeneratedImageBytes> {
  let url: URL
  try {
    url = new URL(urlValue)
  } catch {
    throw new Error('生图服务返回了无效图片地址')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('生图服务返回了不受支持的图片地址')
  }
  const response = await fetchImpl(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`下载生成图片失败（HTTP ${response.status}）`)
  const bytes = await readLimitedBody(response, IMAGE_GENERATION_MAX_OUTPUT_BYTES)
  return validateGeneratedBytes(bytes, response.headers.get('content-type') || undefined)
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null
  const first = value.find((item) => item && typeof item === 'object' && !Array.isArray(item))
  return first ? first as Record<string, unknown> : null
}

async function requestOpenAIImage(
  request: ImageGenerationClientRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<GeneratedImageBytes> {
  const references = request.references || []
  const url = buildImageGenerationEndpoint(request.config, references.length > 0)
  const headers: Record<string, string> = { Authorization: `Bearer ${request.config.apiKey}` }
  let body: BodyInit
  if (references.length > 0) {
    const form = new FormData()
    form.append('model', request.config.model)
    form.append('prompt', request.prompt)
    form.append('n', '1')
    form.append('size', request.size || request.config.size || '1024x1024')
    references.forEach((reference, index) => {
      form.append(
        'image[]',
        new Blob([Uint8Array.from(reference.bytes).buffer], { type: reference.mimeType }),
        sanitizeUploadName(reference.name, index),
      )
    })
    body = form
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({
      model: request.config.model,
      prompt: request.prompt,
      n: 1,
      size: request.size || request.config.size || '1024x1024',
    })
  }
  const response = await fetchImpl(url, { method: 'POST', headers, body, signal })
  const json = await readJsonResponse(response)
  const image = firstRecord(json.data)
  if (!image) throw new Error('生图服务没有返回图片')
  const base64 = typeof image.b64_json === 'string'
    ? image.b64_json
    : typeof image.b64Json === 'string'
      ? image.b64Json
      : ''
  const declaredMime = typeof image.mime_type === 'string'
    ? image.mime_type
    : typeof image.mimeType === 'string'
      ? image.mimeType
      : 'image/png'
  if (base64) return validateGeneratedBytes(decodeBase64(base64), declaredMime)
  if (typeof image.url === 'string' && image.url.trim()) {
    return downloadReturnedImage(image.url.trim(), fetchImpl, signal)
  }
  throw new Error('生图服务响应中没有可用图片')
}

function findGeminiInlineImage(body: Record<string, unknown>): { data: string; mimeType: string } | null {
  const candidate = firstRecord(body.candidates)
  const content = candidate?.content && typeof candidate.content === 'object'
    ? candidate.content as Record<string, unknown>
    : null
  if (!Array.isArray(content?.parts)) return null
  for (const rawPart of content.parts) {
    if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) continue
    const part = rawPart as Record<string, unknown>
    const inline = part.inlineData && typeof part.inlineData === 'object'
      ? part.inlineData as Record<string, unknown>
      : part.inline_data && typeof part.inline_data === 'object'
        ? part.inline_data as Record<string, unknown>
        : null
    if (inline && typeof inline.data === 'string') {
      return {
        data: inline.data,
        mimeType: typeof inline.mimeType === 'string'
          ? inline.mimeType
          : typeof inline.mime_type === 'string'
            ? inline.mime_type
            : 'image/png',
      }
    }
  }
  return null
}

async function requestGeminiImage(
  request: ImageGenerationClientRequest,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<GeneratedImageBytes> {
  const url = buildImageGenerationEndpoint(request.config, Boolean(request.references?.length))
  const parts: Array<Record<string, unknown>> = [{ text: request.prompt }]
  for (const reference of request.references || []) {
    parts.push({
      inlineData: {
        mimeType: reference.mimeType,
        data: Buffer.from(reference.bytes).toString('base64'),
      },
    })
  }
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${request.config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.4,
        topP: 0.95,
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: request.aspectRatio || request.config.aspectRatio || '1:1',
          imageSize: request.imageSize || request.config.imageSize || '1K',
        },
      },
    }),
    signal,
  })
  const json = await readJsonResponse(response)
  const inline = findGeminiInlineImage(json)
  if (!inline) throw new Error('Gemini 响应中没有图片')
  return validateGeneratedBytes(decodeBase64(inline.data), inline.mimeType)
}

function createTimedSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let didTimeout = false
  const forwardAbort = () => controller.abort(upstream?.reason)
  if (upstream?.aborted) forwardAbort()
  else upstream?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    didTimeout = true
    controller.abort(new Error('timeout'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timer)
      upstream?.removeEventListener('abort', forwardAbort)
    },
  }
}

export async function generateImageBytes(
  request: ImageGenerationClientRequest,
  dependencies: ImageGenerationClientDependencies = {},
): Promise<GeneratedImageBytes> {
  const prompt = String(request.prompt || '').trim()
  if (!prompt) throw new Error('生图提示词不能为空')
  if (prompt.length > 10_000) throw new Error('生图提示词过长')
  const fetchImpl = dependencies.fetch || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求')
  const timed = createTimedSignal(
    request.signal,
    dependencies.timeoutMs || IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
  )
  try {
    if (request.config.protocol === 'openai-images') {
      return await requestOpenAIImage({ ...request, prompt }, fetchImpl, timed.signal)
    }
    return await requestGeminiImage({ ...request, prompt }, fetchImpl, timed.signal)
  } catch (error) {
    if (timed.timedOut()) throw new Error('生图服务请求超时')
    if (request.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const aborted = new Error('生图已取消')
      aborted.name = 'AbortError'
      throw aborted
    }
    throw error
  } finally {
    timed.dispose()
  }
}
