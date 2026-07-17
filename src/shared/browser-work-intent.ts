export type BrowserWorkIntentKind = 'observe' | 'site_research' | 'persist_collection' | 'transact' | 'diagnose'
export type BrowserSiteSurface = 'current_site' | 'supplied_urls' | 'none'
export type BrowserBatchScope = 'none' | 'explicit_all_items'

export interface BrowserWorkIntent {
  kind: BrowserWorkIntentKind
  siteSurface: BrowserSiteSurface
  queries: string[]
  persistenceRequested: boolean
  batchScope: BrowserBatchScope
  roles: {
    researchQueries: string[]
    evidenceSources: string[]
    evaluationTargets: string[]
    outputDestinations: string[]
  }
  reason: string
}

const URL_RE = /https?:\/\/[^\s)\]}]+/gi
const SITE_SURFACE_RE = /(?:这里|当前(?:网页|页面|站点)|这个(?:网页|页面|站点)|小红书|抖音|微博|bilibili|网站|浏览器)/i
const CURRENT_SITE_REFERENCE_RE = /(?:这里|当前(?:网页|页面|站点)|这个(?:网页|页面|站点))/i
const RESEARCH_RE = /(?:搜索|搜一下|查找|检索|研究|找找|爆款|对标|选题|分析)/i
const PERSIST_RE = /(?:采集(?!时间(?:戳)?|日期|时刻)|抓取(?!时间(?:戳)?|日期|时刻)|爬取(?!时间(?:戳)?|日期|时刻)|下载|保存|存档|归档|落盘|写入(?:文件|目录|文件夹)|放到.{0,12}文件夹)/i
const TRANSACT_RE = /(?:发布|发帖|发笔记|提交表单|提交订单|上传(?:文件|图片|视频))/i
const DIAGNOSE_RE = /(?:诊断|排查|控制台|网络请求|为什么打不开|页面报错)/i
const ALL_ITEMS_RE = /(?:每篇|逐篇|每个|逐个|全部|所有|全量|整页|整个主页)/i
const CONTENT_OBJECT_RE = /(?:笔记|帖子|作品|动态|视频|图集|页面|卡片|内容)/i
const EVALUATION_TARGET_RE = /(?:(?:分析|评估|研究|筛选|适合|匹配|结合|针对).{0,30}(?:这个|当前|该)?(?:账号|博主|主页)|(?:这个|当前|该)(?:账号|博主|主页).{0,20}(?:分析|评估|研究|筛选|适合|匹配))/i
const NEGATION_PREFIX_RE = /(?:不要|不用|无需|不必|别|禁止|不).{0,6}$/i
const QUERY_TRANSITION_RE = /^(?:然后|再|接着|随后|最后|并且|同时|另外|并)\s*(?:分析|筛选|整理|总结|判断|评估|结合|针对|输出|给出|推荐|保存|下载|采集)/i
const QUERY_TRAILING_INSTRUCTION_RE = /^(?:这是|请|如遇|如果|若|不要|不用|无需|不必|禁止).{0,30}(?:任务|处理|完整|发布|点赞|评论|关注|登录|验证|完成|结果)/i
const NEGATED_EVALUATION_INSTRUCTION_RE = /^(?:不需要|无需|不用|不要|不必|别).{0,12}(?:分析|评估|研究|筛选|匹配).{0,12}(?:账号|博主|主页)/i

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim().replace(/[；;，,。]+$/g, '')
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function uniqueQueries(values: string[]): string[] {
  return unique(values.map((value) => value.replace(/^(?:[-*•]\s+|\d{1,3}[.)、]\s*)/, '')))
}

function extractQueries(text: string): string[] {
  const marker = /(?:关键词|查询|搜索词)(?:如下|包括|是)?\s*[：:]/i.exec(text)
  const colon = text.lastIndexOf('：') >= 0 ? text.lastIndexOf('：') : text.lastIndexOf(':')
  const candidate = marker
    ? text.slice((marker.index || 0) + marker[0].length)
    : colon >= 0 ? text.slice(colon + 1) : text
  const lines: string[] = []
  for (const rawLine of candidate.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (QUERY_TRANSITION_RE.test(line) || QUERY_TRAILING_INSTRUCTION_RE.test(line) || NEGATED_EVALUATION_INSTRUCTION_RE.test(line)) break
    lines.push(line)
  }
  if (lines.length >= 2) return uniqueQueries(lines)

  const labelled = /(?:关键词|查询|搜索词)(?:如下|包括|是)?\s*[：:]\s*([^。]+)/i.exec(text)?.[1]
  if (!labelled) return []
  const parts: string[] = []
  for (const rawPart of labelled.split(/[；;、\n]/)) {
    const part = rawPart.trim()
    if (QUERY_TRANSITION_RE.test(part) || QUERY_TRAILING_INSTRUCTION_RE.test(part) || NEGATED_EVALUATION_INSTRUCTION_RE.test(part)) break
    parts.push(part)
  }
  return uniqueQueries(parts)
}

function actionSegments(text: string): string[] {
  return text
    .split(/[。！？!?；;，,\n]/)
    .flatMap((clause) => clause.split(/(?=(?:只|仅|但|不过|而是|然后|再|接着))/))
    .map((clause) => clause.trim())
    .filter(Boolean)
}

function hasPositiveAction(segment: string, pattern: RegExp): boolean {
  const match = pattern.exec(segment)
  if (!match || match.index === undefined) return false
  return !NEGATION_PREFIX_RE.test(segment.slice(Math.max(0, match.index - 10), match.index))
}

function hasExplicitBatchPersistence(text: string): boolean {
  return actionSegments(text)
    .some((segment) => hasPositiveAction(segment, PERSIST_RE) && ALL_ITEMS_RE.test(segment) && CONTENT_OBJECT_RE.test(segment))
}

function hasPositivePersistence(text: string): boolean {
  return actionSegments(text).some((segment) => hasPositiveAction(segment, PERSIST_RE))
}

function hasPositiveTransaction(text: string): boolean {
  return actionSegments(text).some((segment) => hasPositiveAction(segment, TRANSACT_RE))
}

export function resolveBrowserWorkIntent(text: string | null | undefined): BrowserWorkIntent {
  const source = String(text || '').trim()
  const urls = unique(source.match(URL_RE) || [])
  const queries = extractQueries(source)
  const persistenceRequested = hasPositivePersistence(source)
  const siteSurface: BrowserSiteSurface = CURRENT_SITE_REFERENCE_RE.test(source)
    ? 'current_site'
    : urls.length > 0
      ? 'supplied_urls'
      : SITE_SURFACE_RE.test(source)
        ? 'current_site'
        : 'none'
  const batchScope: BrowserBatchScope = persistenceRequested && hasExplicitBatchPersistence(source)
    ? 'explicit_all_items'
    : 'none'

  let kind: BrowserWorkIntentKind = 'observe'
  let reason = 'observe'
  if (hasPositiveTransaction(source)) {
    kind = 'transact'
    reason = 'explicit_transaction'
  } else if (DIAGNOSE_RE.test(source)) {
    kind = 'diagnose'
    reason = 'explicit_diagnosis'
  } else if (persistenceRequested) {
    kind = 'persist_collection'
    reason = batchScope === 'explicit_all_items' ? 'explicit_batch_persistence' : 'explicit_persistence'
  } else if (RESEARCH_RE.test(source) && (queries.length > 0 || urls.length > 0)) {
    kind = 'site_research'
    reason = 'current_site_research'
  }

  return {
    kind,
    siteSurface,
    queries,
    persistenceRequested,
    batchScope,
    roles: {
      researchQueries: queries,
      evidenceSources: siteSurface === 'current_site' ? ['current_site'] : urls,
      evaluationTargets: actionSegments(source).some((segment) => hasPositiveAction(segment, EVALUATION_TARGET_RE)) ? ['current_account'] : [],
      outputDestinations: [],
    },
    reason,
  }
}
