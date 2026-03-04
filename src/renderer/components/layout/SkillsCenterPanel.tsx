import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Folder, FolderInput, FolderOpen, Trash2 } from 'lucide-react'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { useWorkspace } from '../../stores/useWorkspace'
import { PANEL_TOKENS, SKILLS_PANEL_DIMENSIONS } from './panelTokens'

type EmbeddedSkillId = 'video-expert-analyzer' | 'video-copy-analyzer' | 'lets-go-rss'

interface EmbeddedSkillState {
  id: EmbeddedSkillId
  name: string
  description: string
  version: string
  installed: boolean
  installStatePath: string
}

interface SkillsRuntimeInfo {
  skillsRoot: string
}

interface ImportedSkillFolder {
  id: string
  name: string
  path: string
  addedAt: number
}

type SkillCardContextTarget =
  | { type: 'system'; id: string; path: string }
  | { type: 'imported'; id: string; path: string }

const IMPORTED_SKILL_KEY = 'ready-imported-skill-folders'

const DEFAULT_ACTION_TEMPLATES: Record<EmbeddedSkillId, string> = {
  'video-expert-analyzer': '/skill video-expert-analyzer video_expert_pipeline {"url":""}',
  'video-copy-analyzer': '/skill video-copy-analyzer video_copy_analyze {"input":""}',
  'lets-go-rss': '/skill lets-go-rss rss_update {"digest":true,"noLlm":true}',
}

const PANEL_COLORS = {
  panelBg: PANEL_TOKENS.panelBg,
  border: PANEL_TOKENS.border,
  title: PANEL_TOKENS.title,
  sectionTitle: PANEL_TOKENS.sectionTitle,
  text: PANEL_TOKENS.text,
  muted: PANEL_TOKENS.muted,
  mutedStrong: PANEL_TOKENS.mutedStrong,
  cardBg: PANEL_TOKENS.cardBg,
  dropBorder: PANEL_TOKENS.dropBorder,
  iconAccent: PANEL_TOKENS.iconAccent,
  blue: PANEL_TOKENS.blue,
  blueLight: PANEL_TOKENS.blueLight,
}

function basename(input: string): string {
  const normalized = input.replace(/\\+/g, '/')
  const chunks = normalized.split('/')
  return chunks[chunks.length - 1] || input
}

function parseImportedFoldersFromStorage(): ImportedSkillFolder[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(IMPORTED_SKILL_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ImportedSkillFolder[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => !!item?.path && !!item?.name)
  } catch {
    return []
  }
}

function putSkillDragData(
  e: DragEvent,
  payload: {
    name: string
    path: string
    skillId?: string
    defaultCommand?: string
    source: 'system' | 'imported'
  },
): void {
  const data = JSON.stringify({
    type: 'skill-folder',
    name: payload.name,
    path: payload.path,
    skillId: payload.skillId,
    source: payload.source,
    defaultCommand: payload.defaultCommand,
  })
  e.dataTransfer.setData('application/x-ready-drag', data)
  e.dataTransfer.setData('application/x-ready-skill', data)
  e.dataTransfer.setData('text/plain', payload.defaultCommand || payload.path)
  e.dataTransfer.effectAllowed = 'copy'
}

export default function SkillsCenterPanel() {
  const [skills, setSkills] = useState<EmbeddedSkillState[]>([])
  const [runtimeInfo, setRuntimeInfo] = useState<SkillsRuntimeInfo | null>(null)
  const [importedFolders, setImportedFolders] = useState<ImportedSkillFolder[]>(() => parseImportedFoldersFromStorage())
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [importDropActive, setImportDropActive] = useState(false)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: SkillCardContextTarget } | null>(null)

  const bodyRef = useRef<HTMLDivElement>(null)
  const skillsSplitRatio = useWorkspace((state) => state.skillsSplitRatio)
  const setSkillsSplitRatio = useWorkspace((state) => state.setSkillsSplitRatio)

  useEffect(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem(IMPORTED_SKILL_KEY, JSON.stringify(importedFolders))
  }, [importedFolders])

  const loadAll = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.skills) return
    setLoading(true)
    try {
      const [skillsRes, runtimeRes] = await Promise.all([
        window.electronAPI.skills.list(),
        window.electronAPI.skills.runtimeInfo(),
      ])
      if (skillsRes.success && skillsRes.data) setSkills(skillsRes.data as EmbeddedSkillState[])
      if (runtimeRes.success && runtimeRes.data) setRuntimeInfo(runtimeRes.data as SkillsRuntimeInfo)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const pushMessage = useCallback((text: string) => {
    setMessage(text)
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        setMessage((current) => (current === text ? '' : current))
      }, 2200)
    }
  }, [])

  const upsertImportedPaths = useCallback((paths: string[]) => {
    const cleaned = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)))
    if (cleaned.length === 0) return 0

    let addedCount = 0
    setImportedFolders((prev) => {
      const existing = new Set(prev.map((item) => item.path))
      const additions = cleaned
        .filter((path) => !existing.has(path))
        .map((path) => ({
          id: `skill-folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: basename(path),
          path,
          addedAt: Date.now(),
        }))
      addedCount = additions.length
      return additions.length > 0 ? [...additions, ...prev] : prev
    })
    return addedCount
  }, [])

  const handleImportByDialog = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.document?.openFolder) return
    const res = await window.electronAPI.document.openFolder()
    if (!res.success || !res.path) return
    const count = upsertImportedPaths([res.path])
    if (count > 0) pushMessage(`已导入技能目录：${basename(res.path)}`)
  }, [pushMessage, upsertImportedPaths])

  const handleRemoveImported = useCallback((id: string) => {
    setImportedFolders((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const handleOpenPath = useCallback(async (path: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.document?.showInFolder) return
    await window.electronAPI.document.showInFolder(path)
  }, [])

  const resolveDroppedPaths = useCallback(async (e: DragEvent): Promise<string[]> => {
    const readyRaw = e.dataTransfer.getData('application/x-ready-drag')
    const result = new Set<string>()

    if (readyRaw) {
      try {
        const parsed = JSON.parse(readyRaw) as { type?: string; path?: string }
        if ((parsed.type === 'folder' || parsed.type === 'skill-folder') && parsed.path) {
          result.add(parsed.path)
        }
      } catch {
        // ignore malformed payload
      }
    }

    const nativeFiles = Array.from(e.dataTransfer.files)
    for (const file of nativeFiles) {
      const filePath = window.electronAPI?.getFilePathFromDrop?.(file)
      if (filePath) result.add(filePath)
    }

    if (!window.electronAPI?.document?.stat) return Array.from(result)

    const verified: string[] = []
    for (const path of result) {
      try {
        const statRes = await window.electronAPI.document.stat(path)
        if (statRes.success) {
          const isDirectory = statRes.data?.isDirectory ?? statRes.stat?.isDirectory ?? false
          if (isDirectory) verified.push(path)
        }
      } catch {
        // ignore unreadable path
      }
    }
    return verified
  }, [])

  const handleImportDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setImportDropActive(true)
  }, [])

  const handleImportDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setImportDropActive(false)
  }, [])

  const handleImportDrop = useCallback((e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setImportDropActive(false)
    void (async () => {
      const paths = await resolveDroppedPaths(e)
      if (paths.length === 0) {
        pushMessage('仅支持导入文件夹作为技能目录')
        return
      }
      const count = upsertImportedPaths(paths)
      if (count <= 0) {
        pushMessage('目录已存在，无需重复导入')
        return
      }
      pushMessage(`已导入 ${count} 个技能目录`)
    })()
  }, [pushMessage, resolveDroppedPaths, upsertImportedPaths])

  const sortedSkills = useMemo(
    () => [...skills].sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)),
    [skills],
  )

  const topHeight = `calc((100% - 4px) * ${skillsSplitRatio})`
  const bottomHeight = `calc((100% - 4px) * ${1 - skillsSplitRatio})`

  const handleSplitterMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const body = bodyRef.current
    if (!body) return

    const onMove = (ev: MouseEvent) => {
      const rect = body.getBoundingClientRect()
      const draggableHeight = Math.max(1, rect.height - 4)
      const y = ev.clientY - rect.top
      const ratio = (y - 2) / draggableHeight
      setSkillsSplitRatio(ratio)
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }, [setSkillsSplitRatio])

  const getSystemSkillPath = useCallback((skill: EmbeddedSkillState): string => {
    if (runtimeInfo?.skillsRoot) return `${runtimeInfo.skillsRoot}/${skill.id}`
    return skill.installStatePath.replace(/[\\/]\.ready-install-state\.json$/, '')
  }, [runtimeInfo?.skillsRoot])

  const openContextMenu = useCallback((e: React.MouseEvent, target: SkillCardContextTarget) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, target })
  }, [])

  const contextItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu) return []
    const base: ContextMenuItem[] = [
      {
        id: 'open-in-finder',
        label: '在 Finder 中打开',
        icon: <FolderOpen className="w-3.5 h-3.5" />,
        onClick: () => { void handleOpenPath(contextMenu.target.path) },
      },
    ]
    if (contextMenu.target.type === 'imported') {
      base.push({
        id: 'remove-from-list',
        label: '从列表中移除',
        icon: <Trash2 className="w-3.5 h-3.5" />,
        danger: true,
        onClick: () => handleRemoveImported(contextMenu.target.id),
      })
    }
    return base
  }, [contextMenu, handleOpenPath, handleRemoveImported])

  return (
    <div className="relative flex h-full min-h-0 flex-col" style={{ background: PANEL_COLORS.panelBg }}>
      <div
        className="shrink-0 border-b flex items-center"
        style={{ borderColor: PANEL_COLORS.border, height: SKILLS_PANEL_DIMENSIONS.headerHeight, padding: '10px 14px' }}
      >
        <span className="text-[13px] font-semibold" style={{ color: PANEL_COLORS.title }}>
          技能中心
        </span>
      </div>

      <div ref={bodyRef} className="flex-1 min-h-0 flex flex-col">
        <section
          className="shrink-0 border-b"
          style={{
            borderColor: PANEL_COLORS.border,
            background: PANEL_COLORS.panelBg,
            height: topHeight,
            minHeight: 156,
          }}
        >
          <div className="h-full min-h-0 overflow-auto">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
              <p className="shrink-0 text-[12px] font-semibold" style={{ color: PANEL_COLORS.sectionTitle }}>
                系统级 Skill
              </p>

              {sortedSkills.length === 0 ? (
                <p className="text-[11px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                  {loading ? '加载技能列表中...' : '暂无系统 Skill'}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {sortedSkills.map((skill) => {
                    const skillPath = getSystemSkillPath(skill)
                    const cardId = `system:${skill.id}`
                    const selected = selectedCardId === cardId
                    return (
                      <div
                        key={skill.id}
                        className="cursor-pointer transition-colors duration-150"
                        style={{
                          borderRadius: 8,
                          border: `1px solid ${selected ? PANEL_COLORS.blue : PANEL_COLORS.border}`,
                          padding: '10px 12px',
                          background: selected ? PANEL_COLORS.blueLight : PANEL_COLORS.cardBg,
                        }}
                        onClick={() => setSelectedCardId(cardId)}
                        onDoubleClick={() => void handleOpenPath(skillPath)}
                        onContextMenu={(e) => openContextMenu(e, { type: 'system', id: skill.id, path: skillPath })}
                        draggable
                        onDragStart={(e) => putSkillDragData(e, {
                          name: skill.name,
                          path: skillPath,
                          skillId: skill.id,
                          source: 'system',
                          defaultCommand: DEFAULT_ACTION_TEMPLATES[skill.id],
                        })}
                        title="拖拽到 Agent 对话框可调用 Skill"
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Folder className="shrink-0" style={{ width: 14, height: 14, color: PANEL_COLORS.iconAccent }} />
                          <p className="truncate" style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.25, color: PANEL_COLORS.text }}>
                            {skill.name}
                          </p>
                        </div>
                        <p
                          style={{
                            marginTop: 4,
                            fontSize: 11,
                            fontWeight: 500,
                            lineHeight: 1.4,
                            color: PANEL_COLORS.muted,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {skill.description}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          className="shrink-0 cursor-row-resize hover:bg-[#ECEAE4]"
          style={{
            background: PANEL_COLORS.panelBg,
            height: 4,
          }}
          onMouseDown={handleSplitterMouseDown}
          title="拖拽调整上下分区高度"
        />

        <section
          className="min-h-0"
          style={{ height: bottomHeight, minHeight: 156, background: PANEL_COLORS.panelBg }}
        >
          <div className="h-full min-h-0 overflow-auto">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
              <p className="shrink-0 text-[12px] font-semibold" style={{ color: PANEL_COLORS.sectionTitle }}>
                手动导入 Skill
              </p>

              <div
                className="shrink-0 flex flex-col items-center justify-center transition-colors cursor-pointer"
                style={{
                  borderRadius: 8,
                  border: `1px solid ${importDropActive ? PANEL_COLORS.blue : PANEL_COLORS.dropBorder}`,
                  background: importDropActive ? '#ECF3FF' : PANEL_COLORS.cardBg,
                  height: SKILLS_PANEL_DIMENSIONS.dropZoneHeight,
                  gap: 4,
                }}
                onClick={() => void handleImportByDialog()}
                onDragOver={handleImportDragOver}
                onDragLeave={handleImportDragLeave}
                onDrop={handleImportDrop}
              >
                <FolderInput className="h-[16px] w-[16px]" style={{ color: PANEL_COLORS.mutedStrong }} />
                <p className="text-[12px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                  拖拽 skill 文件夹到这里
                </p>
              </div>

              {importedFolders.length === 0 ? (
                <p className="text-[11px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                  暂无手动导入目录
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {importedFolders.map((folder) => {
                    const cardId = `imported:${folder.id}`
                    const selected = selectedCardId === cardId
                    return (
                      <div
                        key={folder.id}
                        className="cursor-pointer transition-colors duration-150"
                        style={{
                          borderRadius: 8,
                          border: `1px solid ${selected ? PANEL_COLORS.blue : PANEL_COLORS.border}`,
                          padding: '10px 12px',
                          background: selected ? PANEL_COLORS.blueLight : PANEL_COLORS.cardBg,
                        }}
                        onClick={() => setSelectedCardId(cardId)}
                        onDoubleClick={() => void handleOpenPath(folder.path)}
                        onContextMenu={(e) => openContextMenu(e, { type: 'imported', id: folder.id, path: folder.path })}
                        draggable
                        onDragStart={(e) => putSkillDragData(e, {
                          name: folder.name,
                          path: folder.path,
                          source: 'imported',
                          defaultCommand: `/skill ${folder.name}`,
                        })}
                        title="拖拽到 Agent 对话框可作为技能目录引用"
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Folder className="shrink-0" style={{ width: 14, height: 14, color: PANEL_COLORS.iconAccent }} />
                          <p className="truncate" style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.25, color: PANEL_COLORS.text }}>
                            {folder.name}
                          </p>
                        </div>
                        <p
                          style={{
                            marginTop: 4,
                            fontSize: 11,
                            fontWeight: 500,
                            lineHeight: 1.4,
                            color: PANEL_COLORS.muted,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            wordBreak: 'break-all',
                          }}
                        >
                          {folder.path}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {message && (
        <div className="pointer-events-none absolute left-[8px] right-[8px] bottom-[8px]">
          <div
            className="rounded-[7px] px-[8px] py-[4px] text-[10px] font-medium shadow-[0_3px_10px_rgba(0,0,0,0.08)]"
            style={{ background: '#5B8DEF18', color: PANEL_COLORS.blue }}
          >
            {message}
          </div>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          items={contextItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
