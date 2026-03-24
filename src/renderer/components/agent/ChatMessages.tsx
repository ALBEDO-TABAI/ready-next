import { useRef, useEffect } from 'react'
import { Copy, Check, ChevronRight, Wrench, CheckCircle2, CircleDashed } from 'lucide-react'
import type { AgentMessage, ChatAttachment, ToolTraceEvent } from '../../stores/useAgent'

interface ChatMessagesProps {
  messages: AgentMessage[]
  isStreaming: boolean
  streamingMessageId: string | null
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: string | null
  toolTraceExpanded: boolean
  copiedMessageId: string | null
  showToolTraceCapsule: boolean
  onSetInputSuggestion: (value: string) => void
  onToggleToolTrace: () => void
  onCopyMessage: (id: string, content: string) => void | Promise<void>
  onAttachmentPreview: (attachment: ChatAttachment) => void | Promise<void>
  onRevealDocumentQuote: (attachment: ChatAttachment) => void
  getDocumentQuoteTooltip: (attachment: ChatAttachment) => string
  getAttachmentMetaSummary: (attachment: ChatAttachment) => string | null
  getAttachmentPreviewSrc: (attachment: ChatAttachment) => string | null
  renderAttachmentIcon: (attachment: ChatAttachment, size?: number) => React.ReactNode
  renderMarkdown: (content: string) => React.ReactNode
}

export default function ChatMessages({
  messages,
  isStreaming,
  streamingMessageId,
  toolTrace,
  toolTraceStatus,
  toolTraceExpanded,
  copiedMessageId,
  showToolTraceCapsule,
  onSetInputSuggestion,
  onToggleToolTrace,
  onCopyMessage,
  onAttachmentPreview,
  onRevealDocumentQuote,
  getDocumentQuoteTooltip,
  getAttachmentMetaSummary,
  getAttachmentPreviewSrc,
  renderAttachmentIcon,
  renderMarkdown,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const hasWelcomeMessage = messages.some((msg) => /^welcome(?:-|$)/.test(msg.id))
  const totalMessageTextLength = messages.reduce((sum, msg) => sum + msg.content.trim().length, 0)
  const shouldFloatIntroBlock = (
    !showToolTraceCapsule &&
    hasWelcomeMessage &&
    messages.length > 0 &&
    messages.length <= 4 &&
    totalMessageTextLength <= 280
  )

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const latestToolEvent = toolTrace.length > 0 ? toolTrace[toolTrace.length - 1] : null

  return (
    <div
      className="panel-hover-scrollbar flex-1 overflow-auto"
      style={{
        padding: shouldFloatIntroBlock ? '20px 16px clamp(76px, 16vh, 132px)' : 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        justifyContent: shouldFloatIntroBlock ? 'center' : 'flex-start',
      }}
    >
      {/* Welcome Card */}
      {messages.length === 0 && (
        <div
          className="flex flex-col items-center"
          style={{ gap: 16, padding: '12px 16px' }}
        >
          <div
            className="flex items-center justify-center"
            style={{
              width: 40, height: 40,
              borderRadius: 10,
              background: 'var(--bg-avatar)'
            }}
          >
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-title)' }}>R</span>
          </div>

          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)' }}>Ready AI Assistant</span>

          <span
            style={{
              fontSize: 13, fontWeight: 500, color: 'var(--text-gray)',
              textAlign: 'center', lineHeight: '1.5'
            }}
          >
            你的智能工作区助手。随时提问、创作内容、分析数据。
          </span>

          {/* Quick Action Cards */}
          <div className="flex w-full" style={{ gap: 8 }}>
            <button
              onClick={() => onSetInputSuggestion('帮我分析最近的热门视频趋势')}
              className="flex-1 text-left hover:border-[var(--color-blue)] transition-all duration-200 ease-out active:scale-[0.98]"
              style={{
                padding: 12, borderRadius: 8,
                border: '1px solid var(--border-default)',
                display: 'flex', flexDirection: 'column', gap: 4
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>内容优化</span>
              <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>分析热门数据...</span>
            </button>
            <button
              onClick={() => onSetInputSuggestion('帮我写一篇关于 AI 创作的文案')}
              className="flex-1 text-left hover:border-[var(--color-blue)] transition-all duration-200 ease-out active:scale-[0.98]"
              style={{
                padding: 12, borderRadius: 8,
                border: '1px solid var(--border-default)',
                display: 'flex', flexDirection: 'column', gap: 4
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>写作文案</span>
              <span style={{ fontSize: 11, color: 'var(--text-gray)' }}>创作优质内容...</span>
            </button>
          </div>
        </div>
      )}

      {/* Tool Trace Capsule */}
      {showToolTraceCapsule && (
        <div className="flex">
          <div
            className="max-w-[92%] w-full"
            style={{
              borderRadius: 12,
              border: '1px solid var(--border-default)',
              background: 'color-mix(in srgb, var(--surface-card-bg) 24%, transparent)',
              overflow: 'hidden',
              backdropFilter: 'blur(16px) saturate(132%)',
              WebkitBackdropFilter: 'blur(16px) saturate(132%)',
            }}
          >
            <button
              type="button"
              onClick={onToggleToolTrace}
              className="w-full text-left"
              style={{
                padding: '8px 10px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
                <div
                  className="flex items-center justify-center"
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: 'color-mix(in srgb, var(--color-blue) 12%, transparent)',
                    color: 'var(--color-blue)',
                    flexShrink: 0,
                  }}
                >
                  {toolTraceStatus === 'running'
                    ? <CircleDashed style={{ width: 12, height: 12 }} className="animate-spin" strokeWidth={2} />
                    : <CheckCircle2 style={{ width: 12, height: 12 }} strokeWidth={2} />}
                </div>
                <Wrench style={{ width: 13, height: 13, color: 'var(--text-gray)', flexShrink: 0 }} strokeWidth={2} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--text-body)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {toolTraceStatus === 'running'
                      ? '工具调用中'
                      : toolTraceStatus === 'error'
                        ? '工具调用失败'
                        : toolTraceStatus === 'cancelled'
                          ? '工具调用已停止'
                          : '工具调用结束'}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text-gray)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginTop: 1,
                    }}
                  >
                    {latestToolEvent?.text || (isStreaming ? '准备执行网页/文档操作…' : '本次会话没有额外工具输出。')}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-light)', flexShrink: 0 }}>
                  {toolTrace.length} 条
                </div>
                <ChevronRight
                  style={{
                    width: 13,
                    height: 13,
                    color: 'var(--text-light)',
                    transform: toolTraceExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 180ms ease',
                    flexShrink: 0,
                  }}
                  strokeWidth={2}
                />
              </button>

              {toolTraceExpanded && (
                <div
                  style={{
                    padding: '8px 10px 10px',
                    borderTop: '1px solid var(--border-default)',
                    background: 'var(--bg-secondary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    maxHeight: 180,
                    overflowY: 'auto',
                  }}
                >
                  {toolTrace.map((event) => (
                    <div
                      key={event.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-body)',
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ color: event.kind === 'call' ? 'var(--color-blue)' : 'var(--color-green)', marginTop: 1 }}>
                        {event.kind === 'call' ? '•' : '✓'}
                      </span>
                      <div style={{ minWidth: 0, flex: 1, wordBreak: 'break-word' }}>{event.text}</div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      )}

      {/* Messages */}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex gap-2.5 ${msg.type === 'user' ? 'flex-row-reverse' : ''}`}
        >
          {msg.type === 'user' ? (
            <div
              className="max-w-[85%] text-[13px] leading-relaxed"
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
                  {msg.attachments.map((att) => (
                    <button
                      key={att.id}
                      type="button"
                      onClick={() => {
                        if (att.source === 'document-quote') {
                          onRevealDocumentQuote(att)
                          return
                        }
                        void onAttachmentPreview(att)
                      }}
                      className="flex items-center gap-1.5 rounded-md text-left transition-all duration-150 hover:border-[var(--color-blue)]"
                      style={{
                        padding: '5px 8px',
                        background: att.source === 'document-quote'
                          ? 'color-mix(in srgb, var(--color-blue) 10%, transparent)'
                          : 'var(--surface-card-bg)',
                        border: '1px solid var(--border-default)',
                        fontSize: 11,
                        color: att.source === 'document-quote' ? 'var(--color-blue)' : 'var(--text-gray)',
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
                        {getAttachmentMetaSummary(att) ? (
                          <span
                            style={{
                              fontSize: 10,
                              lineHeight: 1.1,
                              padding: '2px 6px',
                              borderRadius: 999,
                              background: att.source === 'document-quote'
                                ? 'rgba(255,255,255,0.68)'
                                : 'rgba(0,0,0,0.04)',
                              color: att.source === 'document-quote' ? 'var(--color-blue)' : 'var(--text-light)',
                              maxWidth: '100%',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {getAttachmentMetaSummary(att)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {msg.content && <div style={{ whiteSpace: 'pre-wrap', textAlign: 'right' }}>{msg.content}</div>}
            </div>
          ) : msg.type === 'system' ? (
            <div
              className="text-[12px] leading-relaxed"
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
              className="group/agentmsg relative max-w-[90%] text-[13px] leading-relaxed"
              style={{ color: 'var(--text-body)', paddingRight: 18 }}
            >
              <div style={{ fontSize: 13, color: 'var(--text-body)', lineHeight: 1.6 }}>
                {renderMarkdown(msg.content)}
              </div>
              {!!msg.content?.trim() && (
                <button
                  type="button"
                  onClick={() => { void onCopyMessage(msg.id, msg.content) }}
                  className={`absolute transition-all duration-160 ease-out ${
                    copiedMessageId === msg.id
                      ? 'opacity-100 pointer-events-auto'
                      : 'opacity-0 pointer-events-none group-hover/agentmsg:opacity-100 group-hover/agentmsg:pointer-events-auto'
                  }`}
                  style={{
                    right: 0,
                    bottom: -2,
                    width: 18,
                    height: 18,
                    borderRadius: 9,
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
      ))}

      {isStreaming && (() => {
        const streamMsg = messages.find((m) => m.id === streamingMessageId)
        if (!streamMsg || streamMsg.content.length === 0) {
          return (
            <div className="flex items-center gap-3" style={{ padding: '2px 0 4px' }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'var(--bg-avatar)' }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-title)' }}>R</span>
              </div>
              <div className="flex items-center gap-2.5" style={{ color: 'var(--text-gray)' }}>
                <span style={{ fontSize: 12, fontWeight: 500 }}>思考中</span>
                <div className="flex items-center gap-1.5" aria-label="agent-thinking">
                  <span
                    className="animate-pulse"
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 999,
                      background: 'var(--color-blue)',
                      opacity: 0.5,
                      animationDelay: '0ms',
                    }}
                  />
                  <span
                    className="animate-pulse"
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 999,
                      background: 'var(--color-blue)',
                      opacity: 0.5,
                      animationDelay: '180ms',
                    }}
                  />
                  <span
                    className="animate-pulse"
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 999,
                      background: 'var(--color-blue)',
                      opacity: 0.5,
                      animationDelay: '360ms',
                    }}
                  />
                </div>
              </div>
            </div>
          )
        }
        return null
      })()}

      <div ref={messagesEndRef} />
    </div>
  )
}
