export interface LiveInfoIntent {
  needsLiveInfo: boolean
  confidence: 'low' | 'medium' | 'high'
  topic:
    | 'weather'
    | 'news'
    | 'finance'
    | 'sports'
    | 'transport'
    | 'air_quality'
    | 'generic'
  searchQuery: string
  signals: string[]
}

const LOOKUP_VERBS = /(查(一下|下)?|看看|看下|帮我看|帮我查|搜(一下|下)?|找(一下|下)?|告诉我|想知道|帮我确认|帮我看看|帮我确认一下)/i
const FRESHNESS_CUES = /(今天|明天|后天|现在|实时|当前|最新|最近|刚刚|此刻|目前|现价|今日|明日|本周|本月|right now|today|tomorrow|current|latest|live|recent)/i
const WEATHER_PATTERNS = /(天气|气温|温度|降雨|下雨|雷阵雨|体感|风力|湿度|预报|气象|台风)/i
const AIR_QUALITY_PATTERNS = /(空气质量|aqi|pm2\.?5|污染指数|空气污染)/i
const NEWS_PATTERNS = /(新闻|头条|快讯|热点|突发|通报|公告|发布会|最新消息)/i
const FINANCE_PATTERNS = /(股价|币价|汇率|现价|价格|油价|金价|盘前|盘后|大盘|指数|涨跌)/i
const SPORTS_PATTERNS = /(比分|赛程|战绩|排名|结果|战报|几比几|谁赢了|第几名)/i
const TRANSPORT_PATTERNS = /(航班|高铁|列车|火车|路况|堵车|地铁|延误|票价|余票)/i
const EXTERNAL_SOURCE_HINTS = /(官网|官方网站|官方|网站|网页|页面|气象台|中国天气网|中央气象台)/i
const KNOWLEDGE_STYLE_QUESTIONS = /(是什么意思|怎么翻译|英文|英语|定义|原理|为什么|区别|是什么|啥意思|如何理解)/i
const LOCAL_DOMAIN_HINTS = /(文档|文稿|widget|show-widget|rss|日历|calendar|飞书|feishu|skill|workflow|blocker)/i

function normalizeSearchQuery(text: string): string {
  let normalized = String(text || '').trim()
  let changed = true
  while (changed) {
    const next = normalized
      .replace(/^(那|那么|现在|麻烦你|请你|请|帮我|你去|你帮我|帮忙|麻烦)\s*/g, '')
      .replace(/^(看看|看一下|看下|查一下|查下|查查)\s*/g, '')
      .trim()
    changed = next !== normalized
    normalized = next
  }

  return normalized
    .replace(/(帮我)?(看看|看一下|看下|查一下|查下|查查)$/g, '')
    .replace(/[？?]+$/g, '')
    .trim()
}

export function detectLiveInfoIntent(rawText: string): LiveInfoIntent {
  const text = String(rawText || '').trim()
  if (!text) {
    return {
      needsLiveInfo: false,
      confidence: 'low',
      topic: 'generic',
      searchQuery: '',
      signals: [],
    }
  }

  if (LOCAL_DOMAIN_HINTS.test(text) || KNOWLEDGE_STYLE_QUESTIONS.test(text)) {
    return {
      needsLiveInfo: false,
      confidence: 'low',
      topic: 'generic',
      searchQuery: '',
      signals: [],
    }
  }

  const signals: string[] = []
  const hasLookupVerb = LOOKUP_VERBS.test(text)
  const hasFreshnessCue = FRESHNESS_CUES.test(text)
  const hasSourceHint = EXTERNAL_SOURCE_HINTS.test(text)

  let topic: LiveInfoIntent['topic'] = 'generic'
  let topicMatched = false

  if (WEATHER_PATTERNS.test(text)) {
    signals.push('topic-weather')
    topic = 'weather'
    topicMatched = true
  }
  if (AIR_QUALITY_PATTERNS.test(text)) {
    signals.push('topic-air-quality')
    topic = 'air_quality'
    topicMatched = true
  }
  if (NEWS_PATTERNS.test(text)) {
    signals.push('topic-news')
    topic = 'news'
    topicMatched = true
  }
  if (FINANCE_PATTERNS.test(text)) {
    signals.push('topic-finance')
    topic = 'finance'
    topicMatched = true
  }
  if (SPORTS_PATTERNS.test(text)) {
    signals.push('topic-sports')
    topic = 'sports'
    topicMatched = true
  }
  if (TRANSPORT_PATTERNS.test(text)) {
    signals.push('topic-transport')
    topic = 'transport'
    topicMatched = true
  }

  if (hasLookupVerb) signals.push('lookup-verb')
  if (hasFreshnessCue) signals.push('freshness-cue')
  if (hasSourceHint) signals.push('source-hint')

  const shouldUseLiveInfo =
    (topicMatched && (hasLookupVerb || hasFreshnessCue || hasSourceHint))
    || (topicMatched && topic === 'weather')
    || (hasSourceHint && hasLookupVerb)

  const confidence: LiveInfoIntent['confidence'] =
    shouldUseLiveInfo
      ? (topicMatched && (hasLookupVerb || hasFreshnessCue || hasSourceHint)) || (hasSourceHint && hasLookupVerb)
        ? 'high'
        : 'medium'
      : 'low'

  return {
    needsLiveInfo: shouldUseLiveInfo,
    confidence,
    topic,
    searchQuery: shouldUseLiveInfo ? normalizeSearchQuery(text) : '',
    signals,
  }
}
