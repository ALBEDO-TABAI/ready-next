import { X } from 'lucide-react'
import { isImageGenerationReferencePath } from '../../../shared/image-generation'
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
  const referenceImageIds = attachments
    .filter((attachment) => attachment.type === 'image' && isImageGenerationReferencePath(attachment.path))
    .map((attachment) => attachment.id)

  return (
    <div className="flex items-center gap-2 overflow-x-auto" style={{ padding: '4px 0' }}>
      {attachments.map((att) => {
        const referenceOrder = referenceImageIds.indexOf(att.id) + 1
        const metaSummary = referenceOrder > 0 ? `参考图 ${referenceOrder}` : getAttachmentMetaSummary(att)
        return (
          <div
            key={att.id}
            className="relative flex-shrink-0 flex items-center gap-1.5 chat-reference-chip"
            style={{
              padding: '5px 8px',
              borderRadius: 8,
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
                    color: 'var(--text-body)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                  }}
                >
                  {att.name}
                </span>
                {metaSummary ? (
                  <span
                    data-reference-image-order={referenceOrder > 0 ? referenceOrder : undefined}
                    style={{
                      fontSize: 10,
                      lineHeight: 1.1,
                      padding: '2px 6px',
                      borderRadius: 999,
                      background: 'rgba(0,0,0,0.05)',
                      color: 'var(--text-light)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}
                  >
                    {metaSummary}
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
