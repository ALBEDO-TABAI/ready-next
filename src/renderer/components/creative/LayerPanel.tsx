import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Layers, Eye, EyeOff, Lock, Unlock,
  Copy, Trash2, ChevronDown, ChevronRight,
  GripVertical, Type as TypeIcon, Image as ImageIcon,
  FolderOpen, Folder, Group, Ungroup,
} from 'lucide-react'
import type { CanvasObject, ContextMenuState } from './types'

interface LayerPanelProps {
  objects: CanvasObject[]
  selectedIds: string[]
  onSelect: (id: string, addToSelection?: boolean) => void
  onToggleVisibility: (id: string) => void
  onToggleLock: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReorder: (draggedId: string, targetId: string) => void
  onMerge: (id: string) => void
  onGroup?: () => void
  onUngroup?: (id: string) => void
  onToggleGroupExpand?: (id: string) => void
}

export default function LayerPanel({
  objects,
  selectedIds,
  onSelect,
  onToggleVisibility,
  onToggleLock,
  onDuplicate,
  onDelete,
  onReorder,
  onMerge,
  onGroup,
  onUngroup,
  onToggleGroupExpand,
}: LayerPanelProps) {
  const [layersExpanded, setLayersExpanded] = useState(true)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false, x: 0, y: 0, layerId: null,
  })
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [hoveredRow, setHoveredRow] = useState<string | null>(null)
  const [hoveredIcon, setHoveredIcon] = useState<string | null>(null)
  const [hoveredMenuItem, setHoveredMenuItem] = useState<string | null>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu((prev) => ({ ...prev, visible: false }))
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // --- Build tree structure ---
  const getDepth = (obj: CanvasObject): number => {
    if (!obj.parentId) return 0
    const parent = objects.find((o) => o.id === obj.parentId)
    return parent ? 1 + getDepth(parent) : 0
  }

  const isVisible = (obj: CanvasObject): boolean => {
    if (!obj.parentId) return true
    const parent = objects.find((o) => o.id === obj.parentId)
    if (!parent) return true
    if (parent.expanded === false) return false
    return isVisible(parent)
  }

  // Get top-level objects (not children of a group) in reverse zIndex order
  const getOrderedObjects = (): CanvasObject[] => {
    const result: CanvasObject[] = []
    const addWithChildren = (obj: CanvasObject) => {
      result.push(obj)
      if (obj.type === 'group' && obj.children && obj.expanded !== false) {
        const childObjs = obj.children
          .map((cid) => objects.find((o) => o.id === cid))
          .filter((o): o is CanvasObject => !!o)
          .reverse()
        for (const child of childObjs) {
          addWithChildren(child)
        }
      }
    }

    const topLevel = objects.filter((o) => !o.parentId).reverse()
    for (const obj of topLevel) {
      addWithChildren(obj)
    }
    return result
  }

  // --- Drag handlers ---
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDraggedId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, id: string) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (draggedId && draggedId !== id) {
        setDragOverId(id)
      }
    },
    [draggedId],
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOverId(null)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault()
      e.stopPropagation()
      if (draggedId && draggedId !== targetId) {
        onReorder(draggedId, targetId)
      }
      setDraggedId(null)
      setDragOverId(null)
    },
    [draggedId, onReorder],
  )

  // --- Context menu ---
  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, layerId: id })
  }, [])

  const handleContextMenuAction = useCallback(
    (action: 'duplicate' | 'delete' | 'merge' | 'group' | 'ungroup') => {
      if (action === 'group' && onGroup) {
        onGroup()
        setContextMenu((prev) => ({ ...prev, visible: false }))
        return
      }
      if (!contextMenu.layerId) return
      switch (action) {
        case 'duplicate':
          onDuplicate(contextMenu.layerId)
          break
        case 'delete':
          onDelete(contextMenu.layerId)
          break
        case 'merge':
          onMerge(contextMenu.layerId)
          break
        case 'ungroup':
          onUngroup?.(contextMenu.layerId)
          break
      }
      setContextMenu((prev) => ({ ...prev, visible: false }))
    },
    [contextMenu.layerId, onDuplicate, onDelete, onMerge, onGroup, onUngroup],
  )

  const contextObj = contextMenu.layerId ? objects.find((o) => o.id === contextMenu.layerId) : null

  const orderedObjects = getOrderedObjects()

  return (
    <>
      <div style={{ borderTop: '1px solid var(--border-default)' }}>
        <button
          onClick={() => setLayersExpanded(!layersExpanded)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(0,0,0,0.03)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent' }}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 16px',
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'Inter, sans-serif',
            color: 'var(--text-secondary)',
            background: 'var(--bg-toolbar)',
            border: 'none',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {layersExpanded ? (
            <ChevronDown style={{ width: 14, height: 14, flexShrink: 0 }} />
          ) : (
            <ChevronRight style={{ width: 14, height: 14, flexShrink: 0 }} />
          )}
          <Layers style={{ width: 14, height: 14, flexShrink: 0 }} />
          <span>图层</span>
          <span style={{
            marginLeft: 'auto',
            fontSize: 10,
            fontWeight: 400,
            color: 'var(--text-gray)',
            fontFamily: 'Inter, sans-serif',
          }}>
            {objects.length}
          </span>
        </button>

        {/* Group / Ungroup toolbar */}
        {layersExpanded && selectedIds.length > 0 && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 12px 6px',
            background: 'var(--bg-toolbar)',
            borderBottom: '1px solid var(--border-default)',
          }}>
            {selectedIds.length >= 2 && onGroup && (
              <button
                onClick={onGroup}
                title="编组 (Cmd+G)"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  fontSize: 11,
                  fontFamily: 'Inter, sans-serif',
                  borderRadius: 4,
                  border: '1px solid var(--border-default)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <Group style={{ width: 12, height: 12 }} />
                编组
              </button>
            )}
            {selectedIds.length === 1 && objects.find((o) => o.id === selectedIds[0])?.type === 'group' && onUngroup && (
              <button
                onClick={() => onUngroup(selectedIds[0])}
                title="取消编组 (Cmd+Shift+G)"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  fontSize: 11,
                  fontFamily: 'Inter, sans-serif',
                  borderRadius: 4,
                  border: '1px solid var(--border-default)',
                  background: 'transparent',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <Ungroup style={{ width: 12, height: 12 }} />
                取消编组
              </button>
            )}
          </div>
        )}

        {layersExpanded && (
          <div style={{
            maxHeight: 'calc(100% - 80px)',
            overflowY: 'auto',
            overflowX: 'hidden',
            paddingBottom: 8,
            background: 'var(--bg-toolbar)',
          }}>
            {orderedObjects.map((obj) => {
              const isDragOver = dragOverId === obj.id && draggedId !== obj.id
              const isSelected = selectedIds.includes(obj.id)
              const isHovered = hoveredRow === obj.id
              const isDragging = draggedId === obj.id
              const depth = getDepth(obj)
              const isGroup = obj.type === 'group'
              const isExpanded = obj.expanded !== false

              return (
                <div
                  key={obj.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, obj.id)}
                  onDragOver={(e) => handleDragOver(e, obj.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, obj.id)}
                  onClick={(e) => !obj.locked && onSelect(obj.id, e.shiftKey)}
                  onContextMenu={(e) => handleContextMenu(e, obj.id)}
                  onMouseEnter={() => setHoveredRow(obj.id)}
                  onMouseLeave={() => { setHoveredRow(null); setHoveredIcon(null) }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0 12px',
                    paddingLeft: 12 + depth * 16,
                    height: 32,
                    fontSize: 12,
                    fontFamily: 'Inter, sans-serif',
                    cursor: 'pointer',
                    userSelect: 'none',
                    transition: 'background-color 0.15s ease',
                    backgroundColor: isSelected
                      ? 'rgba(91,141,239,0.08)'
                      : isHovered
                        ? 'rgba(0,0,0,0.03)'
                        : 'transparent',
                    color: isSelected ? 'var(--color-blue)' : 'var(--text-secondary)',
                    borderTop: isDragOver ? '2px solid #5B8DEF' : '2px solid transparent',
                    opacity: isDragging ? 0.5 : 1,
                  }}
                >
                  {/* Group expand/collapse toggle */}
                  {isGroup ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleGroupExpand?.(obj.id)
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-gray)',
                        flexShrink: 0,
                        width: 12,
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown style={{ width: 12, height: 12 }} />
                      ) : (
                        <ChevronRight style={{ width: 12, height: 12 }} />
                      )}
                    </button>
                  ) : (
                    <GripVertical style={{
                      width: 12,
                      height: 12,
                      opacity: 0.3,
                      cursor: 'grab',
                      color: 'var(--text-gray)',
                      flexShrink: 0,
                    }} />
                  )}

                  {/* Thumbnail */}
                  <LayerThumbnail obj={obj} />

                  {/* Visibility toggle */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleVisibility(obj.id)
                    }}
                    onMouseEnter={() => setHoveredIcon(`vis-${obj.id}`)}
                    onMouseLeave={() => setHoveredIcon(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: !obj.visible ? 'var(--color-red)' : (hoveredIcon === `vis-${obj.id}` ? 'var(--text-secondary)' : 'var(--text-gray)'),
                      opacity: obj.visible ? (hoveredIcon === `vis-${obj.id}` ? 1 : 0.5) : 1,
                      transition: 'color 0.15s ease, opacity 0.15s ease',
                      flexShrink: 0,
                    }}
                  >
                    {obj.visible ? (
                      <Eye style={{ width: 14, height: 14 }} />
                    ) : (
                      <EyeOff style={{ width: 14, height: 14 }} />
                    )}
                  </button>

                  {/* Name */}
                  <span style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 12,
                    fontFamily: 'Inter, sans-serif',
                    textDecoration: !obj.visible ? 'line-through' : 'none',
                    opacity: !obj.visible ? 0.4 : 1,
                    color: isSelected ? 'var(--color-blue)' : 'var(--text-secondary)',
                  }}>
                    {obj.name}
                  </span>

                  {/* Lock toggle */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleLock(obj.id)
                    }}
                    onMouseEnter={() => setHoveredIcon(`lock-${obj.id}`)}
                    onMouseLeave={() => setHoveredIcon(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      opacity: obj.locked ? 1 : (isHovered ? (hoveredIcon === `lock-${obj.id}` ? 1 : 0.4) : 0),
                      color: obj.locked ? 'var(--color-orange)' : (hoveredIcon === `lock-${obj.id}` ? 'var(--text-secondary)' : 'var(--text-gray)'),
                      transition: 'opacity 0.15s ease, color 0.15s ease',
                      flexShrink: 0,
                    }}
                  >
                    {obj.locked ? (
                      <Lock style={{ width: 14, height: 14 }} />
                    ) : (
                      <Unlock style={{ width: 14, height: 14 }} />
                    )}
                  </button>

                  {/* Actions */}
                  <div style={{
                    display: 'flex',
                    gap: 2,
                    opacity: isHovered ? 0.5 : 0,
                    transition: 'opacity 0.15s ease',
                    flexShrink: 0,
                  }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onDuplicate(obj.id)
                      }}
                      onMouseEnter={() => setHoveredIcon(`dup-${obj.id}`)}
                      onMouseLeave={() => setHoveredIcon(null)}
                      title="复制图层"
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: hoveredIcon === `dup-${obj.id}` ? 'var(--text-secondary)' : 'var(--text-gray)',
                        opacity: hoveredIcon === `dup-${obj.id}` ? 1 : undefined,
                        transition: 'color 0.15s ease, opacity 0.15s ease',
                      }}
                    >
                      <Copy style={{ width: 12, height: 12 }} />
                    </button>
                    {!obj.locked && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(obj.id)
                        }}
                        onMouseEnter={() => setHoveredIcon(`del-${obj.id}`)}
                        onMouseLeave={() => setHoveredIcon(null)}
                        title="删除图层"
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: hoveredIcon === `del-${obj.id}` ? 'var(--color-red)' : 'var(--text-gray)',
                          opacity: hoveredIcon === `del-${obj.id}` ? 1 : undefined,
                          transition: 'color 0.15s ease, opacity 0.15s ease',
                        }}
                      >
                        <Trash2 style={{ width: 12, height: 12 }} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          ref={contextMenuRef}
          style={{
            position: 'fixed',
            zIndex: 50,
            backgroundColor: 'var(--bg-primary)',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
            border: '1px solid var(--border-default)',
            padding: '4px 0',
            minWidth: 140,
            left: contextMenu.x,
            top: contextMenu.y,
            fontFamily: 'Inter, sans-serif',
          }}
        >
          <button
            onClick={() => handleContextMenuAction('duplicate')}
            onMouseEnter={() => setHoveredMenuItem('duplicate')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            style={ctxBtnStyle(hoveredMenuItem === 'duplicate')}
          >
            <Copy style={{ width: 14, height: 14 }} />
            复制图层
          </button>

          {/* Group option when multiple selected */}
          {selectedIds.length >= 2 && onGroup && (
            <button
              onClick={() => handleContextMenuAction('group')}
              onMouseEnter={() => setHoveredMenuItem('group')}
              onMouseLeave={() => setHoveredMenuItem(null)}
              style={ctxBtnStyle(hoveredMenuItem === 'group')}
            >
              <Group style={{ width: 14, height: 14 }} />
              编组
            </button>
          )}

          {/* Ungroup option for group objects */}
          {contextObj?.type === 'group' && onUngroup && (
            <button
              onClick={() => handleContextMenuAction('ungroup')}
              onMouseEnter={() => setHoveredMenuItem('ungroup')}
              onMouseLeave={() => setHoveredMenuItem(null)}
              style={ctxBtnStyle(hoveredMenuItem === 'ungroup')}
            >
              <Ungroup style={{ width: 14, height: 14 }} />
              取消编组
            </button>
          )}

          <button
            onClick={() => handleContextMenuAction('merge')}
            onMouseEnter={() => setHoveredMenuItem('merge')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            style={ctxBtnStyle(hoveredMenuItem === 'merge')}
          >
            <Layers style={{ width: 14, height: 14 }} />
            向下合并
          </button>
          <div style={{
            height: 1,
            backgroundColor: 'var(--border-default)',
            margin: '4px 0',
          }} />
          <button
            onClick={() => handleContextMenuAction('delete')}
            onMouseEnter={() => setHoveredMenuItem('delete')}
            onMouseLeave={() => setHoveredMenuItem(null)}
            style={{
              ...ctxBtnStyle(hoveredMenuItem === 'delete'),
              color: 'var(--color-red)',
            }}
          >
            <Trash2 style={{ width: 14, height: 14 }} />
            删除图层
          </button>
        </div>
      )}
    </>
  )
}

function ctxBtnStyle(hovered: boolean): React.CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px',
    height: 32,
    fontSize: 12,
    fontFamily: 'Inter, sans-serif',
    color: 'var(--text-secondary)',
    background: hovered ? 'rgba(0,0,0,0.04)' : 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'background-color 0.15s ease',
  }
}

// --- Layer Thumbnail ---

function LayerThumbnail({ obj }: { obj: CanvasObject }) {
  const getThumbnailContent = () => {
    switch (obj.type) {
      case 'group':
        return (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 2,
              backgroundColor: 'var(--border-default)',
              opacity: obj.visible ? 1 : 0.3,
            }}
          >
            <FolderOpen style={{ width: 12, height: 12, color: 'var(--text-gray)' }} />
          </div>
        )
      case 'rect':
        return (
          <div
            style={{
              width: '100%',
              height: '100%',
              borderRadius: 2,
              backgroundColor: obj.fill || '#ccc',
              opacity: obj.visible ? (obj.fillOpacity ?? 1) : 0.3,
            }}
          />
        )
      case 'ellipse':
        return (
          <div
            style={{
              width: '100%',
              height: '100%',
              backgroundColor: obj.fill || '#ccc',
              opacity: obj.visible ? (obj.fillOpacity ?? 1) : 0.3,
              borderRadius: '50%',
            }}
          />
        )
      case 'text':
        return (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 2,
              backgroundColor: obj.fill ? `${obj.fill}20` : 'var(--bg-hover)',
              opacity: obj.visible ? 1 : 0.3,
            }}
          >
            <TypeIcon
              style={{ width: 12, height: 12, color: obj.fill || '#333' }}
            />
          </div>
        )
      case 'image':
        return (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 2,
              backgroundColor: 'var(--bg-hover)',
              opacity: obj.visible ? 1 : 0.3,
            }}
          >
            <ImageIcon style={{ width: 12, height: 12, color: 'var(--text-gray)' }} />
          </div>
        )
      default:
        return (
          <div style={{
            width: '100%',
            height: '100%',
            backgroundColor: 'var(--border-default)',
            borderRadius: 2,
          }} />
        )
    }
  }

  const typeLabel = obj.type === 'group' ? '组'
    : obj.type === 'rect' ? '矩形'
    : obj.type === 'ellipse' ? '椭圆'
    : obj.type === 'text' ? '文本'
    : '图片'

  return (
    <div
      style={{
        width: 24,
        height: 24,
        borderRadius: 4,
        border: '1px solid var(--border-default)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
      title={`${typeLabel}图层`}
    >
      {getThumbnailContent()}
    </div>
  )
}
