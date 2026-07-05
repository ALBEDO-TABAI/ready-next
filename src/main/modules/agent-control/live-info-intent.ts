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
    | 'event'
    | 'generic'
  searchQuery: string
  signals: string[]
}

const LOOKUP_VERBS = /(查(一下|下)?|看看|看下|帮我看|帮我查|搜(一下|下)?|找(一下|下)?|告诉我|想知道|帮我确认|帮我看看|帮我确认一下)/i
const FRESHNESS_CUES = /(今天|明天|后天|现在|实时|当前|最新|最近|刚刚|此刻|目前|现价|今日|明日|本周|本月|周末|今晚|这周|下周|right now|today|tomorrow|tonight|weekend|current|latest|live|recent)/i
const WEATHER_PATTERNS = /(天气|气温|温度|降雨|下雨|雷阵雨|体感|风力|湿度|预报|气象|台风)/i
const AIR_QUALITY_PATTERNS = /(空气质量|aqi|pm2\.?5|污染指数|空气污染)/i
const NEWS_PATTERNS = /(新闻|头条|快讯|热点|突发|通报|公告|发布会|最新消息)/i
const FINANCE_PATTERNS = /(股价|币价|汇率|现价|价格|油价|金价|盘前|盘后|大盘|指数|涨跌)/i
const SPORTS_PATTERNS = /(比分|赛程|战绩|排名|结果|战报|几比几|谁赢了|第几名)/i
const TRANSPORT_PATTERNS = /(航班|高铁|列车|火车|路况|堵车|地铁|延误|票价|余票)/i
// D19：事件/活动/场所类此前整类缺席，导致「这周末有什么演出」等实时问题
// 判成 local_chat。词形保持查询态（如「什么活动」「活动安排」），不收录裸
// 「活动」「预约」——它们在文档/日历任务里高频出现（一词多域教训）。
const EVENT_PATTERNS = /(演出|演唱会|音乐会|音乐节|live\s*house|展览|展会|漫展|画展|车展|首映|排片|场次|门票|购票|抢票|开售|售票|预售|营业时间|开放时间|几点开门|几点关门|排队情况|等位|什么活动|有.{0,8}活动|活动安排)/i
const EXTERNAL_SOURCE_HINTS = /(官网|官方网站|官方|网站|网页|页面|气象台|中国天气网|中央气象台)/i
const MEDIA_PLATFORM_PATTERNS = /(youtube|youtu\.be|b站|bilibili|小红书|抖音|douyin|tiktok|微博|weibo|快手|spotify|网易云|qq音乐|instagram|twitter|x\.com)/i
const PUBLIC_RANKING_PATTERNS = /(播放量|播放数|播放次数|浏览量|观看量|views?\b|点赞数?|转发数?|评论数?|订阅数?|粉丝数?|排名|榜单|最火|热门|爆款|\btop\s*\d*\b|most\s+(viewed|popular|liked))/i
const MEDIA_OBJECT_PATTERNS = /(视频|影片|短视频|mv|音乐视频|歌曲|单曲|专辑|频道|账号|博主|up主|艺人|artist|idol|女团|男团)/i
const KNOWLEDGE_STYLE_QUESTIONS = /(是什么意思|怎么翻译|英文|英语|定义|原理|为什么|区别|是什么|啥意思|如何理解)/i
const LOCAL_DOMAIN_HINTS = /(文档|文稿|widget|show-widget|rss|日历|calendar|飞书|feishu|skill|workflow|blocker|信息卡|卡片|图表|趋势图|波动图|折线图|柱状图|统计图|走势图|价格图|股价图|收益图|对比图|对比卡|进度卡|日程卡|待办|习惯|计划板|计算器|小工具|提示块|表格|超特殊卡片|交互式信息卡|交互式数据图|透明背景|A4|4:3|骨架|skeleton)/i

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

  const hasMediaPlatformHint = MEDIA_PLATFORM_PATTERNS.test(text)
  const hasPublicRankingCue = PUBLIC_RANKING_PATTERNS.test(text)
  const hasMediaObjectHint = MEDIA_OBJECT_PATTERNS.test(text)
  const hasDynamicPublicRanking = hasPublicRankingCue && (hasMediaPlatformHint || hasMediaObjectHint)

  if (LOCAL_DOMAIN_HINTS.test(text) || (KNOWLEDGE_STYLE_QUESTIONS.test(text) && !hasDynamicPublicRanking)) {
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
  if (EVENT_PATTERNS.test(text)) {
    signals.push('topic-event')
    topic = 'event'
    topicMatched = true
  }

  if (hasLookupVerb) signals.push('lookup-verb')
  if (hasFreshnessCue) signals.push('freshness-cue')
  if (hasSourceHint) signals.push('source-hint')
  if (hasMediaPlatformHint) signals.push('source-media-platform')
  if (hasDynamicPublicRanking) signals.push('dynamic-public-ranking-object')

  const shouldUseLiveInfo =
    (topicMatched && (hasLookupVerb || hasFreshnessCue || hasSourceHint))
    || (topicMatched && topic === 'weather')
    || (hasSourceHint && hasLookupVerb)
    || hasDynamicPublicRanking

  const confidence: LiveInfoIntent['confidence'] =
    shouldUseLiveInfo
      ? (topicMatched && (hasLookupVerb || hasFreshnessCue || hasSourceHint)) || (hasSourceHint && hasLookupVerb) || hasDynamicPublicRanking
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
