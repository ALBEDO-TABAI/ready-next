import type { RequestEnvelope } from './contracts/request-envelope'
import { detectLiveInfoIntent } from './live-info-intent'

export type IntentDomain = 'browser' | 'document' | 'rss' | 'calendar' | 'feishu' | 'skill' | 'pet' | 'research' | 'map' | 'generic'
export type IntentConfidence = 'high' | 'medium' | 'low'

export interface IntentClassification {
  primaryDomain: IntentDomain
  mentionedDomains: Array<Exclude<IntentDomain, 'generic'>>
  excludedDomains: Array<Exclude<IntentDomain, 'generic'>>
  objectSignals: string[]
  actionSignals: string[]
  crossDomain: boolean
  confidence: IntentConfidence
}

type PatternIntentDomain = Exclude<IntentDomain, 'generic' | 'map'>

interface DomainSignal {
  domain: PatternIntentDomain
  score: number
  signals: string[]
}

const DOMAIN_OBJECT_PATTERNS: Record<PatternIntentDomain, Array<[RegExp, string, number]>> = {
  document: [
    [/(文档|文稿|原文|文章|段落|章节|widget|show-widget|图表|信息卡|卡片|svg)/i, 'document-object', 3],
    [/(当前文档|新文档|\.md\b|markdown|docx?)/i, 'document-file', 2],
  ],
  rss: [
    [/(^|[^a-z])(rss|feed|rsshub)([^a-z]|$)/i, 'rss-object', 4],
    [/(订阅源|订阅|源站|信息源|推送的\s*\d+\s*条)/i, 'rss-feed', 3],
  ],
  calendar: [
    [/(日历|日程|会议|提醒|排期|行程|calendar|event)/i, 'calendar-object', 4],
  ],
  feishu: [
    [/(飞书|feishu|lark|多维表格|飞书文档|飞书群|飞书消息|群聊|知识库)/i, 'feishu-object', 4],
  ],
  skill: [
    [/(^|[^a-z])(skill|skills|workflow)([^a-z]|$)/i, 'skill-object', 4],
    [/(技能|技能流|工作流|blocker|阻塞器|执行器)/i, 'skill-workflow', 3],
  ],
  pet: [
    [/(宠物|猫猫|桌面猫|宠物气泡|信息气泡|便利贴|便签|贴纸|pet)/i, 'pet-object', 5],
  ],
  research: [
    [/(研究|调研|综述|综评|综合分析)/i, 'research-object', 4],
    [/(^|[^a-z])(research|survey|review|analysis|overview)([^a-z]|$)/i, 'research-object-en', 3],
  ],
  browser: [
    [/(浏览器|网页|网站|打开页面|打开网页|上传图片|提交到网页|prompt 输入区)/i, 'browser-object', 4],
    [/(https?:\/\/\S+)/i, 'browser-url', 2],
  ],
}

const DOMAIN_ACTION_PATTERNS: Record<PatternIntentDomain, Array<[RegExp, string, number]>> = {
  document: [
    [/(生成|创建|插入|更新|修改|改写|润色|排版|保存|输出\s*svg)/i, 'document-action', 2],
  ],
  rss: [
    [/(抓取|拉取|分析|汇总|输出.*报告|生成.*报告)/i, 'rss-action', 2],
  ],
  calendar: [
    [/(创建|修改|删除|安排|排到|提醒我)/i, 'calendar-action', 2],
  ],
  feishu: [
    [/(发送|同步|更新|写入|回复|发到)/i, 'feishu-action', 2],
  ],
  skill: [
    [/(继续执行|继续跑|恢复执行|处理 blocker|提交结果|确认继续|workflow)/i, 'skill-action', 2],
  ],
  pet: [
    [/(贴到|贴上|贴|放到|放上|新增|添加|显示|关闭|删除|清空|移除)/i, 'pet-action', 2],
  ],
  research: [
    [/(研究|调研|综述|对比分析|调查|整理研究)/i, 'research-action', 2],
    [/(?:比较|对比).{0,24}(?:特色|差异|优劣|适合|趋势|产业|公司类型|园区|商圈|市场|竞品)/i, 'research-comparison-action', 2],
    [/(^|[^a-z])(research|survey|compare|investigate|explain in depth)([^a-z]|$)/i, 'research-action-en', 2],
  ],
  browser: [
    [/(打开|进入|上传|提交|点击|填写|发送)/i, 'browser-action', 2],
  ],
}

function collectSignals(text: string, patterns: Array<[RegExp, string, number]>): { score: number; signals: string[] } {
  let score = 0
  const signals: string[] = []
  for (const [pattern, label, weight] of patterns) {
    if (!pattern.test(text)) continue
    score += weight
    signals.push(label)
  }
  return { score, signals }
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function normalizeSkillToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '')
    .trim()
}

function detectDomainSignals(
  envelope: RequestEnvelope,
  options?: { registeredSkillTokens?: string[] },
): DomainSignal[] {
  const text = [
    envelope.primaryInstruction,
    ...envelope.referencedResources.map((ref) => ref.value),
  ].filter(Boolean).join('\n')
  const signals: DomainSignal[] = []
  // Live-info detection only consumes the user's own primary instruction — widget
  // attachments and referenced resources carry domain words like 赛程/比分 that
  // would false-positive the sports regex and flip the run into browser_workflow.
  // When the caller has already bound an explicit Widget 更新上下文, the user is
  // editing a specific card — never run live-info detection, even if their words
  // happen to include weather / finance / sports topic keywords.
  const liveInfoIntent = envelope.environmentHints.hasWidgetTargetContext
    ? { needsLiveInfo: false, confidence: 'low' as const, signals: [] as string[] }
    : detectLiveInfoIntent(envelope.primaryInstruction || '')

  for (const domain of Object.keys(DOMAIN_OBJECT_PATTERNS) as PatternIntentDomain[]) {
    const objectResult = collectSignals(text, DOMAIN_OBJECT_PATTERNS[domain])
    const actionResult = collectSignals(text, DOMAIN_ACTION_PATTERNS[domain])
    const hasDocumentContext = envelope.environmentHints.hasDocumentContext || envelope.environmentHints.hasWidgetTargetContext
    if (
      (domain === 'rss' || domain === 'calendar' || domain === 'feishu') &&
      objectResult.score === 0
    ) {
      continue
    }
    if (domain === 'document' && objectResult.score === 0 && !hasDocumentContext) {
      continue
    }
    let score = objectResult.score + actionResult.score
    const domainSignals = [...objectResult.signals, ...actionResult.signals]

    if (domain === 'document' && envelope.environmentHints.hasDocumentContext) {
      score += 1
      domainSignals.push('document-context')
    }
    if (domain === 'document' && envelope.environmentHints.hasWidgetTargetContext) {
      score += 2
      domainSignals.push('widget-target')
    }
    if (score <= 0) continue
    signals.push({ domain, score, signals: dedupe(domainSignals) })
  }

  if (liveInfoIntent.needsLiveInfo) {
    // Public live facts belong to the lightweight research surface first:
    // Ready can answer them through configured search/fetch APIs without
    // opening or taking over a visible BrowserView. Platform ranking queries
    // remain browser-owned because their truth commonly depends on the live
    // site/session rather than a public search backend.
    const requiresBrowserSession = liveInfoIntent.signals.includes('dynamic-public-ranking-object')
    const liveInfoOwner = requiresBrowserSession ? 'browser' : 'research'
    const liveInfoSignals = liveInfoIntent.signals.map((signal) => `${liveInfoOwner}-live-info-${signal}`)
    signals.push({
      domain: liveInfoOwner,
      score: liveInfoIntent.confidence === 'high' ? 6 : 4,
      signals: dedupe([
        `${liveInfoOwner}-live-info-object`,
        ...liveInfoSignals,
      ]),
    })
  }

  const registeredSkillTokens = options?.registeredSkillTokens
  if (registeredSkillTokens && registeredSkillTokens.length > 0) {
    const normalizedPrimary = normalizeSkillToken(envelope.primaryInstruction || '')
    if (normalizedPrimary) {
      const matched = registeredSkillTokens.some((token) => token && normalizedPrimary.includes(token))
      if (matched) {
        const existing = signals.find((entry) => entry.domain === 'skill')
        if (existing) {
          existing.score += 4
          existing.signals = dedupe([...existing.signals, 'skill-registered-id-object'])
        } else {
          signals.push({
            domain: 'skill',
            score: 4,
            signals: ['skill-registered-id-object'],
          })
        }
      }
    }
  }

  return signals
}

function suppressGenericResearchModifier(signals: DomainSignal[]): DomainSignal[] {
  const research = signals.find((item) => item.domain === 'research')
  if (!research) return signals
  const nonResearchSignals = signals.filter((item) => item.domain !== 'research')
  if (nonResearchSignals.length !== 1) return signals
  const [productSignal] = nonResearchSignals
  if (!productSignal || productSignal.score < research.score) return signals
  const researchIsGenericModifier = research.signals.every((signal) => (
    signal === 'research-object' || signal === 'research-action'
  ))
  if (!researchIsGenericModifier) return signals
  return nonResearchSignals
}

function resolveExcludedDomains(
  primaryDomain: IntentDomain,
  signals: DomainSignal[],
): Array<Exclude<IntentDomain, 'generic'>> {
  const positive = new Set(signals.map((item) => item.domain))
  if (primaryDomain === 'generic') return []
  return ((['browser', 'document', 'rss', 'calendar', 'feishu', 'skill', 'pet', 'research'] as PatternIntentDomain[])
    .filter((domain) => domain !== primaryDomain && !positive.has(domain))
  ) as Array<Exclude<IntentDomain, 'generic'>>
}

export function classifyIntent(
  envelope: RequestEnvelope,
  options?: { registeredSkillTokens?: string[] },
): IntentClassification {
  const signals = suppressGenericResearchModifier(detectDomainSignals(envelope, options))
  if (signals.length === 0) {
    return {
      primaryDomain: 'generic',
      mentionedDomains: [],
      excludedDomains: [],
      objectSignals: [],
      actionSignals: [],
      crossDomain: false,
      confidence: 'low',
    }
  }

  const sorted = signals.slice().sort((left, right) => right.score - left.score)
  const primary = sorted[0]
  const mentionedDomains = sorted.map((item) => item.domain)
  const crossDomain = mentionedDomains.length > 1
  const objectSignals = dedupe(sorted.flatMap((item) => item.signals.filter((signal) => signal.includes('object') || signal.includes('context') || signal.includes('target') || signal.includes('file') || signal.includes('feed') || signal.includes('url'))))
  const actionSignals = dedupe(sorted.flatMap((item) => item.signals.filter((signal) => signal.includes('action'))))
  const confidence: IntentConfidence = primary.score >= 6 ? 'high' : primary.score >= 4 ? 'medium' : 'low'

  return {
    primaryDomain: primary.domain,
    mentionedDomains,
    excludedDomains: resolveExcludedDomains(primary.domain, signals),
    objectSignals,
    actionSignals,
    crossDomain,
    confidence,
  }
}
