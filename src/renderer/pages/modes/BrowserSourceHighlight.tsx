import { useState } from 'react'

/** Browser chrome takes layout space; this action opens no DOM overlay above the native page. */
export function BrowserSourceHighlight({ tabId }: { tabId: string }) {
  const [saving, setSaving] = useState(false), [message, setMessage] = useState('')
  const save = async () => {
    if (saving) return
    setSaving(true); setMessage('')
    try {
      const result = await window.electronAPI.sourceAnnotations.web({ tabId })
      if (!result.success) throw new Error(result.error)
      setMessage(result.data.persistence === 'saved' ? '已划线到来源页' : '已加入来源页，请保存笔记')
    } catch (error) { console.warn('[BrowserSourceHighlight] save web highlight failed:', error instanceof Error ? error.message : String(error)); setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  return <div className="flex items-center gap-2 px-3 py-1 text-xs" aria-label="FastCard 来源标注">
    <button disabled={saving} onMouseDown={event => event.preventDefault()} onClick={() => { void save() }}>划线到来源页</button>
    <span role="status">{message || '在网页中选中文字，再划线保存'}</span>
  </div>
}
