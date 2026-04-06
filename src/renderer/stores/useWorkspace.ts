import { create } from 'zustand'
import { readJsonStorage, readStorage, removeStorage, writeJsonStorage, writeStorage } from '../utils/storage'

export interface FileItem {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: Date
}

export type SidePanelWidthKey = 'files' | 'search' | 'skills'
export type WorkspaceSidePanelVariant = SidePanelWidthKey | 'hidden'

interface SidePanelWidths {
  // 三个面板共享一个宽度，避免切换时跳跃
  shared: number
}

interface WorkspaceState {
  // State
  workspaceRoot: string | null
  currentPath: string
  files: FileItem[]
  selectedFile: string | null
  expandedDirs: Set<string>
  dirChildren: Map<string, FileItem[]>
  pinnedFolders: string[]
  sidebarVisible: boolean
  sidePanelVariant: WorkspaceSidePanelVariant
  sidePanelWidths: SidePanelWidths
  skillsSplitRatio: number
  chatPanelVisible: boolean
  chatPanelWidth: number
  renamingPath: string | null
  creatingType: 'file' | 'folder' | null
  creatingPath: string | null

  // Navigation
  setCurrentPath: (path: string) => void
  setFiles: (files: FileItem[]) => void
  selectFile: (path: string | null) => void
  toggleSidebar: () => void
  setSidePanelVariant: (variant: WorkspaceSidePanelVariant) => void
  setSidePanelWidth: (variant: SidePanelWidthKey, width: number) => void
  setSkillsSplitRatio: (ratio: number) => void
  toggleChatPanel: () => void
  refreshFiles: () => Promise<void>
  toggleDir: (path: string) => Promise<void>
  loadDirChildren: (path: string) => Promise<FileItem[]>

  // Workspace
  setWorkspaceRoot: (path: string) => void
  clearWorkspace: () => void
  openFolderDialog: () => Promise<void>
  addPinnedFolder: (path: string) => void
  removePinnedFolder: (path: string) => void
  saveWorkspace: (name: string) => void
  getSavedWorkspaces: () => { name: string; folders: string[] }[]
  loadSavedWorkspace: (folders: string[]) => void
  deleteSavedWorkspace: (name: string) => void

  // File operations
  createFile: (name: string) => Promise<boolean>
  createFolder: (name: string) => Promise<boolean>
  renameItem: (oldPath: string, newName: string) => Promise<boolean>
  deleteItem: (path: string) => Promise<boolean>
  moveItem: (src: string, dest: string) => Promise<boolean>
  showInFolder: (path: string) => Promise<void>
  copyPathToClipboard: (path: string) => void

  // Inline editing state
  startRenaming: (path: string) => void
  cancelRenaming: () => void
  startCreating: (type: 'file' | 'folder') => void
  cancelCreating: () => void
}

const getPathSeparator = (path: string): '/' | '\\' => {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

const isWindowsDriveRoot = (path: string): boolean => /^[A-Za-z]:\\?$/.test(path)

const normalizeDirectoryPath = (path: string): string => {
  if (!path) return path
  const separator = getPathSeparator(path)
  if (separator === '\\') {
    if (isWindowsDriveRoot(path)) {
      return path.endsWith('\\') ? path : `${path}\\`
    }
    return path.replace(/\\+$/, '')
  }
  if (path === '/') return '/'
  return path.replace(/\/+$/, '')
}

// Helper to get dirname
const getDirName = (path: string): string => {
  const separator = getPathSeparator(path)
  const normalized = normalizeDirectoryPath(path)
  if (!normalized) return separator

  if (separator === '\\') {
    if (isWindowsDriveRoot(normalized)) return normalized
    const idx = normalized.lastIndexOf('\\')
    if (idx < 0) return normalized
    if (idx <= 2 && /^[A-Za-z]:/.test(normalized)) {
      return `${normalized.slice(0, 2)}\\`
    }
    return normalized.slice(0, idx)
  }

  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? '/' : normalized.slice(0, idx)
}

const joinChildPath = (dir: string, name: string): string => {
  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const normalized = dir.replace(/[\\/]+$/, '')
  if (!normalized) return `${separator}${name}`
  return `${normalized}${separator}${name}`
}

const isSameOrDescendantPath = (path: string, ancestor: string): boolean => {
  const normalizedPath = normalizeDirectoryPath(path)
  const normalizedAncestor = normalizeDirectoryPath(ancestor)
  if (!normalizedPath || !normalizedAncestor) return false
  if (normalizedPath === normalizedAncestor) return true
  const separator = getPathSeparator(normalizedPath)
  return normalizedPath.startsWith(`${normalizedAncestor}${separator}`)
}

const expandDirsForTarget = (
  targetDir: string,
  expandedDirs: Set<string>,
  pinnedFolders: string[],
): Set<string> => {
  const next = new Set(expandedDirs)
  const normalizedTarget = normalizeDirectoryPath(targetDir)
  if (!normalizedTarget || normalizedTarget === '/') return next

  const pinnedAncestor = pinnedFolders.find((folder) => isSameOrDescendantPath(normalizedTarget, folder))
  let cursor = normalizedTarget

  while (cursor) {
    next.add(cursor)

    if (pinnedAncestor && normalizeDirectoryPath(cursor) === normalizeDirectoryPath(pinnedAncestor)) {
      break
    }

    const parent = getDirName(cursor)
    if (!parent || parent === cursor) break
    if (parent === '/' || isWindowsDriveRoot(parent)) {
      if (!pinnedAncestor) next.add(parent)
      break
    }
    cursor = parent
  }

  return next
}

const isKnownDirectoryPath = (
  path: string | null,
  files: FileItem[],
  dirChildren: Map<string, FileItem[]>,
  pinnedFolders: string[],
): boolean => {
  if (!path) return false
  if (pinnedFolders.includes(path)) return true
  if (files.some((item) => item.path === path && item.isDirectory)) return true
  for (const children of dirChildren.values()) {
    if (children.some((item) => item.path === path && item.isDirectory)) return true
  }
  return false
}

const resolveCreationBaseDir = (state: Pick<
  WorkspaceState,
  'currentPath' | 'workspaceRoot' | 'pinnedFolders' | 'selectedFile' | 'files' | 'dirChildren'
>): string => {
  if (isKnownDirectoryPath(state.selectedFile, state.files, state.dirChildren, state.pinnedFolders)) {
    return state.selectedFile as string
  }

  if (state.selectedFile) {
    return getDirName(state.selectedFile)
  }

  if (state.currentPath && state.currentPath !== '/') {
    return state.currentPath
  }

  if (state.workspaceRoot) {
    return state.workspaceRoot
  }

  if (state.pinnedFolders.length > 0) {
    return state.pinnedFolders[0]
  }

  return state.currentPath || '/'
}

const SIDE_PANEL_WIDTHS_KEY = 'ready-side-panel-widths-v2'
const SKILLS_SPLIT_RATIO_KEY = 'ready-skills-split-ratio-v2'
const SIDE_PANEL_VARIANT_KEY = 'ready-side-panel-variant-v1'
const DEFAULT_SIDE_PANEL_WIDTH = 220
const MIN_SIDE_PANEL_WIDTH = 220
const MAX_SIDE_PANEL_WIDTH = 420
const DEFAULT_SKILLS_SPLIT_RATIO = 0.5
const MIN_SKILLS_SPLIT_RATIO = 0.25
const MAX_SKILLS_SPLIT_RATIO = 0.75

const clampSidePanelWidth = (width: number): number => {
  if (!Number.isFinite(width)) return DEFAULT_SIDE_PANEL_WIDTH
  return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(MAX_SIDE_PANEL_WIDTH, Math.round(width)))
}

const clampSkillsSplitRatio = (ratio: number): number => {
  if (!Number.isFinite(ratio)) return DEFAULT_SKILLS_SPLIT_RATIO
  return Math.max(MIN_SKILLS_SPLIT_RATIO, Math.min(MAX_SKILLS_SPLIT_RATIO, ratio))
}

const loadSidePanelWidthsFromStorage = (): SidePanelWidths => {
  const fallback: SidePanelWidths = {
    shared: DEFAULT_SIDE_PANEL_WIDTH,
  }
  try {
    const raw = readStorage(SIDE_PANEL_WIDTHS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<SidePanelWidths> | { files?: number; search?: number; skills?: number }

    // 向后兼容：如果是旧格式，取第一个有效值
    if ('files' in parsed || 'search' in parsed || 'skills' in parsed) {
      const oldParsed = parsed as { files?: number; search?: number; skills?: number }
      const width = oldParsed.files ?? oldParsed.search ?? oldParsed.skills ?? fallback.shared
      return { shared: clampSidePanelWidth(width) }
    }

    // 新格式
    const newParsed = parsed as Partial<SidePanelWidths>
    return {
      shared: clampSidePanelWidth(newParsed.shared ?? fallback.shared),
    }
  } catch {
    return fallback
  }
}

const loadSkillsSplitRatioFromStorage = (): number => {
  const raw = readStorage(SKILLS_SPLIT_RATIO_KEY)
  const parsed = raw ? Number(raw) : Number.NaN
  return clampSkillsSplitRatio(parsed)
}

const loadSidePanelVariantFromStorage = (): WorkspaceSidePanelVariant => {
  if (typeof localStorage === 'undefined') {
    console.log('[SidePanelVariant] localStorage undefined, returning default')
    return 'files'
  }
  try {
    const raw = readStorage(SIDE_PANEL_VARIANT_KEY)
    console.log('[SidePanelVariant] Loaded from storage:', raw)
    if (!raw) return 'files'
    const parsed = raw as WorkspaceSidePanelVariant
    // Validate the variant
    if (['files', 'search', 'skills', 'hidden'].includes(parsed)) {
      console.log('[SidePanelVariant] Valid variant loaded:', parsed)
      return parsed
    }
    console.log('[SidePanelVariant] Invalid variant, returning default')
    return 'files'
  } catch (err) {
    console.error('[SidePanelVariant] Error loading from storage:', err)
    return 'files'
  }
}

const remapPathAfterMove = (value: string | null, src: string, dest: string): string | null => {
  if (!value) return value
  if (value === src) return dest
  if (value.startsWith(`${src}/`)) return `${dest}${value.slice(src.length)}`
  if (value.startsWith(`${src}\\`)) return `${dest}${value.slice(src.length)}`
  return value
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const initialVariant = loadSidePanelVariantFromStorage()
  console.log('[SidePanelVariant] Store initialized with variant:', initialVariant)

  return {
  workspaceRoot: null,
  currentPath: '/',
  files: [],
  selectedFile: null,
  expandedDirs: new Set<string>(),
  dirChildren: new Map<string, FileItem[]>(),
  pinnedFolders: readJsonStorage('ready-pinned-folders', [] as string[]),
  sidebarVisible: true,
  sidePanelVariant: initialVariant,
  sidePanelWidths: loadSidePanelWidthsFromStorage(),
  skillsSplitRatio: loadSkillsSplitRatioFromStorage(),
  chatPanelVisible: true,
  chatPanelWidth: 380,
  renamingPath: null,
  creatingType: null,
  creatingPath: null,

  setCurrentPath: (path) => {
    set({ currentPath: path })
    get().refreshFiles()
  },

  setFiles: (files) => set({ files }),

  selectFile: (path) => set({ selectedFile: path }),

  toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

  setSidePanelVariant: (variant) => {
    console.log('[SidePanelVariant] Setting variant:', variant)

    // 先保存到 localStorage，确保持久化
    if (typeof localStorage !== 'undefined') {
      try {
        writeStorage(SIDE_PANEL_VARIANT_KEY, variant)
        console.log('[SidePanelVariant] Saved to storage:', variant)
        // 立即验证写入是否成功
        const saved = readStorage(SIDE_PANEL_VARIANT_KEY)
        console.log('[SidePanelVariant] Verification read:', saved)
        if (saved !== variant) {
          console.error('[SidePanelVariant] Verification failed! Expected:', variant, 'Got:', saved)
        }
      } catch (err) {
        console.error('[SidePanelVariant] Error saving to storage:', err)
      }
    }

    // 然后更新 store 状态
    set({ sidePanelVariant: variant })
  },

  setSidePanelWidth: (variant, width) => {
    const clamped = clampSidePanelWidth(width)
    set((state) => {
      const next: SidePanelWidths = {
        shared: clamped,
      }
      if (typeof localStorage !== 'undefined') {
        writeJsonStorage(SIDE_PANEL_WIDTHS_KEY, next)
      }
      return { sidePanelWidths: next }
    })
  },

  setSkillsSplitRatio: (ratio) => {
    const next = clampSkillsSplitRatio(ratio)
    if (get().skillsSplitRatio === next) return
    set({ skillsSplitRatio: next })
    if (typeof localStorage !== 'undefined') {
      writeStorage(SKILLS_SPLIT_RATIO_KEY, String(next))
    }
  },

  toggleChatPanel: () => set((state) => ({ chatPanelVisible: !state.chatPanelVisible })),

  loadDirChildren: async (dirPath) => {
    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.document.listFiles(dirPath)
        if (result.success && result.items) {
          const items: FileItem[] = result.items
            .map((item) => ({
              ...item,
              modified: new Date(item.modified)
            }) as FileItem)
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
              return a.name.localeCompare(b.name)
            })
          set((state) => {
            const next = new Map(state.dirChildren)
            next.set(dirPath, items)
            return { dirChildren: next }
          })
          return items
        }
      }
    } catch (error) {
      console.warn('Failed to load dir children:', dirPath, error)
    }
    return []
  },

  toggleDir: async (path) => {
    const { expandedDirs, dirChildren, loadDirChildren } = get()
    const next = new Set(expandedDirs)
    if (next.has(path)) {
      next.delete(path)
      set({ expandedDirs: next })
    } else {
      next.add(path)
      set({ expandedDirs: next })
      // Lazy load children if not cached
      if (!dirChildren.has(path)) {
        await loadDirChildren(path)
      }
    }
  },

  setWorkspaceRoot: (path) => {
    set({ workspaceRoot: path, currentPath: path, expandedDirs: new Set(), dirChildren: new Map(), selectedFile: null })
    writeStorage('ready-workspace-root', path)
    get().refreshFiles()
  },

  clearWorkspace: () => {
    set({
      workspaceRoot: null,
      currentPath: '/',
      files: [],
      selectedFile: null,
      expandedDirs: new Set(),
      dirChildren: new Map(),
      pinnedFolders: [],
      renamingPath: null,
      creatingType: null,
      creatingPath: null,
    })
    removeStorage('ready-workspace-root')
    removeStorage('ready-pinned-folders')
  },

  addPinnedFolder: (path) => {
    const { pinnedFolders } = get()
    if (pinnedFolders.includes(path)) return
    const next = [...pinnedFolders, path]
    set({ pinnedFolders: next })
    writeJsonStorage('ready-pinned-folders', next)
  },

  removePinnedFolder: (path) => {
    const { pinnedFolders } = get()
    const next = pinnedFolders.filter(p => p !== path)
    set({ pinnedFolders: next })
    writeJsonStorage('ready-pinned-folders', next)
  },

  saveWorkspace: (name) => {
    const { pinnedFolders } = get()
    if (pinnedFolders.length === 0) return
    const saved = readJsonStorage('ready-saved-workspaces', [] as { name: string; folders: string[] }[])
    const filtered = saved.filter(w => w.name !== name)
    filtered.push({ name, folders: [...pinnedFolders] })
    writeJsonStorage('ready-saved-workspaces', filtered)
  },

  getSavedWorkspaces: () => {
    return readJsonStorage('ready-saved-workspaces', [] as { name: string; folders: string[] }[])
  },

  loadSavedWorkspace: (folders) => {
    set({
      pinnedFolders: folders,
      expandedDirs: new Set(),
      dirChildren: new Map(),
      selectedFile: null,
      workspaceRoot: folders[0] || null,
      currentPath: folders[0] || '/',
    })
    writeJsonStorage('ready-pinned-folders', folders)
    if (folders[0]) {
      writeStorage('ready-workspace-root', folders[0])
    }
    get().refreshFiles()
  },

  deleteSavedWorkspace: (name) => {
    const saved = readJsonStorage('ready-saved-workspaces', [] as { name: string; folders: string[] }[])
    const filtered = saved.filter(w => w.name !== name)
    writeJsonStorage('ready-saved-workspaces', filtered)
  },

  openFolderDialog: async () => {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.openFolder()
        if (result.success && result.path) {
          get().addPinnedFolder(result.path)
        }
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error)
    }
  },

  refreshFiles: async () => {
    try {
      const { currentPath } = get()

      if (typeof window !== 'undefined' && window.electronAPI) {
        const result = await window.electronAPI.document.listFiles(currentPath)

        if (result.success && result.items) {
          const items: FileItem[] = result.items
            .map((item) => ({
              ...item,
              modified: new Date(item.modified)
            }) as FileItem)
            // Sort: directories first, then by name
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            // Hide dotfiles
            .filter((item) => !item.name.startsWith('.'))

          set({ files: items })
        }
      } else {
        // Mock files for development
        set({
          files: [
            { name: 'documents', path: `${currentPath === '/' ? '' : currentPath}/documents`, isDirectory: true, size: 0, modified: new Date() },
            { name: 'images', path: `${currentPath === '/' ? '' : currentPath}/images`, isDirectory: true, size: 0, modified: new Date() },
            { name: '项目说明.md', path: `${currentPath === '/' ? '' : currentPath}/项目说明.md`, isDirectory: false, size: 2048, modified: new Date() },
            { name: '需求文档.md', path: `${currentPath === '/' ? '' : currentPath}/需求文档.md`, isDirectory: false, size: 4096, modified: new Date() },
            { name: '设计稿.png', path: `${currentPath === '/' ? '' : currentPath}/设计稿.png`, isDirectory: false, size: 102400, modified: new Date() },
            { name: '演示视频.mp4', path: `${currentPath === '/' ? '' : currentPath}/演示视频.mp4`, isDirectory: false, size: 5242880, modified: new Date() },
            { name: '数据表.xlsx', path: `${currentPath === '/' ? '' : currentPath}/数据表.xlsx`, isDirectory: false, size: 8192, modified: new Date() }
          ]
        })
      }
    } catch (error) {
      console.error('Failed to refresh files:', error)
    }
  },

  createFile: async (name) => {
    const state = get()
    const targetDir = resolveCreationBaseDir(state)
    const filePath = joinChildPath(targetDir, name)
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.createFile(filePath)
        if (result.success) {
          if (state.currentPath !== targetDir) {
            set({ currentPath: targetDir })
          }
          await get().refreshFiles()
          await get().loadDirChildren(targetDir)
          set({ creatingType: null, creatingPath: null, selectedFile: filePath })
          return true
        }
      } else {
        // Mock: just add to files list
        set((state) => ({
          files: [...state.files, { name, path: filePath, isDirectory: false, size: 0, modified: new Date() }],
          creatingType: null,
          creatingPath: null,
          selectedFile: filePath,
          currentPath: targetDir,
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to create file:', error)
    }
    return false
  },

  createFolder: async (name) => {
    const state = get()
    const targetDir = resolveCreationBaseDir(state)
    const folderPath = joinChildPath(targetDir, name)
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.mkdir(folderPath)
        if (result.success) {
          if (state.currentPath !== targetDir) {
            set({ currentPath: targetDir })
          }
          await get().refreshFiles()
          await get().loadDirChildren(targetDir)
          set({ creatingType: null, creatingPath: null, selectedFile: folderPath })
          return true
        }
      } else {
        set((state) => ({
          files: [...state.files, { name, path: folderPath, isDirectory: true, size: 0, modified: new Date() }],
          creatingType: null,
          creatingPath: null,
          selectedFile: folderPath,
          currentPath: targetDir,
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to create folder:', error)
    }
    return false
  },

  renameItem: async (oldPath, newName) => {
    const dir = getDirName(oldPath)
    const newPath = `${dir}/${newName}`
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.document.rename(oldPath, newPath)
        if (result.success) {
          await get().refreshFiles()
          set({ renamingPath: null })
          return true
        }
      } else {
        set((state) => ({
          files: state.files.map(f =>
            f.path === oldPath ? { ...f, name: newName, path: newPath } : f
          ),
          renamingPath: null
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to rename:', error)
    }
    return false
  },

  deleteItem: async (path) => {
    try {
      if (window.electronAPI) {
        const state = get()
        const parentPath = getDirName(path)
        const result = await window.electronAPI.document.deleteItem(path)
        if (result.success) {
          if (state.currentPath === path) {
            set({ currentPath: parentPath })
          }
          await get().refreshFiles()
          const currentState = get()
          const cleanedExpanded = new Set<string>()
          currentState.expandedDirs.forEach((dir) => {
            if (dir !== path && !dir.startsWith(`${path}/`) && !dir.startsWith(`${path}\\`)) {
              cleanedExpanded.add(dir)
            }
          })
          set({
            selectedFile: currentState.selectedFile === path ? null : currentState.selectedFile,
            expandedDirs: cleanedExpanded,
          })
          await get().loadDirChildren(parentPath)
          return true
        }
      } else {
        set((state) => ({
          files: state.files.filter(f => f.path !== path),
          selectedFile: state.selectedFile === path ? null : state.selectedFile
        }))
        return true
      }
    } catch (error) {
      console.error('Failed to delete:', error)
    }
    return false
  },

  moveItem: async (src, dest) => {
    try {
      if (src === dest) return true

      if (window.electronAPI) {
        const result = await window.electronAPI.document.moveItem(src, dest)
        if (!result.success) return false

        set((state) => {
          const remappedExpanded = new Set<string>()
          state.expandedDirs.forEach((dir) => {
            remappedExpanded.add(remapPathAfterMove(dir, src, dest) || dir)
          })
          return {
            selectedFile: remapPathAfterMove(state.selectedFile, src, dest),
            currentPath: remapPathAfterMove(state.currentPath, src, dest) || state.currentPath,
            expandedDirs: remappedExpanded,
            dirChildren: new Map(),
          }
        })

        await get().refreshFiles()
        const expanded = Array.from(get().expandedDirs)
        for (const dir of expanded) {
          await get().loadDirChildren(dir)
        }
        return true
      }

      // Mock fallback
      set((state) => ({
        files: state.files.map((f) => {
          if (f.path === src) {
            return {
              ...f,
              path: dest,
              name: dest.split('/').pop() || f.name,
            }
          }
          return f
        }),
        selectedFile: remapPathAfterMove(state.selectedFile, src, dest),
        currentPath: remapPathAfterMove(state.currentPath, src, dest) || state.currentPath,
      }))
      return true
    } catch (error) {
      console.error('Failed to move item:', error)
    }
    return false
  },

  showInFolder: async (path) => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.document.showInFolder(path)
      }
    } catch (error) {
      console.error('showInFolder failed:', error)
    }
  },

  copyPathToClipboard: (path) => {
    navigator.clipboard.writeText(path).catch(console.error)
  },

  startRenaming: (path) => set({ renamingPath: path }),
  cancelRenaming: () => set({ renamingPath: null }),
  startCreating: (type) => {
    const state = get()
    const targetDir = resolveCreationBaseDir(state)
    const expandedDirs = expandDirsForTarget(targetDir, state.expandedDirs, state.pinnedFolders)
    if (targetDir !== state.currentPath) {
      set({
        creatingType: type,
        creatingPath: targetDir,
        currentPath: targetDir,
        selectedFile: targetDir,
        expandedDirs,
      })
      void get().refreshFiles()
      void get().loadDirChildren(targetDir)
      return
    }
    set({ creatingType: type, creatingPath: targetDir, expandedDirs })
    if (!state.dirChildren.has(targetDir)) {
      void get().loadDirChildren(targetDir)
    }
  },
  cancelCreating: () => set({ creatingType: null, creatingPath: null })
}})

// 订阅 sidePanelVariant 变化，自动保存到 localStorage
// 这样即使有其他地方直接修改了状态，也能被捕获
if (typeof window !== 'undefined') {
  let previousVariant = useWorkspace.getState().sidePanelVariant
  useWorkspace.subscribe((state) => {
    if (state.sidePanelVariant !== previousVariant) {
      console.log('[SidePanelVariant] Detected variant change via subscription:', previousVariant, '->', state.sidePanelVariant)
      if (typeof localStorage !== 'undefined') {
        try {
          writeStorage(SIDE_PANEL_VARIANT_KEY, state.sidePanelVariant)
          console.log('[SidePanelVariant] Auto-saved to storage via subscription:', state.sidePanelVariant)
        } catch (err) {
          console.error('[SidePanelVariant] Auto-save via subscription failed:', err)
        }
      }
      previousVariant = state.sidePanelVariant
    }
  })
}
