import { useConversationReveal } from '../../modules/agent/conversation-navigation'
import { Fragment, useRef, useEffect, useMemo, useCallback, useState } from 'react'
import type { ReactNode } from 'react'

// EP2 dogfood gap 5 — safety margin appended to the measured composer tail.
const CHAT_BOTTOM_SAFETY_MARGIN_PX = 12
// Auto-scroll only "sticks" the view to the bottom while the user is already
// near it. Once they scroll up (e.g. to read a tall 反问卡 / ask-user card that
// overflows the viewport), composer-resize-driven re-renders must NOT yank the
// view back down. 96px ≈ one short message of slack so小幅 overshoot still counts.
const CHAT_STICK_TO_BOTTOM_THRESHOLD_PX = 96
import { Copy, Check, RotateCcw } from 'lucide-react'
import type { AgentMessage, AgentArtifact, ChatAttachment, ToolTraceEvent } from '../../stores/useAgent'
import { useAgent } from '../../stores/useAgent'
import { useMode } from '../../stores/useMode'
import { productTurnActionProjectionMatchesContext } from '../../modules/agent/productTurnReceipt'
import { filterUserVisibleToolTraceEvents } from '../../modules/agent/toolTraceVisibility'
import { ToolTraceCard } from './chat-panel/task/TaskCard'
import { BrowserTaskRunCards } from './chat-panel/task/BrowserTaskCard'
import { AskUserQuestionsCard } from './AskUserQuestionsCard'
import { GeneratedImageGallery } from './GeneratedImageGallery'
import { ThinkingIndicator } from './chat-panel/ThinkingIndicator'
import {
  generatedImagesFromArtifacts,
  generatedImagesFromMessage,
} from '../../modules/image-generation/generatedImageArtifacts'
import { submitAskUserQuestionsAnswers, cancelAskUserQuestionsCard } from '../../stores/useAgent'
import type { CalendarAttachmentDisplayRef } from '../../../shared/calendar-event-identity'
import { parseReadyUri, toReadyUri } from '../../../shared/ready-ref'
import { isImageGenerationReferencePath } from '../../../shared/image-generation'
import WelcomePanel from './WelcomePanel'
import { renderInline } from './chat-panel/markdown'
import SkillAskUserPrompt from '../skill/SkillAskUserPrompt'
import type {
  CodexConversationContextBoundary,
  CodexProductTurnActionProjection,
} from '../../../shared/ipc-contracts/agent-runtime'

// The session-tab strip + chat header overflow ~24px into the top of this
// scroll region (MotionLayer's header row is a fixed 44px). The top padding
// parks the first message below that chrome without using mask-image, which is
// unstable with transparent vibrancy windows on Chromium 148.
const CHAT_SCROLL_TOP_FADE = 38
interface ChatMessagesProps {
  messages: AgentMessage[]
  contextBoundaries: CodexConversationContextBoundary[]
  messageTaskSnapshots: Record<string, React.ReactNode>
  messageGeneratedImageArtifacts: Record<string, AgentArtifact[]>
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
  productTurnActionProjectionByRunId: Record<string, CodexProductTurnActionProjection>
  showToolTraceCapsule: boolean
  bottomOverlayInset: number
  onSetInputSuggestion: (value: string) => void
  onToggleToolTrace: () => void
  onCopyMessage: (id: string, content: string) => void | Promise<void>
  onRetryProductTurn?: (readyRunId: string) => void | Promise<void>
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
  contextBoundaries,
  messageTaskSnapshots,
  messageGeneratedImageArtifacts,
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
  productTurnActionProjectionByRunId,
  showToolTraceCapsule,
  bottomOverlayInset,
  onSetInputSuggestion,
  onToggleToolTrace,
  onCopyMessage,
  onRetryProductTurn,
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
  const displayKey = JSON.stringify(messages.filter(msg => msg.type === 'user' && msg.attachments?.length).map(msg => msg.id))
  const [displayRefs, setDisplayRefs] = useState<
    { key: string; status: 'ready'; rows: CalendarAttachmentDisplayRef[] }
    | { key: string; status: 'error'; reason: string } | null
  >(null)
  useEffect(() => {
    if (displayKey === '[]') return
    let cancelled = false
    void (async () => {
      try {
        const result = await window.electronAPI.calendar.getAttachmentDisplayRefs(JSON.parse(displayKey))
        if (!result.success || !result.data) throw new Error(result.error || '历史附件展示读取失败')
        if (!cancelled) setDisplayRefs({ key: displayKey, status: 'ready', rows: result.data })
      } catch (error) {
        console.warn('[ChatMessages] load attachment display references failed:', error instanceof Error ? error.message : String(error))
        if (!cancelled) setDisplayRefs({ key: displayKey, status: 'error', reason: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { cancelled = true }
  }, [displayKey])
  const displayState = displayRefs?.key === displayKey ? displayRefs : null
  const revealTarget = useConversationReveal(state => state.target)
  const conversationId = useAgent(state => state.conversationId)
  const head = useAgent((state) => state.activeSessionId
    ? state.sessions[state.activeSessionId]?.scopeHeadActionProjection ?? null : null)
  const workbenchMode = useMode((state) => state.workbenchMode)
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
  const hasLiveActivity = isStreaming || Boolean(pendingTaskRun) || Boolean(pendingToolTrace)
  // "无对话历史" 状态：只有 welcome 文案、没有任何用户消息也没有真正的 agent
  // 回复。这一状态下欢迎语应竖直居中（更像登陆页），用户一旦输入立刻进入
  // bottom-anchored 流：欢迎语从可见列表里消失，新消息从底部向上"顶"。
  const onlyWelcomePresent = !hasLiveActivity
    && !hasUserMessage
    && visibleMessages.every((msg) => /^welcome(?:-|$)/.test(msg.id))

  // Auto-scroll to bottom when new messages arrive — but only while the user is
  // already near the bottom. If they have scrolled up (reading a tall ask-user
  // card), composer-resize-driven inset changes must not drag the view back down.
  useEffect(() => {
    if (revealTarget?.scopeId === conversationId || !isNearBottomRef.current) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [visibleMessages.length, bottomOverlayInset, revealTarget, conversationId])
  useEffect(() => {
    if (!revealTarget) return
    if (revealTarget.scopeId !== conversationId) { useConversationReveal.setState({ target: null }); return }
    const node = Array.from(scrollRootRef.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []).find(node => node.dataset.messageId === revealTarget.messageId)
    if (!node) return
    isNearBottomRef.current = false
    node.scrollIntoView({ block: 'start' })
    useConversationReveal.setState({ target: null })
  }, [revealTarget, conversationId, visibleMessages])

  // A run's reply can stream in several segments; its browser task cards go under the last one.
  const lastReplyIdByRun = useMemo(() => {
    const last = new Map<string, string>()
    for (const msg of visibleMessages) {
      if (msg.type === 'agent' && typeof msg.meta?.runId === 'string') last.set(msg.meta.runId, msg.id)
    }
    return last
  }, [visibleMessages])

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
      {visibleMessages.length === 0 && messages.length === 0 && !hasLiveActivity && (
        <WelcomePanel onSetInputSuggestion={onSetInputSuggestion} />
      )}

      {/* Bottom-anchor spacer: only active once the user has typed. When the
          welcome message is the sole content we let `justifyContent: center`
          on the parent center it instead — so the empty-state hero floats
          mid-pane rather than sticking to the input. After first user input,
          this spacer consumes the leftover vertical space so messages enter
          at the bottom and push earlier ones up. */}
      {!onlyWelcomePresent && <div style={{ marginTop: 'auto' }} aria-hidden />}

      {contextBoundaries.filter((boundary) => boundary.previousVisibleMessageAnchor === null).map(
        (boundary) => (
          <div key={boundary.operationId} data-ready-context-boundary={boundary.operationId} role="separator">
            从这里开始新的上下文
          </div>
        ),
      )}

      {/* Messages */}
      {visibleMessages.map((msg) => {
        const boundaryMarkers = contextBoundaries.filter(
          (boundary) => boundary.previousVisibleMessageAnchor === msg.id,
        ).map((boundary) => (
          <div key={boundary.operationId} data-ready-context-boundary={boundary.operationId} role="separator">
            从这里开始新的上下文
          </div>
        ))
        // agent_interaction — render the inline question card as a special
        // message. Skip the normal user/agent bubble pipeline entirely; the
        // card handles its own pending/collapsed presentation.
        if (msg.type === 'ask_user_questions' && msg.askUserQuestions) {
          return (
            <Fragment key={msg.id}>
              <div
                data-chat-message-ask-user={msg.id}
                className="flex flex-col max-w-[90%] w-full"
                style={{ gap: 10, paddingRight: 18, boxSizing: 'border-box' }}
              >
                <AskUserQuestionsCard
                  card={msg.askUserQuestions}
                  onSubmit={submitAskUserQuestionsAnswers}
                  onCancel={cancelAskUserQuestionsCard}
                />
              </div>
              {boundaryMarkers}
            </Fragment>
          )
        }
        const taskSnapshot = msg.type === 'agent' ? messageTaskSnapshots[msg.id] : null
        const toolTraceSnapshot = msg.type === 'agent' ? messageToolTraceSnapshots[msg.id] : null
        const generatedImages = generatedImagesFromArtifacts([
          ...generatedImagesFromMessage(msg),
          ...(messageGeneratedImageArtifacts[msg.id] || []),
        ])
        const isStreamingMessage = isStreaming && msg.id === streamingMessageId
        const messageRunId = msg.type === 'agent' && typeof msg.meta?.runId === 'string'
          ? msg.meta.runId
          : null
        const retryRunId = messageRunId
          && productTurnActionProjectionByRunId[messageRunId]?.retry_failed_task.availability === 'ready'
          && productTurnActionProjectionMatchesContext(
            productTurnActionProjectionByRunId[messageRunId], head, workbenchMode,
          )
          ? messageRunId
          : null

        return (
          <div key={msg.id} data-message-id={msg.id} className="flex flex-col" style={{ gap: 10 }}>
            {taskSnapshot ? (
              <div
                data-chat-message-task-snapshot={msg.id}
                className="max-w-[90%] w-full"
                style={{ paddingRight: 18, boxSizing: 'border-box' }}
              >
                {taskSnapshot}
              </div>
            ) : null}

            {toolTraceSnapshot ? (
              <div
                data-chat-message-tool-trace={msg.id}
                className="max-w-[90%] w-full"
                style={{ paddingRight: 18, boxSizing: 'border-box' }}
              >
                {toolTraceSnapshot}
              </div>
            ) : null}

            <div className={`flex gap-2.5 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}>
              {msg.type === 'user' ? (
                <div
                  className="ready-chat-user-message max-w-[85%] t-body"
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
                      {msg.attachments.map((original, attachmentIndex) => {
                        const target = displayState?.status === 'ready'
                          ? displayState.rows.find(row => row.messageId === msg.id && row.attachmentIndex === attachmentIndex)?.target : undefined
                        const att: ChatAttachment = target?.status === 'resolved'
                          ? { ...original, source: 'calendar-event', path: toReadyUri(target.ref) } : original
                        const calendarRef = displayState?.status === 'ready' && att.source === 'calendar-event' ? parseReadyUri(att.path) : null
                        const unlocatable = target?.status === 'unlocatable' ? target.reason
                          : calendarRef && (!calendarRef.ok || calendarRef.ref.kind !== 'event') ? att.description || '缺少有效的日程引用' : null
                        const displayError = displayState?.status === 'error' ? displayState.reason : null
                        const label = unlocatable ? (att.name.endsWith('（无法定位）') ? att.name : `${att.name}（无法定位）`) : displayError ? `${att.name}（读取失败）` : att.name
                        const tooltip = !displayState ? '正在读取历史附件' : unlocatable ? `无法定位：${unlocatable}` : displayError || (att.source === 'calendar-event' ? `${att.name}\n${att.path}` : att.name)

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
                          disabled={!displayState || !!unlocatable || !!displayError}
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
                            cursor: !displayState || unlocatable || displayError ? 'default' : 'pointer',
                          }}
                          title={att.source === 'document-quote' && !displayError ? getDocumentQuoteTooltip(att) : tooltip}
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
                            <span className="truncate" style={{ maxWidth: '100%' }}>{label}</span>
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
                  {msg.content && (
                    <div className="ready-chat-user-message-content" style={{ whiteSpace: 'pre-wrap' }}>
                      {renderInline(
                        msg.content,
                        Object.fromEntries(
                          (msg.attachments || [])
                            .filter((item) => item.name && item.path)
                            .map((item) => [item.name, { path: item.path, kind: item.source || item.type }]),
                        ),
                      )}
                    </div>
                  )}
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
                  {(!!msg.content?.trim() || retryRunId) && (
                    <div
                      className={`absolute flex items-center gap-1 transition-[opacity,transform] duration-160 ease-out ${
                        copiedMessageId === msg.id
                          ? 'opacity-100 pointer-events-auto'
                          : 'opacity-0 pointer-events-none group-hover/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto'
                      }`}
                      style={{
                        right: 0,
                        bottom: -2,
                      }}
                    >
                      {retryRunId && onRetryProductTurn ? (
                        <button
                          type="button"
                          onClick={() => { void onRetryProductTurn(retryRunId) }}
                          className="flex items-center justify-center"
                          style={{
                            width: 18, height: 18, borderRadius: 8,
                            border: '1px solid var(--border-default)',
                            color: 'var(--text-light)', background: 'var(--surface-card-bg)',
                          }}
                          title="从已保留的结果继续重试"
                          aria-label="再试一次"
                        >
                          <RotateCcw style={{ width: 12, height: 12 }} strokeWidth={2} />
                        </button>
                      ) : null}
                      {msg.content?.trim() ? (
                        <button
                          type="button"
                          onClick={() => { void onCopyMessage(msg.id, msg.content) }}
                          className="flex items-center justify-center"
                          style={{
                            width: 18, height: 18, borderRadius: 8,
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
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* The run's browser tasks: what they need from the person, the files they downloaded (W7). */}
            {messageRunId && lastReplyIdByRun.get(messageRunId) === msg.id ? <BrowserTaskRunCards runId={messageRunId} /> : null}

            {boundaryMarkers}
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

      {isStreaming ? (
        <div data-chat-live-activity="true" className="flex flex-col" style={{ gap: 6 }}>
          {(() => {
            const streamMsg = messages.find((m) => m.id === streamingMessageId)
            if (!streamMsg || streamMsg.content.length === 0) {
              return (
                pendingTaskRun || pendingToolTrace ? (
                  <div className="flex flex-col" style={{ gap: 8 }}>
                    {pendingTaskRun ? (
                      <div
                        data-chat-pending-task-snapshot="true"
                        className="max-w-[90%] w-full"
                        style={{ paddingRight: 18, boxSizing: 'border-box' }}
                      >
                        {pendingTaskRun}
                      </div>
                    ) : null}
                    {pendingToolTrace ? (
                      <div
                        data-chat-pending-tool-trace="true"
                        className="max-w-[90%] w-full"
                        style={{ paddingRight: 18, boxSizing: 'border-box' }}
                      >
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
        </div>
      ) : runDurationMeter}

      <SkillAskUserPrompt />

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
