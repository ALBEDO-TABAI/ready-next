import type React from 'react'
import type { FileItem } from '../../../stores/useWorkspace'
import type { FileAppearance } from '../../../stores/fileAppearance'
import type { FileTreeDropTarget } from '../fileTreeExternalDrop'
import type { FileFilterMap } from './file-kinds'
import { hasMatchingDescendant, isFileAllowed, passesFilter } from './file-kinds'
import { InlineCreateRow } from './inline-inputs'
import { FileTreeItem } from './FileTreeItem'
import { PendingClipRow, type PendingClipPlaceholder } from './pending-placeholders'

export function FileTreeRecursive({
  items,
  containerPath,
  depth,
  selectedFile,
  selectedPaths,
  dragItemsByPath,
  orderedPaths,
  expandedDirs,
  dirChildren,
  fileAppearances,
  renamingPath,
  creatingType,
  creatingPath,
  queryLower,
  filters,
  moveDropTargetDir,
  fileTreeDropTarget,
  flashingPath,
  pendingClips,
  onToggleDir,
  onOpenFile,
  onSelectFile,
  onContextMenu,
  onItemDragStart,
  onItemDragEnd,
  onItemDragOver,
  onItemDragLeave,
  onItemDrop,
  onRenameConfirm,
  onRenameCancel,
  onCreateConfirm,
  onCreateCancel,
  onDismissPendingClip,
}: {
  items: FileItem[]
  containerPath: string
  depth: number
  selectedFile: string | null
  selectedPaths: ReadonlySet<string>
  dragItemsByPath: ReadonlyMap<string, FileItem[]>
  orderedPaths: readonly string[]
  expandedDirs: Set<string>
  dirChildren: Map<string, FileItem[]>
  fileAppearances: Record<string, FileAppearance>
  renamingPath: string | null
  creatingType: 'file' | 'folder' | null
  creatingPath: string | null
  queryLower: string
  filters: FileFilterMap
  moveDropTargetDir: string | null
  fileTreeDropTarget: FileTreeDropTarget | null
  flashingPath: string | null
  pendingClips: PendingClipPlaceholder[]
  onToggleDir: (path: string) => Promise<void>
  onOpenFile: (item: FileItem) => void
  onSelectFile: (e: React.MouseEvent, item: FileItem, orderedPaths: readonly string[]) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onItemDragStart: () => void
  onItemDragEnd: () => void
  onItemDragOver: (e: React.DragEvent, item: FileItem, containerPath: string) => void
  onItemDragLeave: (e: React.DragEvent, item: FileItem) => void
  onItemDrop: (e: React.DragEvent, item: FileItem, containerPath: string) => void
  onRenameConfirm: (path: string, newName: string) => void
  onRenameCancel: () => void
  onCreateConfirm: (newName: string) => void
  onCreateCancel: () => void
  onDismissPendingClip: (taskId: string) => void
}) {
  const visibleItems = items.filter((item) => {
    if (!isFileAllowed(item)) return false
    if (!passesFilter(item, filters)) return false
    if (!queryLower) return true
    if (item.name.toLowerCase().includes(queryLower)) return true
    if (item.isDirectory) {
      return hasMatchingDescendant(item.path, queryLower, filters, dirChildren)
    }
    return false
  })

  const placeholdersForThisFolder = pendingClips.filter((p) => p.targetDir === containerPath)
  return (
    <>
      {creatingType && creatingPath === containerPath && (
        <InlineCreateRow
          type={creatingType}
          depth={depth}
          onConfirm={onCreateConfirm}
          onCancel={onCreateCancel}
        />
      )}
      {placeholdersForThisFolder.map((p) => (
        <PendingClipRow
          key={p.taskId}
          taskId={p.taskId}
          status={p.status}
          urlHost={p.urlHost}
          title={p.title}
          errorMessage={p.errorMessage}
          message={p.message}
          progress={p.progress}
          depth={depth}
          kind={p.kind}
          onDismiss={onDismissPendingClip}
        />
      ))}
      {visibleItems.map((item) => {
        const isExpanded = expandedDirs.has(item.path)
        const children = dirChildren.get(item.path) || []
        const browserDropLine =
          fileTreeDropTarget?.kind === 'insert-before' && fileTreeDropTarget.anchorPath === item.path
            ? 'before'
            : fileTreeDropTarget?.kind === 'insert-after' && fileTreeDropTarget.anchorPath === item.path
              ? 'after'
              : null
        return (
          <div key={item.path}>
            <FileTreeItem
              item={item}
              isActive={selectedPaths.size > 0 ? selectedPaths.has(item.path) : selectedFile === item.path}
              isExpanded={isExpanded}
              isRenaming={renamingPath === item.path}
              isDropTarget={item.isDirectory && moveDropTargetDir === item.path}
              isBrowserDropInside={
                fileTreeDropTarget?.kind === 'inside-directory' && fileTreeDropTarget.itemPath === item.path
              }
              browserDropLine={browserDropLine}
              isFlashing={flashingPath === item.path}
              dragItems={dragItemsByPath.get(item.path)}
              appearance={fileAppearances[item.path]}
              depth={depth}
              onToggleDir={() => onToggleDir(item.path)}
              onOpenFile={() => onOpenFile(item)}
              onSelectFile={(e) => onSelectFile(e, item, orderedPaths)}
              onContextMenu={(e) => onContextMenu(e, item)}
              onDragStart={onItemDragStart}
              onDragEnd={onItemDragEnd}
              onDragOver={(e) => onItemDragOver(e, item, containerPath)}
              onDragLeave={(e) => onItemDragLeave(e, item)}
              onDrop={(e) => onItemDrop(e, item, containerPath)}
              onRenameConfirm={(newName) => onRenameConfirm(item.path, newName)}
              onRenameCancel={onRenameCancel}
            />
            {item.isDirectory && isExpanded && (
              <FileTreeRecursive
                items={children}
                containerPath={item.path}
                depth={depth + 1}
                selectedFile={selectedFile}
                selectedPaths={selectedPaths}
                dragItemsByPath={dragItemsByPath}
                orderedPaths={orderedPaths}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                fileAppearances={fileAppearances}
                renamingPath={renamingPath}
                creatingType={creatingType}
                creatingPath={creatingPath}
                queryLower={queryLower}
                filters={filters}
                moveDropTargetDir={moveDropTargetDir}
                fileTreeDropTarget={fileTreeDropTarget}
                flashingPath={flashingPath}
                pendingClips={pendingClips}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
                onSelectFile={onSelectFile}
                onContextMenu={onContextMenu}
                onItemDragStart={onItemDragStart}
                onItemDragEnd={onItemDragEnd}
                onItemDragOver={onItemDragOver}
                onItemDragLeave={onItemDragLeave}
                onItemDrop={onItemDrop}
                onRenameConfirm={onRenameConfirm}
                onRenameCancel={onRenameCancel}
                onCreateConfirm={onCreateConfirm}
                onCreateCancel={onCreateCancel}
                onDismissPendingClip={onDismissPendingClip}
              />
            )}
          </div>
        )
      })}
    </>
  )
}
