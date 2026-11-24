import { prepareFileDragRef } from '../../modules/workbench/file-drag-ref'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, ImagePlus } from 'lucide-react'
import type { AgentArtifact, ChatAttachment } from '../../modules/agent/types'
import {
  announceGeneratedImageDragState,
  endGeneratedImageDrag,
  writeGeneratedImageDragData,
} from '../../modules/image-generation/generatedImageDrag'
import { generatedImageArtifactToAttachment } from '../../modules/image-generation/generatedImageArtifacts'
import { toLocalFileUrl } from '../../utils/dragDrop'
import ContextMenu from '../layout/ContextMenu'

interface GeneratedImageGalleryProps {
  images: AgentArtifact[]
  onPreview: (attachment: ChatAttachment) => void | Promise<void>
  onReferenceSelect: (attachment: ChatAttachment) => void
}

interface ImageMenuState {
  x: number
  y: number
  attachment: ChatAttachment
}

export function GeneratedImageGallery({ images, onPreview, onReferenceSelect }: GeneratedImageGalleryProps) {
  const [activeId, setActiveId] = useState<string | null>(images.at(-1)?.id || null)
  const [menu, setMenu] = useState<ImageMenuState | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const dragStartedRef = useRef(false)
  const cards = useMemo(() => images.map((image) => ({
    image,
    attachment: generatedImageArtifactToAttachment(image),
  })), [images])

  useEffect(() => { for (const { attachment } of cards) void prepareFileDragRef(attachment.path).catch(error => setFeedback(String(error))) }, [cards])

  const copyImage = async (attachment: ChatAttachment) => {
    const result = await window.electronAPI.imageGeneration.copyToClipboard({ sourcePath: attachment.path })
    setFeedback(result.success ? '图片已复制' : result.error || '复制图片失败')
    window.setTimeout(() => setFeedback(null), 2200)
  }

  return (
    <div className="mt-2 flex flex-col gap-1.5" data-generated-image-gallery="true">
      <div className="flex flex-wrap gap-2">
        {cards.map(({ image, attachment }) => {
          const active = image.id === activeId
          return (
            <button
              key={image.id}
              type="button"
              draggable
              data-generated-image-id={image.id}
              onMouseDown={(event) => {
                setActiveId(image.id)
                if (event.button !== 0) return
                dragStartedRef.current = false
                announceGeneratedImageDragState(true)
              }}
              onMouseUp={(event) => {
                if (event.button !== 0) return
                if (!dragStartedRef.current) {
                  window.setTimeout(() => announceGeneratedImageDragState(false), 0)
                }
              }}
              onClick={() => {
                setActiveId(image.id)
                void onPreview(attachment)
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setActiveId(image.id)
                setMenu({ x: event.clientX, y: event.clientY, attachment })
              }}
              onDragStart={(event) => {
                dragStartedRef.current = true
                setActiveId(image.id)
                writeGeneratedImageDragData(event, {
                  type: 'generated-image',
                  id: image.id,
                  path: attachment.path,
                  name: attachment.name,
                  ext: attachment.ext,
                  size: attachment.size,
                  mimeType: attachment.contentType || 'image/png',
                })
                announceGeneratedImageDragState(true)
              }}
              onDragEnd={() => {
                dragStartedRef.current = false
                announceGeneratedImageDragState(false)
                endGeneratedImageDrag()
              }}
              className="group/generated-image overflow-hidden border-0 text-left transition-transform duration-(--rn-d-1) active:scale-[0.99]"
              style={{
                width: cards.length === 1 ? 'min(100%, 420px)' : 'min(48%, 260px)',
                minWidth: 168,
                borderRadius: 'var(--rn-r-card)',
                background: 'var(--rn-inlay)',
                boxShadow: 'inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2)',
                cursor: 'grab',
              }}
              title="点击放大；拖到文档、网页或文件区"
            >
              <img
                src={toLocalFileUrl(attachment.path)}
                alt={attachment.name}
                draggable={false}
                style={{ display: 'block', width: '100%', maxHeight: 360, objectFit: 'cover' }}
              />
              <span
                className="flex items-center justify-between gap-2 px-2.5 py-2 text-[10px]"
                style={{ color: 'var(--rn-ink-3)' }}
              >
                <span className="truncate">{String(image.meta?.model || 'AI 生成图片')}</span>
                {active ? (
                  <span
                    aria-label="当前图片"
                    title="当前图片"
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: 'var(--rn-ok)',
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <span>点击预览</span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      {feedback ? <div className="text-[11px]" style={{ color: 'var(--rn-ink-2)' }}>{feedback}</div> : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              id: 'copy-generated-image',
              label: '复制图片',
              icon: <Copy style={{ width: 15, height: 15 }} strokeWidth={2} />,
              onClick: () => { void copyImage(menu.attachment) },
            },
            {
              id: 'reference-generated-image',
              label: '作为参考图',
              icon: <ImagePlus style={{ width: 15, height: 15 }} strokeWidth={2} />,
              onClick: () => onReferenceSelect(menu.attachment),
            },
          ]}
        />
      ) : null}
    </div>
  )
}
