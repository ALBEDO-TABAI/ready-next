import { X } from 'lucide-react'
import type { ChatAttachment } from '../../stores/useAgent'

interface ChatAttachmentsProps {
  attachments: ChatAttachment[]
  onRemove: (id: string) => void
  onPreview: (attachment: ChatAttachment) => void | Promise<void>
  onRevealDocumentQuote: (attachment: ChatAttachment) => void
  getDocumentQuoteTooltip: (attachment: ChatAttachment) => string
  getAttachmentMetaSummary: (attachment: ChatAttachment) => string | null
  renderAttachmentIcon: (attachment: ChatAttachment, size?: number) => React.ReactNode
  toLocalFileUrl: (path: string) => string
}

export default function ChatAttachments({
  attachments,
  onRemove,
  onPreview,
  onRevealDocumentQuote,
  getDocumentQuoteTooltip,
  getAttachmentMetaSummary,
  renderAttachmentIcon,
  toLocalFileUrl,
}: ChatAttachmentsProps) {
  if (attachments.length === 0) return null

  return (
    <div className="flex items-center gap-2 overflow-x-auto" style={{ padding: '4px 0' }}>
      {attachments.map((att) => {
        return (
          <div
            key={att.id}
            className="relative flex-shrink-0 flex items-center gap-1.5"
            style={{
              padding: '5px 8px',
              borderRadius: 6,
              background: att.source === 'document-quote' ? 'var(--color-blue-light)' : 'var(--bg-hover)',
              border: '1px solid var(--border-default)',
              maxWidth: att.source === 'document-quote' ? 240 : 168,
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (att.source === 'document-quote') {
                  onRevealDocumentQuote(att)
                  return
                }
                void onPreview(att)
              }}
              className="flex items-center gap-1.5 text-left"
              style={{ minWidth: 0, flex: 1, paddingRight: 8 }}
              title={att.source === 'document-quote' ? getDocumentQuoteTooltip(att) : att.name}
            >
              {att.type === 'image' ? (
                <img
                  src={toLocalFileUrl(att.path)}
                  alt={att.name}
                  style={{ width: 28, height: 28, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                />
              ) : (
                renderAttachmentIcon(att)
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
                <span
                  style={{
                    fontSize: 10,
                    color: att.source === 'document-quote' ? 'var(--color-blue)' : 'var(--text-body)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {att.name}
                </span>
                {getAttachmentMetaSummary(att) ? (
                  <span
                    style={{
                      fontSize: 10,
                      lineHeight: 1.1,
                      padding: '2px 6px',
                      borderRadius: 999,
                      background: att.source === 'document-quote' ? 'rgba(255,255,255,0.58)' : 'rgba(0,0,0,0.05)',
                      color: att.source === 'document-quote' ? 'var(--color-blue)' : 'var(--text-light)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}
                  >
                    {getAttachmentMetaSummary(att)}
                  </span>
                ) : null}
              </span>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRemove(att.id)
              }}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full flex items-center justify-center hover:bg-black/10"
              style={{ background: 'color-mix(in srgb, var(--bg-panel) 24%, transparent)', border: '1px solid var(--border-default)' }}
              title="移除"
            >
              <X style={{ width: 8, height: 8 }} className="text-[var(--text-gray)]" strokeWidth={3} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
