/**
 * Phase I（2026-07-05）—— 远程会话回传桥。
 *
 * `channel_send_file` 工具（tools/builtins/channel-send-file.ts）与
 * RemoteChannelService 之间的解耦缝：工具侧只管参数校验与结构化回灌，
 * 真正的线程反查 + sidecar 发送由 runtime 构造时注册的 sender 承担。
 * 默认 null（未注册 = 渠道回传不可用），镜像 ask-user bridge 的模式，
 * 让工具模块在纯 Node 测试下可导入、sender 可注入假实现。
 */

export interface ChannelOutboundFile {
  path: string
  caption?: string
}

export interface ChannelOutboundDeliveryResult {
  success: boolean
  error?: string
  channelId?: string
  attachmentName?: string
}

export type ChannelOutboundSender = (
  scopeId: string,
  file: ChannelOutboundFile,
) => Promise<ChannelOutboundDeliveryResult>

let registeredSender: ChannelOutboundSender | null = null

export function registerChannelOutboundSender(sender: ChannelOutboundSender | null): void {
  registeredSender = sender
}

export function getChannelOutboundSender(): ChannelOutboundSender | null {
  return registeredSender
}

/** Test helper. */
export function _resetChannelOutboundBridgeForTests(): void {
  registeredSender = null
}
