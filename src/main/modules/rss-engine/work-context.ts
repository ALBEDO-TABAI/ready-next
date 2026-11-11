import type { RSSWorkPrivacy, RSSWorkEntry, RSSWorkContextSnapshot } from '../../../shared/rss-sieve'
export interface RSSWorkContextSources {
  pages(): { id: string; title: string; editedAt: number }[]
  projects(): { title: string; active: boolean }[]
  calendar(): { title: string; startsAt: number }[]
  books(): { id?: string; title: string; reading: boolean }[]
}
/** Only the supplied title projections may cross this boundary. No bodies, paths or metadata are serialized. */
export function buildRSSWorkContext(sources: RSSWorkContextSources, privacy: RSSWorkPrivacy, excluded: readonly string[], now: number): RSSWorkContextSnapshot {
  const week = 7 * 86400000
  const titles = [
    ...(privacy.pages ? sources.pages().filter(p => !excluded.includes(p.id) && p.editedAt >= now - week && p.editedAt <= now).sort((a, b) => b.editedAt - a.editedAt || a.id.localeCompare(b.id)).slice(0, 12).map(p => ({title:p.title,kind:'page' as const})) : []),
    ...(privacy.pages ? sources.projects().filter(p => p.active).map(p => ({title:p.title,kind:'project' as const})) : []),
    ...(privacy.calendar ? sources.calendar().filter(e => e.startsAt >= now && e.startsAt < now + week).sort((a, b) => a.startsAt - b.startsAt).slice(0, 8).map(e => ({title:e.title,kind:'calendar' as const})) : []),
    ...(privacy.books ? sources.books().filter(b => b.reading && (!b.id || !excluded.includes(b.id))).map(b => ({title:b.title,kind:'book' as const})) : []),
  ]
  const result: RSSWorkEntry[] = []
  for (const entry of titles) {
    const { title } = entry
    // Keep titles whole so the model can cite only an exact, independently addressable entry.
    if (!title.trim() || /[\r\n]/.test(title) || result.some(value => value.title === title)) continue
    if ([...result.map(value => value.title), title].join('\n').length <= 800) result.push(entry)
  }
  return { text:result.map(value => value.title).join('\n'),entries:result }
}
