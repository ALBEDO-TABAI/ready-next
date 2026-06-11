import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { logAgentMetric } from '../metrics'
import { isHighControlPlatformText } from '../../../../shared/browser-collection-intent'
import type { BrowserSiteExperienceRiskLevel } from '../../../../shared/browser-site-experience'

/**
 * Site knowledge card reader (EP1-B3). Site cards carry EXPERIENCE narrative
 * (selectors / login-wall / scrape risk notes) in belief-card format. The
 * authoritative risk level is NOT the card — it comes from the code-side risk
 * signal (`isHighControlPlatformText`, the same predicate the
 * browser-site-experience-store consults to force `high`). Any hand-written
 * riskLevel in a card is IGNORED and warns on mismatch — single source of
 * truth stays in code, the card never overrides the guard.
 *
 * Resolution priority: user override (belief store knowledge/sites/<domain>.md,
 * writable, K1-whitelisted) > bundled seed (read-only). Upgrades only touch the
 * bundled layer; user cards are never overwritten.
 */

export interface SiteCardRender {
  domain: string
  riskLevel: BrowserSiteExperienceRiskLevel
  body: string
  source: 'user' | 'bundled'
}

export interface SiteCardReaderOptions {
  /** Bundled seed dirs (assets/site-cards), first existing wins. */
  bundledRoots: string[]
  /** Belief store root; user cards live at <root>/knowledge/sites/<domain>.md. */
  userKnowledgeRoot?: string | null
  /** Risk authority; default derives high|low from isHighControlPlatformText. */
  riskAuthority?: (domain: string) => BrowserSiteExperienceRiskLevel
  warn?: (event: { domain: string; cardRisk: string; authorityRisk: string }) => void
}

function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '')
  const match = normalized.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) return { meta: {}, body: normalized.trim() }
  const meta: Record<string, string> = {}
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!entry) continue
    meta[entry[1].toLowerCase()] = entry[2].trim().replace(/^['"]|['"]$/g, '')
  }
  return { meta, body: normalized.slice(match[0].length).trim() }
}

export class SiteCardReader {
  private readonly opts: SiteCardReaderOptions
  constructor(opts: SiteCardReaderOptions) {
    this.opts = opts
  }

  private authority(domain: string): BrowserSiteExperienceRiskLevel {
    if (this.opts.riskAuthority) return this.opts.riskAuthority(domain)
    return isHighControlPlatformText(domain) ? 'high' : 'low'
  }

  private resolveRaw(domain: string): { raw: string; source: 'user' | 'bundled' } | null {
    if (this.opts.userKnowledgeRoot) {
      const userPath = join(this.opts.userKnowledgeRoot, 'knowledge', 'sites', `${domain}.md`)
      if (existsSync(userPath)) return { raw: readFileSync(userPath, 'utf-8'), source: 'user' }
    }
    for (const root of this.opts.bundledRoots) {
      const bundledPath = join(root, `${domain}.md`)
      if (existsSync(bundledPath)) return { raw: readFileSync(bundledPath, 'utf-8'), source: 'bundled' }
    }
    return null
  }

  /** All available site-card domains (user overrides + bundled), de-duplicated. */
  listDomains(): string[] {
    const domains = new Set<string>()
    for (const root of this.opts.bundledRoots) {
      if (!existsSync(root)) continue
      for (const name of readdirSync(root)) {
        if (name.endsWith('.md')) domains.add(name.replace(/\.md$/, ''))
      }
    }
    if (this.opts.userKnowledgeRoot) {
      const userSites = join(this.opts.userKnowledgeRoot, 'knowledge', 'sites')
      if (existsSync(userSites)) {
        for (const name of readdirSync(userSites)) {
          if (name.endsWith('.md')) domains.add(name.replace(/\.md$/, ''))
        }
      }
    }
    return [...domains]
  }

  /** Render a site card for a domain; risk level always from the authority. */
  render(domain: string): SiteCardRender | null {
    const resolved = this.resolveRaw(domain)
    if (!resolved) return null
    const { meta, body } = splitFrontmatter(resolved.raw)
    const authorityRisk = this.authority(domain)
    // Hand-written riskLevel is ignored; warn if present and disagreeing.
    const cardRisk = meta.risklevel
    if (cardRisk && cardRisk !== authorityRisk) {
      const warn = this.opts.warn ?? ((e) => logAgentMetric('site_card_risk_conflict', { ...e }))
      warn({ domain, cardRisk, authorityRisk })
    }
    return { domain, riskLevel: authorityRisk, body, source: resolved.source }
  }
}
