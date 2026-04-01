import type {
  RSSAnalysisAction,
  RSSAnalysisJob,
  RSSAnalysisJobStatus,
  RSSDraftStoreSourceSummary,
  RSSItem,
  RSSSource,
  RSSStats,
} from '../database'
import { getDatabase } from '../database'

export class RSSRepository {
  getSetting(key: string): string | undefined {
    return getDatabase().getSetting(key)
  }

  setSetting(key: string, value: string): void {
    getDatabase().setSetting(key, value)
  }

  getRSSSources(): RSSSource[] {
    return getDatabase().getRSSSources()
  }

  addRSSSource(source: { name: string; url: string; group?: string; icon?: string; platform?: string }): string {
    return getDatabase().addRSSSource(source)
  }

  updateRSSSourcePlatform(id: string, platform: string): void {
    getDatabase().updateRSSSourcePlatform(id, platform)
  }

  removeRSSSource(id: string): void {
    getDatabase().removeRSSSource(id)
  }

  getRSSItems(sourceId?: string): RSSItem[] {
    return getDatabase().getRSSItems(sourceId)
  }

  getAllRSSItems(sourceId?: string): RSSItem[] {
    return getDatabase().getAllRSSItems(sourceId)
  }

  getRSSItemsWithSource(sourceId?: string): Array<RSSItem & { source_name: string }> {
    return getDatabase().getRSSItemsWithSource(sourceId)
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
    ai_tags?: string | null
  }>): number {
    return getDatabase().upsertRSSItems(items)
  }

  markRSSRead(itemId: string): void {
    getDatabase().markRSSRead(itemId)
  }

  markRSSReadMany(itemIds: string[]): number {
    return getDatabase().markRSSReadMany(itemIds)
  }

  deleteRSSItems(itemIds: string[]): number {
    return getDatabase().deleteRSSItems(itemIds)
  }

  dismissRSSItemsFromInbox(itemIds: string[], preserveStarred = false): number {
    return getDatabase().dismissRSSItemsFromInbox(itemIds, preserveStarred)
  }

  deleteRSSItemsBySource(sourceId: string): number {
    return getDatabase().deleteRSSItemsBySource(sourceId)
  }

  toggleRSSStarred(itemId: string): void {
    getDatabase().toggleRSSStarred(itemId)
  }

  updateRSSSourceLastFetched(sourceId: string): void {
    getDatabase().updateRSSSourceLastFetched(sourceId)
  }

  setRSSSourceDraftSeeded(sourceId: string, seeded: boolean): void {
    getDatabase().setRSSSourceDraftSeeded(sourceId, seeded)
  }

  getRSSItemsByIds(itemIds: string[]): RSSItem[] {
    return getDatabase().getRSSItemsByIds(itemIds)
  }

  getRSSDraftStoreSources(): RSSDraftStoreSourceSummary[] {
    return getDatabase().getRSSDraftStoreSources()
  }

  clearRSSDraftStore(sourceId?: string): { deletedItems: number; resetSources: number } {
    return getDatabase().clearRSSDraftStore(sourceId)
  }

  getLatestPerSource(): RSSItem[] {
    return getDatabase().getLatestPerSource()
  }

  getRSSStats(): RSSStats {
    return getDatabase().getRSSStats()
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
    return getDatabase().createRSSAnalysisJob(payload)
  }

  getRSSAnalysisJob(jobId: string): RSSAnalysisJob | null {
    return getDatabase().getRSSAnalysisJob(jobId)
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
    return getDatabase().updateRSSAnalysisJob(jobId, patch)
  }

  listRSSAnalysisJobs(itemId?: string, limit = 50): RSSAnalysisJob[] {
    return getDatabase().listRSSAnalysisJobs(itemId, limit)
  }

  deleteRSSAnalysisJob(jobId: string): boolean {
    return getDatabase().deleteRSSAnalysisJob(jobId)
  }

  findActiveRSSAnalysisJob(itemId: string, action: RSSAnalysisAction): RSSAnalysisJob | null {
    return getDatabase().findActiveRSSAnalysisJob(itemId, action)
  }

  getLatestRSSAnalysisByItemIds(itemIds: string[]): Record<string, RSSAnalysisJob> {
    return getDatabase().getLatestRSSAnalysisByItemIds(itemIds)
  }

  markInterruptedRSSAnalysisJobs(): number {
    return getDatabase().markInterruptedRSSAnalysisJobs()
  }

  cleanupRSSAnalysisJobs(retentionDays: number, maxRows: number): number {
    return getDatabase().cleanupRSSAnalysisJobs(retentionDays, maxRows)
  }
}
