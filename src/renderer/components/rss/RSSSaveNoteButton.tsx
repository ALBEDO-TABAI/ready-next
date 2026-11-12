import { useEffect, useRef, useState } from 'react'
import { FilePlus2, Loader2 } from 'lucide-react'
import { useDocTabs } from '../../stores/useDocTabs'
import { useWorkspace } from '../../stores/useWorkspace'
import { requestWorkbenchModeOpen } from '../../modules/workbench/mode-transition'
import type { RSSArticleExcerpt } from '../../../shared/rss-workspace'
import { IconButton } from '../ui/Button'

export default function RSSSaveNoteButton({ article, disabled, active, onError }: {
  article: RSSArticleExcerpt['article'] | null
  disabled: boolean
  active: boolean
  onError(message: string): void
}) {
  const [saving, setSaving] = useState(false)
  const live = useRef(true)
  const current = useRef({ active, itemId: article?.id })
  current.current = { active, itemId: article?.id }
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const save = async () => {
    if (!article || saving) return
    setSaving(true)
    try {
      const result = await window.electronAPI.rss.saveArticleNote({ itemId: article.id, expectedRevision: article.revision,
        defaultDirectory: useWorkspace.getState().workspaceRoot || undefined })
      if (!result.success || !result.data) throw new Error(result.error || '笔记保存失败')
      if (result.data.canceled) return
      if (result.data.itemId !== article.id || result.data.revision !== article.revision) throw new Error('保存结果与当前文章不一致，未打开文档。')
      if (!live.current || !current.current.active || current.current.itemId !== article.id) return
      useDocTabs.getState().openTab(result.data.path)
      requestWorkbenchModeOpen('document')
    } catch (error) {
      if (live.current && current.current.itemId === article.id) onError(error instanceof Error ? error.message : String(error))
    } finally { if (live.current) setSaving(false) }
  }
  return <IconButton disabled={disabled || saving || !article} onClick={() => void save()} aria-label="保存为笔记"
    title={saving ? '正在保存为笔记' : '保存为笔记（独立副本，可编辑）'} icon={saving ? <Loader2 className="animate-spin" /> : <FilePlus2 />} />
}
