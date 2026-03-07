import { getDatabase } from '../database'
import { type AIModelConfig, getProviderDef, normalizeAIConfig, resolveAIConfigCapabilities } from '../../../shared/ai-providers'
import { parseJsonOrEventStreamResponse } from '../openai-responses'

interface CompletionRequest {
  system: string
  user: string
  maxTokens: number
}

interface CopySummaryInput {
  title: string
  link: string
  source?: string
  publishedAt?: string
  summary?: string
  extractedText: string
}

interface VisualSummaryInput {
  title: string
  link: string
  source?: string
  pipelineSummary: string
}

function clipText(input: string, maxChars: number): string {
  const text = input.replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

function readAIConfig(): AIModelConfig | null {
  try {
    const raw = getDatabase().getSetting('ai_model_config')
    if (!raw) return null
    return normalizeAIConfig(JSON.parse(raw) as AIModelConfig)
  } catch {
    return null
  }
}

function extractOpenAIText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices
  const content = choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (!part || typeof part !== 'object') return ''
        return typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''
      })
      .filter(Boolean)
    return textParts.join('\n').trim()
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
  if (provider?.extraHeaders) {
    Object.assign(headers, provider.extraHeaders)
  }
  return headers
}

function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const content = (payload as { content?: Array<{ type?: string; text?: string }> }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() || '')
    .filter(Boolean)
    .join('\n')
}

export class RSSSubagentRunner {
  getVisualAnalyzerEnv(): Record<string, string> | undefined {
    const config = readAIConfig()
    if (!config?.apiKey) return undefined
    const baseUrl = (config.baseUrl || '').trim()
    return {
      VIDEO_ANALYZER_API_KEY: config.apiKey,
      VIDEO_ANALYZER_BASE_URL: baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai',
      VIDEO_ANALYZER_MODEL: config.model || 'gemini-2.0-flash',
    }
  }

  async summarizeCopy(input: CopySummaryInput): Promise<string> {
    const user = [
      `标题: ${input.title}`,
      `链接: ${input.link}`,
      input.source ? `来源账号: ${input.source}` : '',
      input.publishedAt ? `发布时间: ${input.publishedAt}` : '',
      input.summary ? `原始摘要: ${clipText(input.summary, 600)}` : '',
      '',
      '正文或转录文本:',
      clipText(input.extractedText, 8_000),
    ]
      .filter(Boolean)
      .join('\n')

    const text = await this.complete({
      system:
        [
          '你是视频文案分析助手，严格对齐 video-copy-analyzer 的三维分析框架。',
          '只输出 Markdown；保留事实，不虚构，不擅自重写原文内容。',
          '优先做结构化分析与优化建议，不做大段改写。',
        ].join(''),
      user:
        [
          `${user}`,
          '',
          '请严格按以下标题输出（不可改名、不可缺失）：',
          '## 一、TextContent Analysis 视角',
          '- 叙事结构分析（开场/发展/高潮/转折/结尾）',
          '- 叙事声音分析（基调/节奏/金句）',
          '- 修辞手法识别（比喻/反转/呼应/隐喻）',
          '- 词库提取（关键词 8-15 个）',
          '',
          '## 二、Viral-Abstract-Script 视角',
          '- Viral-5D 诊断（Hook/Emotion/爆点/CTA/社交货币，分别 1-5 星并简评）',
          '- 风格定位（2-4 个标签）',
          '- 爆款潜力评估（完播率/互动率/转发率）',
          '- 优化建议（1-3 条，必须可执行）',
          '',
          '## 三、Brainstorming 视角',
          '- 核心价值拆解',
          '- 创意方向探索（2-3 个）',
          '- 增量验证点（2-4 个可测试项）',
          '',
          '要求：',
          '- 全文中文；',
          '- 保持原意，不做改写式重写；',
          '- 每段简洁，避免空泛套话。',
        ].join('\n'),
      maxTokens: 900,
    })
    if (text) return text

    return [
      `# 文案分析报告`,
      '',
      `- 标题：${input.title}`,
      `- 链接：${input.link}`,
      '',
      '## 一、TextContent Analysis 视角',
      '- 叙事结构分析：自动分析降级，建议人工复核结构分段。',
      '- 叙事声音分析：语料提取完成，但模型总结不可用。',
      '- 修辞手法识别：请参考原始文本进行二次判断。',
      `- 词库提取：${clipText(input.extractedText, 260)}`,
      '',
      '## 二、Viral-Abstract-Script 视角',
      '- Viral-5D 诊断：自动诊断失败（降级）。',
      '- 风格定位：待补充。',
      '- 爆款潜力评估：待补充。',
      '- 优化建议：先补齐上游分析结果后再生成。',
      '',
      '## 三、Brainstorming 视角',
      '- 核心价值拆解：待补充。',
      '- 创意方向探索：待补充。',
      '- 增量验证点：待补充。',
      '',
      '> 备注：自动分析失败，已降级为脚本提取结果。',
      '',
    ].join('\n')
  }

  async summarizeVisual(input: VisualSummaryInput): Promise<string> {
    const user = [
      `标题: ${input.title}`,
      `链接: ${input.link}`,
      input.source ? `来源账号: ${input.source}` : '',
      '',
      '视觉分析脚本输出：',
      clipText(input.pipelineSummary, 6_000),
    ]
      .filter(Boolean)
      .join('\n')

    const text = await this.complete({
      system:
        '你是短视频视觉分析助手。只输出 Markdown，聚焦镜头质量、叙事节奏、剪辑建议和优先改进项。',
      user:
        `${user}\n\n请输出：\n1) 综合判断\n2) 镜头质量分层(MUST KEEP/USABLE/DISCARD)\n3) 剪辑建议(按优先级)\n4) 可复用视觉模板\n5) 一段给创作者的执行清单`,
      maxTokens: 700,
    })
    if (text) return text

    return [
      '# 视觉分析总结',
      '',
      `- 标题：${input.title}`,
      `- 链接：${input.link}`,
      '',
      '## 结果',
      '- 自动总结失败，已保留脚本原始结果，请查看同目录分析文件。',
      '',
    ].join('\n')
  }

  private async complete(request: CompletionRequest): Promise<string> {
    const config = readAIConfig()
    if (!config?.apiKey || !config.baseUrl || !config.model) return ''

    const capabilities = resolveAIConfigCapabilities(config)
    const baseUrl = capabilities?.baseUrl || config.baseUrl.replace(/\/+$/, '')

    try {
      if (capabilities?.agentProtocol === 'anthropic') {
        const headers = buildAnthropicLikeHeaders(config, baseUrl)
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxTokens,
            temperature: 0.2,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
          }),
          signal: AbortSignal.timeout(40_000),
        })
        if (!resp.ok) return ''
        const json = await resp.json()
        return extractAnthropicText(json)
      }

      const provider = capabilities?.provider || getProviderDef(config.provider, baseUrl)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      const authHeader = provider?.authHeader || 'Authorization'
      const authPrefix = provider?.authPrefix ?? 'Bearer '
      headers[authHeader] = `${authPrefix}${config.apiKey}`
      if (provider?.extraHeaders) {
        Object.assign(headers, provider.extraHeaders)
      }

      const wireApi = capabilities?.wireApi || config.wireApi || provider?.wireApi || (baseUrl.includes('/codex/v1') ? 'responses' : 'chat/completions')
      if (wireApi === 'responses') {
        const resp = await fetch(`${baseUrl}/responses`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: config.model,
            instructions: request.system,
            reasoning: { effort: capabilities?.reasoningEffort || config.reasoningEffort || provider?.defaultReasoningEffort || 'high' },
            stream: false,
            input: [{ role: 'user', content: [{ type: 'input_text', text: request.user }] }],
            max_output_tokens: request.maxTokens,
          }),
          signal: AbortSignal.timeout(40_000),
        })
        if (!resp.ok) return ''
        const json = await parseJsonOrEventStreamResponse(resp)
        return extractResponsesText(json)
      }

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          max_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
        }),
        signal: AbortSignal.timeout(40_000),
      })
      if (!resp.ok) return ''
      const json = await resp.json()
      return extractOpenAIText(json)
    } catch {
      return ''
    }
  }
}

export const rssSubagentRunner = new RSSSubagentRunner()
