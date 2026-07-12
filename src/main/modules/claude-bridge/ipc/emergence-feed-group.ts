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
import type { FileEmergenceIntentCard } from '../../../../shared/file-emergence'
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
  listFileIntentCards?: () => Promise<FileEmergenceIntentCard[]>
}

const CHANNELS = ['agent:emergence:feed'] as const
const PROJECTION_SCAN_LIMIT = 50

/**
 * 真机反馈（2026-07-03）：同名任务多次尝试会产生多个 taskId 不同、标题相同
 * 的可续跑投影，feed 里全量展示是纯噪声。按 (type + title) 去重，保留
 * 提取顺序里最先出现的一张（投影列表按 recent 排序，先出现者最新）。
 */
function dedupeByTypeAndTitle(cards: ReadonlyArray<EmergenceCard>): EmergenceCard[] {
  const seen = new Set<string>()
  const out: EmergenceCard[] = []
  for (const card of cards) {
    const key = card.projectKey ? `${card.type}|project:${card.projectKey}` : `${card.type}|${card.title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(card)
  }
  return out
}

export function assembleFeedEntries(deps: EmergenceFeedGroupDeps, fileIntentCards: readonly FileEmergenceIntentCard[] = []): EmergenceFeedEntry[] {
  const projections = deps.listRecentProjections(PROJECTION_SCAN_LIMIT)
  const scopeByTaskId = new Map<string, string>()
  for (const record of projections) {
    if (record.taskId && record.scopeId) scopeByTaskId.set(String(record.taskId), String(record.scopeId))
  }

  const cards = assembleEmergenceFeed(dedupeByTypeAndTitle([
    ...extractResumeCards(projections),
    ...extractFollowUpCards(projections),
    ...extractCrystallizeCards(deps.listCrystallizeSignals()),
    ...extractAgentCandidateCards(deps.listCandidateSignals()),
    ...fileIntentCards.flatMap(fileIntentCardToEmergenceCard),
  ]))

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
        const fileIntentCards = await deps.listFileIntentCards?.() ?? []
        return { success: true, data: assembleFeedEntries(deps, fileIntentCards) }
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

function fileIntentCardToEmergenceCard(card: FileEmergenceIntentCard): EmergenceCard[] {
  if (card.action.kind !== 'open_project' && card.action.kind !== 'open_artifact' && card.action.kind !== 'open_project_group') return []
  if (!card.projectKey || !card.action.ref || card.evidence.length === 0) return []
  return [{
    id: card.id,
    projectKey: card.projectKey,
    type: card.type,
    title: card.type === 'prepare' ? `接下来要准备：${card.title}` : card.type === 'forming' ? `正在成形：${card.title}` : `已完成产物：${card.title}`,
    evidence: card.evidence.map((item) => ({fact:item.fact,ref:item.ref ?? `project:${card.projectKey}`})),
    confidence: card.confidence,
    action: {kind:card.action.kind,ref:card.action.ref,targetPath:card.action.targetPath,memberPaths:card.action.memberPaths},
    requiresExplicitConfirm: false,
  }]
}
