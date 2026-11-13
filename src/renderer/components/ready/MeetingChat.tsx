import { READY_REF_MIME, readReadyRefTransfer } from '../../../shared/ready-ref'
import { useRef, useEffect, useState, useCallback } from 'react'
import { useAgent } from '../../stores/useAgent'

interface MeetingChatProps {
  onFileDrop?: (filePath: string, fileName: string) => void
}

/**
 * MeetingChat (420px) — Ready conversation panel.
 * - User messages: right-aligned, blue background
 * - Agent replies: left-aligned, white background with avatar
 * - System notifications: centered, gray
 * - Auto-scroll + typing indicator
 * - File drop zone for drag-from-FilePanel
 * - Listens for new-file events and shows notifications
 * - Detects file paths in agent messages and highlights them
 */
export default function MeetingChat({ onFileDrop }: MeetingChatProps) {
  const { messages, isStreaming, addMessage } = useAgent()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isStreaming])

  // Listen for new-file events from FilePanel (Task 8)
  useEffect(() => {
    const handler = (e: CustomEvent<{ name: string; path: string }>) => {
      addMessage({
        id: `newfile-${Date.now()}`,
        agent: 'system',
        content: `新文件已创建: ${e.detail.name}`,
        type: 'system',
        timestamp: new Date()
      })
    }
    window.addEventListener('ready:new-file', handler as EventListener)
    return () => window.removeEventListener('ready:new-file', handler as EventListener)
  }, [addMessage])

  // Detect file paths in agent messages and dispatch highlight event (Task 8)
  useEffect(() => {
    if (messages.length === 0) return
    const lastMsg = messages[messages.length - 1]
    if (lastMsg.type !== 'agent') return
    // Simple file path detection: matches /path/to/file.ext patterns
    const filePathRegex = /(?:^|\s)(\/[\w\-./]+\.\w+)/g
    let match: RegExpExecArray | null
    while ((match = filePathRegex.exec(lastMsg.content)) !== null) {
      window.dispatchEvent(
        new CustomEvent('ready:highlight-file', { detail: { path: match[1] } })
      )
    }
  }, [messages])

  // File drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.types.includes(READY_REF_MIME)) {
      setIsDragOver(true)
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const dropped = readReadyRefTransfer(e.dataTransfer)
    if (dropped?.ref.kind === 'file' || dropped?.ref.kind === 'page') {
      void window.electronAPI.objects.locate(dropped.ref.id).then(location => {
        if (location) onFileDrop?.(location.path, dropped.title)
      }).catch(error => console.warn('[MeetingChat] drop failed', error))
    }
  }, [onFileDrop])

  return (
    <div
      className="flex-shrink-0 flex flex-col"
      style={{
        width: 420,
        // The conversation is a region on the window glass (DL1): no background of its own, a hairline to its right.
        borderRight: '.5px solid var(--rn-hair)',
        position: 'relative'
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {isDragOver && (
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 20,
            // The drop target is "here" (DL5): the signal colour, as the document tree marks its drop targets.
            background: 'color-mix(in srgb, var(--rn-accent) 8%, transparent)',
            border: '2px dashed var(--rn-accent)',
            borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none'
          }}
        >
          <div style={{
            padding: '12px 24px', borderRadius: 12,
            background: 'var(--rn-solid)',
            boxShadow: 'var(--rn-shadow-2)',
            fontSize: 13, fontWeight: 500, color: 'var(--rn-accent-text)'
          }}>
            拖放文件到此处添加附件
          </div>
        </div>
      )}

      {/* Chat Header */}
      <div
        className="flex items-center justify-between flex-shrink-0"
        style={{
          padding: '10px 16px',
          borderBottom: '.5px solid var(--rn-hair)'
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--rn-ink)' }}>
          Ready 对话
        </span>
      </div>

      {/* Chat Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
        style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {/* Welcome */}
        <div className="text-center" style={{ padding: '32px 16px' }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--rn-ink)', marginBottom: 8 }}>
            Ready 已准备就绪
          </div>
          <div style={{ fontSize: 12, color: 'var(--rn-ink-2)', lineHeight: '1.6' }}>
            任务进展与产物会显示在这里。
            <br />
            你也可以拖入文件作为当前任务的附件。
          </div>
        </div>

        {/* Message List */}
        {messages.map((msg) => {
          // System notifications — centered gray
          if (msg.type === 'system') {
            return (
              <div key={msg.id} className="flex justify-center" style={{ padding: '4px 0' }}>
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--rn-ink-3)',
                    background: 'var(--rn-fill)',
                    padding: '4px 12px',
                    borderRadius: 8,
                    maxWidth: '80%',
                    textAlign: 'center'
                  }}
                >
                  {msg.content}
                </span>
              </div>
            )
          }

          // User messages — right-aligned, blue
          if (msg.type === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div style={{ maxWidth: '75%' }}>
                  <div className="flex items-center justify-end" style={{ gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--rn-ink-3)', fontFamily: 'var(--rn-font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                      {msg.timestamp.toLocaleTimeString()}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--rn-ink)' }}>
                      我
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12, color: 'var(--rn-ink)', lineHeight: '1.5',
                      background: 'var(--rn-fill-2)',
                      borderRadius: '12px 4px 12px 12px',
                      padding: '8px 12px',
                      wordBreak: 'break-word'
                    }}
                  >
                    {msg.content}
                  </div>
                </div>
              </div>
            )
          }

          // Agent replies — left-aligned, white with avatar
          return (
            <div key={msg.id} className="flex" style={{ gap: 8 }}>
              <div
                className="flex items-center justify-center flex-shrink-0"
                style={{
                  width: 28, height: 28,
                  borderRadius: 8,
                  background: 'var(--rn-fill-2)',
                  marginTop: 2
                }}
              >
                <span style={{ fontSize: 12 }}>
                  {'\u{1F916}'}
                </span>
              </div>
              <div className="flex-1 min-w-0" style={{ maxWidth: '75%' }}>
                <div className="flex items-center" style={{ gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--rn-ink)' }}>
                    Ready
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--rn-ink-3)', fontFamily: 'var(--rn-font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                    {msg.timestamp.toLocaleTimeString()}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 12, color: 'var(--rn-ink)', lineHeight: '1.5',
                    background: 'var(--rn-inlay)',
                    border: '.5px solid var(--rn-hair-2)',
                    borderRadius: '4px 12px 12px 12px',
                    padding: '8px 12px',
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap'
                  }}
                >
                  {msg.content}
                </div>
              </div>
            </div>
          )
        })}

        {/* Typing indicator */}
        {isStreaming && (
          <div className="flex items-center" style={{ gap: 8, padding: '4px 0' }}>
            <div
              className="flex items-center justify-center flex-shrink-0"
              style={{
                width: 28, height: 28,
                borderRadius: 8,
                background: 'var(--rn-fill-2)'
              }}
            >
              <span style={{ fontSize: 12 }}>{'\u{1F916}'}</span>
            </div>
            <div
              className="flex items-center"
              style={{
                gap: 4,
                background: 'var(--rn-inlay)',
                border: '.5px solid var(--rn-hair-2)',
                borderRadius: 12,
                padding: '8px 14px'
              }}
            >
              <span
                className="animate-pulse"
                style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--rn-ink-3)', display: 'inline-block' }}
              />
              <span
                className="animate-pulse"
                style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--rn-ink-3)', display: 'inline-block', animationDelay: '0.15s' }}
              />
              <span
                className="animate-pulse"
                style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--rn-ink-3)', display: 'inline-block', animationDelay: '0.3s' }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
