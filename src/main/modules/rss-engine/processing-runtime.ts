import type { AIModelConfig } from '../../../shared/ai-providers'
import { BrowserWindow } from 'electron'
import { getDatabase } from '../database'
import { completeRSSModel, validateRSSModelRequest } from './model-completion'
import { hasRSSProcessingModel, rssModelConfig, setRSSProviderReadiness } from './model-readiness'
import { RSS_JUDGMENT_INSTRUCTIONS } from './processing-judgment'
import { RSSProcessingService } from './processing-service'

export { hasRSSProcessingModel } from './model-readiness'

let service: RSSProcessingService | null = null
export function notifyRSSProcessing(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('rss:organizationChanged')
  }
}
export function getRSSProcessingService(): RSSProcessingService {
  if (!service) {
    const rss = getDatabase().rss
    service = new RSSProcessingService({ store: rss.processing, getArticle: (id) => rss.content.getArticle(id),
      hasModel: hasRSSProcessingModel, now: () => Date.now(), notify: notifyRSSProcessing,
      prepare: (input, jobId) => {
        const config = rssModelConfig()
        const request = { system: RSS_JUDGMENT_INSTRUCTIONS, user: JSON.stringify(input), maxTokens: 6000, runId: jobId }
        validateRSSModelRequest(config, request)
        return (signal) => completeRSSModel(config, { ...request, signal })
      },
    })
  }
  return service
}
export function startRSSProcessing(options?: { isProviderReady(config: AIModelConfig): boolean }): Promise<void> {
  if (options) setRSSProviderReadiness(options.isProviderReady)
  return getRSSProcessingService().start()
}
export async function stopRSSProcessing(): Promise<void> { await service?.stop() }
export function wakeRSSProcessing(): void { if (service) void service.wake() }
