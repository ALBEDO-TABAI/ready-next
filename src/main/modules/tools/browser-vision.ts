import { type AIModelConfig, getProviderDef, normalizeAIConfig, resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { parseJsonOrEventStreamResponse } from '../openai-responses'
import { SettingsRepository } from '../repositories/settings-repository'

export interface BrowserViewportAnalysisTarget {
  kind: 'text_button' | 'icon_button' | 'upload_launcher' | 'send_button' | 'close_button' | 'back_button' | 'prompt_input'
  label: string
  x: number
  y: number
  confidence: number
  reason: string
}

export interface BrowserViewportAnalysis {
  recommendedAction: 'upload' | 'send' | 'close' | 'back' | 'input' | 'none'
  summary: string
  targets: BrowserViewportAnalysisTarget[]
  rawText?: string
}

async function readAIConfig(): Promise<AIModelConfig | null> {
  try {
    const repository = new SettingsRepository()
    const raw = await repository.getSetting('ai_model_config')
    if (!raw) return null
    return normalizeAIConfig(JSON.parse(raw) as AIModelConfig)
  } catch {
    return null
  }
}

function supportsVision(config: AIModelConfig | null): boolean {
  if (!config?.apiKey || !config.baseUrl || !config.model) return false
  const capabilities = resolveAIConfigCapabilities(config)
  return !!capabilities?.supportsVision
}

// D14 后续（2026-07-04 R1 实锚）：gpt-5.5 走 openai-compatible 中转被保守
// 默认判成无视觉，模型拿到裸 reason 码后原地挣扎 4 分钟、用户全程不知道
// 设置页有开关。拒绝时必须给出可执行的救济指引：说清是显式关闭还是中转
// 保守默认，指到设置页的开关。
export function buildNoVisionRemediation(config: AIModelConfig | null): string {
  const model = config?.model || '当前模型'
  if (config?.visionMode === 'off') {
    return `当前配置（${model}）在设置里显式关闭了「网页视觉」。视觉分析不可用是预期行为；请改用 read_page_map / click_text 等非视觉通道完成任务，不要重试本工具。如需视觉，请用户在 设置 → AI 模型 → 该配置 → 网页视觉 改为「强制开启」。`
  }
  return `当前配置（${model}）经 openai-compatible 中转接入，能力层保守默认不假定中转透传图片，视觉被判定为关闭。请改用 read_page_map / click_text 等非视觉通道完成任务，不要重试本工具；若用户确认该中转支持图像输入，可在 设置 → AI 模型 → 该配置 → 网页视觉 改为「强制开启」。`
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

function normalizeJsonText(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  return raw.trim()
}

function buildAnthropicLikeHeaders(config: AIModelConfig, baseUrl: string): Record<string, string> {
  const provider = getProviderDef(config.provider, baseUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
  if ((provider?.id === 'anthropic' && !config.agentProtocol) || baseUrl.includes('api.kimi.com/coding')) {
    headers['x-api-key'] = config.apiKey
    return headers
  }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)
  return headers
}

function parseAnalysis(raw: string): BrowserViewportAnalysis | null {
  const normalized = normalizeJsonText(raw)
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>
    const rawTargets = Array.isArray(parsed.targets) ? parsed.targets : []
    const targets = rawTargets.length > 0
      ? rawTargets
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const record = item as Record<string, unknown>
          const x = Number(record.x)
          const y = Number(record.y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null
          return {
            kind: typeof record.kind === 'string'
              ? record.kind as BrowserViewportAnalysisTarget['kind']
              : 'icon_button',
            label: String(record.label || ''),
            x: Math.max(0, Math.min(999, Math.round(x))),
            y: Math.max(0, Math.min(999, Math.round(y))),
            confidence: Math.max(0, Math.min(1, Number(record.confidence || 0))),
            reason: String(record.reason || ''),
          }
        })
        .filter(Boolean) as BrowserViewportAnalysisTarget[]
      : []
    return {
      recommendedAction: typeof parsed.recommendedAction === 'string'
        ? parsed.recommendedAction as BrowserViewportAnalysis['recommendedAction']
        : 'none',
      summary: String(parsed.summary || ''),
      targets,
      rawText: raw,
    }
  } catch {
    return null
  }
}

async function runVisionCompletion(
  config: AIModelConfig,
  prompt: string,
  base64Png: string,
): Promise<string> {
  const capabilities = resolveAIConfigCapabilities(config)
  const baseUrl = capabilities?.baseUrl || config.baseUrl.replace(/\/+$/, '')
  const provider = capabilities?.provider || getProviderDef(config.provider, baseUrl)

  if (capabilities?.agentProtocol === 'anthropic') {
    const headers = buildAnthropicLikeHeaders(config, baseUrl)
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        max_tokens: 900,
        temperature: 0.1,
        system: '你是网页界面视觉分析助手。严格输出 JSON，不要带解释。',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: base64Png,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!resp.ok) return ''
    return extractAnthropicText(await resp.json())
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const authHeader = provider?.authHeader || 'Authorization'
  const authPrefix = provider?.authPrefix ?? 'Bearer '
  headers[authHeader] = `${authPrefix}${config.apiKey}`
  if (provider?.extraHeaders) Object.assign(headers, provider.extraHeaders)

  const wireApi = capabilities?.wireApi || config.wireApi || provider?.wireApi || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions')
  if (wireApi === 'responses') {
    const resp = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        instructions: '你是网页界面视觉分析助手。严格输出 JSON，不要带解释。',
        reasoning: { effort: capabilities?.reasoningEffort || config.reasoningEffort || provider?.defaultReasoningEffort || 'high' },
        stream: false,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_image', image_url: `data:image/png;base64,${base64Png}` },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!resp.ok) return ''
    return extractResponsesText(await parseJsonOrEventStreamResponse(resp))
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        {
          role: 'system',
          content: '你是网页界面视觉分析助手。严格输出 JSON，不要带解释。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${base64Png}`,
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!resp.ok) return ''
  return extractOpenAIText(await resp.json())
}

export async function analyzeViewportWithVision(options: {
  action: 'upload' | 'send' | 'close' | 'back' | 'input'
  title?: string
  url?: string
  screenshotBase64: string
  domCandidates?: unknown[]
}): Promise<{ ok: boolean; analysis?: BrowserViewportAnalysis; reason?: string; rawText?: string; remediation?: string }> {
  const config = await readAIConfig()
  if (!supportsVision(config)) {
    return {
      ok: false,
      reason: 'current_provider_has_no_vision_support',
      remediation: buildNoVisionRemediation(config),
    }
  }

  const prompt = [
    '分析这张网页截图，找出最适合执行当前动作的候选控件。',
    `当前动作: ${options.action}`,
    options.title ? `页面标题: ${options.title}` : '',
    options.url ? `页面 URL: ${options.url}` : '',
    Array.isArray(options.domCandidates) && options.domCandidates.length > 0
      ? `DOM 候选（仅供参考）: ${JSON.stringify(options.domCandidates).slice(0, 2800)}`
      : '',
    '',
    '请只输出 JSON，结构必须是：',
    '{"recommendedAction":"upload|send|close|back|input|none","summary":"...","targets":[{"kind":"text_button|icon_button|upload_launcher|send_button|close_button|back_button|prompt_input","label":"...","x":0-999,"y":0-999,"confidence":0-1,"reason":"..."}]}',
    '要求：',
    '- x/y 使用 0-999 归一化坐标',
    '- 最多返回 5 个候选',
    '- 如果没有把握，recommendedAction 填 none，targets 返回空数组',
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const rawText = await runVisionCompletion(config!, prompt, options.screenshotBase64)
    if (!rawText) return { ok: false, reason: 'vision_completion_failed' }
    const parsed = parseAnalysis(rawText)
    if (!parsed) {
      return { ok: false, reason: 'vision_json_parse_failed', rawText }
    }
    return { ok: true, analysis: parsed, rawText }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
