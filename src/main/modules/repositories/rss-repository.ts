import type { RSSAnalysisAction, RSSAnalysisJob, RSSAnalysisJobStatus, RSSDraftStoreSourceSummary, RSSItem, RSSSource, RSSStats } from '../database/records'

import { getDatabase } from '../database'

export class RSSRepository {
  getOrganizationStore() { return getDatabase().rss.organization }

  getContentStore() {
    return getDatabase().rss.content
  }

  getSetting(key: string): string | undefined {
    return getDatabase().settings.getSetting(key)
  }

  setSetting(key: string, value: string): void {
    getDatabase().settings.setSetting(key, value)
  }

  getRSSSources(): RSSSource[] {
    return getDatabase().rss.getRSSSources()
  }

  addRSSSource(source: { name: string; url: string; group?: string; icon?: string; platform?: string }): string {
    return getDatabase().rss.addRSSSource(source)
  }

  updateRSSSourcePlatform(id: string, platform: string): void {
    getDatabase().rss.updateRSSSourcePlatform(id, platform)
  }

  removeRSSSource(id: string): void {
    getDatabase().rss.removeRSSSource(id)
  }

  getRSSItems(sourceId?: string): RSSItem[] {
    return getDatabase().rss.getRSSItems(sourceId)
  }

  getAllRSSItems(sourceId?: string): RSSItem[] {
    return getDatabase().rss.getAllRSSItems(sourceId)
  }

  getRSSItemsWithSource(sourceId?: string): Array<RSSItem & { source_name: string }> {
    return getDatabase().rss.getRSSItemsWithSource(sourceId)
  }

  upsertRSSItems(items: Array<{
    id: string
    source_id: string
    guid: string
    title: string
    link: string
    summary?: string | null
    cover_image?: string | null
    author?: string | null
    published_at?: number | null
  }>): number {
    return getDatabase().rss.upsertRSSItems(items)
  }

  markRSSRead(itemId: string): void {
    getDatabase().rss.markRSSRead(itemId)
  }

  markRSSReadMany(itemIds: string[]): number {
    return getDatabase().rss.markRSSReadMany(itemIds)
  }

  deleteRSSItems(itemIds: string[]): number {
    return getDatabase().rss.deleteRSSItems(itemIds)
  }

  dismissRSSItemsFromInbox(itemIds: string[], preserveStarred = false): number {
    return getDatabase().rss.dismissRSSItemsFromInbox(itemIds, preserveStarred)
  }

  deleteRSSItemsBySource(sourceId: string): number {
    return getDatabase().rss.deleteRSSItemsBySource(sourceId)
  }

  toggleRSSStarred(itemId: string): void {
    getDatabase().rss.toggleRSSStarred(itemId)
  }

  updateRSSSourceLastFetched(sourceId: string): void {
    getDatabase().rss.updateRSSSourceLastFetched(sourceId)
  }

  setRSSSourceDraftSeeded(sourceId: string, seeded: boolean): void {
    getDatabase().rss.setRSSSourceDraftSeeded(sourceId, seeded)
  }

  getRSSItemsByIds(itemIds: string[]): RSSItem[] {
    return getDatabase().rss.getRSSItemsByIds(itemIds)
  }

  getRSSDraftStoreSources(): RSSDraftStoreSourceSummary[] {
    return getDatabase().rss.getRSSDraftStoreSources()
  }

  clearRSSDraftStore(sourceId?: string): { deletedItems: number; resetSources: number } {
    return getDatabase().rss.clearRSSDraftStore(sourceId)
  }

  getLatestPerSource(): RSSItem[] {
    return getDatabase().rss.getLatestPerSource()
  }

  getRSSStats(): RSSStats {
    return getDatabase().rss.getRSSStats()
  }

  createRSSAnalysisJob(payload: {
    id: string
    itemId: string
    action: RSSAnalysisAction
    sourceUrl: string
    title: string
    targetDir: string
    outputDir: string
    status: RSSAnalysisJobStatus
    progress: number
    message?: string | null
    error?: string | null
    reportPath?: string | null
    metaJson?: string | null
    startedAt?: string | null
    finishedAt?: string | null
  }): RSSAnalysisJob {
    return getDatabase().rss.createRSSAnalysisJob(payload)
  }

  getRSSAnalysisJob(jobId: string): RSSAnalysisJob | null {
    return getDatabase().rss.getRSSAnalysisJob(jobId)
  }

  updateRSSAnalysisJob(
    jobId: string,
    patch: Partial<{
      status: RSSAnalysisJobStatus
      progress: number
      message: string | null
      error: string | null
      reportPath: string | null
      metaJson: string | null
      startedAt: string | null
      finishedAt: string | null
      outputDir: string
    }>,
  ): RSSAnalysisJob | null {
    return getDatabase().rss.updateRSSAnalysisJob(jobId, patch)
  }

  listRSSAnalysisJobs(itemId?: string, limit = 50): RSSAnalysisJob[] {
    return getDatabase().rss.listRSSAnalysisJobs(itemId, limit)
  }

  deleteRSSAnalysisJob(jobId: string): boolean {
    return getDatabase().rss.deleteRSSAnalysisJob(jobId)
  }

  findActiveRSSAnalysisJob(itemId: string, action: RSSAnalysisAction): RSSAnalysisJob | null {
    return getDatabase().rss.findActiveRSSAnalysisJob(itemId, action)
  }

  getLatestRSSAnalysisByItemIds(itemIds: string[]): Record<string, RSSAnalysisJob> {
    return getDatabase().rss.getLatestRSSAnalysisByItemIds(itemIds)
  }

  markInterruptedRSSAnalysisJobs(): number {
    return getDatabase().rss.markInterruptedRSSAnalysisJobs()
  }

  cleanupRSSAnalysisJobs(retentionDays: number, maxRows: number): number {
    return getDatabase().rss.cleanupRSSAnalysisJobs(retentionDays, maxRows)
  }
}
