import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconBook2 as BookOpen,
  IconArtboard,
  IconAt as AtSign,
  IconCopy as Copy,
  IconFilePlus as FilePlus2,
  IconFileText as FileText,
  IconFolderOpen as FolderOpen,
  IconFolderPlus as FolderPlus,
  IconListDetails as ListMinus,
  IconMinus as Minus,
  IconPencil as Pen,
  IconPhoto as Image,
  IconRefresh as RefreshCw,
  IconTrash as Trash2,
  IconWorld as Globe,
} from '@tabler/icons-react'
import { useWorkspace, type FileItem } from '../../../stores/useWorkspace'
import {
  FILE_APPEARANCE_COLORS,
  getFileAppearanceColorValue,
  normalizeFileAppearanceIcon,
  type FileAppearanceColor,
} from '../../../stores/fileAppearance'
import { addReadyContextReferenceToAgentInput } from '../../../modules/agent/chat-input-bridge'
import ContextMenu, { type ContextMenuItem } from '../ContextMenu'
import type { NativeContextMenuItem } from '../../../../shared/native-context-menu'
import {
  buildFloatingMenuItemStyle,
  buildFloatingMenuSurfaceStyle,
} from '../../ui/floatingMenuStyles'
import {
  clampDropMenuPositionToBoundary,
  isLikelyVideoDropPayload,
  type FileTreeDropTarget,
  type FileTreeExternalDropAction,
  type FileTreeExternalActionPayload,
} from '../fileTreeExternalDrop'
import type { FileTreeDeleteTarget } from '../fileTreeSelection'
import { buildWorkspaceDragPayload } from '../fileTreeDragPayload'
import { canMoveAllToDirectory } from '../fileTreeExternalDrop'
import { joinPath } from './drag-utils'
import { getParentDir } from './file-kinds'
import { CustomFileIcon } from './file-icons'
import { isActiveReadyBoardTab } from './ready-board-tab'

export interface FileTreeExternalDropMenuState {
  x: number
  y: number
  payload: FileTreeExternalActionPayload
  target: FileTreeDropTarget
}

export interface FileAppearanceColorMenuState {
  x: number
  y: number
  item: FileItem
}

export function FileTreeExternalDropMenu({
  menu,
  boundaryRect,
  onAction,
  onClose,
}: {
  menu: FileTreeExternalDropMenuState
  boundaryRect: DOMRect | null
  onAction: (action: FileTreeExternalDropAction) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x: menu.x, y: menu.y })
  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const surfaceStyle = useMemo(
    () => buildFloatingMenuSurfaceStyle(208, {
      padding: 6,
      zIndex: 260,
    }),
    [],
  )
  const actionItems = useMemo(() => {
    const items: Array<{
      id: FileTreeExternalDropAction
      label: string
      icon: React.ReactNode
    }> = [
      {
        id: 'web-clip',
        label: '网页剪藏',
        icon: <Globe style={{ width: 15, height: 15 }} />,
      },
      {
        id: 'content-study',
        label: '内容学习',
        icon: <BookOpen style={{ width: 15, height: 15 }} />,
      },
      {
        id: 'copy-analysis',
        label: '文案分析',
        icon: <FileText style={{ width: 15, height: 15 }} />,
      },
    ]
    if (isLikelyVideoDropPayload(menu.payload)) {
      items.push({
        id: 'visual-analysis',
        label: '视觉分析',
        icon: <Image style={{ width: 15, height: 15 }} />,
      })
    }
    return items
  }, [menu.payload])

  useLayoutEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    if (!boundaryRect) {
      const maxX = Math.max(8, window.innerWidth - rect.width - 8)
      const maxY = Math.max(8, window.innerHeight - rect.height - 8)
      setAdjustedPos({
        x: Math.max(8, Math.min(menu.x, maxX)),
        y: Math.max(8, Math.min(menu.y, maxY)),
      })
      return
    }
    setAdjustedPos(
      clampDropMenuPositionToBoundary({
        x: menu.x,
        y: menu.y,
        menuWidth: rect.width,
        menuHeight: rect.height,
        boundaryLeft: boundaryRect.left,
        boundaryTop: boundaryRect.top,
        boundaryRight: boundaryRect.right,
        boundaryBottom: boundaryRect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    )
  }, [actionItems.length, boundaryRect, menu.x, menu.y])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', handleClick)
      window.addEventListener('contextmenu', handleClick)
    }, 0)
    window.addEventListener('keydown', handleKey)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('contextmenu', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const content = (
    <div
      ref={menuRef}
      className="glass-surface-floating ready-floating-menu"
      style={{
        ...surfaceStyle,
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
      }}
    >
      {actionItems.map((item) => (
        <button
          key={item.id}
          type="button"
          className="ready-floating-menu-item"
          style={{
            ...buildFloatingMenuItemStyle({ compact: true }),
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minHeight: 38,
          }}
          onClick={() => onAction(item.id)}
        >
          <span
            style={{
              width: 16,
              height: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-body)',
              flexShrink: 0,
            }}
          >
            {item.icon}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-title)',
              lineHeight: 1.2,
            }}
          >
            {item.label}
          </span>
        </button>
      ))}
    </div>
  )

  return portalRoot ? createPortal(content, portalRoot) : content
}

export function FileColorPalette({
  menu,
  boundaryRect,
  selectedColor,
  onSetColor,
  onClose,
}: {
  menu: FileAppearanceColorMenuState
  boundaryRect: DOMRect | null
  selectedColor: FileAppearanceColor | null
  onSetColor: (color: FileAppearanceColor | null) => void
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x: menu.x, y: menu.y })
  const portalRoot = typeof document !== 'undefined' ? document.body : null

  useLayoutEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    if (!boundaryRect) {
      const maxX = Math.max(8, window.innerWidth - rect.width - 8)
      const maxY = Math.max(8, window.innerHeight - rect.height - 8)
      setAdjustedPos({
        x: Math.max(8, Math.min(menu.x, maxX)),
        y: Math.max(8, Math.min(menu.y, maxY)),
      })
      return
    }
    setAdjustedPos(
      clampDropMenuPositionToBoundary({
        x: menu.x,
        y: menu.y,
        menuWidth: rect.width,
        menuHeight: rect.height,
        boundaryLeft: boundaryRect.left,
        boundaryTop: boundaryRect.top,
        boundaryRight: boundaryRect.right,
        boundaryBottom: boundaryRect.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    )
  }, [boundaryRect, menu.x, menu.y])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', handleClick)
      window.addEventListener('contextmenu', handleClick)
    }, 0)
    window.addEventListener('keydown', handleKey)

    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('contextmenu', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const content = (
    <div
      ref={menuRef}
      className="glass-surface-floating ready-floating-menu"
      style={{
        ...buildFloatingMenuSurfaceStyle(252, {
          padding: 8,
          zIndex: 280,
        }),
        position: 'fixed',
        left: adjustedPos.x,
        top: adjustedPos.y,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {FILE_APPEARANCE_COLORS.map((color) => (
        <button
          key={color.key}
          type="button"
          aria-label={color.label}
          title={color.label}
          onClick={() => onSetColor(color.key)}
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            border: selectedColor === color.key
              ? '2px solid var(--text-title)'
              : '1px solid rgba(255,255,255,0.76)',
            background: color.value,
            boxShadow: selectedColor === color.key
              ? '0 0 0 2px rgba(255,255,255,0.72), 0 4px 10px rgba(0,0,0,0.18)'
              : '0 2px 6px rgba(0,0,0,0.16)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        />
      ))}
      <button
        type="button"
        aria-label="清除颜色"
        title="清除颜色"
        onClick={() => onSetColor(null)}
        style={{
          width: 24,
          height: 24,
          borderRadius: '50%',
          border: '1px solid var(--border-default)',
          background: 'var(--files-panel-state-hover-bg)',
          color: 'var(--text-light)',
          fontSize: 18,
          lineHeight: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  )

  return portalRoot ? createPortal(content, portalRoot) : content
}

export function ContextMenuBridge({
  contextMenu,
  pinnedFolders,
  onClose,
  onOpenFile,
  onCreateBoard,
  selectedDeleteTargets,
  selectedMoveItems,
  onRequestDelete,
  onRequestUnpin,
  workspaceRoot,
  onOpenColorMenu,
  onOpenIconPrompt,
}: {
  contextMenu: { x: number; y: number; item: FileItem | null }
  pinnedFolders: string[]
  onClose: () => void
  onOpenFile: (item: FileItem) => void
  onCreateBoard: (targetDir: string | null) => void
  selectedDeleteTargets: FileTreeDeleteTarget[]
  selectedMoveItems: FileItem[]
  onRequestDelete: (targets: FileTreeDeleteTarget[]) => void
  onRequestUnpin: (info: { path: string; name: string }) => void
  workspaceRoot: string | null
  onOpenColorMenu: (item: FileItem, x: number, y: number) => void
  onOpenIconPrompt: (item: FileItem) => void
}) {
  const {
    fileAppearances,
    startRenaming,
    copyPathToClipboard,
    startCreating,
    showInFolder,
    refreshFiles,
    moveItem,
    setFileIcon,
    clearFileAppearance,
  } = useWorkspace()
  const pinnedFolderSet = useMemo(() => new Set(pinnedFolders), [pinnedFolders])

  const nativeMenuAvailable = Boolean(
    typeof window !== 'undefined' && window.electronAPI?.ui?.showNativeContextMenu,
  )
  const moveTargetDialogAvailable = Boolean(
    typeof window !== 'undefined' && window.electronAPI?.document?.openFolder,
  )

  const isPinnedRootMoveTarget = useCallback((path: string) => {
    return pinnedFolderSet.has(path) || path === workspaceRoot
  }, [pinnedFolderSet, workspaceRoot])

  const getMoveTargets = useCallback((item: FileItem): FileItem[] => {
    const selectedMoveItemSet = new Set(selectedMoveItems.map((target) => target.path))
    return selectedMoveItems.length > 1 && selectedMoveItemSet.has(item.path)
      ? selectedMoveItems
      : [item]
  }, [selectedMoveItems])

  const handleMoveTo = useCallback((item: FileItem) => {
    const moveTargets = getMoveTargets(item)
    const payloads = moveTargets.map((target) =>
      buildWorkspaceDragPayload(target, !isPinnedRootMoveTarget(target.path)),
    )

    void (async () => {
      const result = await window.electronAPI?.document?.openFolder?.({ title: '选择移动目标文件夹' })
      if (!result?.success || !result.path) return
      if (!canMoveAllToDirectory(payloads, result.path)) return

      for (const payload of payloads) {
        const nextPath = joinPath(result.path, payload.name)
        if (nextPath === payload.path) continue
        await moveItem(payload.path, nextPath)
      }
    })().catch((error) => {
      console.error('Failed to move selected file tree items:', error)
    })
  }, [getMoveTargets, isPinnedRootMoveTarget, moveItem])

  const getContextItems = useCallback((item: FileItem | null): ContextMenuItem[] => {
    if (!item) {
      return [
        {
          id: 'newFile',
          label: '新建文件',
          icon: <FilePlus2 style={{ width: 16, height: 16 }} />,
          onClick: () => startCreating('file')
        },
        {
          id: 'newFolder',
          label: '新建文件夹',
          icon: <FolderPlus style={{ width: 16, height: 16 }} />,
          onClick: () => startCreating('folder')
        },
        {
          id: 'newBoard',
          label: '新建画板',
          icon: <IconArtboard style={{ width: 16, height: 16 }} />,
          onClick: () => onCreateBoard(null)
        },
        { id: 'sep1', label: '', separator: true },
        {
          id: 'refresh',
          label: '刷新',
          icon: <RefreshCw style={{ width: 16, height: 16 }} />,
          onClick: () => void refreshFiles()
        },
      ]
    }
    const selectedDeleteTargetSet = new Set(selectedDeleteTargets.map((target) => target.path))
    const deleteTargets = selectedDeleteTargets.length > 1 && selectedDeleteTargetSet.has(item.path)
      ? selectedDeleteTargets
      : [{ path: item.path, name: item.name }]
    const moveTargets = getMoveTargets(item)
    const moveDisabled = !moveTargetDialogAvailable || moveTargets.some((target) => isPinnedRootMoveTarget(target.path))
    const appearance = fileAppearances[item.path]
    const appearanceColor = getFileAppearanceColorValue(appearance?.color)
    return [
      ...(item.isDirectory ? [] : [
        {
          id: 'open',
          label: '打开',
          icon: <FileText style={{ width: 16, height: 16 }} />,
          onClick: () => onOpenFile(item)
        }
      ]),
      {
        id: 'referenceToInput',
        label: '引用到输入框',
        icon: <AtSign style={{ width: 16, height: 16 }} />,
        onClick: () => {
          void addReadyContextReferenceToAgentInput({
            type: 'file',
            name: item.name,
            path: item.path,
            size: item.size,
            isDirectory: item.isDirectory,
          })
        },
      },
      { id: 'sep1', label: '', separator: true },
      {
        id: 'rename',
        label: '重命名',
        shortcut: 'Enter',
        icon: <Pen style={{ width: 16, height: 16 }} />,
        onClick: () => startRenaming(item.path)
      },
      {
        id: 'copyPath',
        label: '复制路径',
        shortcut: '⌥⌘C',
        icon: <Copy style={{ width: 16, height: 16 }} />,
        onClick: () => copyPathToClipboard(item.path)
      },
      {
        id: 'moveTo',
        label: '移动到',
        icon: <FolderOpen style={{ width: 16, height: 16 }} />,
        disabled: moveDisabled,
        onClick: () => handleMoveTo(item)
      },
      { id: 'sep2', label: '', separator: true },
      {
        id: 'setColor',
        label: '设置颜色...',
        icon: (
          <span
            style={{
              width: 13,
              height: 13,
              borderRadius: '50%',
              background: appearanceColor ?? 'transparent',
              border: appearanceColor ? '1px solid rgba(255,255,255,0.78)' : '1px solid var(--text-light)',
              boxShadow: appearanceColor ? '0 1px 3px rgba(0,0,0,0.16)' : 'none',
            }}
          />
        ),
        onClick: () => onOpenColorMenu(item, contextMenu.x, contextMenu.y)
      },
      {
        id: 'setCustomIcon',
        label: '自定图标...',
        icon: appearance?.icon
          ? <CustomFileIcon icon={appearance.icon} size={16} />
          : <Pen style={{ width: 16, height: 16 }} />,
        onClick: () => onOpenIconPrompt(item)
      },
      ...(appearance?.icon ? [
        {
          id: 'clearCustomIcon',
          label: '清除图标',
          icon: <span style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</span>,
          onClick: () => setFileIcon(item.path, null)
        }
      ] : []),
      ...(appearance?.color || appearance?.icon ? [
        {
          id: 'clearAppearance',
          label: '清除颜色和图标',
          icon: <span style={{ width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>×</span>,
          onClick: () => clearFileAppearance(item.path)
        }
      ] : []),
      { id: 'sepAppearance', label: '', separator: true },
      {
        id: 'newFile',
        label: '新建文件',
        icon: <FilePlus2 style={{ width: 16, height: 16 }} />,
        onClick: () => startCreating('file')
      },
      {
        id: 'newFolder',
        label: '新建文件夹',
        icon: <FolderPlus style={{ width: 16, height: 16 }} />,
        onClick: () => startCreating('folder')
      },
      {
        id: 'newBoard',
        label: '新建画板',
        icon: <IconArtboard style={{ width: 16, height: 16 }} />,
        onClick: () => onCreateBoard(item.isDirectory ? item.path : getParentDir(item.path))
      },
      { id: 'sep3', label: '', separator: true },
      {
        id: 'showInFinder',
        label: '在 Finder 中显示',
        icon: <FolderOpen style={{ width: 16, height: 16 }} />,
        onClick: () => void showInFolder(item.path)
      },
      ...(pinnedFolderSet.has(item.path) || item.path === workspaceRoot ? [
        {
          id: 'removeFromList',
          label: '从列表中移除',
          icon: <ListMinus style={{ width: 16, height: 16 }} />,
          onClick: () => onRequestUnpin({ path: item.path, name: item.name }),
        },
      ] : []),
      { id: 'sep4', label: '', separator: true },
      {
        id: 'delete',
        label: deleteTargets.length > 1 ? `删除 ${deleteTargets.length} 项` : '删除',
        icon: <Trash2 style={{ width: 16, height: 16 }} />,
        danger: true,
        onClick: () => onRequestDelete(deleteTargets)
      }
    ]
  }, [clearFileAppearance, contextMenu.x, contextMenu.y, fileAppearances, onOpenFile, onCreateBoard, onOpenColorMenu, onOpenIconPrompt, setFileIcon, startRenaming, copyPathToClipboard, getMoveTargets, moveTargetDialogAvailable, isPinnedRootMoveTarget, handleMoveTo, startCreating, showInFolder, refreshFiles, pinnedFolderSet, workspaceRoot, selectedDeleteTargets, onRequestDelete, onRequestUnpin])

  const contextItems = useMemo(() => getContextItems(contextMenu.item), [contextMenu.item, getContextItems])

  const toNativeContextItems = useCallback((items: ContextMenuItem[]): NativeContextMenuItem[] => {
    const iconTextById: Record<string, string> = {
      open: '↩',
      referenceToInput: '@',
      rename: '✎',
      copyPath: '⧉',
      moveTo: '↪',
      setColor: '●',
      setCustomIcon: '◆',
      clearCustomIcon: '×',
      clearAppearance: '×',
      newFile: '+',
      newFolder: '⊞',
      newBoard: '□',
      showInFinder: '↗',
      refresh: '↻',
      removeFromList: '−',
      delete: '⌫',
    }
    const acceleratorById: Record<string, string> = {
      rename: 'Enter',
      copyPath: 'Alt+Command+C',
    }
    return items.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: !item.disabled,
      separator: item.separator,
      iconText: item.separator ? undefined : iconTextById[item.id],
      accelerator: item.separator ? undefined : acceleratorById[item.id],
    }))
  }, [])

  // ref 模式：useEffect 只在菜单首次打开（坐标变化）时跑，避免父组件 inline
  // 函数引用变化导致 cancelled=true、用户已经选了的 onClick 永远不触发。
  const liveRef = useRef({ contextItems, onClose, toNativeContextItems })
  liveRef.current = { contextItems, onClose, toNativeContextItems }

  useEffect(() => {
    if (!nativeMenuAvailable) return
    let invoked = false
    const itemsAtOpen = liveRef.current.contextItems
    const actionById = new Map(
      itemsAtOpen
        .filter((item) => !item.separator)
        .map((item) => [item.id, item]),
    )
    void window.electronAPI.ui?.showNativeContextMenu({
      x: contextMenu.x,
      y: contextMenu.y,
      items: liveRef.current.toNativeContextItems(itemsAtOpen),
    }).then((result) => {
      invoked = true
      const close = liveRef.current.onClose
      if (!result?.success || !result.selectedId) {
        close()
        return
      }
      const item = actionById.get(result.selectedId)
      if (!item || item.disabled) {
        close()
        return
      }
      item.onClick?.()
      close()
    }).catch(() => {
      invoked = true
      liveRef.current.onClose()
    })

    return () => {
      // 卸载时若菜单还没回调（用户尚未选择），主动让 UI 收起；如果 promise
      // 已 resolved（invoked=true），无需再做任何事——onClick 已经跑过。
      if (!invoked) {
        liveRef.current.onClose()
      }
    }
  }, [contextMenu.x, contextMenu.y, nativeMenuAvailable])

  if (nativeMenuAvailable) {
    return null
  }

  return (
    <ContextMenu
      items={contextItems}
      x={contextMenu.x}
      y={contextMenu.y}
      onClose={onClose}
    />
  )
}
