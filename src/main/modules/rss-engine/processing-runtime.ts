import { startRSSSieve, stopRSSSieve } from './sieve-runtime'
import { sendableCurrentRSSWorkContext } from './work-context-runtime'
import { getRSSContentService } from './content-runtime'
import type { AIModelConfig } from '../../../shared/ai-providers'
import { BrowserWindow } from 'electron'
import { getDatabase } from '../database'
import { completeRSSModel, validateRSSModelRequest } from './model-completion'
import { hasRSSProcessingModel, rssModelConfig, setRSSProviderReadiness } from './model-readiness'
import { buildRSSJudgmentRequest } from './processing-judgment'
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
      loadArticle: (id) => getRSSContentService().loadForJudgment(id),
      focus: () => rss.sieve.focus().text,
      workContext: () => sendableCurrentRSSWorkContext(),
      hasModel: hasRSSProcessingModel, now: () => Date.now(), notify: notifyRSSProcessing,
      prepare: (input, jobId) => {
        const config = rssModelConfig()
        if (!config) throw new Error('请先在 Ready 中配置用于资讯分析的模型。')
        const request = buildRSSJudgmentRequest(input, jobId, config)
        validateRSSModelRequest(config, request)
        return (signal) => completeRSSModel(config, { ...request, signal })
      },
    })
  }
  return service
}
export function startRSSProcessing(options: { isProviderReady(config: AIModelConfig): boolean; getWindow(): BrowserWindow | null }): Promise<void> {
  setRSSProviderReadiness(options.isProviderReady)
  return Promise.all([getRSSProcessingService().start(), startRSSSieve(options.getWindow)]).then(() => undefined)
}
export async function stopRSSProcessing(): Promise<void> { await Promise.all([stopRSSSieve(), service?.stop()]) }
export function wakeRSSProcessing(): void { if (service) void service.wake() }
