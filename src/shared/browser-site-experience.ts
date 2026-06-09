export type BrowserSiteExperienceRiskLevel = 'low' | 'medium' | 'high'
export type BrowserSiteExperienceSource = 'manual' | 'successful-task' | 'test-fixture'

export interface BrowserSiteExperience {
  id: string
  domain: string
  pathPattern?: string
  appliesToTaskKinds: string[]
  aliases: string[]
  reliableEntryPatterns: string[]
  generatedLinkPatterns: string[]
  knownTraps: Array<{
    kind: string
    description: string
    recovery: string
  }>
  selectorsOrTargetHints: Array<{
    purpose: string
    hint: string
    confidence: number
  }>
  frameHints: Array<{
    purpose: string
    framePattern: string
    readable: boolean
  }>
  riskLevel: BrowserSiteExperienceRiskLevel
  confidence: number
  source: BrowserSiteExperienceSource
  lastVerifiedAt: string
  expiresAt?: string
}

export interface BrowserSiteExperienceQuery {
  url: string
  taskKind?: string
  now?: Date
  highControlPlatform?: boolean
}

export interface BrowserSiteExperienceHint {
  id: string
  domain: string
  pathPattern?: string
  riskLevel: BrowserSiteExperienceRiskLevel
  confidence: number
  source: BrowserSiteExperienceSource
  hint: string
  lastVerifiedAt: string
  expiresAt?: string
}
