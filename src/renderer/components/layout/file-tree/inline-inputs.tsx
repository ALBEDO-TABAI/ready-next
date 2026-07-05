import { useEffect, useRef, useState } from 'react'
import {
  IconFileText as FileText,
  IconFolder as Folder,
} from '@tabler/icons-react'

export function InlineInput({
  defaultValue,
  onConfirm,
  onCancel
}: {
  defaultValue: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    inputRef.current?.focus()
    const dotIdx = defaultValue.lastIndexOf('.')
    inputRef.current?.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length)
  }, [defaultValue])

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value.trim()) onConfirm(value.trim())
        else onCancel()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onConfirm(value.trim())
        if (e.key === 'Escape') onCancel()
        e.stopPropagation()
      }}
      className="w-full px-1 py-0.5 text-[12px] border border-[var(--color-blue)] rounded bg-[var(--bg-primary)] outline-none"
    />
  )
}

export function InlineCreateRow({
  type,
  depth,
  onConfirm,
  onCancel,
}: {
  type: 'file' | 'folder'
  depth: number
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  return (
    <div
      className="flex items-center gap-[6px] rounded-[8px]"
      style={{
        padding: '6px 8px',
        paddingLeft: `${8 + depth * 22}px`,
        background: 'var(--files-panel-state-active-bg)',
        boxShadow: 'var(--files-panel-state-active-shadow)',
      }}
    >
      <span className="w-3 flex-shrink-0" />
      <span className="flex-shrink-0">
        {type === 'folder'
          ? <Folder className="w-[14px] h-[14px]" style={{ color: 'var(--text-muted)' }} />
          : <FileText className="w-[14px] h-[14px]" style={{ color: 'var(--text-muted)' }} />}
      </span>
      <div className="flex-1 min-w-0">
        <InlineInput
          defaultValue={type === 'folder' ? '新建文件夹' : '新建文件.md'}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </div>
    </div>
  )
}
