import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BookOpen,
  Shapes,
  AtSign,
  Copy,
  FilePlus2,
  FileText,
  FolderOpen,
  FolderPlus,
  ListMinus,
  Pencil as Pen,
  Image,
  RefreshCw,
  Trash2,
  Globe,
  X,
} from 'lucide-react'
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
import { IconButton, MenuList, type MenuEntry } from '../../ui'
import { FloatPanel } from '../../ui/float/FloatPanel'
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

/**
 * Places a float the tree opened at a pointer inside the file panel (clamped to the panel when known, else to the
 * window) and closes it on an outside click, a right click elsewhere or Esc. The float itself is the shared
 * FloatPanel material (W1 §4–§5), which also makes the native web view step aside beneath it.
 */
function useTreeFloatPlacement(
  point: { x: number; y: number },
  boundaryRect: DOMRect | null,
  onClose: () => void,
  layoutKey: unknown,
) {
  const ref = useRef<HTMLDivElement>(null)
  const [adjustedPos, setAdjustedPos] = useState({ x: point.x, y: point.y })

  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    if (!boundaryRect) {
      const maxX = Math.max(8, window.innerWidth - rect.width - 8)
      const maxY = Math.max(8, window.innerHeight - rect.height - 8)
      setAdjustedPos({
        x: Math.max(8, Math.min(point.x, maxX)),
        y: Math.max(8, Math.min(point.y, maxY)),
      })
      return
    }
    setAdjustedPos(
      clampDropMenuPositionToBoundary({
        x: point.x,
        y: point.y,
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
  }, [boundaryRect, layoutKey, point.x, point.y])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return
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

  const style: React.CSSProperties = { position: 'fixed', left: adjustedPos.x, top: adjustedPos.y }
  return { ref, style }
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
  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const actionItems = useMemo(() => {
    const items: Array<{ id: FileTreeExternalDropAction; label: string; icon: React.ReactNode }> = [
      { id: 'web-clip', label: '网页剪藏', icon: <Globe /> },
      { id: 'content-study', label: '内容学习', icon: <BookOpen /> },
      { id: 'copy-analysis', label: '文案分析', icon: <FileText /> },
    ]
    if (isLikelyVideoDropPayload(menu.payload)) {
      items.push({ id: 'visual-analysis', label: '视觉分析', icon: <Image /> })
    }
    return items
  }, [menu.payload])
  // The shared menu list (keyboard: ↑/↓, Enter); choosing an action hands it to the tree, which closes the menu.
  const entries = useMemo<MenuEntry[]>(
    () => actionItems.map((item) => ({ id: item.id, label: item.label, icon: item.icon, onSelect: () => onAction(item.id) })),
    [actionItems, onAction],
  )
  const { ref, style } = useTreeFloatPlacement(menu, boundaryRect, onClose, actionItems.length)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [ref])

  const content = (
    <FloatPanel ref={ref} className="rn-ui" style={{ ...style, zIndex: 260 }}>
      <MenuList items={entries} label="拖入的网页" onDone={() => {}} />
    </FloatPanel>
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
  const portalRoot = typeof document !== 'undefined' ? document.body : null
  const { ref, style } = useTreeFloatPlacement(menu, boundaryRect, onClose, null)

  // A small float of swatches: the colours are the person's own (content palette); the chosen one carries an ink ring.
  const content = (
    <FloatPanel
      ref={ref}
      role="group"
      aria-label="设置颜色"
      className="rn-ui"
      style={{ ...style, zIndex: 280 }}
      contentStyle={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8 }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {FILE_APPEARANCE_COLORS.map((color) => (
        <button
          key={color.key}
          type="button"
          aria-label={color.label}
          aria-pressed={selectedColor === color.key}
          title={color.label}
          onClick={() => onSetColor(color.key)}
          style={{
            width: 24,
            height: 24,
            padding: 0,
            border: 0,
            borderRadius: '50%',
            background: color.value,
            boxShadow: selectedColor === color.key
              ? '0 0 0 2px var(--rn-solid), 0 0 0 3.5px var(--rn-ink)'
              : 'inset 0 0 0 .5px var(--rn-hair-2)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        />
      ))}
      <IconButton
        size="sm"
        title="清除颜色"
        icon={<X />}
        onClick={() => onSetColor(null)}
        style={{ borderRadius: '50%', boxShadow: 'inset 0 0 0 .5px var(--rn-hair-2)' }}
      />
    </FloatPanel>
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
  extraItems,
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
  /** Items the host adds for an entry, after 在 Finder 中显示 (e.g. 收进资料库 for mounted folders). */
  extraItems?: (item: FileItem) => ContextMenuItem[]
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
          icon: <Shapes style={{ width: 16, height: 16 }} />,
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
              boxShadow: appearanceColor ? 'none' : 'inset 0 0 0 1px var(--rn-ink-3)',
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
        icon: <Shapes style={{ width: 16, height: 16 }} />,
        onClick: () => onCreateBoard(item.isDirectory ? item.path : getParentDir(item.path))
      },
      { id: 'sep3', label: '', separator: true },
      {
        id: 'showInFinder',
        label: '在 Finder 中显示',
        icon: <FolderOpen style={{ width: 16, height: 16 }} />,
        onClick: () => void showInFolder(item.path)
      },
      ...(extraItems?.(item) ?? []),
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
  }, [clearFileAppearance, contextMenu.x, contextMenu.y, fileAppearances, onOpenFile, onCreateBoard, onOpenColorMenu, onOpenIconPrompt, setFileIcon, startRenaming, copyPathToClipboard, getMoveTargets, moveTargetDialogAvailable, isPinnedRootMoveTarget, handleMoveTo, startCreating, showInFolder, refreshFiles, pinnedFolderSet, workspaceRoot, selectedDeleteTargets, onRequestDelete, onRequestUnpin, extraItems])

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
