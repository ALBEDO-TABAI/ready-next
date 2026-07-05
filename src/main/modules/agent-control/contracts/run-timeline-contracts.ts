/**
 * Phase D D1（2026-07-05）—— run-timeline 事件单源信封。
 *
 * run 家族五通道（stream/status/error/scopeRunEvent/conversationEvent）此前
 * 由 ipc-handler 十个裸 `webContents.send` 各自发射，负载形状靠约定。D1 起
 * 全部经 run-timeline-emitter 单点发射，并在负载上盖 `timeline` 戳：
 * 版本 + 通道名 + 发射时刻。renderer 现有字段读取零影响（纯增量字段）；
 * 后续消费侧可凭 stamp 做旁路检测、乱序诊断与单源断言（D3 gate）。
 */

export const RUN_TIMELINE_CHANNELS = [
  'agent:stream',
  'agent:status',
  'agent:error',
  'agent:scopeRunEvent',
  'agent:conversationEvent',
] as const

export type RunTimelineChannel = typeof RUN_TIMELINE_CHANNELS[number]

export interface RunTimelineStamp {
  /** 信封版本；形状演进时递增，消费侧按版本窄化 */
  v: 1
  /** 发射通道名——负载自证来源，防"错频道发对形状"类旁路 */
  channel: RunTimelineChannel
  /** 主进程发射时刻（ISO）；renderer 侧乱序/迟到诊断的一手时间基 */
  at: string
}

export interface RunTimelineEnvelope extends Record<string, unknown> {
  timeline: RunTimelineStamp
}
