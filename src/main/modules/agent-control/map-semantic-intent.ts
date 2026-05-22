import { z } from 'zod'
import type { IntentClassification } from './intent-classifier'

export const MAP_SEMANTIC_INTENT_CONFIDENCE_THRESHOLD = 0.6

export const MapSemanticIntentSchema = z.object({
  isMapIntent: z.boolean(),
  primaryTask: z.enum(['route', 'along_route_search', 'multi_point_order', 'none']),
  secondarySignals: z.array(z.enum(['document_output', 'research_lookup', 'browser_lookup'])).default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional(),
})

export type MapSemanticIntent = z.infer<typeof MapSemanticIntentSchema>

interface CacheEntry {
  expiresAt: number
  value: MapSemanticIntent | null
}

const CACHE_TTL_MS = 30_000
const CACHE_MAX = 200
const LLM_TIMEOUT_MS = 1500
const cache = new Map<string, CacheEntry>()

function cacheKey(prompt: string): string {
  return prompt.trim().slice(0, 2000)
}

function readCache(key: string): MapSemanticIntent | null | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt < Date.now()) {
    cache.delete(key)
    return undefined
  }
  return entry.value
}

function writeCache(key: string, value: MapSemanticIntent | null): void {
  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  })
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value
    if (!first) break
    cache.delete(first)
  }
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    // silent-catch: primary JSON parse fallback — try permissive brace-extract retry below; if that also fails, returning null is the documented "intent unparseable" signal.
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      // silent-catch: permissive brace-extract retry failed; null is the documented "intent unparseable" signal handled by the caller.
      return null
    }
  }
}

function strongKeywordFallback(prompt: string): MapSemanticIntent | null {
  const text = prompt.replace(/\s+/g, '')
  const routePattern = /从.+到.+(怎么走|路线|导航|顺路|途经|途径|最省时间|最短|最优|去)/
  const strongPattern = /(怎么走|导航|路线规划|顺路|途经|途径|最省时间|最短路线|最优行程|多点.*顺序)/
  const contextualTimingPattern = /路线.+(多久|耗时|时间)|逛完.+(多久|耗时|时间)/
  if (!routePattern.test(text) && !strongPattern.test(text) && !contextualTimingPattern.test(text)) return null
  return {
    isMapIntent: true,
    primaryTask: /多点|顺序|最省时间|最优行程/.test(text) ? 'multi_point_order' : /顺路|途经|途径/.test(text) ? 'along_route_search' : 'route',
    secondarySignals: /(文档|写成文档|markdown|信息卡|卡片)/i.test(prompt) ? ['document_output'] : [],
    confidence: 0.65,
    reason: 'llm_failed_keyword_fallback',
  }
}

function hasPotentialMapSignal(prompt: string): boolean {
  const text = prompt.replace(/\s+/g, '')
  return /(地图|导航|路线|怎么走|从.+到|附近|途经|途径|顺路|绕路|最省时间|最短|最优行程|多点|地点|路上|开车|步行|公交|地铁|打车|耗时|多久)/.test(text)
}

function buildPrompt(userPrompt: string): string {
  return [
    '你只判断用户这句话是否是路线规划/地图导航意图，必须只输出 JSON。',
    '地图意图包括：从 A 到 B 怎么走、路上找 X、多个地点访问顺序、绕路成本、行程导航、顺路路线。',
    '不是地图意图：安排会议日程；只问“附近有什么店”但没有起点终点；泛泛旅游攻略。',
    'secondarySignals 只能包含 document_output、research_lookup、browser_lookup。',
    '输出格式：{"isMapIntent":boolean,"primaryTask":"route|along_route_search|multi_point_order|none","secondarySignals":[],"confidence":0-1,"reason":"短原因"}',
    '',
    `用户原文：${userPrompt}`,
  ].join('\n')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('map semantic intent timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function classifyMapSemanticIntent(params: {
  prompt: string
  requestLLM?: (prompt: string, timeoutMs: number) => Promise<string>
}): Promise<MapSemanticIntent | null> {
  const key = cacheKey(params.prompt)
  const cached = readCache(key)
  if (cached !== undefined) return cached

  let result: MapSemanticIntent | null = null
  if (params.requestLLM && hasPotentialMapSignal(params.prompt)) {
    try {
      const text = await withTimeout(
        params.requestLLM(buildPrompt(params.prompt), LLM_TIMEOUT_MS),
        LLM_TIMEOUT_MS,
      )
      const parsed = MapSemanticIntentSchema.safeParse(extractJsonObject(text))
      result = parsed.success ? parsed.data : null
    } catch {
      // silent-catch: LLM request / timeout failure degrades map intent detection to "not a map task". Caller treats null as "fall through to other intent paths"; user-visible impact is at most one missed map suggestion.
      result = null
    }
  }
  const fallback = strongKeywordFallback(params.prompt)
  if (!result || (fallback && !isMapSemanticIntentActive(result))) result = fallback
  writeCache(key, result)
  return result
}

export function isMapSemanticIntentActive(intent?: MapSemanticIntent | null): boolean {
  return Boolean(
    intent?.isMapIntent
    && intent.confidence >= MAP_SEMANTIC_INTENT_CONFIDENCE_THRESHOLD,
  )
}

export function applyMapSemanticIntentToIntentClassification(
  intent: IntentClassification,
  mapSemanticIntent?: MapSemanticIntent | null,
): IntentClassification {
  if (!isMapSemanticIntentActive(mapSemanticIntent)) return intent
  const mentionedDomains = Array.from(new Set([
    ...intent.mentionedDomains,
    'map' as const,
  ]))
  return {
    ...intent,
    primaryDomain: 'map',
    mentionedDomains,
    crossDomain: false,
    confidence: mapSemanticIntent!.confidence >= 0.75 ? 'high' : 'medium',
  }
}

export function _resetMapSemanticIntentCacheForTests(): void {
  cache.clear()
}
