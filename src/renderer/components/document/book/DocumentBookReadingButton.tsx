/**
 * DocumentBookReadingButton.tsx — 文档顶栏阅读模式圆钮。
 * 与相邻 rail 钮同规格（document-floating-toggle，28×28，14px 图标）。
 */

import { memo } from 'react'
import { BookOpen } from 'lucide-react'

export interface DocumentBookReadingButtonProps {
  active: boolean
  disabled: boolean
  onToggle: () => void
}

const DocumentBookReadingButton = memo(function DocumentBookReadingButton({
  active,
  disabled,
  onToggle,
}: DocumentBookReadingButtonProps) {
  return (
    <button
      type="button"
      className={`document-floating-toggle${active ? ' is-active' : ''}`}
      onClick={onToggle}
      title={disabled ? '当前文档不支持阅读模式' : active ? '退出阅读模式' : '阅读模式'}
      aria-pressed={active}
      disabled={disabled}
    >
      <BookOpen className="h-[14px] w-[14px]" strokeWidth={2} />
    </button>
  )
})

export default DocumentBookReadingButton
