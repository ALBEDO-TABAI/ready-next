import RSSReferencePreview from '../../../rss/RSSReferencePreview'
import {
  ExternalLink,
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
  Folder,
  FolderOpen,
  Rss
} from 'lucide-react'
import { useEffect } from 'react'
import type { ChatAttachment, AttachmentPreviewState } from '../../../../stores/useAgent'
import { toLocalFileUrl } from '../../../../utils/dragDrop'

export function AttachmentIcon({ attachment, size = 16 }: { attachment: ChatAttachment; size?: number }) {
  const style = { width: size, height: size }
  const cls = 'text-[var(--text-gray)]'
  if (attachment.isDirectory) {
    return <Folder style={style} className={cls} strokeWidth={2} />
  }
  if (attachment.source === 'rss-reference') return <Rss style={style} className={cls} strokeWidth={2} />
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
  useEffect(() => {
    if (!preview) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, preview])

  if (!preview) return null
  return (
    <div
      className="attachment-preview-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="attachment-preview-panel ready-app-liquid-panel"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="附件预览"
      >
        <div className="attachment-preview-toolbar" aria-label="预览操作">
            {/^(?:\/|[a-z]:[\\/])/i.test(preview.attachment.path) && <><button
              type="button"
              className="attachment-preview-action"
              onClick={() => {
                void onReveal(preview.attachment)
              }}
              title="在 Finder 中显示"
              aria-label="在 Finder 中显示"
            >
              <FolderOpen aria-hidden="true" />
            </button>
            <button
              type="button"
              className="attachment-preview-action"
              onClick={() => {
                void onOpen(preview.attachment)
              }}
              title="系统打开"
              aria-label="系统打开"
            >
              <ExternalLink aria-hidden="true" />
            </button></>}
            <button
              type="button"
              className="attachment-preview-action"
              onClick={onClose}
              title="关闭"
              aria-label="关闭"
            >
              <X aria-hidden="true" />
            </button>
        </div>

        <div className="attachment-preview-content">
          {preview.attachment.source === 'rss-reference' ? <RSSReferencePreview reference={preview.attachment.rssReference} onReveal={onClose} /> : <>
          {loading && (
            <div style={{ fontSize: 12, color: 'var(--text-gray)' }}>正在读取附件内容…</div>
          )}

          {!loading && preview.mode === 'image' && (
            <img
              src={toLocalFileUrl(preview.attachment.path)}
              alt={preview.attachment.name}
              className="attachment-preview-media"
            />
          )}

          {!loading && preview.mode === 'video' && (
            <video
              src={toLocalFileUrl(preview.attachment.path)}
              controls
              className="attachment-preview-media attachment-preview-video"
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
          </>}
        </div>
      </div>
    </div>
  )
}
