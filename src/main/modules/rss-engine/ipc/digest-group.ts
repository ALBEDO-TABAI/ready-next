import { z } from 'zod'
import type { IpcChannelGroup } from './types'
import type { RSSDigestStore } from '../../database/rss-digest-store'
import type { RSSDigestService } from '../digest-service'
import { RSSDigestReadSchema, RSSDigestSettingsSchema, RSSDigestGenerateSchema, type RSSDigestGenerateInput, type RSSDigestHeader, type RSSDigestSource, type RSSDigestCriteria, type RSSDigestCoverageSource } from '../../../../shared/rss-digests'
import { writeNewText } from '../workspace-files'
import { renderRSSDigest } from '../../../../shared/rss-digest-markdown'

const CHANNELS = ['rss:readDigests', 'rss:digestSettings', 'rss:configureDigests', 'rss:generateDigest', 'rss:exportDigest'] as const
export const digestGroup: IpcChannelGroup<{
  store(): RSSDigestStore; service(): RSSDigestService; generate(input: RSSDigestGenerateInput): RSSDigestHeader;
  chooseDirectory(sender: Electron.WebContents): Promise<string | null>;
}> = { namespace: 'rss:digests', register(ipcMain, deps) {
  for (const name of CHANNELS) ipcMain.removeHandler(name)
  const respond = async (action: () => unknown | Promise<unknown>) => {
    try { return { success: true, data: await action() } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle('rss:readDigests', (_e, input) => respond(() => deps.store().read(RSSDigestReadSchema.parse(input || {}))))
  ipcMain.handle('rss:digestSettings', () => respond(() => deps.store().schedule()))
  ipcMain.handle('rss:configureDigests', (_e, input) => respond(async () => { await deps.service().configure(RSSDigestSettingsSchema.parse(input)); return deps.store().schedule() }))
  ipcMain.handle('rss:generateDigest', (_e, input) => respond(() => deps.generate(RSSDigestGenerateSchema.parse(input))))
  ipcMain.handle('rss:exportDigest', (e, input) => respond(async () => {
    const { reportId } = z.object({ reportId: z.string().min(1) }).strict().parse(input)
    const folder = await deps.chooseDirectory(e.sender)
    if (!folder) return { canceled: true }
    const store = deps.store(), first = store.read({ view: 'entries', reportId })
    if (first.view !== 'entries') throw new Error('刊物读取失败')
    const entries = [...first.entries]; let offset = first.nextOffset
    while (offset !== null) { const page = store.read({ view: 'entries', reportId, offset }); if (page.view !== 'entries') throw new Error('刊物读取失败'); entries.push(...page.entries); offset = page.nextOffset }
    const sources = entries.flatMap((entry) => {
      const all: RSSDigestSource[] = []; let offset: number | null = 0
      while (offset !== null) { const page = store.read({ view: 'sources', reportId, groupKey: entry.groupKey, offset }); if (page.view !== 'sources') throw new Error('依据读取失败'); all.push(...page.sources); offset = page.nextOffset }
      return [{ ...entry, sources: all }]
    })
    const criteria: RSSDigestCriteria[] = [], coverage: RSSDigestCoverageSource[] = []
    for (const view of ['criteria', 'coverage'] as const) {
      let offset: number | null = 0
      while (offset !== null) {
        const page = store.read({ view, reportId, offset })
        if (page.view === 'criteria') criteria.push(...page.criteria)
        else if (page.view === 'coverage') coverage.push(...page.sources)
        else throw new Error('刊物范围读取失败')
        offset = page.nextOffset
      }
    }
    const text = renderRSSDigest(first.report, sources, criteria, coverage)
    const path = await writeNewText(folder, `RSS-${first.report.kind === 'daily' ? '日报' : '范围简报'}-${new Date(first.report.until).toISOString().slice(0, 10)}-v${first.report.version}`, 'md', text, () => {})
    return { canceled: false, path, reportId }
  }))
  return { dispose: () => { for (const name of CHANNELS) ipcMain.removeHandler(name) } }
} }
