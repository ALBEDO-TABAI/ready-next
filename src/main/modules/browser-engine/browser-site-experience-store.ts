import type { DatabaseConnection } from '../database/connection'
import { randomUUID } from 'crypto'

import { getDatabase } from '../database'
import { isHighControlPlatformText } from '../../../shared/browser-collection-intent'
import type {
  BrowserSiteExperience,
  BrowserSiteExperienceHint,
  BrowserSiteExperienceQuery,
  BrowserSiteExperienceRiskLevel,
} from '../../../shared/browser-site-experience'

interface BrowserSiteExperienceRow {
  id: string
  domain: string
  path_pattern?: string | null
  applies_to_task_kinds_json: string
  aliases_json: string
  reliable_entry_patterns_json: string
  generated_link_patterns_json: string
  known_traps_json: string
  selectors_or_target_hints_json: string
  frame_hints_json: string
  risk_level: BrowserSiteExperienceRiskLevel
  confidence: number
  source: BrowserSiteExperience['source']
  last_verified_at: string
  expires_at?: string | null
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

function normalizeDomain(value: string): string {
  const trimmed = String(value || '').trim().toLowerCase()
  if (!trimmed) return ''
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, '')
  } catch {
    return trimmed.replace(/^www\./, '')
  }
}

function parseUrl(value: string): { domain: string; path: string } {
  try {
    const url = new URL(value)
    return { domain: normalizeDomain(url.hostname), path: url.pathname || '/' }
  } catch {
    return { domain: normalizeDomain(value), path: '/' }
  }
}

function pathMatches(path: string, pattern?: string | null): boolean {
  const normalized = String(path || '/')
  const raw = String(pattern || '').trim()
  if (!raw) return true
  if (raw.endsWith('*')) return normalized.startsWith(raw.slice(0, -1))
  return normalized === raw || normalized.startsWith(raw)
}

function rowToExperience(row: BrowserSiteExperienceRow): BrowserSiteExperience {
  return {
    id: row.id,
    domain: row.domain,
    ...(row.path_pattern ? { pathPattern: row.path_pattern } : {}),
    appliesToTaskKinds: parseJsonArray<string>(row.applies_to_task_kinds_json),
    aliases: parseJsonArray<string>(row.aliases_json),
    reliableEntryPatterns: parseJsonArray<string>(row.reliable_entry_patterns_json),
    generatedLinkPatterns: parseJsonArray<string>(row.generated_link_patterns_json),
    knownTraps: parseJsonArray<BrowserSiteExperience['knownTraps'][number]>(row.known_traps_json),
    selectorsOrTargetHints: parseJsonArray<BrowserSiteExperience['selectorsOrTargetHints'][number]>(row.selectors_or_target_hints_json),
    frameHints: parseJsonArray<BrowserSiteExperience['frameHints'][number]>(row.frame_hints_json),
    riskLevel: row.risk_level,
    confidence: Number(row.confidence || 0),
    source: row.source,
    lastVerifiedAt: row.last_verified_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  }
}

function buildHint(experience: BrowserSiteExperience, riskLevel: BrowserSiteExperienceRiskLevel): BrowserSiteExperienceHint {
  const parts = [
    experience.reliableEntryPatterns.length > 0 ? `reliable entries: ${experience.reliableEntryPatterns.join('; ')}` : '',
    experience.generatedLinkPatterns.length > 0 ? `generated links: ${experience.generatedLinkPatterns.join('; ')}` : '',
    experience.knownTraps.length > 0 ? `known traps: ${experience.knownTraps.map((trap) => `${trap.kind}: ${trap.description} -> ${trap.recovery}`).join('; ')}` : '',
    experience.selectorsOrTargetHints.length > 0 ? `target hints: ${experience.selectorsOrTargetHints.map((hint) => `${hint.purpose}: ${hint.hint}`).join('; ')}` : '',
    experience.frameHints.length > 0 ? `frame hints: ${experience.frameHints.map((hint) => `${hint.purpose}: ${hint.framePattern} readable=${hint.readable}`).join('; ')}` : '',
  ].filter(Boolean)
  return {
    id: experience.id,
    domain: experience.domain,
    ...(experience.pathPattern ? { pathPattern: experience.pathPattern } : {}),
    riskLevel,
    confidence: experience.confidence,
    source: experience.source,
    hint: parts.join(' | ') || 'site experience hint available; verify against current page evidence',
    lastVerifiedAt: experience.lastVerifiedAt,
    ...(experience.expiresAt ? { expiresAt: experience.expiresAt } : {}),
  }
}

export class BrowserSiteExperienceStore {
  constructor(private readonly db: DatabaseConnection = (() => {
    const raw = getDatabase().getRawDb()
    if (!raw) throw new Error('Database not available')
    return raw
  })()) {}

  upsert(input: Omit<BrowserSiteExperience, 'id'> & { id?: string }): BrowserSiteExperience {
    const now = Date.now()
    const experience: BrowserSiteExperience = {
      id: input.id || randomUUID(),
      domain: normalizeDomain(input.domain),
      ...(input.pathPattern ? { pathPattern: input.pathPattern } : {}),
      appliesToTaskKinds: input.appliesToTaskKinds || [],
      aliases: input.aliases || [],
      reliableEntryPatterns: input.reliableEntryPatterns || [],
      generatedLinkPatterns: input.generatedLinkPatterns || [],
      knownTraps: input.knownTraps || [],
      selectorsOrTargetHints: input.selectorsOrTargetHints || [],
      frameHints: input.frameHints || [],
      riskLevel: input.riskLevel,
      confidence: Math.max(0, Math.min(1, Number(input.confidence || 0))),
      source: input.source,
      lastVerifiedAt: input.lastVerifiedAt,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    }
    this.db.prepare(`
      INSERT INTO browser_site_experience (
        id, domain, path_pattern, applies_to_task_kinds_json, aliases_json,
        reliable_entry_patterns_json, generated_link_patterns_json, known_traps_json,
        selectors_or_target_hints_json, frame_hints_json, risk_level, confidence,
        source, last_verified_at, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        domain = excluded.domain,
        path_pattern = excluded.path_pattern,
        applies_to_task_kinds_json = excluded.applies_to_task_kinds_json,
        aliases_json = excluded.aliases_json,
        reliable_entry_patterns_json = excluded.reliable_entry_patterns_json,
        generated_link_patterns_json = excluded.generated_link_patterns_json,
        known_traps_json = excluded.known_traps_json,
        selectors_or_target_hints_json = excluded.selectors_or_target_hints_json,
        frame_hints_json = excluded.frame_hints_json,
        risk_level = excluded.risk_level,
        confidence = excluded.confidence,
        source = excluded.source,
        last_verified_at = excluded.last_verified_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      experience.id,
      experience.domain,
      experience.pathPattern || null,
      JSON.stringify(experience.appliesToTaskKinds),
      JSON.stringify(experience.aliases),
      JSON.stringify(experience.reliableEntryPatterns),
      JSON.stringify(experience.generatedLinkPatterns),
      JSON.stringify(experience.knownTraps),
      JSON.stringify(experience.selectorsOrTargetHints),
      JSON.stringify(experience.frameHints),
      experience.riskLevel,
      experience.confidence,
      experience.source,
      experience.lastVerifiedAt,
      experience.expiresAt || null,
      now,
      now,
    )
    return experience
  }

  queryHints(query: BrowserSiteExperienceQuery): BrowserSiteExperienceHint[] {
    const target = parseUrl(query.url)
    if (!target.domain) return []
    const now = query.now || new Date()
    const highControl = query.highControlPlatform === true || isHighControlPlatformText(query.url)
    const rows = this.db.prepare(`
      SELECT * FROM browser_site_experience
      WHERE domain = ?
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 12
    `).all<BrowserSiteExperienceRow>(target.domain)

    return rows
      .map(rowToExperience)
      .filter((experience) => pathMatches(target.path, experience.pathPattern))
      .filter((experience) => !experience.expiresAt || new Date(experience.expiresAt).getTime() >= now.getTime())
      .filter((experience) => !query.taskKind || experience.appliesToTaskKinds.length === 0 || experience.appliesToTaskKinds.includes(query.taskKind))
      .map((experience) => buildHint(experience, highControl ? 'high' : experience.riskLevel))
  }
}
