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
const ENGLISH_UNSUPPORTED_TRANSIT_MODE_PATTERN = '(?:subway|metro|transit|bus|train|rail|railway|tram|streetcar|ferry|coach|public\\s+(?:transit|transport|transportation))'
const ENGLISH_UNSUPPORTED_TRANSIT_PATTERNS = [
  new RegExp(`\\b(?:by|using)\\s+(?:the\\s+)?${ENGLISH_UNSUPPORTED_TRANSIT_MODE_PATTERN}\\b`),
  new RegExp(`\\bvia\\s+(?:the\\s+)?${ENGLISH_UNSUPPORTED_TRANSIT_MODE_PATTERN}\\b(?:\\s+(?:line|route|service))?(?=\\s*(?:[.?!,;:]|$))`),
  new RegExp(`\\bon\\s+(?:the\\s+)?${ENGLISH_UNSUPPORTED_TRANSIT_MODE_PATTERN}\\b`),
  new RegExp(`\\btake\\s+(?:the\\s+)?${ENGLISH_UNSUPPORTED_TRANSIT_MODE_PATTERN}\\b`),
  new RegExp(`\\b${ENGLISH_UNSUPPORTED_TRANSIT_MODE_PATTERN}\\s+(?:from|to)\\b`),
]
const ENGLISH_NON_ROUTE_BEST_WAY_TO_PATTERN = /\b(?:best|fastest|quickest|shortest)\s+way\s+to\s+(?:translate|migrate|convert|configure|install|build|create|copy|move|map)\b/

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
  const compactEnglish = prompt.toLowerCase().replace(/\s+/g, ' ')
  const englishEndpointSignal =
    /\bfrom\b.+\bto\b/.test(compactEnglish)
    || /\bto\b.+\bfrom\b/.test(compactEnglish)
    || /\bbetween\b.+\band\b/.test(compactEnglish)
  const englishUnsupportedTransitSignal = ENGLISH_UNSUPPORTED_TRANSIT_PATTERNS.some((pattern) => pattern.test(compactEnglish))
  const englishSupportedTravelSignal = /\b(walk|walking|drive|driving|bike|biking|bicycle|bicycling|cycling|taxi|cab|uber)\b/.test(compactEnglish)
  const englishTechnicalRouteSignal =
    /\b(api|sdk|code|function|database|query|schema|file|folder|dropbox|event bus|http|https|request|packet|router|webhook)\b/.test(compactEnglish)
    || /\b(?:network|api|http|https|gateway)\s+traffic\b/.test(compactEnglish)
    || /\bapi\s+gateway\b/.test(compactEnglish)
  const englishDriveNounSignal = /\b(google drive|icloud drive|one drive|onedrive)\b/.test(compactEnglish)
  const englishDriveVerbSignal = /\b(drive|driving)\s+(to|from)\b/.test(compactEnglish) && !englishDriveNounSignal
  const englishRouteQuestionSignal =
    englishEndpointSignal && (
      /\bhow\s+(?:(?:do|can)\s+(?:i|we)\s+|to\s+)?get\s+(?:from|to)\b/.test(compactEnglish)
      || /\bhow\s+long\s+(?:does|will|would)\s+it\s+take\s+to\s+get\s+(?:from|to)\b/.test(compactEnglish)
      || /\bwhat(?:'s| is)\s+the\s+(?:best|fastest|quickest|shortest)\s+way\s+(?:from|between)\b/.test(compactEnglish)
      || /\bwhat(?:'s| is)\s+the\s+(?:best|fastest|quickest|shortest)\s+way\s+to\s+get\s+(?:from|to)\b/.test(compactEnglish)
      || (/\bwhat(?:'s| is)\s+the\s+(?:best|fastest|quickest|shortest)\s+way\s+to\b/.test(compactEnglish) && !ENGLISH_NON_ROUTE_BEST_WAY_TO_PATTERN.test(compactEnglish))
      || /\b(?:best|fastest|quickest|shortest)\s+way\s+(?:from|between)\b/.test(compactEnglish)
      || /\b(?:best|fastest|quickest|shortest)\s+way\s+to\s+get\s+(?:from|to)\b/.test(compactEnglish)
      || (/\b(?:best|fastest|quickest|shortest)\s+way\s+to\b/.test(compactEnglish) && !ENGLISH_NON_ROUTE_BEST_WAY_TO_PATTERN.test(compactEnglish))
    )
  const englishRouteSignal =
    !englishUnsupportedTransitSignal && (
      (/\b(navigate|navigation|directions?|detour|waypoints?)\b/.test(compactEnglish) && (englishEndpointSignal || englishSupportedTravelSignal) && !englishTechnicalRouteSignal)
      || (/\b(route|routing)\b/.test(compactEnglish) && (englishSupportedTravelSignal || englishEndpointSignal) && !englishTechnicalRouteSignal)
      || (englishRouteQuestionSignal && !englishTechnicalRouteSignal)
      || /\b(taxi|cab|uber)\s+(from|to)\b/.test(compactEnglish)
      || /\b(walk|walking|bike|biking|bicycle|bicycling|cycling)\s+(to|from)\b/.test(compactEnglish)
      || englishDriveVerbSignal
    )
  return /(地图|导航|路线|怎么走|从.+到|附近|途经|途径|顺路|绕路|最省时间|最短|最优行程|多点|地点|路上|开车|步行|公交|地铁|打车|耗时|多久)/.test(text)
    || englishRouteSignal
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
