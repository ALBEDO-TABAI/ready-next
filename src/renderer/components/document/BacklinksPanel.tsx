import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, Link2 } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'

interface BacklinkReference {
  path: string
  name: string
  kind: string
}

interface BacklinksPanelProps {
  path: string | null | undefined
  className?: string
}

export default function BacklinksPanel({ path, className }: BacklinksPanelProps) {
  const [references, setReferences] = useState<BacklinkReference[]>([])
  const [loading, setLoading] = useState(false)
  const selectFile = useWorkspace((state) => state.selectFile)

  const fetchBacklinks = useCallback(async (targetPath: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.document?.getBacklinks) {
      setReferences([])
      return
    }
    setLoading(true)
    try {
      const response = await window.electronAPI.document.getBacklinks({ path: targetPath })
      if (response?.success && response.data) {
        setReferences(response.data.references)
      } else {
        setReferences([])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!path) {
      setReferences([])
      return
    }
    void fetchBacklinks(path)
  }, [path, fetchBacklinks])

  if (!path) return null
  if (!loading && references.length === 0) return null

  return (
    <div
      className={`rounded-[10px] border p-3 ${className ?? ''}`}
      style={{ borderColor: 'var(--surface-card-border, rgba(0,0,0,0.08))', background: 'var(--surface-card-bg, transparent)' }}
    >
      <div className="flex items-center gap-[6px] text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
        <Link2 className="h-[13px] w-[13px]" />
        反向链接 {references.length > 0 ? `(${references.length})` : ''}
      </div>
      {loading && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-placeholder)' }}>
          正在读取…
        </p>
      )}
      {!loading && references.length > 0 && (
        <ul className="mt-2 space-y-[4px]">
          {references.map((ref) => (
            <li key={`${ref.path}-${ref.kind}`}>
              <button
                type="button"
                onClick={() => selectFile(ref.path)}
                className="w-full rounded-[6px] px-[6px] py-[4px] text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text)' }}
              >
                <div className="flex items-center gap-[4px]">
                  <ArrowUpRight className="h-[11px] w-[11px] shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <span className="truncate">{ref.name}</span>
                  <span
                    className="ml-auto rounded-[3px] border px-[4px] py-[0.5px] text-[9px] font-medium shrink-0"
                    style={{ borderColor: 'var(--surface-card-border, rgba(0,0,0,0.12))', color: 'var(--text-muted)' }}
                  >
                    {ref.kind}
                  </span>
                </div>
                <div className="mt-[1px] truncate text-[9px]" style={{ color: 'var(--text-placeholder)' }}>
                  {ref.path}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
