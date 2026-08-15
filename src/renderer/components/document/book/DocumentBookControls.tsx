/**
 * DocumentBookControls.tsx — 阅读模式底部胶囊条。
 *
 * 组成：‹ › 翻页钮、页码滑杆（以对开为单位）、页标、字号滑杆、Aa 排版弹层
 * （行高 + 页边距）。磨砂玻璃外观；闲置淡出，悬停钉住。
 */

import { memo } from 'react'
import { ALargeSmall, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react'
import type { BookFlipDirection } from '../../../modules/document/book/bookFlipController'
import {
  BOOK_FONT_SIZE_RANGE,
  BOOK_LINE_HEIGHT_RANGE,
  type BookMarginPreset,
  type BookReadingPreferences,
} from '../../../modules/document/book/bookReadingPreferences'

export interface DocumentBookControlsProps {
  visible: boolean
  spreadIndex: number
  spreadCount: number
  pageLabel: string
  pageCount: number
  prefs: BookReadingPreferences
  typesetOpen: boolean
  canFlip: (direction: BookFlipDirection) => boolean
  onFlip: (direction: BookFlipDirection) => void
  onJump: (spreadIndex: number) => void
  onPrefsChange: (prefs: BookReadingPreferences) => void
  onTypesetOpenChange: (open: boolean) => void
  onPinChange: (pinned: boolean) => void
}

const MARGIN_OPTIONS: Array<{ value: BookMarginPreset; label: string }> = [
  { value: 'narrow', label: '窄' },
  { value: 'normal', label: '标准' },
  { value: 'wide', label: '宽' },
]

const DocumentBookControls = memo(function DocumentBookControls({
  visible,
  spreadIndex,
  spreadCount,
  pageLabel,
  pageCount,
  prefs,
  typesetOpen,
  canFlip,
  onFlip,
  onJump,
  onPrefsChange,
  onTypesetOpenChange,
  onPinChange,
}: DocumentBookControlsProps) {
  const maxSpread = Math.max(0, spreadCount - 1)

  return (
    <div
      className={`document-book-controls${visible ? ' is-visible' : ''}`}
      onPointerEnter={() => onPinChange(true)}
      onPointerLeave={() => onPinChange(false)}
    >
      <div className="document-book-controls__pill">
        <button
          type="button"
          className="document-book-controls__chevron"
          onClick={() => onFlip('backward')}
          disabled={!canFlip('backward')}
          title="上一页"
          aria-label="上一页"
        >
          <ChevronLeft className="h-[14px] w-[14px]" strokeWidth={2} />
        </button>
        <input
          type="range"
          className="document-book-controls__range document-book-controls__range--pages"
          min={0}
          max={maxSpread}
          step={1}
          value={Math.min(spreadIndex, maxSpread)}
          onChange={(event) => onJump(Number(event.target.value))}
          aria-label="页码"
        />
        <button
          type="button"
          className="document-book-controls__chevron"
          onClick={() => onFlip('forward')}
          disabled={!canFlip('forward')}
          title="下一页"
          aria-label="下一页"
        >
          <ChevronRight className="h-[14px] w-[14px]" strokeWidth={2} />
        </button>
        <div className="document-book-controls__label">
          {pageLabel}
          <span className="document-book-controls__label-total">共 {pageCount} 页</span>
        </div>

        <div className="document-book-controls__divider" aria-hidden />

        <ALargeSmall className="document-book-controls__glyph" aria-hidden />
        <input
          type="range"
          className="document-book-controls__range document-book-controls__range--font"
          min={BOOK_FONT_SIZE_RANGE.min}
          max={BOOK_FONT_SIZE_RANGE.max}
          step={0.5}
          value={prefs.fontSize}
          onChange={(event) => onPrefsChange({ ...prefs, fontSize: Number(event.target.value) })}
          aria-label="字号"
          title={`字号 ${prefs.fontSize}px`}
        />
        <button
          type="button"
          className={`document-book-controls__chevron${typesetOpen ? ' is-active' : ''}`}
          onClick={() => onTypesetOpenChange(!typesetOpen)}
          title="排版"
          aria-label="排版"
          aria-expanded={typesetOpen}
        >
          <SlidersHorizontal className="h-[14px] w-[14px]" strokeWidth={2} />
        </button>

        {typesetOpen && (
          <div className="document-book-controls__popover">
            <div className="document-book-controls__popover-row">
              <span className="document-book-controls__popover-label">行高</span>
              <input
                type="range"
                className="document-book-controls__range"
                min={BOOK_LINE_HEIGHT_RANGE.min}
                max={BOOK_LINE_HEIGHT_RANGE.max}
                step={0.05}
                value={prefs.lineHeight}
                onChange={(event) => onPrefsChange({ ...prefs, lineHeight: Number(event.target.value) })}
                aria-label="行高"
              />
              <span className="document-book-controls__popover-value">{prefs.lineHeight.toFixed(2)}</span>
            </div>
            <div className="document-book-controls__popover-row">
              <span className="document-book-controls__popover-label">页边距</span>
              <div className="document-book-controls__segmented">
                {MARGIN_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`document-book-controls__segment${prefs.margin === option.value ? ' is-active' : ''}`}
                    onClick={() => onPrefsChange({ ...prefs, margin: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
})

export default DocumentBookControls
