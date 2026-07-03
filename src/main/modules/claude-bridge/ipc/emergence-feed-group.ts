/**
 * 梯队三（2026-07-03）— emergence feed 通电的组装通道。
 *
 * `emergence-cards.ts` 的确定性提取器 + 本 group 的信号注入 = feed 产出。
 * 拉取式生产：renderer 打开/刷新 feed 面时组装一次（信号源都是即时读，
 * 无失效缓存问题），每次组装打 `emergence_feed_assembled` 账本（正向 gate
 * 断言存在）。当前接入四类信号（resume/follow_up/crystallize/agent-candidate）；
 * prepare/harvest/forming 的信号采集（日历联动/产物打开跟踪/文件聚类）
 * 尚无数据源，提取器保留在 emergence-cards.ts 待接。
 *
 * 卡片动作出口由 renderer 落地：resume/adjudicate/supply → 打开对应 scope；
 * adopt_candidate/review_duplicate → 跳设置页确认面（涌现卡永不一键采纳）。
 */
import type { IpcMain } from 'electron'
import {
  assembleEmergenceFeed,
  extractAgentCandidateCards,
  extractCrystallizeCards,
  extractFollowUpCards,
  extractResumeCards,
  type AgentCandidateFeedSignal,
  type CrystallizeSignalCard,
  type EmergenceCard,
} from '../../agent-control/emergence/emergence-cards'
import type { TaskProjectionRecord } from '../../agent-control/contracts/run-contracts'
import { logAgentMetric } from '../../agent-control/metrics'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

interface IPCResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/** feed 卡 + renderer 落地动作所需的最小定位信息。 */
export interface EmergenceFeedEntry {
  card: EmergenceCard
  /** resume/follow_up 卡的宿主 scope；知识类卡为 null（出口在设置页）。 */
  scopeId: string | null
}

export interface EmergenceFeedGroupDeps {
  listRecentProjections: (limit: number) => TaskProjectionRecord[]
  listCrystallizeSignals: () => CrystallizeSignalCard[]
  listCandidateSignals: () => AgentCandidateFeedSignal[]
}

const CHANNELS = ['agent:emergence:feed'] as const
const PROJECTION_SCAN_LIMIT = 50

export function assembleFeedEntries(deps: EmergenceFeedGroupDeps): EmergenceFeedEntry[] {
  const projections = deps.listRecentProjections(PROJECTION_SCAN_LIMIT)
  const scopeByTaskId = new Map<string, string>()
  for (const record of projections) {
    if (record.taskId && record.scopeId) scopeByTaskId.set(String(record.taskId), String(record.scopeId))
  }

  const cards = assembleEmergenceFeed([
    ...extractResumeCards(projections),
    ...extractFollowUpCards(projections),
    ...extractCrystallizeCards(deps.listCrystallizeSignals()),
    ...extractAgentCandidateCards(deps.listCandidateSignals()),
  ])

  const entries = cards.map((card) => ({
    card,
    scopeId: card.action.kind === 'resume_task' || card.action.kind === 'adjudicate_task' || card.action.kind === 'supply_input'
      ? scopeByTaskId.get(card.action.ref) ?? null
      : null,
  }))

  const byType: Record<string, number> = {}
  for (const entry of entries) byType[entry.card.type] = (byType[entry.card.type] ?? 0) + 1
  logAgentMetric('emergence_feed_assembled', { count: entries.length, byType })
  return entries
}

export const emergenceFeedGroup: IpcChannelGroup<EmergenceFeedGroupDeps> = {
  namespace: 'agent:emergence',

  register(ipcMain: IpcMain, deps: EmergenceFeedGroupDeps): IpcDisposeHandle {
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('agent:emergence:feed', async (): Promise<IPCResponse<EmergenceFeedEntry[]>> => {
      try {
        return { success: true, data: assembleFeedEntries(deps) }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose() {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
        }
      },
    }
  },
}

export const _emergenceFeedGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
