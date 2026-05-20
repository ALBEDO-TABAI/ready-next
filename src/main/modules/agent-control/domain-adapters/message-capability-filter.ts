/**
 * Stage U (PR 2) — message-capability filter.
 *
 * Bridges a real gap in Ready's capability handling: today
 * `run-capability-controller` filters **tools** by `supportsVision`, but
 * neither the SDK runtime (`agent-sdk-runtime.ts`) nor the legacy
 * DirectChatEngine clients (`openai-execution-client.ts`,
 * `anthropic-execution-client.ts`) filter **message content** by the same
 * capability. As a result, if turn N attaches an image and turn N+1 routes
 * to a vision-off model, the provider rejects the request with 400.
 *
 * Two pure helpers, paired with explicit caller responsibility:
 *
 *   - `assertCurrentMessageCapability(blocks, cap)`: called at the entry
 *     point where a NEW user message enters the runtime. Vision-off model
 *     + image block → throws `ToolDomainError('provider_request_failed', …)`
 *     with `recoverable:false`, so the renderer surfaces a config-style
 *     error (NOT a silent strip). This is the G3 "current turn must be
 *     rejected before the request goes out" contract.
 *
 *   - `sanitizeHistoricalMessagesByCapability(messages, cap)`: called at
 *     the provider request build point, where ALL remaining image/video
 *     blocks must be historical residue (because the current turn was
 *     already gated). Strips them and replaces empty content with a text
 *     placeholder so the model knows there was prior media it can no longer
 *     see. Returns counts so the call site can emit
 *     `provider_request_capability_filter` metric.
 *
 * Types are deliberately neutral (`CapabilityBlock` / `CapabilityMessage`)
 * — the helper imports neither `ChatMessage` from `direct-chat.ts` nor
 * `AgentInputItem` from the SDK. Callers adapt at the boundary.
 */

import { ToolDomainError } from '../../tools/tool-errors'

export interface CapabilityBlock {
  type: string
  text?: string
  // Other provider-specific fields (image url / video url / source / etc.)
  // are tunneled untouched. The helper only inspects `type`.
  [key: string]: unknown
}

export interface CapabilityMessage {
  role: string
  // Content is either a flat string (text-only) or a list of typed blocks
  // (multimodal). String content cannot contain image/video blocks so the
  // helper passes it through unmodified.
  content: string | CapabilityBlock[]
  // Other fields (tool_calls, reasoning_content, providerData, …) are
  // tunneled untouched.
  [key: string]: unknown
}

export interface MessageCapabilitySnapshot {
  /** Strictly === true to count as "supported". `undefined` and `false`
   *  both block image content — conservative default per §6.26. */
  supportsVision: boolean
  /** Same strict-true semantics for video. */
  supportsVideo: boolean
}

export interface CapabilityFilterDecision {
  filtered: CapabilityMessage[]
  removedImageBlocks: number
  removedVideoBlocks: number
  /** Number of messages where the entire content array was emptied by
   *  filtering and we substituted a single placeholder text block. */
  replacedWithPlaceholders: number
}

const IMAGE_KIND_NAMES = new Set([
  'image',          // legacy ChatMessage shape
  'image_url',      // openai chat-completions
  'input_image',    // openai responses api / agent SDK
])

const VIDEO_KIND_NAMES = new Set([
  'video',
  'video_url',
])

function isImageBlock(block: CapabilityBlock): boolean {
  return IMAGE_KIND_NAMES.has(block.type)
}

function isVideoBlock(block: CapabilityBlock): boolean {
  return VIDEO_KIND_NAMES.has(block.type)
}

function makePlaceholderText(removedImages: number, removedVideos: number): string {
  const parts: string[] = []
  if (removedImages > 0) parts.push(`${removedImages} 张图片`)
  if (removedVideos > 0) parts.push(`${removedVideos} 段视频`)
  if (parts.length === 0) return ''
  return `[此前一轮包含 ${parts.join(' / ')}；当前模型不支持视觉/视频输入，已省略]`
}

/**
 * Sanitize a list of HISTORY messages (everything except the current turn).
 * Image/video blocks are removed when the matching capability is `!== true`.
 * If filtering empties an array-style content payload, a placeholder text
 * block is substituted so the model is aware media was present.
 *
 * Non-array content (plain string) and non-image/video blocks pass through.
 * Other top-level fields on the message (role, tool_calls, reasoning_content,
 * providerData, etc.) are preserved verbatim.
 */
export function sanitizeHistoricalMessagesByCapability(
  messages: ReadonlyArray<CapabilityMessage>,
  cap: MessageCapabilitySnapshot,
): CapabilityFilterDecision {
  const visionOn = cap.supportsVision === true
  const videoOn = cap.supportsVideo === true
  // Fast path: both capabilities on → nothing to do.
  if (visionOn && videoOn) {
    return {
      filtered: messages.slice() as CapabilityMessage[],
      removedImageBlocks: 0,
      removedVideoBlocks: 0,
      replacedWithPlaceholders: 0,
    }
  }
  let removedImageBlocks = 0
  let removedVideoBlocks = 0
  let replacedWithPlaceholders = 0
  const filtered: CapabilityMessage[] = messages.map((msg) => {
    if (typeof msg.content === 'string') return { ...msg }
    const blocks = msg.content
    const kept: CapabilityBlock[] = []
    let perMsgImagesDropped = 0
    let perMsgVideosDropped = 0
    for (const block of blocks) {
      if (!visionOn && isImageBlock(block)) {
        perMsgImagesDropped += 1
        removedImageBlocks += 1
        continue
      }
      if (!videoOn && isVideoBlock(block)) {
        perMsgVideosDropped += 1
        removedVideoBlocks += 1
        continue
      }
      kept.push(block)
    }
    if (perMsgImagesDropped === 0 && perMsgVideosDropped === 0) {
      // Untouched — same content reference.
      return { ...msg }
    }
    if (kept.length === 0) {
      replacedWithPlaceholders += 1
      const placeholder: CapabilityBlock = {
        type: 'text',
        text: makePlaceholderText(perMsgImagesDropped, perMsgVideosDropped),
      }
      return { ...msg, content: [placeholder] }
    }
    return { ...msg, content: kept }
  })
  return { filtered, removedImageBlocks, removedVideoBlocks, replacedWithPlaceholders }
}

/**
 * Convenience wrapper used by SDK runtime + legacy DirectChatEngine clients
 * alike. Takes a provider-formatted message array and a capability snapshot,
 * runs `sanitizeHistoricalMessagesByCapability`, and reports the decision
 * via a caller-supplied metric sink. The caller stays responsible for
 * resolving the snapshot from its config — that's intentional, the helper
 * does not import the AIModelConfig shape.
 */
export function applyCapabilityFilterForRoute<TMessage extends Record<string, unknown>>(
  rawMessages: ReadonlyArray<TMessage>,
  cap: MessageCapabilitySnapshot,
  metricSink: (decision: CapabilityFilterDecision) => void,
): TMessage[] {
  if (cap.supportsVision === true && cap.supportsVideo === true) {
    return rawMessages.slice()
  }
  const decision = sanitizeHistoricalMessagesByCapability(
    rawMessages as unknown as CapabilityMessage[],
    cap,
  )
  if (decision.removedImageBlocks > 0 || decision.removedVideoBlocks > 0) {
    metricSink(decision)
  }
  return decision.filtered as unknown as TMessage[]
}

/**
 * Assert that a CURRENT-turn message body is compatible with the resolved
 * capability. Vision-off + image block → throws. Vision-off + video block →
 * throws. This is intentionally the loud path (not silent strip) so the
 * user sees "current model doesn't support media" as a config error before
 * the request would have 400'd.
 *
 * Empty / text-only content is always allowed.
 */
export function assertCurrentMessageCapability(
  blocks: ReadonlyArray<CapabilityBlock> | undefined,
  cap: MessageCapabilitySnapshot,
): void {
  if (!blocks || blocks.length === 0) return
  const visionOn = cap.supportsVision === true
  const videoOn = cap.supportsVideo === true
  let hasImage = false
  let hasVideo = false
  for (const block of blocks) {
    if (!visionOn && isImageBlock(block)) hasImage = true
    if (!videoOn && isVideoBlock(block)) hasVideo = true
    if (hasImage && hasVideo) break
  }
  if (!hasImage && !hasVideo) return
  const parts: string[] = []
  if (hasImage) parts.push('图片')
  if (hasVideo) parts.push('视频')
  throw new ToolDomainError(
    'provider_request_failed',
    `当前 AI 模型不支持${parts.join('/')}输入，请切换到支持视觉的模型，或移除${parts.join('/')}附件后重试。`,
    { hasImage, hasVideo, recoverable: false },
  )
}
