/**
 * EP3-PK3 — packet execution-channel dispatch (09 §3.2 channel table) +
 * verbatim brief injection (05 §4 最小传话铁律).
 * P5c/C22 unwired: this module is not in production path.
 *
 * Channel selection is a STATIC LOOKUP over declared packet traits — never
 * a model judgment. The three channels:
 *   - chat_turn:        same agent, needs conversation context (steps_json
 *                       sequential execution in the current session);
 *   - subagent:         same agent, independent / parallel / long-running
 *                       (runSubAgent with the verbatim brief injected);
 *   - background_task:  browser collection / skill long tasks
 *                       (browser_tasks / skill_task_runs; terminal events
 *                       return via the C2.1 event bridge).
 * Unknown traits fail fast — there is no default channel.
 *
 * The brief carries the user's ORIGINAL words byte-for-byte
 * (`userRequestVerbatim`) plus structured refs. Building a brief never
 * rewrites, trims, normalizes, or summarizes the verbatim text; an empty
 * verbatim is a hard error (a paraphrase pipeline would produce one).
 */

import { validatePacketFields } from './packet-fields'
import type { CompiledChildPacket } from './packet-compiler'

export type PacketChannel = 'chat_turn' | 'subagent' | 'background_task'

export const PACKET_CHANNELS: ReadonlyArray<PacketChannel> = ['chat_turn', 'subagent', 'background_task']

export type PacketWorkKind = 'general' | 'browser_collection' | 'skill_long_task'

export interface PacketTraits {
  /** Declared by planner CODE from the packet's compiled shape. */
  kind: PacketWorkKind
  needsConversationContext: boolean
  longRunningOrParallel: boolean
}

/** 09 §3.2 — the static channel table. No default row: unknown kinds throw. */
export function resolvePacketChannel(traits: PacketTraits): PacketChannel {
  switch (traits.kind) {
    case 'browser_collection':
    case 'skill_long_task':
      return 'background_task'
    case 'general':
      if (traits.needsConversationContext) return 'chat_turn'
      if (traits.longRunningOrParallel) return 'subagent'
      return 'chat_turn'
    default:
      throw new Error(`[packet-dispatch] unknown packet kind: ${String((traits as { kind?: unknown }).kind)} — 查表无默认行，fail-fast`)
  }
}

export interface PacketDispatchBrief {
  /** 用户原话逐字片段 — 禁止转述、改写、拼接摘要（05 §4）。 */
  userRequestVerbatim: string
  /** Structured references only (file paths / card slugs / packet ids). */
  contextRefs: string[]
  /** The packet's single acceptance deliverable (compile-time fixed). */
  deliverable: string
  title: string
}

/**
 * Build the brief for one compiled child packet. The verbatim text passes
 * through UNCHANGED — no trim, no normalization, no truncation.
 */
export function buildPacketBrief(input: {
  userRequestVerbatim: string
  child: CompiledChildPacket
}): PacketDispatchBrief {
  if (typeof input.userRequestVerbatim !== 'string' || input.userRequestVerbatim.length === 0) {
    throw new Error('[packet-dispatch] userRequestVerbatim is required — 跨层转发只传用户原话逐字')
  }
  validatePacketFields({ packetRole: 'child', contextRefs: input.child.contextRefs })
  if (!input.child.deliverable.trim()) {
    throw new Error('[packet-dispatch] child packet without a deliverable cannot dispatch')
  }
  return {
    userRequestVerbatim: input.userRequestVerbatim,
    contextRefs: [...input.child.contextRefs],
    deliverable: input.child.deliverable,
    title: input.child.title,
  }
}

export type PacketChannelExecutor = (brief: PacketDispatchBrief) => Promise<unknown> | unknown

export type PacketChannelExecutors = Partial<Record<PacketChannel, PacketChannelExecutor>>

export interface PacketDispatchResult {
  channel: PacketChannel
  result: unknown
}

/** Resolve the channel by table, then hand the brief to that executor.
 *  A missing executor for a resolved channel is a hard error — packets
 *  never silently fall back to a different channel. */
export async function dispatchPacket(opts: {
  brief: PacketDispatchBrief
  traits: PacketTraits
  executors: PacketChannelExecutors
}): Promise<PacketDispatchResult> {
  const channel = resolvePacketChannel(opts.traits)
  const executor = opts.executors[channel]
  if (!executor) {
    throw new Error(`[packet-dispatch] no executor registered for channel ${channel} — 不存在静默降级通道`)
  }
  return { channel, result: await executor(opts.brief) }
}
