import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import {
  type AIModelConfig,
  type AIProviderType,
  getProviderDef,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
} from '../../../shared/ai-providers'
import {
  type FastCardDescribeImageRequest,
  type FastCardDescribeImageResult,
  type FastCardTranslateRequest,
  type FastCardTranslateResult,
} from '../../../shared/fastcard'
import type { AgentSpawnContext } from '../../../shared/skill-host-contract'
import { parseJsonOrEventStreamResponse } from '../openai-responses'
import { AppSettingsRepository } from '../repositories/app-settings-repository'
import { ExternalServiceStore } from '../settings-engine/external-service-store'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const FASTCARD_AI_PROVIDERS = new Set<AIProviderType>([
  'moonshot',
  'anthropic',
  'openai',
  'fox',
  'gemini',
  'volcengine',
  'openai-compatible',
])

function readAIConfig(): AIModelConfig | null {
  try {
    return new AppSettingsRepository().getAIConfig()
  } catch {
    return null
  }
}

function hasUsableConfig(config: AIModelConfig | null): config is AIModelConfig {
  return Boolean(config?.apiKey && config.baseUrl && config.model)
}

function readVisionAgentContext(): AgentSpawnContext | null {
  try {
    return new ExternalServiceStore().buildVisionAgentContext()
  } catch {
    return null
  }
}

function normalizeFastCardProvider(provider: string): AIProviderType {
  return FASTCARD_AI_PROVIDERS.has(provider as AIProviderType)
    ? provider as AIProviderType
    : 'openai-compatible'
}

export function buildFastCardVisionConfigFromAgentContext(context: AgentSpawnContext | null): AIModelConfig | null {
  if (!context) return null
  const inputModes = Array.isArray(context.input_modes)
    ? context.input_modes.map((item) => String(item).toLowerCase())
    : []
  if (!inputModes.includes('image')) return null

  const provider = normalizeFastCardProvider(String(context.provider || '').trim())
  const model = String(context.model_id || '').trim()
  const baseUrl = String(context.base_url || '').trim()
  const apiKey = String(context.api_key || '').trim()
  if (!model || !baseUrl || !apiKey) return null

  const config: AIModelConfig = normalizeAIConfig({
    provider,
    baseUrl,
    apiKey,
    model,
    agentProtocol: context.api_kind === 'anthropic-messages' ? 'anthropic' : 'openai',
    wireApi: context.api_kind === 'openai-responses' ? 'responses' : 'chat/completions',
    visionMode: 'on',
    toolUseMode: 'auto',
    nativeVideoMode: 'auto',
  })

  if (config.agentProtocol === 'anthropic') delete config.wireApi
  return config
}

export function resolveFastCardVisionConfig(readers: {
  readAIConfig?: () => AIModelConfig | null
  readVisionAgentContext?: () => AgentSpawnContext | null
} = {}): AIModelConfig | null {
  const visionConfig = buildFastCardVisionConfigFromAgentContext(
    (readers.readVisionAgentContext || readVisionAgentContext)(),
  )
  if (hasUsableConfig(visionConfig) && resolveAIConfigCapabilities(visionConfig)?.supportsVision) {
    return visionConfig
  }
  return (readers.readAIConfig || readAIConfig)()
}

function extractOpenAIText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices
  const content = choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        return typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

function extractResponsesText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const direct = (payload as { output_text?: unknown }).output_text
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const output = Array.isArray((payload as { output?: unknown[] }).output)
    ? (payload as { output: unknown[] }).output
    : []
  const chunks: string[] = []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record.type !== 'message') continue
    const content = Array.isArray(record.content) ? record.content : []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const block = part as Record<string, unknown>
      if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
        chunks.push(block.text)
      }
    }
  }
  return chunks.join('').trim()
}

function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const content = (payload as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text?.trim() || '')
    .filter(Boolean)
    .join('\n')
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractProviderErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const record = payload as Record<string, unknown>
  const direct = stringField(record.message) || stringField(record.detail)
  if (direct) return direct
  const error = record.error
  if (typeof error === 'string') return error.trim()
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>
    return stringField(err.message) || stringField(err.detail) || stringField(err.code) || stringField(err.type)
  }
  return ''
}

function extractProviderError(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('<')) return ''
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const message = extractProviderErrorMessage(parsed)
    if (message) return message.slice(0, 220)
  } catch {
    // Plain text error bodies are common for OpenAI-compatible gateways.
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 220)
}

export function formatFastCardModelHttpError(status: number, raw = ''): string {
  const detail = extractProviderError(raw)
  const base = (() => {
    if (status === 401) return '模型服务拒绝访问：API Key 无效或已过期。'
    if (status === 402) return '模型服务返回 402：账号余额不足、额度用完，或当前套餐没有开通这个模型。'
    if (status === 403) return '模型服务拒绝访问：当前 Key 没有权限使用这个模型。'
    if (status === 404) return '模型服务找不到当前模型：请检查模型名称是否还可用。'
    if (status === 429) return '模型服务暂时限流：请求过快或额度达到上限。'
    if (status >= 500) return '模型服务暂时不可用：供应商服务器返回错误。'
    return `模型请求失败（${status}）。`
  })()
  return detail ? `${base} 供应商返回：${detail}` : base
}

async function throwModelHttpError(resp: Response): Promise<never> {
  let raw = ''
  try {
    raw = await resp.text()
  } catch {
    raw = ''
  }
  throw new Error(formatFastCardModelHttpError(resp.status, raw))
}

function buildHeaders(config: AIModelConfig, baseUrl: string): Record<string, string> {
  const provider = getProviderDef(config.provider, baseUrl)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const isAnthropic = provider?.id === 'anthropic' || config.agentProtocol === 'anthropic'
  if (isAnthropic) headers['anthropic-version'] = '2023-06-01'
  const authHeader = provider?.authHeader || (isAnthropic ? 'x-api-key' : 'Authorization')
  const authPrefix = provider?.authPrefix ?? (isAnthropic ? '' : 'Bearer ')
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
  return headers
}

async function readResponseText(resp: Response, extractor: (payload: unknown) => string): Promise<string> {
  if (!resp.ok) {
    await throwModelHttpError(resp)
  }
  const payload = await resp.json()
  return extractor(payload)
}

async function runTextCompletion(config: AIModelConfig, system: string, prompt: string, maxTokens: number): Promise<string> {
  const normalized = normalizeAIConfig(config)
  const capabilities = resolveAIConfigCapabilities(normalized)
  const baseUrl = (capabilities?.baseUrl || normalized.baseUrl).replace(/\/+$/, '')
  const provider = capabilities?.provider || getProviderDef(normalized.provider, baseUrl)
  const headers = buildHeaders(normalized, baseUrl)

  if (capabilities?.agentProtocol === 'anthropic' || normalized.agentProtocol === 'anthropic') {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        max_tokens: maxTokens,
        temperature: 0.1,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    })
    return readResponseText(resp, extractAnthropicText)
  }

  const wireApi = capabilities?.wireApi
    || normalized.wireApi
    || provider?.wireApi
    || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions')
  if (wireApi === 'responses') {
    const resp = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        instructions: system,
        reasoning: { effort: capabilities?.reasoningEffort || normalized.reasoningEffort || provider?.defaultReasoningEffort || 'low' },
        stream: false,
        input: prompt,
        max_output_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!resp.ok) await throwModelHttpError(resp)
    return extractResponsesText(await parseJsonOrEventStreamResponse(resp))
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: normalized.model,
      temperature: 0.1,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  return readResponseText(resp, extractOpenAIText)
}

async function runVisionCompletion(
  config: AIModelConfig,
  system: string,
  prompt: string,
  image: { dataUrl: string; mediaType: string; base64: string },
): Promise<string> {
  const normalized = normalizeAIConfig(config)
  const capabilities = resolveAIConfigCapabilities(normalized)
  const baseUrl = (capabilities?.baseUrl || normalized.baseUrl).replace(/\/+$/, '')
  const provider = capabilities?.provider || getProviderDef(normalized.provider, baseUrl)
  const headers = buildHeaders(normalized, baseUrl)

  if (capabilities?.agentProtocol === 'anthropic' || normalized.agentProtocol === 'anthropic') {
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        max_tokens: 700,
        temperature: 0.1,
        system,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: image.base64,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    })
    return readResponseText(resp, extractAnthropicText)
  }

  const wireApi = capabilities?.wireApi
    || normalized.wireApi
    || provider?.wireApi
    || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions')
  if (wireApi === 'responses') {
    const resp = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: normalized.model,
        instructions: system,
        reasoning: { effort: capabilities?.reasoningEffort || normalized.reasoningEffort || provider?.defaultReasoningEffort || 'low' },
        stream: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: image.dataUrl },
            ],
          },
        ],
        max_output_tokens: 700,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!resp.ok) await throwModelHttpError(resp)
    return extractResponsesText(await parseJsonOrEventStreamResponse(resp))
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: normalized.model,
      temperature: 0.1,
      max_tokens: 700,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: image.dataUrl } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  return readResponseText(resp, extractOpenAIText)
}

function readDescriptorPrompt(): string {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string }
  const roots = [
    process.cwd(),
    processWithResources.resourcesPath,
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    const candidates = [
      join(root, 'assets', 'embedded-skills', 'image-reverse-descriptor', 'SKILL.md'),
      join(root, 'embedded-skills', 'image-reverse-descriptor', 'SKILL.md'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8').slice(0, 6000)
    }
  }
  return '输出适合创作提示词使用的图片描述词。聚焦主体、场景、构图、色彩、材质、光线、风格和可复用关键词。'
}

async function loadImageAsDataUrl(imageUrl: string): Promise<{ dataUrl: string; mediaType: string; base64: string }> {
  const dataMatch = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/)
  if (dataMatch) {
    return { dataUrl: imageUrl, mediaType: dataMatch[1], base64: dataMatch[2] }
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('图片地址不可由主进程读取')
  }
  const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) })
  if (!resp.ok) throw new Error(`图片读取失败 (${resp.status})`)
  const mediaType = resp.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
  if (!mediaType.startsWith('image/')) throw new Error('目标不是可识别图片')
  const buffer = Buffer.from(await resp.arrayBuffer())
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error('图片超过 8MB 限制')
  const base64 = buffer.toString('base64')
  return { dataUrl: `data:${mediaType};base64,${base64}`, mediaType, base64 }
}

export async function translateFastCardSelection(request: FastCardTranslateRequest): Promise<FastCardTranslateResult> {
  const text = String(request.text || '').trim()
  if (!text) throw new Error('没有可翻译的文字')
  const config = readAIConfig()
  if (!hasUsableConfig(config)) throw new Error('当前没有可用的 AI 模型配置')
  const targetLanguage = request.targetLanguage || 'zh-CN'
  const prompt = [
    `目标语言：${targetLanguage}`,
    '只输出译文，保留专有名词、数字和必要格式，不添加解释。',
    '',
    text,
  ].join('\n')
  const translatedText = await runTextCompletion(config, '你是准确、克制的网页选中文本翻译器。', prompt, 1400)
  if (!translatedText) throw new Error('模型没有返回译文')
  return { originalText: text, translatedText, targetLanguage }
}

export async function describeFastCardImage(request: FastCardDescribeImageRequest): Promise<FastCardDescribeImageResult> {
  const imageUrl = String(request.imageUrl || '').trim()
  if (!imageUrl) throw new Error('没有可描述的图片')
  const config = resolveFastCardVisionConfig()
  if (!hasUsableConfig(config)) throw new Error('当前没有可用的 AI 模型配置')
  const capabilities = resolveAIConfigCapabilities(config)
  if (!capabilities?.supportsVision) throw new Error('当前模型不支持图片理解')
  const image = await loadImageAsDataUrl(imageUrl)
  const skill = readDescriptorPrompt()
  const prompt = [
    skill,
    '',
    '请直接输出 1 段中文描述词，控制在 120-220 字。不要提及网页上下文，不要输出 JSON。',
    request.source?.pageTitle ? `来源标题：${request.source.pageTitle}` : '',
  ].filter(Boolean).join('\n')
  const description = await runVisionCompletion(config, '你是 image-reverse-descriptor。', prompt, image)
  if (!description) throw new Error('模型没有返回图片描述')
  return { imageUrl, description }
}
