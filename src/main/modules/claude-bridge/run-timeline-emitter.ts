/**
 * Phase D D1（2026-07-05）—— run-timeline 唯一发射漏斗。
 *
 * 合同：run 家族五通道的 `webContents.send` 全仓只允许出现在本文件
 * （check-run-timeline-single-source gate 钉死）；所有发射经 stampRunTimeline
 * 盖信封戳。窗口已销毁时静默不发（与旧调用点的 isDestroyed 守卫同义，
 * 收敛到漏斗内防遗漏）。
 */
import type { BrowserWindow } from 'electron'
import {
  type RunTimelineChannel,
  type RunTimelineStamp,
} from '../agent-control/contracts/run-timeline-contracts'

function stampRunTimeline(channel: RunTimelineChannel, now: () => Date): RunTimelineStamp {
  return { v: 1, channel, at: now().toISOString() }
}

export function emitRunTimelineEvent(
  window: BrowserWindow | null,
  channel: RunTimelineChannel,
  payload: Record<string, unknown>,
  deps?: { now?: () => Date },
): boolean {
  if (!window || window.isDestroyed()) return false
  const now = deps?.now ?? (() => new Date())
  window.webContents.send(channel, {
    ...payload,
    timeline: stampRunTimeline(channel, now),
  })
  return true
}
