import { readReadyRefTransfer, writeReadyRefTransfer } from '../../../shared/ready-ref'
import { fileDragRef, prepareFileDragRef } from '../../modules/workbench/file-drag-ref'
import { beginSkillDrag, endSkillDrag } from '../../modules/workbench/skill-drag'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Boxes, Folder, FolderInput, FolderOpen, Loader2, Pen, Settings2, Trash2 } from 'lucide-react'
import { MODELS_RUNTIME_SETTINGS_SECTION } from '../../../shared/model-pack-types'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'
import { Button } from '../ui'
import { useWorkspace } from '../../stores/useWorkspace'
import { readStorage, removeStorage, writeStorage } from '../../utils/storage'
import { PANEL_TOKENS, SKILLS_PANEL_DIMENSIONS } from './panelTokens'
import type { PublicExternalServiceProfile } from '../../../shared/external-services'
import type {
  SkillConfigurationDefinition,
  SkillConfigurationView,
  SkillConfigValue,
} from '../../../shared/skill-configuration'

interface SkillActionDefinition {
  name: string
  description: string
  visibility?: 'public' | 'internal'
}

interface SkillState {
  id: string
  name: string
  description: string
  version: string
  installed: boolean
  installStatePath: string
  source: 'embedded' | 'custom'
  manifestValid: boolean
  defaultAction?: string
  actions: SkillActionDefinition[]
  executionMode: 'advisory' | 'workflow' | 'direct'
  managedPath?: string
  sourcePath?: string
  requiredBins?: string[]
  configuration?: SkillConfigurationDefinition
}

interface SkillsRuntimeInfo {
  skillsRoot: string
  customSkillsRoot: string
}

interface LegacyImportedSkillFolder {
  id?: string
  name?: string
  path: string
  addedAt?: number
}

interface LegacyImportedFolderParseResult {
  folders: LegacyImportedSkillFolder[]
  error: string | null
}

type SkillCardContextTarget = {
  skill: SkillState
  path: string
}

interface SkillsCenterPanelProps {
  children?: (slots: SidePanelSlots) => ReactNode
}

export interface SidePanelSlots {
  header: ReactNode
  body: ReactNode
}

const IMPORTED_SKILL_KEY = 'ready-imported-skill-folders'

// Reference/advisory skills (video-expert-analyzer, video-copy-analyzer) expose
// only `internal` actions to the LLM tool surface; their typed actions are
// invoked by product code (e.g. RSS item-analysis-manager) and must not be
// surfaced as user-typed slash defaults. Only public-action skills like
// lets-go-rss keep an explicit default command here.
const DEFAULT_SYSTEM_COMMANDS: Record<string, string> = {
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

function parseLegacyImportedFolders(): LegacyImportedFolderParseResult {
  if (typeof window === 'undefined') return { folders: [], error: null }
  try {
    const raw = readStorage(IMPORTED_SKILL_KEY)
    if (!raw) return { folders: [], error: null }
    const parsed = JSON.parse(raw) as LegacyImportedSkillFolder[]
    if (!Array.isArray(parsed)) {
      return { folders: [], error: '旧版技能目录数据损坏，已跳过无效记录。' }
    }
    return {
      folders: parsed.filter((item) => typeof item?.path === 'string' && item.path.trim().length > 0),
      error: null,
    }
  } catch {
    return { folders: [], error: '旧版技能目录数据损坏，已跳过无效记录。' }
  }
}

function buildDefaultCommand(skill: SkillState): string {
  if (skill.source === 'embedded' && DEFAULT_SYSTEM_COMMANDS[skill.id]) {
    return DEFAULT_SYSTEM_COMMANDS[skill.id]
  }
  if (skill.defaultAction) {
    return `/skill ${skill.id} ${skill.defaultAction}`
  }
  return `/skill ${skill.id}`
}

function putSkillDragData(
  e: DragEvent,
  payload: {
    name: string
    path: string
    skillId: string
    defaultCommand: string
    source: 'system' | 'imported'
  },
): void {
  const ref = fileDragRef(payload.path)
  beginSkillDrag(ref, { type: 'skill-folder', name: payload.name, path: payload.path, skillId: payload.skillId })
  writeReadyRefTransfer(e.dataTransfer, ref, payload.name)
  e.dataTransfer.effectAllowed = 'copy'
}

// P3-1 — discovered external skill candidate (mirrors main-side ExternalSkillCandidate).
type ExternalSkillCandidateView = {
  path: string
  name: string
  description: string
  source: 'user_agents_dir'
  alreadyImported: boolean
}

export default function SkillsCenterPanel({ children }: SkillsCenterPanelProps) {
  const [skills, setSkills] = useState<SkillState[]>([])
  const [runtimeInfo, setRuntimeInfo] = useState<SkillsRuntimeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [importDropActive, setImportDropActive] = useState(false)
  // P3-1 — discovered ~/.agents/skills candidates (suggest-import; rendered only when non-empty).
  const [externalCandidates, setExternalCandidates] = useState<ExternalSkillCandidateView[]>([])
  // P3-2 — per-custom-skill local-execution consent info.
  const [shellConsentMap, setShellConsentMap] = useState<Record<string, { hasScripts: boolean; consent: boolean }>>({})
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: SkillCardContextTarget } | null>(null)
  const [editingSkill, setEditingSkill] = useState<SkillState | null>(null)
  const [configuringSkill, setConfiguringSkill] = useState<SkillState | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [savingDescription, setSavingDescription] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  const migratedLegacyRef = useRef(false)
  const skillsSplitRatio = useWorkspace((state) => state.skillsSplitRatio)
  const setSkillsSplitRatio = useWorkspace((state) => state.setSkillsSplitRatio)

  const pushMessage = useCallback((text: string) => {
    setMessage(text)
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        setMessage((current) => (current === text ? '' : current))
      }, 2400)
    }
  }, [])

  const refreshSkills = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.skills) return
    setLoading(true)
    try {
      const [skillsRes, runtimeRes] = await Promise.all([
        window.electronAPI.skills.list(),
        window.electronAPI.skills.runtimeInfo(),
      ])
      if (skillsRes.success && skillsRes.data) {
        setSkills(skillsRes.data as SkillState[])
      }
      if (runtimeRes.success && runtimeRes.data) {
        setRuntimeInfo(runtimeRes.data as SkillsRuntimeInfo)
      }
      // P3-1 — read-only discovery; failures are silent (the section just stays hidden).
      try {
        const candidatesRes = await window.electronAPI.skills.listExternalCandidates?.()
        setExternalCandidates(candidatesRes?.success && candidatesRes.data ? candidatesRes.data : [])
      } catch {
        setExternalCandidates([])
      }
      // P3-2 — shell-consent info for the toggle; silent on failure.
      try {
        const consentRes = await window.electronAPI.skills.listShellConsent?.()
        setShellConsentMap(consentRes?.success && consentRes.data ? consentRes.data : {})
      } catch {
        setShellConsentMap({})
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSkills()
  }, [refreshSkills])

  const importFolders = useCallback(async (paths: string[]) => {
    if (typeof window === 'undefined' || !window.electronAPI?.skills?.importCustomSkill) return { imported: 0, failed: paths, warnings: [], ignoredFields: [] }
    const uniquePaths = Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)))
    let imported = 0
    const failed: string[] = []
    // P2-4/P2-5 — non-blocking import metadata surfaced to the user (ignored allowed-tools / oversized SKILL.md).
    const warnings: string[] = []
    const ignoredFields: string[] = []

    for (const path of uniquePaths) {
      try {
        const res = await window.electronAPI.skills.importCustomSkill({ path })
        if (res.success && res.data) {
          imported += 1
          for (const warning of res.data.warnings || []) warnings.push(warning)
          for (const field of res.data.ignoredFields || []) if (!ignoredFields.includes(field)) ignoredFields.push(field)
        } else {
          failed.push(path)
        }
      } catch {
        failed.push(path)
      }
    }

    if (imported > 0) {
      await refreshSkills()
    }
    return { imported, failed, warnings, ignoredFields }
  }, [refreshSkills])

  useEffect(() => {
    if (migratedLegacyRef.current || typeof window === 'undefined' || !window.electronAPI?.skills?.importCustomSkill) return
    migratedLegacyRef.current = true
    const legacyFolders = parseLegacyImportedFolders()
    if (legacyFolders.error) {
      pushMessage(legacyFolders.error)
    }
    if (legacyFolders.folders.length === 0) {
      removeStorage(IMPORTED_SKILL_KEY)
      return
    }

    void (async () => {
      const { imported, failed } = await importFolders(legacyFolders.folders.map((item) => item.path))
      if (failed.length > 0) {
        writeStorage(
          IMPORTED_SKILL_KEY,
          JSON.stringify(failed.map((path) => ({ path, name: basename(path), addedAt: Date.now() }))),
        )
        pushMessage(`旧版技能目录已迁移 ${imported} 个，失败 ${failed.length} 个`)
        return
      }
      removeStorage(IMPORTED_SKILL_KEY)
      if (imported > 0) {
        pushMessage(`已迁移 ${imported} 个旧版技能目录`)
      }
    })()
  }, [importFolders, pushMessage])

  const handleImportByDialog = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.document?.openFolder) return
    const res = await window.electronAPI.document.openFolder()
    if (!res.success || !res.path) return
    const result = await importFolders([res.path])
    if (result.imported > 0) {
      pushMessage(`已导入技能：${basename(res.path)}`)
    } else {
      pushMessage('导入失败，请确认目录内包含可识别的 skill 清单或文档')
    }
  }, [importFolders, pushMessage])

  const handleOpenPath = useCallback(async (path: string) => {
    if (!path || typeof window === 'undefined' || !window.electronAPI?.document?.showInFolder) return
    await window.electronAPI.document.showInFolder(path)
  }, [])

  const resolveDroppedPaths = useCallback(async (e: DragEvent): Promise<{
    paths: string[]
    malformedPayloadCount: number
    unreadablePaths: string[]
  }> => {
    const dropped = readReadyRefTransfer(e.dataTransfer)
    const result = new Set<string>()
    const malformedPayloadCount = 0
    if (dropped?.ref.kind === 'file') {
      const location = await window.electronAPI.objects.locate(dropped.ref.id)
      if (location) result.add(location.path)
    }

    const nativeFiles = Array.from(e.dataTransfer.files)
    for (const file of nativeFiles) {
      const filePath = window.electronAPI?.getFilePathFromDrop?.(file)
      if (filePath) result.add(filePath)
    }

    if (!window.electronAPI?.document?.stat) {
      return { paths: Array.from(result), malformedPayloadCount, unreadablePaths: [] }
    }

    const verified: string[] = []
    const unreadablePaths: string[] = []
    for (const path of result) {
      try {
        const statRes = await window.electronAPI.document.stat(path)
        if (statRes.success) {
          const isDirectory = statRes.data?.isDirectory ?? statRes.stat?.isDirectory ?? false
          if (isDirectory) verified.push(path)
        } else {
          unreadablePaths.push(path)
        }
      } catch {
        unreadablePaths.push(path)
      }
    }
    return { paths: verified, malformedPayloadCount, unreadablePaths }
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
      const { paths, malformedPayloadCount, unreadablePaths } = await resolveDroppedPaths(e)
      if (paths.length === 0) {
        if (malformedPayloadCount > 0) {
          pushMessage('拖拽数据损坏，无法识别可导入的 skill 文件夹。')
          return
        }
        if (unreadablePaths.length > 0) {
          pushMessage(`拖入内容无法读取：${unreadablePaths.length} 个路径检查失败。`)
          return
        }
        pushMessage('仅支持导入 skill 文件夹')
        return
      }
      const result = await importFolders(paths)
      if (result.imported > 0) {
        const warningSuffix = malformedPayloadCount > 0
          ? '，但有拖拽数据损坏已被忽略'
          : unreadablePaths.length > 0
            ? `，但有 ${unreadablePaths.length} 个路径无法读取`
            : ''
        pushMessage(`已导入 ${result.imported} 个 skill${warningSuffix}`)
        // P2-4 — imported skills never bring their own tool authorization; say so plainly.
        if (result.ignoredFields.includes('allowed-tools')) {
          pushMessage('已忽略技能自带的 allowed-tools：工具授权只由 Ready 决定，导入技能不会自带工具权限。')
        }
        // P2-5 — author advisory for an oversized SKILL.md (activation-time truncation).
        for (const warning of result.warnings) pushMessage(warning)
      } else {
        pushMessage('没有成功导入任何 skill，请检查目录内容')
      }
    })()
  }, [importFolders, pushMessage, resolveDroppedPaths])

  const handleRemoveCustomSkill = useCallback(async (skill: SkillState) => {
    if (typeof window === 'undefined' || !window.electronAPI?.skills?.removeCustomSkill) return
    const confirmed = confirm(`确定移除技能 “${skill.name}” 吗？`)
    if (!confirmed) return
    const res = await window.electronAPI.skills.removeCustomSkill({ skillId: skill.id })
    if (res.success && res.data?.removed) {
      setContextMenu(null)
      pushMessage(`已移除技能：${skill.name}`)
      await refreshSkills()
      return
    }
    pushMessage(`移除失败：${res.error || skill.name}`)
  }, [pushMessage, refreshSkills])

  const handleSaveSkillEdits = useCallback(async () => {
    if (!editingSkill || typeof window === 'undefined' || !window.electronAPI?.skills?.updateCustomSkillDescription) return
    setSavingDescription(true)
    try {
      const res = await window.electronAPI.skills.updateCustomSkillDescription({
        skillId: editingSkill.id,
        description: descriptionDraft,
        name: nameDraft,
      })
      if (res.success && res.data) {
        const updated = res.data as SkillState
        setSkills((prev) => prev.map((item) => item.id === editingSkill.id ? updated : item))
        setEditingSkill(null)
        setDescriptionDraft('')
        setNameDraft('')
        pushMessage(`已更新技能：${updated.name}`)
        return
      }
      pushMessage(`更新失败：${res.error || editingSkill.name}`)
    } finally {
      setSavingDescription(false)
    }
  }, [descriptionDraft, nameDraft, editingSkill, pushMessage])

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

  const getSkillPath = useCallback((skill: SkillState): string => {
    if (skill.source === 'embedded') {
      if (runtimeInfo?.skillsRoot) return `${runtimeInfo.skillsRoot}/${skill.id}`
      return skill.managedPath || skill.installStatePath.replace(/[\\/]\.ready-install-state\.json$/, '')
    }
    return skill.managedPath || skill.sourcePath || ''
  }, [runtimeInfo?.skillsRoot])

  useEffect(() => { for (const skill of skills) { const path = getSkillPath(skill); if (path) void prepareFileDragRef(path, true).catch(error => console.warn('[SkillsCenter] drag identity', error)) } }, [skills, getSkillPath])

  const systemSkills = useMemo(
    () => skills.filter((skill) => skill.source === 'embedded').sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name)),
    [skills],
  )

  const customSkills = useMemo(
    () => skills.filter((skill) => skill.source === 'custom').sort((a, b) => a.name.localeCompare(b.name)),
    [skills],
  )

  const topHeight = `calc((100% - 4px) * ${skillsSplitRatio})`
  const bottomHeight = `calc((100% - 4px) * ${1 - skillsSplitRatio})`

  const openContextMenu = useCallback((e: React.MouseEvent, skill: SkillState) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, target: { skill, path: getSkillPath(skill) } })
  }, [getSkillPath])

  const contextItems = useMemo<ContextMenuItem[]>(() => {
    if (!contextMenu) return []
    const { skill, path } = contextMenu.target
    const items: ContextMenuItem[] = [
      {
        id: 'open-in-finder',
        label: '在 Finder 中打开',
        icon: <FolderOpen style={{ width: 16, height: 16 }} />,
        onClick: () => { void handleOpenPath(path) },
      },
    ]

    if (skill.configuration) {
      items.push({
        id: 'configure-skill',
        label: '配置',
        icon: <Settings2 style={{ width: 16, height: 16 }} />,
        onClick: () => { setConfiguringSkill(skill) },
      })
    }

    if (skill.source === 'custom') {
      items.push(
        {
          id: 'edit-description',
          label: '编辑技能',
          icon: <Pen style={{ width: 16, height: 16 }} />,
          onClick: () => {
            setEditingSkill(skill)
            setDescriptionDraft(skill.description || '')
            setNameDraft(skill.name || '')
          },
        },
        { id: 'sep-1', label: '', separator: true },
        {
          id: 'remove-custom-skill',
          label: '移除技能',
          icon: <Trash2 style={{ width: 16, height: 16 }} />,
          danger: true,
          onClick: () => { void handleRemoveCustomSkill(skill) },
        },
      )
    }
    return items
  }, [contextMenu, handleOpenPath, handleRemoveCustomSkill])

  const header = (
    <div
      className="shrink-0 border-b flex items-center"
      style={{
        borderColor: 'transparent',
        height: SKILLS_PANEL_DIMENSIONS.headerHeight,
        padding: `0 ${SKILLS_PANEL_DIMENSIONS.sectionPaddingX}px`,
        boxSizing: 'border-box',
        background: 'transparent',
      }}
    >
      <span className="text-[13px] font-semibold" style={{ color: PANEL_COLORS.title }}>
        技能中心
      </span>
    </div>
  )

  const body = (
    <div ref={bodyRef} className="flex-1 min-h-0 flex flex-col">
        <section
          className="shrink-0 border-b"
          style={{
            borderColor: 'transparent',
            background: 'transparent',
            height: topHeight,
            minHeight: 156,
          }}
        >
          <div className="panel-hover-scrollbar h-full min-h-0 overflow-auto">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
              <p className="shrink-0 text-[12px] font-semibold" style={{ color: PANEL_COLORS.sectionTitle }}>
                系统级 Skill
              </p>

              {systemSkills.length === 0 ? (
                <p className="text-[11px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                  {loading ? '加载技能列表中...' : '暂无系统 Skill'}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {systemSkills.map((skill) => {
                    const skillPath = getSkillPath(skill)
                    const cardId = `system:${skill.id}`
                    const selected = selectedCardId === cardId
                    return (
                      <div
                        key={skill.id}
                        className="cursor-pointer rounded-[8px] border transition-colors duration-150 hover:bg-[var(--rn-fill)]"
                        style={{
                          borderRadius: 8,
                          border: '1px solid transparent',
                          padding: '10px 12px',
                          background: selected ? 'var(--rn-fill)' : 'transparent',
                        }}
                        onClick={() => setSelectedCardId(cardId)}
                        onDoubleClick={() => void handleOpenPath(skillPath)}
                        onContextMenu={(e) => openContextMenu(e, skill)}
                        draggable
                        onDragEnd={endSkillDrag}
                        onDragStart={(e) => putSkillDragData(e, {
                          name: skill.name,
                          path: skillPath,
                          skillId: skill.id,
                          source: 'system',
                          defaultCommand: buildDefaultCommand(skill),
                        })}
                        title="拖拽到 Agent 输入框可直接插入 @[技能名称] 引用"
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
                            lineHeight: 1.45,
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
          className="shrink-0 cursor-row-resize hover:bg-[var(--rn-fill)]"
          style={{ background: 'transparent', height: 4 }}
          onMouseDown={handleSplitterMouseDown}
          title="拖拽调整上下分区高度"
        />

        <section className="min-h-0" style={{ height: bottomHeight, minHeight: 156, background: 'transparent' }}>
          <div className="panel-hover-scrollbar h-full min-h-0 overflow-auto">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 14px' }}>
              <p className="shrink-0 text-[12px] font-semibold" style={{ color: PANEL_COLORS.sectionTitle }}>
                用户导入 Skill
              </p>

              <div
                className="shrink-0 flex cursor-pointer flex-col items-center justify-center rounded-[8px] border transition-colors hover:bg-[var(--rn-fill)]"
                style={{
                  borderRadius: 8,
                  border: importDropActive ? `1px solid ${PANEL_COLORS.blue}` : '1px solid transparent',
                  background: importDropActive ? PANEL_COLORS.blueLight : 'transparent',
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
                  拖拽或点击导入 skill 文件夹
                </p>
              </div>

              {customSkills.length === 0 ? (
                <p className="text-[11px] font-medium" style={{ color: PANEL_COLORS.mutedStrong }}>
                  {loading ? '加载中...' : '暂无用户导入 Skill'}
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {customSkills.map((skill) => {
                    const cardId = `custom:${skill.id}`
                    const selected = selectedCardId === cardId
                    const skillPath = getSkillPath(skill)
                    return (
                      <div
                        key={skill.id}
                        className="cursor-pointer rounded-[8px] border transition-colors duration-150 hover:bg-[var(--rn-fill)]"
                        style={{
                          borderRadius: 8,
                          border: '1px solid transparent',
                          padding: '10px 12px',
                          background: selected ? 'var(--rn-fill)' : 'transparent',
                        }}
                        onClick={() => setSelectedCardId(cardId)}
                        onDoubleClick={() => void handleOpenPath(skillPath)}
                        onContextMenu={(e) => openContextMenu(e, skill)}
                        draggable
                        onDragEnd={endSkillDrag}
                        onDragStart={(e) => putSkillDragData(e, {
                          name: skill.name,
                          path: skillPath,
                          skillId: skill.id,
                          source: 'imported',
                          defaultCommand: buildDefaultCommand(skill),
                        })}
                        title="拖拽到 Agent 输入框可直接插入 @[技能名称] 引用"
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Folder className="shrink-0" style={{ width: 14, height: 14, color: PANEL_COLORS.iconAccent }} />
                          <p className="truncate" style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.25, color: PANEL_COLORS.text }}>
                            {skill.name}
                          </p>
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: PANEL_COLORS.mutedStrong }}>
                            {skill.defaultAction || skill.actions[0]?.name || '无动作'}
                          </span>
                        </div>
                        <p
                          style={{
                            marginTop: 4,
                            fontSize: 11,
                            fontWeight: 500,
                            lineHeight: 1.45,
                            color: PANEL_COLORS.muted,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {skill.description || '暂无技能说明'}
                        </p>
                        <p
                          style={{
                            marginTop: 4,
                            fontSize: 10,
                            lineHeight: 1.4,
                            color: PANEL_COLORS.mutedStrong,
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            wordBreak: 'break-all',
                          }}
                        >
                          {skill.sourcePath || skill.managedPath || runtimeInfo?.customSkillsRoot || ''}
                        </p>
                        {/* P3-2 — only bundled scripts require a Ready-specific consent toggle. */}
                        {shellConsentMap[skill.id]?.hasScripts && (
                          <div
                            style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              style={{
                                fontSize: 10,
                                fontWeight: 600,
                                color: shellConsentMap[skill.id]?.consent ? PANEL_COLORS.blue : PANEL_COLORS.mutedStrong,
                              }}
                              onClick={() => void (async () => {
                                const next = !shellConsentMap[skill.id]?.consent
                                const res = await window.electronAPI?.skills?.setShellConsent?.({ skillId: skill.id, granted: next })
                                if (res?.success) {
                                  setShellConsentMap((prev) => ({ ...prev, [skill.id]: { hasScripts: true, consent: next } }))
                                }
                              })()}
                            >
                              {shellConsentMap[skill.id]?.consent ? '● 已允许运行脚本' : '○ 允许运行脚本'}
                            </button>
                            <span style={{ fontSize: 9, color: PANEL_COLORS.mutedStrong }}>
                              开启后 agent 可运行该技能脚本，请确认来源可信
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* P3-1 — discovered ~/.agents/skills candidates (suggest-import; only when non-empty). */}
              {externalCandidates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <p className="shrink-0 text-[12px] font-semibold" style={{ color: PANEL_COLORS.sectionTitle, marginTop: 4 }}>
                    发现的技能（~/.agents/skills）
                  </p>
                  {externalCandidates.map((candidate) => (
                    <div
                      key={candidate.path}
                      className="rounded-[8px] border transition-colors duration-150 hover:bg-[var(--rn-fill)]"
                      style={{ borderRadius: 8, border: '1px solid transparent', padding: '10px 12px' }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Folder className="shrink-0" style={{ width: 14, height: 14, color: PANEL_COLORS.iconAccent }} />
                        <p className="truncate" style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.25, color: PANEL_COLORS.text }}>
                          {candidate.name}
                        </p>
                        {candidate.alreadyImported ? (
                          <span style={{ marginLeft: 'auto', fontSize: 10, color: PANEL_COLORS.mutedStrong }}>已导入</span>
                        ) : (
                          <button
                            type="button"
                            style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: PANEL_COLORS.blue }}
                            onClick={() => void (async () => {
                              const result = await importFolders([candidate.path])
                              pushMessage(result.imported > 0 ? `已导入 ${candidate.name}` : `导入 ${candidate.name} 失败`)
                              for (const warning of result.warnings) pushMessage(warning)
                            })()}
                          >
                            导入
                          </button>
                        )}
                      </div>
                      <p
                        style={{
                          marginTop: 4, fontSize: 11, fontWeight: 500, lineHeight: 1.45, color: PANEL_COLORS.muted,
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}
                      >
                        {candidate.description}
                      </p>
                      <p
                        style={{
                          marginTop: 4, fontSize: 10, lineHeight: 1.4, color: PANEL_COLORS.mutedStrong,
                          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-all',
                        }}
                      >
                        {candidate.path}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
    </div>
  )

  const overlays = (
    <>
      {message && (
        <div className="pointer-events-none absolute left-[8px] right-[8px] bottom-[8px]">
          <div
            className="glass-surface-floating rounded-[8px] px-[8px] py-[4px] text-[10px] font-medium"
            style={{ background: PANEL_COLORS.blueLight, color: PANEL_COLORS.blue, boxShadow: 'var(--shadow-sm)' }}
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

      <DescriptionEditorDialog
        open={Boolean(editingSkill)}
        nameValue={nameDraft}
        onNameChange={setNameDraft}
        value={descriptionDraft}
        saving={savingDescription}
        onChange={setDescriptionDraft}
        onClose={() => {
          if (savingDescription) return
          setEditingSkill(null)
          setDescriptionDraft('')
          setNameDraft('')
        }}
        onSave={() => { void handleSaveSkillEdits() }}
      />

      <SkillConfigurationDialog
        open={Boolean(configuringSkill)}
        skill={configuringSkill}
        onClose={() => setConfiguringSkill(null)}
        onSaved={(text) => {
          setConfiguringSkill(null)
          pushMessage(text)
        }}
      />
    </>
  )

  const shell = (
    <div className="relative flex h-full min-h-0 flex-col">
      {header}
      {body}
      {overlays}
    </div>
  )

  if (children) {
    return <>{children({ header, body })}{overlays}</>
  }

  return shell
}

function DescriptionEditorDialog({
  open,
  nameValue,
  onNameChange,
  value,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean
  nameValue: string
  onNameChange: (value: string) => void
  value: string
  saving: boolean
  onChange: (value: string) => void
  onClose: () => void
  onSave: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(value.length, value.length)
    }, 20)
    return () => window.clearTimeout(timer)
  }, [open, value])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        onSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onSave, open])

  if (!open) return null

  return (
    <div
      className="absolute inset-[8px] z-[260] flex items-center justify-center"
      style={{ background: 'transparent' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="rn-float"
        style={{
          width: 460,
          maxWidth: '100%',
          padding: 20,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--rn-ink)' }}>
          编辑技能
        </h3>
        <label style={{ display: 'block', margin: '14px 0 6px', fontSize: 12, fontWeight: 500, color: 'var(--rn-ink-2)' }}>
          技能名称
        </label>
        <input
          type="text"
          value={nameValue}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="为技能取一个清晰的名字"
          style={{
            width: '100%',
            padding: '8px 12px',
            fontSize: 13,
            lineHeight: 1.5,
            color: 'var(--rn-ink)',
            background: 'var(--rn-fill)',
            border: '1px solid var(--rn-hair-2)',
            borderRadius: 8,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <label style={{ display: 'block', margin: '14px 0 6px', fontSize: 12, fontWeight: 500, color: 'var(--rn-ink-2)' }}>
          技能说明
        </label>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="请输入更清晰的技能说明，帮助 Agent 更准确地选择和调用它。"
          style={{
            width: '100%',
            minHeight: 140,
            resize: 'vertical',
            padding: '10px 12px',
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--rn-ink)',
            background: 'var(--rn-fill)',
            border: '1px solid var(--rn-hair-2)',
            borderRadius: 8,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, gap: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--rn-ink-3)' }}>⌘/Ctrl + Enter 保存</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={onSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillConfigurationDialog({
  open,
  skill,
  onClose,
  onSaved,
}: {
  open: boolean
  skill: SkillState | null
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [view, setView] = useState<SkillConfigurationView | null>(null)
  const [services, setServices] = useState<PublicExternalServiceProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const usesSubtitleModels = skill?.id === 'video-expert-analyzer' || skill?.id === 'video-copy-analyzer'

  useEffect(() => {
    if (!open || !skill) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const [configRes, servicesRes] = await Promise.all([
          window.electronAPI.skills.getConfiguration({ skillId: skill.id }),
          window.electronAPI.settings.listExternalServices(),
        ])
        if (cancelled) return
        if (configRes.success && configRes.data) {
          setView(configRes.data as SkillConfigurationView)
        } else {
          setError(configRes.error || '读取技能配置失败')
        }
        if (servicesRes.success && servicesRes.data) {
          setServices(servicesRes.data as PublicExternalServiceProfile[])
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, skill])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  const updateBinding = useCallback((id: string, value: string) => {
    setView((current) => current ? {
      ...current,
      values: {
        ...current.values,
        serviceBindings: {
          ...current.values.serviceBindings,
          [id]: value,
        },
      },
    } : current)
  }, [])

  const updateField = useCallback((id: string, value: SkillConfigValue) => {
    setView((current) => current ? {
      ...current,
      values: {
        ...current.values,
        fields: {
          ...current.values.fields,
          [id]: value,
        },
      },
    } : current)
  }, [])

  const save = useCallback(async () => {
    if (!skill || !view) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.electronAPI.skills.updateConfiguration({
        skillId: skill.id,
        serviceBindings: view.values.serviceBindings,
        fields: view.values.fields,
      })
      if (res.success) {
        onSaved(`已保存配置：${skill.name}`)
      } else {
        setError(res.error || '保存失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [onSaved, skill, view])

  const openModelsRuntimeSettings = useCallback(() => {
    onClose()
    navigate(`/settings?section=${MODELS_RUNTIME_SETTINGS_SECTION}`)
  }, [navigate, onClose])

  if (!open || !skill) return null

  const definition = view?.definition || skill.configuration || null
  const hasConfig = Boolean(definition && (definition.serviceBindings.length > 0 || definition.fields.length > 0))

  return (
    <div
      data-ready-native-overlay=""
      className="fixed inset-0 z-[10020] flex items-center justify-center"
      style={{ background: 'transparent' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="rn-float"
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'calc(100vh - 80px)',
          overflow: 'auto',
          padding: 20,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--rn-ink)' }}>
          配置 Skill
        </h3>
        <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--rn-ink-2)' }}>
          {skill.name}
        </p>

        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--rn-ink-2)' }}>
              <Loader2 size={14} className="animate-spin" />
              加载配置...
            </div>
          )}

          {!loading && !hasConfig && (
            <div style={{ fontSize: 12, color: 'var(--rn-ink-2)', lineHeight: 1.6 }}>
              这个 Skill 当前没有需要单独配置的项目。
            </div>
          )}

          {!loading && definition?.serviceBindings.map((binding) => {
            const options = services.filter((service) => binding.allowedKinds.includes(service.kind))
            return (
              <label key={binding.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--rn-ink-2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--rn-ink)' }}>{binding.label}</span>
                {binding.description && <span style={{ fontSize: 11, lineHeight: 1.5 }}>{binding.description}</span>}
                <select
                  value={view?.values.serviceBindings[binding.id] || binding.defaultServiceId || ''}
                  onChange={(event) => updateBinding(binding.id, event.target.value)}
                  style={{
                    width: '100%',
                    padding: '9px 10px',
                    fontSize: 12,
                    color: 'var(--rn-ink)',
                    background: 'var(--rn-fill)',
                    border: '1px solid var(--rn-hair-2)',
                    borderRadius: 8,
                    outline: 'none',
                  }}
                >
                  <option value="">不绑定</option>
                  {options.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}{service.enabled ? '' : '（未启用）'}
                    </option>
                  ))}
                </select>
              </label>
            )
          })}

          {!loading && definition?.fields.map((field) => {
            const value = view?.values.fields[field.id] ?? field.defaultValue ?? ''
            return (
              <label key={field.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--rn-ink-2)' }}>
                <span style={{ fontWeight: 600, color: 'var(--rn-ink)' }}>{field.label}</span>
                {field.description && <span style={{ fontSize: 11, lineHeight: 1.5 }}>{field.description}</span>}
                {field.type === 'boolean' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(value)}
                      onChange={(event) => updateField(field.id, event.target.checked)}
                    />
                    启用
                  </span>
                ) : field.type === 'select' ? (
                  <select
                    value={String(value || '')}
                    onChange={(event) => updateField(field.id, event.target.value)}
                    style={{
                      width: '100%',
                      padding: '9px 10px',
                      fontSize: 12,
                      color: 'var(--rn-ink)',
                      background: 'var(--rn-fill)',
                      border: '1px solid var(--rn-hair-2)',
                      borderRadius: 8,
                      outline: 'none',
                    }}
                  >
                    {(field.options || []).map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                    value={String(value || '')}
                    onChange={(event) => updateField(field.id, field.type === 'number' ? Number(event.target.value) : event.target.value)}
                    style={{
                      width: '100%',
                      padding: '9px 10px',
                      fontSize: 12,
                      color: 'var(--rn-ink)',
                      background: 'var(--rn-fill)',
                      border: '1px solid var(--rn-hair-2)',
                      borderRadius: 8,
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </label>
            )
          })}

          {!loading && usesSubtitleModels && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: 12,
                border: '1px solid var(--rn-hair-2)',
                borderRadius: 8,
                background: 'var(--rn-fill)',
                color: 'var(--rn-ink-2)',
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Boxes size={15} />
                <span style={{ overflowWrap: 'anywhere' }}>
                  字幕识别依赖按需下载的语音模型，可在「设置 › 模型与运行时」中下载或更新。
                </span>
              </div>
              <Button size="sm" icon={<Settings2 />} onClick={openModelsRuntimeSettings} style={{ flexShrink: 0 }}>
                前往设置
              </Button>
            </div>
          )}
        </div>

        {error && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--rn-bad)', lineHeight: 1.5 }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', marginTop: 16, gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={() => { void save() }} disabled={saving || loading || !hasConfig}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  )
}
