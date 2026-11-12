import { useEffect, useRef, useState } from 'react'
import { FileText, Folder } from 'lucide-react'
import { Input } from '../../ui'

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

  // The shared field (W1 §5), sized to sit inside a 30px tree row.
  return (
    <Input
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
      aria-label="名称"
      style={{ width: '100%', height: 22, padding: '0 4px', fontSize: 12, borderRadius: 'var(--rn-r-xs)' }}
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
        height: 'var(--rn-row-h)',
        padding: '0 8px',
        paddingLeft: `${8 + depth * 22}px`,
        background: 'var(--rn-fill)',
      }}
    >
      <span className="w-3 flex-shrink-0" />
      <span className="flex-shrink-0">
        {type === 'folder'
          ? <Folder className="w-[14px] h-[14px]" style={{ color: 'var(--rn-ink-2)' }} strokeWidth={1.5} />
          : <FileText className="w-[14px] h-[14px]" style={{ color: 'var(--rn-ink-2)' }} strokeWidth={1.5} />}
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
