import type { RSSRelevance, RSSSieveFactor, RSSSieveScore } from '../../../shared/rss-sieve'

export const RSS_SIEVE_WEIGHTS = { model: 0.6, source: 20, topic: 15, freshness: 5, duplicate: 20, manual: 100 } as const
// Explicit feedback and topic observations start neutral and remain smoothed.
export function smoothPreference(positive: number, negative: number): number { return (positive + 2) / (positive + negative + 4) }
export interface RSSScoreInput {
  relevance: RSSRelevance | null; sourcePreference: number; topicPreference: number; ageHours: number
  recentTopicInterest: boolean; duplicate: boolean; manual: boolean | null; topicName: string; standardIncluded: boolean
}
export function scoreRSSArticle(input: RSSScoreInput): RSSSieveScore {
  const w = RSS_SIEVE_WEIGHTS
  const contributions: Record<RSSSieveFactor, number> = {
    model: (input.relevance?.score ?? 0) * w.model, source: input.sourcePreference * w.source,
    topic: input.topicPreference * w.topic, freshness: w.freshness * Math.exp(-Math.max(0, input.ageHours) / 24),
    duplicate: input.duplicate ? -w.duplicate : 0, manual: input.manual === true ? w.manual : input.manual === false ? -w.manual : 0,
  }
  const factors = (Object.entries(contributions) as [RSSSieveFactor, number][]).map(([factor, contribution]) => ({ factor, contribution }))
    .sort((a, b) => b.contribution - a.contribution).slice(0, 2)
  const reasons: { contribution: number; text: string }[] = []
  if (input.standardIncluded || input.manual === true) reasons.push({ contribution: input.manual === true ? contributions.manual : contributions.model, text: `符合：${input.topicName}` })
  if (input.relevance?.because === 'work' && input.relevance.workRef && input.relevance.workKind) {
    const ref = input.relevance.workRef
    const text = { page:`因为你在写《${ref}》`, project:`和你在做的项目《${ref}》有关`, calendar:`和你的日程《${ref}》有关`, book:`和你在读的《${ref}》有关` }[input.relevance.workKind]
    reasons.push({ contribution:contributions.model, text })
  }
  if (input.sourcePreference > 0.5) reasons.push({ contribution:contributions.source, text:'你常读这个来源' })
  if (input.topicPreference > 0.5 && input.recentTopicInterest) reasons.push({ contribution:contributions.topic, text:'和你最近收藏的几篇相近' })
  const reason = reasons.sort((a,b) => b.contribution - a.contribution)[0]?.text ?? ''
  return { score: Math.max(0, Math.min(100, Object.values(contributions).reduce((a, b) => a + b, 0))),
    eligible: input.manual !== false && reason.length > 0, pinned: input.manual === true, reason, factors }
}
