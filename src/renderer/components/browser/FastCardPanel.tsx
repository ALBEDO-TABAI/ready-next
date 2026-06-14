import { FileText, Image as ImageIcon, Languages, PanelRightClose, Save, Send, Sparkles, Trash2, Video, X } from 'lucide-react'
import type { FastCardItem } from '../../../shared/fastcard'
import { LiquidSurfaceLayer } from '../ui/liquid-glass/LiquidFloatingPanel'

interface FastCardPanelProps {
  items: FastCardItem[]
  onCollapse: () => void
  onClear: () => void
  onSaveMarkdown: () => void
  onInsertToChat: () => void
  onRemoveItem: (id: string) => void
}

function itemIcon(kind: FastCardItem['kind']) {
  if (kind === 'image') return <ImageIcon size={14} />
  if (kind === 'video') return <Video size={14} />
  if (kind === 'translation') return <Languages size={14} />
  if (kind === 'image-description') return <Sparkles size={14} />
  return <FileText size={14} />
}

function itemTitle(item: FastCardItem): string {
  if (item.title) return item.title
  if (item.kind === 'translation') return '翻译'
  if (item.kind === 'image-description') return '图片反推描述'
  if (item.kind === 'image') return item.alt || item.caption || '图片'
  if (item.kind === 'video') return item.video?.title || '视频'
  return '文字'
}

function itemPreview(item: FastCardItem): string {
  if (item.kind === 'translation') return item.translatedText || item.originalText || ''
  if (item.kind === 'image-description') return item.description || ''
  if (item.kind === 'video') return item.video?.playableUrl || item.video?.originalUrl || item.source?.pageUrl || ''
  if (item.kind === 'image') return item.caption || item.alt || item.imageUrl || ''
  return item.text || ''
}

export default function FastCardPanel({
  items,
  onCollapse,
  onClear,
  onSaveMarkdown,
  onInsertToChat,
  onRemoveItem,
}: FastCardPanelProps) {
  return (
    <aside className="browser-fastcard-drawer browser-fastcard-surface content-surface-panel ready-app-liquid-panel is-entered" aria-label="FastCard">
      <LiquidSurfaceLayer
        className="ready-liquid-popover__lens ready-app-liquid-panel__lens"
        radius={18}
        withProjection={false}
        blur={8}
        frost={0}
        saturation={1.16}
        brightness={1.06}
        contrast={0.82}
      />
      <header className="browser-fastcard-header">
        <div>
          <div className="browser-fastcard-kicker">FastCard</div>
          <h2>{items.length} 条暂存</h2>
        </div>
        <button className="browser-fastcard-icon-button" type="button" aria-label="收起" title="收起" onClick={onCollapse}>
          <PanelRightClose size={16} />
        </button>
      </header>

      <div className="browser-fastcard-list">
        {items.length === 0 ? (
          <div className="browser-fastcard-empty">暂无内容</div>
        ) : (
          items.map((item) => (
            <article className="browser-fastcard-item" key={item.id}>
              <div className="browser-fastcard-item-head">
                <span className="browser-fastcard-item-kind">{itemIcon(item.kind)}</span>
                <div className="browser-fastcard-item-title">{itemTitle(item)}</div>
                <button
                  className="browser-fastcard-icon-button"
                  type="button"
                  aria-label="移除"
                  title="移除"
                  onClick={() => onRemoveItem(item.id)}
                >
                  <X size={14} />
                </button>
              </div>
              <p>{itemPreview(item)}</p>
              {item.source?.domain && <span className="browser-fastcard-source">{item.source.domain}</span>}
            </article>
          ))
        )}
      </div>

      <footer className="browser-fastcard-footer">
        <button className="browser-fastcard-action" type="button" onClick={onSaveMarkdown} disabled={items.length === 0}>
          <Save size={14} />
          <span>以 Markdown 保存</span>
        </button>
        <button className="browser-fastcard-action" type="button" onClick={onInsertToChat} disabled={items.length === 0}>
          <Send size={14} />
          <span>引入到对话框</span>
        </button>
        <button className="browser-fastcard-action subtle" type="button" onClick={onClear} disabled={items.length === 0}>
          <Trash2 size={14} />
          <span>清空</span>
        </button>
      </footer>
    </aside>
  )
}
