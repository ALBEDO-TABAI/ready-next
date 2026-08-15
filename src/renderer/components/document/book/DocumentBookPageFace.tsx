/**
 * DocumentBookPageFace.tsx — 静态书页（对开页的左/右一页）。
 *
 * 纸层（底色/噪点/gutter 阴影）由 CSS 承担；__inner 承载页眉/内容/页码，
 * 翻页时 Leaf 直接 cloneNode 这个 inner —— 所以页眉页码必须在 inner 里。
 * pageIndex 为 BOOK_TITLE_PAGE(-1) 时渲染扉页，null 为空白纸面。
 */

import { memo, useLayoutEffect, useRef } from 'react'
import type { PreviewBlock, PreviewEmbed } from '../note-preview-parser'
import type { DocumentWidgetData } from '../../../../shared/document-widget-parse'
import { BOOK_TITLE_PAGE, type BookPage } from '../../../modules/document/book/bookPagination'
import DocumentBookBlock from './DocumentBookBlock'

export interface DocumentBookPageFaceProps {
  side: 'left' | 'right'
  pageIndex: number | null
  page: BookPage | null
  blocks: PreviewBlock[]
  embedsById: Map<string, PreviewEmbed>
  widgetsById: Map<string, DocumentWidgetData>
  docTitle: string
  docSubtitle: string
  contentWidth: number
  contentHeight: number
  /** 注册 inner 元素（Leaf 克隆源）；卸载时传 null */
  onInnerElement: (pageIndex: number, el: HTMLElement | null) => void
}

function TitlePageInner({ docTitle, docSubtitle }: { docTitle: string; docSubtitle: string }) {
  return (
    <div className="document-book-titlepage">
      <div className="document-book-titlepage__rule" aria-hidden />
      <div className="document-book-titlepage__title">{docTitle}</div>
      {docSubtitle ? <div className="document-book-titlepage__subtitle">{docSubtitle}</div> : null}
      <div className="document-book-titlepage__rule" aria-hidden />
    </div>
  )
}

const DocumentBookPageFace = memo(function DocumentBookPageFace({
  side,
  pageIndex,
  page,
  blocks,
  embedsById,
  widgetsById,
  docTitle,
  docSubtitle,
  contentWidth,
  contentHeight,
  onInnerElement,
}: DocumentBookPageFaceProps) {
  const innerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (pageIndex === null) return undefined
    onInnerElement(pageIndex, innerRef.current)
    return () => onInnerElement(pageIndex, null)
  }, [onInnerElement, pageIndex, page])

  const isTitle = pageIndex === BOOK_TITLE_PAGE
  const folio = pageIndex !== null && pageIndex >= 0 ? pageIndex + 1 : null

  return (
    <div className={`document-book-page document-book-page--${side}`}>
      <div className="document-book-page__inner" data-book-page-side={side} ref={innerRef}>
        {isTitle ? (
          <TitlePageInner docTitle={docTitle} docSubtitle={docSubtitle} />
        ) : (
          <>
            <div className="document-book-page__head" aria-hidden>{docTitle}</div>
            <div className="document-book-page__content">
              {page?.entries.map((entry) => {
                const block = blocks[entry.blockIdx]
                if (!block) return null
                if (entry.spansPages) {
                  return (
                    <div key={block.id} className="document-book-page__fragment-viewport">
                      <div
                        className="document-book-page__fragment-flow"
                        style={{
                          width: contentWidth,
                          height: contentHeight,
                          columnWidth: contentWidth,
                          columnGap: 0,
                          columnFill: 'auto',
                          transform: `translateX(${-entry.columnIndex * contentWidth}px)`,
                        }}
                      >
                        <div className="document-book-page__fragment-spacer" style={{ height: entry.startOffsetY }} />
                        <div className="document-book-measurer__block">
                          <DocumentBookBlock block={block} embedsById={embedsById} widgetsById={widgetsById} />
                        </div>
                      </div>
                    </div>
                  )
                }
                return (
                  <div
                    key={block.id}
                    className="document-book-page__entry"
                    style={{ transform: `translateY(${entry.offsetY}px)` }}
                  >
                    <DocumentBookBlock block={block} embedsById={embedsById} widgetsById={widgetsById} />
                  </div>
                )
              })}
            </div>
            {folio !== null ? (
              <div className={`document-book-page__folio document-book-page__folio--${side}`} aria-hidden>
                {folio}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
})

export default DocumentBookPageFace
