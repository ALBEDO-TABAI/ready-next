import { useRef, useEffect, useMemo, useCallback } from 'react'
import type { ReactNode } from 'react'

// EP2 dogfood gap 5 — safety margin appended to the measured composer tail.
const CHAT_BOTTOM_SAFETY_MARGIN_PX = 12
// Auto-scroll only "sticks" the view to the bottom while the user is already
// near it. Once they scroll up (e.g. to read a tall 反问卡 / ask-user card that
// overflows the viewport), composer-resize-driven re-renders must NOT yank the
// view back down. 96px ≈ one short message of slack so小幅 overshoot still counts.
const CHAT_STICK_TO_BOTTOM_THRESHOLD_PX = 96
import { Copy, Check } from 'lucide-react'
import type { AgentMessage, ChatAttachment, ToolTraceEvent } from '../../stores/useAgent'
import { filterUserVisibleToolTraceEvents } from '../../modules/agent/toolTraceVisibility'
import { ToolTraceCard } from './chat-panel/task/TaskCard'
import { AskUserQuestionsCard } from './AskUserQuestionsCard'
import { GeneratedImageGallery } from './GeneratedImageGallery'
import { ThinkingIndicator } from './chat-panel/ThinkingIndicator'
import { generatedImagesFromMessage } from '../../modules/image-generation/generatedImageArtifacts'
import { submitAskUserQuestionsAnswers, cancelAskUserQuestionsCard } from '../../stores/useAgent'
import { isImageGenerationReferencePath } from '../../../shared/image-generation'
import WelcomePanel from './WelcomePanel'

// The session-tab strip + chat header overflow ~24px into the top of this
// scroll region (MotionLayer's header row is a fixed 44px). The top padding
// parks the first message below that chrome without using mask-image, which is
// unstable with transparent vibrancy windows on Chromium 148.
const CHAT_SCROLL_TOP_FADE = 38
interface ChatMessagesProps {
  messages: AgentMessage[]
  messageTaskSnapshots: Record<string, React.ReactNode>
  messageToolTraceSnapshots: Record<string, React.ReactNode>
  pendingTaskRun: React.ReactNode | null
  pendingToolTrace: React.ReactNode | null
  runDurationMeter: ReactNode
  isStreaming: boolean
  streamingMessageId: string | null
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: string | null
  toolTraceExpanded: boolean
  copiedMessageId: string | null
  showToolTraceCapsule: boolean
  bottomOverlayInset: number
  onSetInputSuggestion: (value: string) => void
  onToggleToolTrace: () => void
  onCopyMessage: (id: string, content: string) => void | Promise<void>
  onAgentSelectionContextMenu?: (event: React.MouseEvent, selectedText: string) => void
  onAttachmentPreview: (attachment: ChatAttachment) => void | Promise<void>
  onReferenceSelect: (attachment: ChatAttachment) => void
  onRevealDocumentQuote: (attachment: ChatAttachment) => void
  getDocumentQuoteTooltip: (attachment: ChatAttachment) => string
  getAttachmentMetaSummary: (attachment: ChatAttachment) => string | null
  getAttachmentPreviewSrc: (attachment: ChatAttachment) => string | null
  renderAttachmentIcon: (attachment: ChatAttachment, size?: number) => React.ReactNode
  renderMarkdown: (content: string, streaming?: boolean) => React.ReactNode
}

export default function ChatMessages({
  messages,
  messageTaskSnapshots,
  messageToolTraceSnapshots,
  pendingTaskRun,
  pendingToolTrace,
  runDurationMeter,
  isStreaming,
  streamingMessageId,
  toolTrace,
  toolTraceStatus,
  toolTraceExpanded,
  copiedMessageId,
  showToolTraceCapsule,
  bottomOverlayInset,
  onSetInputSuggestion,
  onToggleToolTrace,
  onCopyMessage,
  onAgentSelectionContextMenu,
  onAttachmentPreview,
  onReferenceSelect,
  onRevealDocumentQuote,
  getDocumentQuoteTooltip,
  getAttachmentMetaSummary,
  getAttachmentPreviewSrc,
  renderAttachmentIcon,
  renderMarkdown,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollRootRef = useRef<HTMLDivElement>(null)
  // Whether the user is currently parked near the bottom of the scroll region.
  // Starts true so the first messages anchor to the bottom as before.
  const isNearBottomRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRootRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isNearBottomRef.current = distanceFromBottom <= CHAT_STICK_TO_BOTTOM_THRESHOLD_PX
  }, [])
  // Welcome 文案是 renderer-only 的本地提示（不进 LLM 上下文）。一旦用户
  // 发出第一条消息就把它从可见列表里抹掉——视觉上"被新内容顶走"。
  const hasUserMessage = messages.some((msg) => msg.type === 'user')
  const visibleMessages = useMemo(
    () => (hasUserMessage ? messages.filter((msg) => !/^welcome(?:-|$)/.test(msg.id)) : messages),
    [messages, hasUserMessage],
  )
  // "无对话历史" 状态：只有 welcome 文案、没有任何用户消息也没有真正的 agent
  // 回复。这一状态下欢迎语应竖直居中（更像登陆页），用户一旦输入立刻进入
  // bottom-anchored 流：欢迎语从可见列表里消失，新消息从底部向上"顶"。
  const onlyWelcomePresent = !hasUserMessage && visibleMessages.every((msg) => /^welcome(?:-|$)/.test(msg.id))

  // Auto-scroll to bottom when new messages arrive — but only while the user is
  // already near the bottom. If they have scrolled up (reading a tall ask-user
  // card), composer-resize-driven inset changes must not drag the view back down.
  useEffect(() => {
    if (!isNearBottomRef.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [visibleMessages.length, bottomOverlayInset])

  const visibleGlobalToolTrace = useMemo(() => filterUserVisibleToolTraceEvents(toolTrace), [toolTrace])
  const shouldRenderGlobalToolTraceCapsule = showToolTraceCapsule
    && Object.keys(messageToolTraceSnapshots).length === 0
    && !pendingToolTrace
    && visibleGlobalToolTrace.length > 0

  return (
    <div
      ref={scrollRootRef}
      onScroll={handleScroll}
      data-liquid-scroll-root="chat-messages"
      className="panel-hover-scrollbar flex-1 overflow-auto"
      style={{
        padding: `${CHAT_SCROLL_TOP_FADE}px 16px 24px`,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        // Welcome-only state: vertically center the welcome message. Once
        // the user types, switch to bottom-anchored flow (spacer below
        // handles the rest).
        justifyContent: onlyWelcomePresent ? 'center' : 'flex-start',
      }}
    >
      {/* Welcome Card */}
      {visibleMessages.length === 0 && messages.length === 0 && (
        <WelcomePanel onSetInputSuggestion={onSetInputSuggestion} />
      )}

      {/* Bottom-anchor spacer: only active once the user has typed. When the
          welcome message is the sole content we let `justifyContent: center`
          on the parent center it instead — so the empty-state hero floats
          mid-pane rather than sticking to the input. After first user input,
          this spacer consumes the leftover vertical space so messages enter
          at the bottom and push earlier ones up. */}
      {!onlyWelcomePresent && <div style={{ marginTop: 'auto' }} aria-hidden />}

      {/* Messages */}
      {visibleMessages.map((msg, index) => {
        // agent_interaction — render the inline question card as a special
        // message. Skip the normal user/agent bubble pipeline entirely; the
        // card handles its own pending/collapsed presentation.
        if (msg.type === 'ask_user_questions' && msg.askUserQuestions) {
          return (
            <div key={msg.id} className="flex flex-col" style={{ gap: 10 }}>
              <AskUserQuestionsCard
                card={msg.askUserQuestions}
                onSubmit={submitAskUserQuestionsAnswers}
                onCancel={cancelAskUserQuestionsCard}
              />
            </div>
          )
        }
        const showMessageDivider = index < visibleMessages.length - 1 && (msg.type === 'user' || msg.type === 'agent')
        const taskSnapshot = msg.type === 'agent' ? messageTaskSnapshots[msg.id] : null
        const toolTraceSnapshot = msg.type === 'agent' ? messageToolTraceSnapshots[msg.id] : null
        const generatedImages = generatedImagesFromMessage(msg)
        const isStreamingMessage = isStreaming && msg.id === streamingMessageId

        return (
          <div key={msg.id} className="flex flex-col" style={{ gap: 10 }}>
            <div className={`flex gap-2.5 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}>
              {msg.type === 'user' ? (
                <div
                  className="max-w-[85%] t-body"
                  data-typography-role="body"
                  style={{
                    color: 'var(--text-body)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 6,
                  }}
                >
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {msg.attachments.map((att) => {
                        const referenceOrder = att.type === 'image' && isImageGenerationReferencePath(att.path)
                          ? msg.attachments!
                            .filter((item) => item.type === 'image' && isImageGenerationReferencePath(item.path))
                            .findIndex((item) => item.id === att.id) + 1
                          : 0
                        const metaSummary = referenceOrder > 0
                          ? `参考图 ${referenceOrder}`
                          : getAttachmentMetaSummary(att)
                        return (
                        <button
                          key={att.id}
                          type="button"
                          data-chat-message-attachment="true"
                          onClick={() => {
                            if (att.source === 'document-quote') {
                              onRevealDocumentQuote(att)
                              return
                            }
                            void onAttachmentPreview(att)
                          }}
                          className="flex items-center gap-1.5 rounded-md text-left chat-reference-chip"
                          style={{
                            padding: '5px 8px',
                            border: '1px solid transparent',
                            fontSize: 'var(--text-sm)',
                            color: 'var(--text-body)',
                            maxWidth: att.source === 'document-quote' ? 220 : 180,
                            cursor: 'pointer',
                          }}
                          title={att.source === 'document-quote' ? getDocumentQuoteTooltip(att) : att.name}
                        >
                          {getAttachmentPreviewSrc(att) ? (
                            <img
                              src={getAttachmentPreviewSrc(att)!}
                              alt={att.name}
                              style={{
                                width: 24,
                                height: 24,
                                objectFit: 'cover',
                                borderRadius: 6,
                                border: '1px solid var(--border-default)',
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            renderAttachmentIcon(att, 12)
                          )}
                          <span
                            style={{
                              minWidth: 0,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-start',
                              gap: 2,
                              overflow: 'hidden',
                            }}
                          >
                            <span className="truncate" style={{ maxWidth: '100%' }}>{att.name}</span>
                            {metaSummary ? (
                              <span
                                style={{
                                  fontSize: 'var(--text-xs)',
                                  lineHeight: 'var(--leading-tight)',
                                  padding: '2px 6px',
                                  borderRadius: 999,
                                  background: 'rgba(0,0,0,0.05)',
                                  color: 'var(--text-light)',
                                  maxWidth: '100%',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {metaSummary}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        )
                      })}
                    </div>
                  )}
                  {msg.content && <div style={{ whiteSpace: 'pre-wrap', textAlign: 'left' }}>{msg.content}</div>}
                </div>
              ) : msg.type === 'system' ? (
                <div
                  className="t-body-sm"
                  data-typography-role="body-sm"
                  style={{
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: 'color-mix(in srgb, var(--color-red) 10%, transparent)',
                    color: 'var(--color-red)',
                  }}
                >
                  {msg.content}
                </div>
              ) : (
                <div
                  className="group/agentmsg relative max-w-[90%] t-body"
                  data-typography-role="body"
                  style={{ color: 'var(--text-body)', paddingRight: 18 }}
                  onContextMenu={(event) => {
                    const selectedText = window.getSelection()?.toString()?.trim() || ''
                    if (!selectedText) return
                    event.preventDefault()
                    event.stopPropagation()
                    onAgentSelectionContextMenu?.(event, selectedText)
                  }}
                >
                  <div className="t-body" data-typography-role="body" style={{ color: 'var(--text-body)' }}>
                    {renderMarkdown(msg.content, isStreamingMessage)}
                  </div>
                  {generatedImages.length > 0 ? (
                    <GeneratedImageGallery
                      images={generatedImages}
                      onPreview={onAttachmentPreview}
                      onReferenceSelect={onReferenceSelect}
                    />
                  ) : null}
                  {!!msg.content?.trim() && (
                    <button
                      type="button"
                      onClick={() => { void onCopyMessage(msg.id, msg.content) }}
                      className={`absolute transition-[opacity,transform] duration-160 ease-out ${
                        copiedMessageId === msg.id
                          ? 'opacity-100 pointer-events-auto'
                          : 'opacity-0 pointer-events-none group-hover/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto'
                      }`}
                      style={{
                        right: 0,
                        bottom: -2,
                        width: 18,
                        height: 18,
                        borderRadius: 8,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '1px solid var(--border-default)',
                        color: copiedMessageId === msg.id ? 'var(--color-green)' : 'var(--text-light)',
                        background: copiedMessageId === msg.id
                          ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
                          : 'var(--surface-card-bg)',
                      }}
                      title={copiedMessageId === msg.id ? '已复制' : '复制回复'}
                    >
                      {copiedMessageId === msg.id ? (
                        <Check style={{ width: 12, height: 12 }} strokeWidth={2} />
                      ) : (
                        <Copy style={{ width: 12, height: 12 }} strokeWidth={2} />
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>

            {taskSnapshot ? (
              <div data-chat-message-task-snapshot={msg.id}>
                {taskSnapshot}
              </div>
            ) : null}

            {toolTraceSnapshot ? (
              <div data-chat-message-tool-trace={msg.id}>
                {toolTraceSnapshot}
              </div>
            ) : null}

            {showMessageDivider ? (
              <div
                data-chat-message-divider="true"
                aria-hidden="true"
                style={{
                  height: 1,
                  margin: '0 12px',
                  borderRadius: 999,
                  background: 'color-mix(in srgb, rgba(255,255,255,0.46) 42%, transparent)',
                  opacity: 0.72,
                }}
              />
            ) : null}
          </div>
        )
      })}

      {/* Tool Trace Capsule — no-projection fallback，与消息内胶囊同一组件 */}
      {shouldRenderGlobalToolTraceCapsule && (
        <div className="flex">
          <div className="max-w-[92%] w-full">
            <ToolTraceCard
              events={visibleGlobalToolTrace}
              pending={toolTraceStatus === 'running'}
              expanded={toolTraceExpanded}
              onToggleExpanded={onToggleToolTrace}
            />
          </div>
        </div>
      )}

      {isStreaming && (() => {
        const streamMsg = messages.find((m) => m.id === streamingMessageId)
        if (!streamMsg || streamMsg.content.length === 0) {
          return (
            pendingTaskRun || pendingToolTrace ? (
              <div className="flex flex-col" style={{ gap: 8 }}>
                {pendingTaskRun ? (
                  <div data-chat-pending-task-snapshot="true">
                    {pendingTaskRun}
                  </div>
                ) : null}
                {pendingToolTrace ? (
                  <div data-chat-pending-tool-trace="true">
                    {pendingToolTrace}
                  </div>
                ) : null}
              </div>
            ) : (
              <ThinkingIndicator />
            )
          )
        }
        return null
      })()}

      {runDurationMeter}

      <div data-skill-ask-user-anchor="true" aria-hidden="true" style={{ flex: '0 0 auto', width: '100%' }} />

      {!onlyWelcomePresent && bottomOverlayInset > 0 && (
        <div
          data-chat-bottom-overlay-spacer="true"
          aria-hidden="true"
          style={{
            // EP2 dogfood gap 5 — measured composer height PLUS a small
            // safety margin so expanded task cards never sit flush against
            // the composer overlay (readability near the bottom).
            flex: `0 0 ${bottomOverlayInset + CHAT_BOTTOM_SAFETY_MARGIN_PX}px`,
            minHeight: bottomOverlayInset + CHAT_BOTTOM_SAFETY_MARGIN_PX,
          }}
        />
      )}

      <div ref={messagesEndRef} />
    </div>
  )
}
