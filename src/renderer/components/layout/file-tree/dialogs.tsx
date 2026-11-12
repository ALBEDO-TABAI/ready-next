import { closeFloat, confirmDialog, Input, openDialog } from '../../ui'
import type { FileTreeDeleteTarget } from '../fileTreeSelection'

// The file tree's two questions, on the shared dialog (W1 §5): deleting files or removing a folder from the
// list, and naming a custom icon.

export type FileTreeRemovalRequest =
  | { kind: 'fs'; targets: FileTreeDeleteTarget[] }
  | { kind: 'unpin'; path: string; name: string }

/** Resolves true when the person confirms; false on 取消, Esc or a click outside. */
export function confirmFileTreeRemoval(request: FileTreeRemovalRequest): Promise<boolean> {
  if (request.kind === 'unpin') {
    return confirmDialog({
      title: '从列表中移除',
      body: `确定从文件管理列表里移除 "${request.name}" 吗？不会删除磁盘上的实际文件夹。`,
      confirmLabel: '移除',
      cancelLabel: '取消',
      danger: true,
    })
  }
  const many = request.targets.length > 1
  return confirmDialog({
    title: many ? `删除 ${request.targets.length} 项` : '删除文件',
    body: many
      ? `确定删除选中的 ${request.targets.length} 项吗？此操作不可恢复。`
      : `确定删除 "${request.targets[0]?.name || '所选项目'}" 吗？此操作不可恢复。`,
    confirmLabel: '删除',
    cancelLabel: '取消',
    danger: true,
  })
}

/** 自定图标: resolves with what was typed (Enter or 应用), or null when cancelled. */
export function promptFileIcon(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    let value = initial
    let decided = false
    const finish = (result: string | null) => {
      if (decided) return
      decided = true
      resolve(result)
    }
    const id = openDialog({
      title: '自定图标',
      body: (
        <>
          <p style={{ margin: '0 0 10px' }}>输入一个表情符号或短文字。</p>
          <Input
            aria-label="自定图标"
            defaultValue={initial}
            placeholder="📁"
            data-autofocus
            style={{ width: '100%' }}
            onChange={(event) => { value = event.target.value }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              finish(value)
              closeFloat(id)
            }}
          />
        </>
      ),
      onClose: () => finish(null),
      actions: [
        { label: '取消', variant: 'ghost', onClick: () => finish(null) },
        { label: '应用', variant: 'primary', onClick: () => finish(value) },
      ],
    })
  })
}
