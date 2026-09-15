import { useContext } from 'react'
import { resolvePreviewReference } from '../note-preview-parser'
import {
  BookImageContext,
  BookImageParagraphContext,
  resolveBookImageLayout,
} from '../../../modules/document/book/bookImageLayout'

/** 尺寸由本轮测量共享，显示页重新挂载或图片尚未解码时也不会改变占位。 */
export default function DocumentBookImage({ src, alt = '', standalone = false }: {
  src?: string
  alt?: string
  standalone?: boolean
}) {
  const page = useContext(BookImageContext)
  const imageParagraph = useContext(BookImageParagraphContext)
  const resolvedSrc = src ? resolvePreviewReference(src, page.notePath).resolvedUrl : undefined
  const size = resolvedSrc ? page.sizes.get(resolvedSrc) : undefined
  if (size && (!size.width || !size.height)) {
    return <span className="document-book-image-error" role="img" aria-label={alt || '图片加载失败'}>图片加载失败{alt ? ` · ${alt}` : ''}</span>
  }
  const layout = size ? resolveBookImageLayout(size, page, standalone || imageParagraph) : null
  return (
    <span className={`document-book-image${layout?.fullPage ? ' document-book-image--page' : ''}`}>
      <img
        className="document-book-md-img"
        data-book-image-src={resolvedSrc}
        src={resolvedSrc}
        alt={alt}
        loading="eager"
        style={layout ? { width: layout.width, height: layout.height } : undefined}
      />
    </span>
  )
}
