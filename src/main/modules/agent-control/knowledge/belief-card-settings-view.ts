import { isHighControlPlatformText } from '../../../../shared/browser-collection-intent'
import type { BrowserSiteExperienceRiskLevel } from '../../../../shared/browser-site-experience'
import type { BeliefCard, BeliefCardStore, BeliefCardStatus } from './belief-card-store'

export interface BeliefCardSettingsItem {
  relPath: string
  scopeId: string
  title: string
  description: string
  confidence: string | null
  tag: string | null
  status: BeliefCardStatus
  created: string | null
  source: string | null
  stage: string | null
  site: string | null
  siteRiskLevel: BrowserSiteExperienceRiskLevel | null
  siteRiskAuthority: 'code' | null
  isSiteCard: boolean
  isRiskSuggestion: boolean
  bodyPreview: string
}

export interface BeliefCardSettingsSummary {
  total: number
  staged: number
  active: number
  rejected: number
  invalid: number
  agentScoped: number
  siteCards: number
  highRiskSiteCards: number
  riskSuggestions: number
}

export interface BeliefCardSettingsSnapshot {
  cards: BeliefCardSettingsItem[]
  summary: BeliefCardSettingsSummary
}

function siteFromPath(relPath: string): string | null {
  const match = relPath.match(/(?:^|\/)knowledge\/sites\/([^/]+)\.md$/)
  return match?.[1] ?? null
}

function siteRiskLevel(site: string | null): BrowserSiteExperienceRiskLevel | null {
  if (!site) return null
  return isHighControlPlatformText(site) ? 'high' : 'low'
}

function toItem(input: { relPath: string; scopeId: string; card: BeliefCard | null }): BeliefCardSettingsItem {
  if (!input.card) {
    const site = siteFromPath(input.relPath)
    const risk = siteRiskLevel(site)
    return {
      relPath: input.relPath,
      scopeId: input.scopeId,
      title: input.relPath,
      description: '这张卡片格式无法读取。',
      confidence: null,
      tag: null,
      status: 'invalid',
      created: null,
      source: null,
      stage: null,
      site,
      siteRiskLevel: risk,
      siteRiskAuthority: risk ? 'code' : null,
      isSiteCard: Boolean(site),
      isRiskSuggestion: false,
      bodyPreview: '',
    }
  }

  const fm = input.card.frontmatter
  const site = fm.site ?? siteFromPath(input.relPath)
  const risk = siteRiskLevel(site)
  const source = fm.source ?? null
  return {
    relPath: input.relPath,
    scopeId: input.scopeId,
    title: fm.title,
    description: fm.description,
    confidence: fm.confidence,
    tag: fm.tag,
    status: fm.status,
    created: fm.created,
    source,
    stage: fm.stage ?? null,
    site,
    siteRiskLevel: risk,
    siteRiskAuthority: risk ? 'code' : null,
    isSiteCard: Boolean(site),
    isRiskSuggestion: Boolean(source?.startsWith('possible-risk-update-of')),
    bodyPreview: input.card.body.slice(0, 500),
  }
}

export function buildBeliefCardSettingsSnapshot(store: BeliefCardStore): BeliefCardSettingsSnapshot {
  const cards = store
    .listAllCardFilesAllScopes()
    .map(toItem)
    .sort((a, b) => {
      const statusRank = (status: BeliefCardStatus): number =>
        status === 'staged' ? 0 : status === 'invalid' ? 1 : status === 'active' ? 2 : 3
      return statusRank(a.status) - statusRank(b.status)
        || a.scopeId.localeCompare(b.scopeId)
        || a.relPath.localeCompare(b.relPath)
    })

  const summary: BeliefCardSettingsSummary = {
    total: cards.length,
    staged: cards.filter((card) => card.status === 'staged').length,
    active: cards.filter((card) => card.status === 'active').length,
    rejected: cards.filter((card) => card.status === 'rejected').length,
    invalid: cards.filter((card) => card.status === 'invalid').length,
    agentScoped: cards.filter((card) => card.scopeId.startsWith('agent:')).length,
    siteCards: cards.filter((card) => card.isSiteCard).length,
    highRiskSiteCards: cards.filter((card) => card.siteRiskLevel === 'high').length,
    riskSuggestions: cards.filter((card) => card.isRiskSuggestion).length,
  }

  return { cards, summary }
}
