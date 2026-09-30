import { BrowserWindow } from 'electron'
import { getDatabase } from '../database'
import { RSSDigestService } from './digest-service'
import { listRouteAttempts } from './source-diagnostics'
import { RSSDigestGenerateSchema, type RSSDigestGenerateInput } from '../../../shared/rss-digests'

let service: RSSDigestService | null = null
const fetches = () => listRouteAttempts().map((a) => ({ sourceId: a.sourceId, success: a.success, attemptedAt: a.attemptedAt, warning: a.warning, error: a.lastRouteError?.message || null }))
export function notifyRSSDigests(): void {
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('rss:digestsChanged')
}
export function getRSSDigestService(): RSSDigestService {
  if (!service) service = new RSSDigestService({ store: getDatabase().rss.digests, now: Date.now, timezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone, notify: notifyRSSDigests, fetches })
  return service
}
export async function startRSSDigests(): Promise<void> { await getRSSDigestService().start() }
export function stopRSSDigests(): void { service?.stop() }
export async function resumeRSSDigests(): Promise<void> { if (service) await service.resume() }
export function generateRSSDigest(input: RSSDigestGenerateInput) {
  const params = RSSDigestGenerateSchema.parse(input), store = getDatabase().rss.digests, now = Date.now()
  const report = params.kind === 'regenerate' ? store.regenerate(params.reportId, now, fetches()) : store.generate({ kind: 'range', from: params.query.from ?? 0,
    until: params.query.until ?? now, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, query: params.query, fetches: fetches() }, now)
  notifyRSSDigests(); return report
}
