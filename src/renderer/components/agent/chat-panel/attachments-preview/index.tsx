import {
  X,
  FileText,
  Image,
  Film,
  Table,
  Globe,
  CalendarDays,
  Puzzle,
  Pen,
  MessageSquareQuote,
  Folder
} from 'lucide-react'
import type { ChatAttachment, AttachmentPreviewState } from '../../../../stores/useAgent'
import { toLocalFileUrl } from '../../../../utils/dragDrop'

export function AttachmentIcon({ attachment, size = 16 }: { attachment: ChatAttachment; size?: number }) {
  const style = { width: size, height: size }
  const cls = 'text-[var(--text-gray)]'
  if (attachment.isDirectory) {
    return <Folder style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'browser-tab') {
    return <Globe style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'calendar-event') {
    return <CalendarDays style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'document-quote') {
    return <MessageSquareQuote style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'design-project') {
    return <Pen style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'skill-folder') {
    return <Puzzle style={style} className={cls} strokeWidth={2} />
  }
  switch (attachment.type) {
    case 'image':
      return <Image style={style} className={cls} strokeWidth={2} />
    case 'video':
      return <Film style={style} className={cls} strokeWidth={2} />
    case 'spreadsheet':
      return <Table style={style} className={cls} strokeWidth={2} />
    default:
      return <FileText style={style} className={cls} strokeWidth={2} />
  }
}

export function getAttachmentPreviewSrc(attachment: ChatAttachment): string | null {
  if (attachment.type !== 'image') return null
  if (!attachment.path || !attachment.path.startsWith('/')) return null
  return `file://${encodeURI(attachment.path)}`
}

export interface AttachmentPreviewModalProps {
  preview: AttachmentPreviewState | null
  loading: boolean
  onClose: () => void
  onReveal: (attachment: ChatAttachment) => void | Promise<void>
  onOpen: (attachment: ChatAttachment) => void | Promise<void>
}

export function AttachmentPreviewModal({
  preview,
  loading,
  onClose,
  onReveal,
  onOpen
}: AttachmentPreviewModalProps) {
  if (!preview) return null
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(10, 14, 22, 0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        zIndex: 40
      }}
      onClick={onClose}
    >
      <div
        className="glass-surface-floating"
        style={{
          width: 'min(760px, 100%)',
          maxHeight: '82%',
          overflow: 'hidden',
          borderRadius: 16,
          border: '1px solid var(--border-default)',
          background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '14px 16px',
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-title)' }}>
              {preview.attachment.name}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-gray)', marginTop: 2 }}>
              {preview.attachment.path}
            </div>
          </div>
          <div className="flex items-center" style={{ gap: 8 }}>
            <button
              type="button"
              onClick={() => {
                void onReveal(preview.attachment)
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid var(--border-default)',
                fontSize: 12,
                color: 'var(--text-body)'
              }}
            >
              在 Finder 中显示
            </button>
            <button
              type="button"
              onClick={() => {
                void onOpen(preview.attachment)
              }}
              style={{
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid var(--border-default)',
                fontSize: 12,
                color: 'var(--text-body)'
              }}
            >
              系统打开
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                border: '1px solid var(--border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <X style={{ width: 14, height: 14 }} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div style={{ padding: 16, overflow: 'auto' }}>
          {loading && (
            <div style={{ fontSize: 12, color: 'var(--text-gray)' }}>正在读取附件内容…</div>
          )}

          {!loading && preview.mode === 'image' && (
            <img
              src={toLocalFileUrl(preview.attachment.path)}
              alt={preview.attachment.name}
              style={{
                width: '100%',
                maxHeight: '70vh',
                objectFit: 'contain',
                borderRadius: 12
              }}
            />
          )}

          {!loading && preview.mode === 'video' && (
            <video
              src={toLocalFileUrl(preview.attachment.path)}
              controls
              style={{ width: '100%', maxHeight: '70vh', borderRadius: 12, background: '#000' }}
            />
          )}

          {!loading && preview.mode === 'text' && (
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.6,
                color: 'var(--text-body)',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-default)',
                borderRadius: 12,
                padding: 14
              }}
            >
              {preview.content || '(空文本附件)'}
            </pre>
          )}

          {!loading && preview.mode === 'file' && (
            <div
              style={{
                borderRadius: 12,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-secondary)',
                padding: 14,
                display: 'flex',
                flexDirection: 'column',
                gap: 8
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-body)' }}>
                该附件暂不支持内嵌预览。
              </div>
              {preview.error && (
                <div style={{ fontSize: 12, color: 'var(--color-red)' }}>{preview.error}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
