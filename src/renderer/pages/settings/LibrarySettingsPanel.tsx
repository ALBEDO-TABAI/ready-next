import { useEffect, useState } from 'react'
import { useVault } from '../../stores/useVault'
import { useWorkspace } from '../../stores/useWorkspace'
import { confirmDialog } from '../../components/ui'
import { formatIndexedAt, useLibraryIndex } from '../../modules/search/useLibraryIndex'
import { mountFolder } from '../../modules/document/mountFolder'
import { SettingsCard, SettingsRow, settingsButtonClass } from './settings-shared'

// 设置 › 资料库 (W2 §3.2): where the library lives, the folders mounted beside it, and the full-text index.
// The index is built only when asked: scanning a large folder can take minutes and a lot of disk.
export function LibrarySettingsPanel() {
  const { view, load, chooseFolder } = useVault()
  const pinnedFolders = useWorkspace(state => state.pinnedFolders)
  const removePinnedFolder = useWorkspace(state => state.removePinnedFolder)
  const index = useLibraryIndex()
  const [folderError, setFolderError] = useState<string | null>(null)

  useEffect(() => { if (view.phase === 'idle') void load() }, [load, view.phase])

  const vaultRoot = view.data?.status === 'ready' ? view.data.root : null
  const mounted = pinnedFolders.filter(folder => folder !== vaultRoot)

  const mount = async () => {
    setFolderError(null)
    setFolderError(await mountFolder())
  }

  const buildIndex = async () => {
    const ok = await confirmDialog({
      title: index.status ? '重建索引？' : '建立索引？',
      body: `会扫描资料库和挂载的文件夹（共 ${index.roots.length} 个位置），只扫描这些文件夹，可能需要几分钟。`,
      confirmLabel: index.status ? '重建索引' : '建立索引',
    })
    if (ok) await index.rebuild()
  }

  return (
    <div className="flex flex-col gap-4">
      <SettingsCard title="位置" description="页面、画板和数据库都保存在资料库文件夹里。">
        <SettingsRow label="资料库" description={vaultRoot ?? (view.data?.status === 'missing' ? `找不到资料库：${view.data.root}` : '还没有设置资料库')}>
          <button type="button" className={settingsButtonClass('secondary', { size: 'sm' })} disabled={view.phase === 'saving'} onClick={() => void chooseFolder()}>
            {vaultRoot ? '更换…' : '选择文件夹…'}
          </button>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="挂载的文件夹"
        description="资料库之外的文件夹，在文档侧栏的“文件”视角里一起浏览，也一起建立索引。"
        actions={<button type="button" className={settingsButtonClass('secondary', { size: 'sm' })} onClick={() => void mount()}>挂载文件夹…</button>}
      >
        {mounted.length === 0 && <SettingsRow label="没有挂载的文件夹" />}
        {mounted.map(folder => (
          <SettingsRow key={folder} label={folder.split(/[\\/]/).filter(Boolean).pop() ?? folder} description={folder}>
            <button type="button" className={settingsButtonClass('ghost', { size: 'sm' })} onClick={() => removePinnedFolder(folder)}>移除</button>
          </SettingsRow>
        ))}
        {folderError && <SettingsRow label="没有挂载" description={folderError} />}
      </SettingsCard>

      <SettingsCard title="全文索引" description="“在资料库中查找与替换”用这份索引；对象搜索（⌘K）不需要它。">
        <SettingsRow
          label={index.indexing ? '正在建立索引…' : index.status ? `已索引 ${index.status.docCount} 项` : '尚未建立索引'}
          description={index.error ?? (index.status ? `上次：${formatIndexedAt(index.status.lastIndexedAt)}` : index.roots.length === 0 ? '先设置资料库' : `${index.roots.length} 个位置`)}
        >
          <button type="button" className={settingsButtonClass('secondary', { size: 'sm' })} disabled={index.indexing || index.roots.length === 0} onClick={() => void buildIndex()}>
            {index.status ? '重建索引' : '建立索引'}
          </button>
        </SettingsRow>
      </SettingsCard>
    </div>
  )
}
