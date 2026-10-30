import { initializeObjectPresentation, objectLocationForPath, objectPresentationAPI, onObjectMoved, rememberObjectLocation, resolvePresentationObject } from './objectPresentationState'
import { registerDocumentSaveHandler } from '../modules/document/documentSaveRegistry'
import { createDocumentOperationSync } from '../modules/document/documentOperationSync'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getFilename } from '../utils/path'
import { isTabGroupColor, pickNextGroupColor, type TabGroup, type TabGroupColor } from '../../shared/tab-groups'
import { recordDocumentPerformanceCounter } from '../../shared/document-performance-diagnostics'
import {
    addToGroup,
    createGroupFromDrop,
    disbandGroup,
    type GroupModelState,
    normalizeGroupState,
    recolorGroup,
    removeFromGroup,
    renameGroup,
    reorderTab,
    setGroupCollapsed,
} from '../../shared/tab-group-model'

interface DocTabBase {
    id: string
    title: string
    objectId?: string
    objectRevision?: number
    objectBinding?: { status: 'resolving' } | { status: 'resolved' } | { status: 'failed'; message: string }
    lastActivatedAt?: number | null
    tagForgeCreationPending?: boolean
    // Renderer-only grouping (mirrors the browser rail). null/absent = ungrouped.
    groupId?: string | null
}

export type DocTab = DocTabBase & (
    | { kind?: 'document'; path: string | null; content: string; isDirty: boolean }
    | { kind: 'library'; path: null; content: ''; isDirty: false }
)

export interface PendingDocReveal {
    path: string
    selection?: string
    lineStart?: number
    lineEnd?: number
    sectionTitle?: string
    requestedAt: number
}

export type DocumentPaneTarget = 'primary' | 'split'

interface DocTabsState {
    tabs: DocTab[]
    tabGroups: TabGroup[]
    activeTabId: string
    splitTabId: string | null
    focusedPaneTabId: string | null
    documentSplitRatio: number
    pendingReveal: PendingDocReveal | null

    openLibraryTab: () => string
    openTab: (path: string) => void
    openImageTab: (path: string, options?: { activate?: boolean }) => string | null
    openTabInPane: (path: string, pane: DocumentPaneTarget) => string | null
    createBackgroundTab: (options?: { title?: string; path?: string | null; content?: string }) => string
    ensureTabForPath: (path: string) => string | null
    closeTab: (id: string) => void
    setActiveTab: (id: string) => void
    setFocusedPaneTab: (id: string) => void
    renameTab: (id: string, title: string) => void
    setTabPath: (id: string, path: string | null) => void
    setTabContent: (id: string, content: string) => void
    appendTabContent: (id: string, content: string) => void
    updateTabContent: (id: string, content: string) => void
    hydrateTabContentFromDisk: (id: string, content: string) => void
    commitTabSaveSnapshot: (id: string, expectedContent: string, writtenContent: string) => boolean
    markTabSaved: (id: string) => void
    reorderTabs: (fromIndex: number, toIndex: number) => void
    setSplitTab: (id: string | null) => void
    setDocumentSplitRatio: (ratio: number) => void
    setPendingReveal: (reveal: PendingDocReveal | null) => void

    // Group ops — delegate to the pure tab-group-model (single source) and land
    // through the normalize choke. delete-group / new-tab-in-group are orchestrated
    // at the UI layer (they close/create tabs).
    createTabGroupFromDrop: (draggedId: string, targetId: string) => void
    addTabToGroup: (tabId: string, groupId: string) => void
    removeTabFromGroup: (tabId: string) => void
    reorderTabToRank: (movedId: string, toRank: number, intoGroupId: string | null) => void
    renameTabGroup: (groupId: string, name: string) => void
    recolorTabGroup: (groupId: string, color: TabGroupColor) => void
    setTabGroupCollapsed: (groupId: string, collapsed: boolean) => void
    disbandTabGroup: (groupId: string) => void
}

let tabCounter = 0
const makeId = () => `doc-${++tabCounter}`

const STORAGE_KEY = 'ready-doc-tabs-v2'
const DRAFT_STORAGE_PREFIX = 'ready-doc-tab-draft-v1:'
const DRAFT_WRITE_DELAY_MS = 300
const METADATA_WRITE_MAX_DELAY_MS = 500
const METADATA_IDLE_QUIET_MS = 120
const IMAGE_PREVIEW_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'])

interface DocTabStorage {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem: (key: string) => void
}

interface PendingDraftWrite {
    content: string
    timer: ReturnType<typeof setTimeout> | null
}

const pendingDraftWrites = new Map<string, PendingDraftWrite>()
let pendingMetadataWrite: { key: string; value: string } | null = null
let pendingMetadataTimer: ReturnType<typeof setTimeout> | null = null
let pendingMetadataQuietTimer: ReturnType<typeof setTimeout> | null = null
let pendingMetadataIdleId: number | null = null

function getDocTabStorage(): DocTabStorage | null {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null
    } catch {
        // silent-catch: unavailable renderer storage is represented by null.
        return null
    }
}

export function getDocTabDraftStorageKey(id: string): string {
    return `${DRAFT_STORAGE_PREFIX}${encodeURIComponent(id)}`
}

function writePendingDraft(id: string): boolean {
    const pending = pendingDraftWrites.get(id)
    if (!pending) return true
    const storage = getDocTabStorage()
    if (!storage) {
        pending.timer = null
        return false
    }
    try {
        storage.setItem(getDocTabDraftStorageKey(id), pending.content)
        pendingDraftWrites.delete(id)
        return true
    } catch {
        // silent-catch: keep the draft queued so a later flush can retry it.
        pending.timer = null
        return false
    }
}

function queueDraftWrite(id: string, content: string): void {
    const previous = pendingDraftWrites.get(id)
    if (previous?.timer) clearTimeout(previous.timer)
    const pending: PendingDraftWrite = { content, timer: null }
    const timer = setTimeout(() => writePendingDraft(id), DRAFT_WRITE_DELAY_MS)
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
    pending.timer = timer
    pendingDraftWrites.set(id, pending)
}

export function flushPendingDocTabDrafts(): void {
    for (const [id, pending] of pendingDraftWrites) {
        if (pending.timer) clearTimeout(pending.timer)
        pending.timer = null
        writePendingDraft(id)
    }
}

function cancelPendingMetadataSchedules(): void {
    if (pendingMetadataTimer) clearTimeout(pendingMetadataTimer)
    pendingMetadataTimer = null
    if (pendingMetadataQuietTimer) clearTimeout(pendingMetadataQuietTimer)
    pendingMetadataQuietTimer = null
    if (pendingMetadataIdleId !== null && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(pendingMetadataIdleId)
    }
    pendingMetadataIdleId = null
}

export function flushPendingDocTabMetadata(): void {
    const pending = pendingMetadataWrite
    if (!pending) return
    cancelPendingMetadataSchedules()
    const storage = getDocTabStorage()
    if (!storage) {
        return
    }
    try {
        storage.setItem(pending.key, pending.value)
        pendingMetadataWrite = null
        recordDocumentPerformanceCounter('metadataWrites')
    } catch {
        // silent-catch: retain the latest snapshot so the next lifecycle flush can retry it.
        pendingMetadataWrite = pending
    }
}

export function flushPendingDocTabPersistenceForExit(): void {
    flushPendingDocTabDrafts()
    flushPendingDocTabMetadata()
    const failures: string[] = []
    if (pendingDraftWrites.size > 0) failures.push(`${pendingDraftWrites.size} 份文档草稿`)
    if (pendingMetadataWrite) failures.push('文档标签恢复信息')
    if (failures.length > 0) {
        throw new Error(`${failures.join('、')}未能写入本地恢复存储`)
    }
}

function queueMetadataWrite(key: string, value: string): void {
    pendingMetadataWrite = { key, value }
    if (!pendingMetadataTimer) {
        pendingMetadataTimer = setTimeout(flushPendingDocTabMetadata, METADATA_WRITE_MAX_DELAY_MS)
        if (typeof pendingMetadataTimer === 'object' && 'unref' in pendingMetadataTimer && typeof pendingMetadataTimer.unref === 'function') {
            pendingMetadataTimer.unref()
        }
    }
    if (pendingMetadataQuietTimer) clearTimeout(pendingMetadataQuietTimer)
    if (pendingMetadataIdleId !== null) {
        if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(pendingMetadataIdleId)
        }
        pendingMetadataIdleId = null
    }
    pendingMetadataQuietTimer = setTimeout(() => {
        pendingMetadataQuietTimer = null
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            pendingMetadataIdleId = window.requestIdleCallback(flushPendingDocTabMetadata, { timeout: METADATA_WRITE_MAX_DELAY_MS })
        } else {
            flushPendingDocTabMetadata()
        }
    }, METADATA_IDLE_QUIET_MS)
    if (typeof pendingMetadataQuietTimer === 'object' && 'unref' in pendingMetadataQuietTimer && typeof pendingMetadataQuietTimer.unref === 'function') {
        pendingMetadataQuietTimer.unref()
    }
}

const coalescedMetadataStorage: DocTabStorage = {
    getItem: (key) => getDocTabStorage()?.getItem(key) ?? null,
    setItem: queueMetadataWrite,
    removeItem: (key) => {
        if (pendingMetadataWrite?.key === key) {
            pendingMetadataWrite = null
            cancelPendingMetadataSchedules()
        }
        getDocTabStorage()?.removeItem(key)
    },
}

function discardDraft(id: string): void {
    const pending = pendingDraftWrites.get(id)
    if (pending?.timer) clearTimeout(pending.timer)
    pendingDraftWrites.delete(id)
    try {
        getDocTabStorage()?.removeItem(getDocTabDraftStorageKey(id))
    } catch {
        // silent-catch: a clean/saved tab never needs a renderer draft to be authoritative.
    }
}

function readDraft(id: string): string | null {
    const pending = pendingDraftWrites.get(id)
    if (pending) return pending.content
    try {
        return getDocTabStorage()?.getItem(getDocTabDraftStorageKey(id)) ?? null
    } catch {
        // silent-catch: an unreadable draft is treated as absent.
        return null
    }
}

function needsPersistedDraft(tab: DocTab): boolean {
    return tab.kind !== 'library' && (tab.isDirty || tab.path === null)
}

function persistLegacyDrafts(tabs: DocTab[]): void {
    const storage = getDocTabStorage()
    if (!storage) return
    for (const tab of tabs) {
        if (!needsPersistedDraft(tab)) continue
        try {
            storage.setItem(getDocTabDraftStorageKey(tab.id), tab.content)
        } catch {
            // silent-catch: re-attempt after the middleware replaces the larger legacy metadata record.
            queueDraftWrite(tab.id, tab.content)
        }
    }
}

function restorePersistedDrafts(tabs: DocTab[]): DocTab[] {
    return tabs.map((tab): DocTab => {
        if (tab.kind === 'library') return { ...tab, path: null, content: '' as const, isDirty: false }
        if (!needsPersistedDraft(tab)) return { ...tab, content: '' }
        const draft = readDraft(tab.id)
        return draft === null ? tab : { ...tab, content: draft }
    })
}

function installDraftFlushListeners(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const flushAll = () => {
        flushPendingDocTabDrafts()
        flushPendingDocTabMetadata()
    }
    window.addEventListener('pagehide', flushAll)
    window.addEventListener('beforeunload', flushAll)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushAll()
        })
    }
}

installDraftFlushListeners()

let docGroupCounter = 0
function syncDocGroupCounter(groups: TabGroup[]): void {
    for (const group of groups) {
        const match = /^grp-(\d+)$/.exec(group.id)
        if (match) docGroupCounter = Math.max(docGroupCounter, Number(match[1]))
    }
}
function nextDocGroupId(): string {
    return `grp-${++docGroupCounter}`
}

function sanitizeDocTabGroup(group: TabGroup): TabGroup | null {
    const id = String(group?.id || '')
    if (!id) return null
    return {
        id,
        name: typeof group.name === 'string' ? group.name : '',
        color: isTabGroupColor(group.color) ? group.color : 'blue',
        collapsed: Boolean(group.collapsed),
    }
}

function toDocGroupModel(tabs: DocTab[], tabGroups: TabGroup[]): GroupModelState {
    const groupOf: Record<string, string | null> = {}
    for (const tab of tabs) groupOf[tab.id] = tab.groupId ?? null
    return { order: tabs.map((tab) => tab.id), groupOf, groups: tabGroups }
}

function applyDocGroupModel(tabs: DocTab[], model: GroupModelState): { tabs: DocTab[]; tabGroups: TabGroup[] } {
    const byId = new Map(tabs.map((tab) => [tab.id, tab]))
    const nextTabs: DocTab[] = []
    for (const id of model.order) {
        const tab = byId.get(id)
        if (tab) nextTabs.push({ ...tab, groupId: model.groupOf[id] ?? null })
    }
    return { tabs: nextTabs, tabGroups: model.groups }
}

// Normalize {tabs, tabGroups} against the group invariants (I1–I3). The doc store's
// mutators use raw set(), so any mutator that changes membership / order / groupId
// must route its result through this choke — otherwise e.g. closing a group's last
// member leaves an orphan group until reload. Idempotent.
function normalizeDocGroups(tabs: DocTab[], tabGroups: TabGroup[]): { tabs: DocTab[]; tabGroups: TabGroup[] } {
    const groups = tabGroups.map(sanitizeDocTabGroup).filter((group): group is TabGroup => group !== null)
    const applied = applyDocGroupModel(tabs, normalizeGroupState(toDocGroupModel(tabs, groups)))
    syncDocGroupCounter(applied.tabGroups)
    return applied
}

function applyDocGroupOp(state: DocTabsState, model: GroupModelState): Pick<DocTabsState, 'tabs' | 'tabGroups'> {
    return applyDocGroupModel(state.tabs, model)
}

export function normalizeDocTabPathKey(path: string | null | undefined): string | null {
    if (!path) return null
    const normalized = path.normalize('NFC').replace(/\\/g, '/')
    if (!normalized) return null
    const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    const driveMatch = withoutTrailingSlash.match(/^([A-Za-z]):(\/.*)?$/)
    if (driveMatch) {
        return `${driveMatch[1].toLowerCase()}:${driveMatch[2] || ''}`
    }
    return withoutTrailingSlash
}

function getPathExtension(path: string | null | undefined): string {
    if (!path) return ''
    const name = path.replace(/\\/g, '/').split('/').pop() || path
    const index = name.lastIndexOf('.')
    return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

export function isImagePreviewPath(path: string | null | undefined): boolean {
    return IMAGE_PREVIEW_EXTENSIONS.has(getPathExtension(path))
}

function getParentPathKey(path: string | null | undefined): string | null {
    const pathKey = normalizeDocTabPathKey(path)
    if (!pathKey) return null
    const index = pathKey.lastIndexOf('/')
    if (index <= 0) return '/'
    return pathKey.slice(0, index)
}

function syncTabCounterFromTabs(tabs: DocTab[]) {
    const maxId = tabs.reduce((max, tab) => {
        const match = tab.id.match(/^doc-(\d+)$/)
        const numeric = match ? Number(match[1]) : 0
        return Number.isFinite(numeric) ? Math.max(max, numeric) : max
    }, 0)
    tabCounter = Math.max(tabCounter, maxId)
}

function ensureDocumentTabForPath(tabs: DocTab[], path: string): { tabs: DocTab[]; id: string } {
    const pathKey = normalizeDocTabPathKey(path)
    const location = objectLocationForPath(path)
    const existing = location ? tabs.find(tab => tab.objectId === location.objectId)
        : pathKey ? tabs.find(t => !t.objectId && t.objectBinding?.status !== 'failed' && normalizeDocTabPathKey(t.path) === pathKey) : undefined
    if (existing) {
        return { tabs, id: existing.id }
    }

    const id = makeId()
    const title = getFilename(path)
    return {
        tabs: [
            ...tabs,
            {
                id,
                path,
                title,
                content: '',
                isDirty: false,
                lastActivatedAt: null,
            },
        ],
        id,
    }
}

function ensureImagePreviewTabForPath(tabs: DocTab[], path: string): { tabs: DocTab[]; id: string } {
    const dirKey = getParentPathKey(path)
    if (!dirKey) return ensureDocumentTabForPath(tabs, path)
    const pathKey = normalizeDocTabPathKey(path)
    const existing = tabs.find(t => isImagePreviewPath(t.path) && getParentPathKey(t.path) === dirKey)
    if (existing) {
        if (normalizeDocTabPathKey(existing.path) === pathKey) {
            return { tabs, id: existing.id }
        }
        return {
            tabs: tabs.map(t =>
                t.id === existing.id && t.kind !== 'library'
                    ? { ...t, path, objectId: undefined, objectRevision: undefined, objectBinding: undefined, title: getFilename(path), content: '', isDirty: false }
                    : t
            ),
            id: existing.id,
        }
    }
    return ensureDocumentTabForPath(tabs, path)
}

function markTabActivated(tabs: DocTab[], id: string, now = Date.now()): DocTab[] {
    return tabs.map((tab) => tab.id === id ? { ...tab, lastActivatedAt: now } : tab)
}

function replaceDirtyTabContent(tabs: DocTab[], id: string, content: string): DocTab[] {
    const current = tabs.find((tab) => tab.id === id)
    if (!current || current.kind === 'library') return tabs
    if (current.content === content && current.isDirty) return tabs
    if (current.content !== content || !current.isDirty) queueDraftWrite(id, content)
    return tabs.map((tab) => tab.id === id && tab.kind !== 'library' ? { ...tab, content, isDirty: true } : tab)
}

function ensureTabsState(
    state: Pick<DocTabsState, 'tabs' | 'activeTabId' | 'splitTabId' | 'documentSplitRatio'> & { tabGroups?: TabGroup[] },
) {
    const rawTabs: DocTab[] = state.tabs.length > 0
        ? state.tabs.filter((tab, index, tabs) => tab.kind !== 'library' || tabs.findIndex(t => t.kind === 'library') === index)
        : [{ id: 'doc-1', path: null, title: '新文档', content: '', isDirty: false }]
    syncTabCounterFromTabs(rawTabs)
    const { tabs, tabGroups } = normalizeDocGroups(rawTabs, Array.isArray(state.tabGroups) ? state.tabGroups : [])
    const activeTabId = tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : tabs[0].id
    const splitTabId = state.splitTabId
        && state.splitTabId !== activeTabId
        && tabs.some((tab) => tab.id === state.splitTabId)
        ? state.splitTabId
        : null
    return {
        tabs,
        tabGroups,
        activeTabId,
        splitTabId,
        documentSplitRatio: Math.max(20, Math.min(80, state.documentSplitRatio || 50)),
    }
}

const fallbackStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
}

export const useDocTabs = create<DocTabsState>()(persist((set, get) => ({
    tabs: [
        {
            id: makeId(),
            path: null,
            title: '新文档',
            content: '',
            isDirty: false,
            lastActivatedAt: null,
        }
    ],
    tabGroups: [],
    activeTabId: 'doc-1',
    splitTabId: null,
    focusedPaneTabId: 'doc-1',
    documentSplitRatio: 50,
    pendingReveal: null,

    openLibraryTab: () => {
        const state = get()
        const existing = state.tabs.find(tab => tab.kind === 'library')
        const id = existing?.id ?? makeId()
        const tabs: DocTab[] = existing ? state.tabs : [...state.tabs, {
            id, kind: 'library', path: null, title: '书房', content: '', isDirty: false,
        }]
        set({ tabs: markTabActivated(tabs, id), activeTabId: id,
            splitTabId: state.splitTabId === id ? state.activeTabId : state.splitTabId,
            focusedPaneTabId: id })
        return id
    },

    openTab: (path: string) => {
        const { tabs, activeTabId, splitTabId } = get()

        // Empty path = create new blank tab
        if (!path) {
            const id = makeId()
            set({
                tabs: [...tabs, { id, path: null, title: '新文档', content: '', isDirty: false }],
                activeTabId: id,
                focusedPaneTabId: id,
            })
            return
        }

        const next = ensureDocumentTabForPath(tabs, path)
        const nextSplitTabId = next.id === splitTabId ? activeTabId : splitTabId
        set({
            tabs: markTabActivated(next.tabs, next.id),
            activeTabId: next.id,
            splitTabId: nextSplitTabId,
            focusedPaneTabId: next.id,
        })
    },

    openImageTab: (path: string, options) => {
        if (!path || !isImagePreviewPath(path)) return null
        const { tabs, activeTabId, splitTabId } = get()
        const next = ensureImagePreviewTabForPath(tabs, path)
        const updates: Partial<DocTabsState> = { tabs: next.tabs }
        if (options?.activate !== false) {
            updates.tabs = markTabActivated(next.tabs, next.id)
            updates.activeTabId = next.id
            updates.splitTabId = next.id === splitTabId ? activeTabId : splitTabId
            updates.focusedPaneTabId = next.id
        }
        set(updates)
        return next.id
    },

    openTabInPane: (path: string, pane: DocumentPaneTarget) => {
        if (!path) return null

        const { tabs, activeTabId, splitTabId } = get()
        const next = ensureDocumentTabForPath(tabs, path)

        if (pane === 'primary') {
            if (next.id === splitTabId) {
                set({
                    tabs: markTabActivated(next.tabs, next.id),
                    activeTabId: next.id,
                    splitTabId: activeTabId,
                    focusedPaneTabId: next.id,
                })
                return next.id
            }

            set({
                tabs: markTabActivated(next.tabs, next.id),
                activeTabId: next.id,
                focusedPaneTabId: next.id,
            })
            return next.id
        }

        if (next.id === activeTabId) {
            if (splitTabId) {
                set({
                    tabs: markTabActivated(next.tabs, next.id),
                    activeTabId: splitTabId,
                    splitTabId: next.id,
                    focusedPaneTabId: next.id,
                })
            } else {
                set({
                    tabs: markTabActivated(next.tabs, next.id),
                    activeTabId: next.id,
                    focusedPaneTabId: next.id,
                })
            }
            return next.id
        }

        set({
            tabs: markTabActivated(next.tabs, next.id),
            splitTabId: next.id,
            focusedPaneTabId: next.id,
        })
        return next.id
    },

    createBackgroundTab: (options) => {
        const path = options?.path || null
        const title = path ? getFilename(path) : (options?.title?.trim() || '新文档')
        const id = makeId()
        set({
            tabs: [
                ...get().tabs,
                {
                    id,
                    path,
                    title,
                    content: options?.content || '',
                    isDirty: Boolean(options?.content),
                    lastActivatedAt: null,
                },
            ],
        })
        if (options?.content) queueDraftWrite(id, options.content)
        return id
    },

    ensureTabForPath: (path: string) => {
        if (!path) return null
        const { tabs } = get()
        const next = ensureDocumentTabForPath(tabs, path)
        if (next.tabs !== tabs) set({ tabs: next.tabs })
        return next.id
    },

    closeTab: (id: string) => {
        const { tabs, tabGroups, activeTabId, splitTabId } = get()
        const remaining = tabs.filter(t => t.id !== id)

        // If no tabs left, create a new blank one (and clear groups).
        if (remaining.length === 0) {
            const newId = makeId()
            set({
                tabs: [{ id: newId, path: null, title: '新文档', content: '', isDirty: false }],
                tabGroups: [],
                activeTabId: newId,
                splitTabId: null,
                focusedPaneTabId: newId,
            })
            discardDraft(id)
            return
        }

        // Normalize so closing a group's last member drops the now-orphaned group
        // immediately (no reload needed) and any group stays contiguous.
        const normalized = normalizeDocGroups(remaining, tabGroups)
        const updates: Partial<DocTabsState> = { tabs: normalized.tabs, tabGroups: normalized.tabGroups }

        // If closed tab was the split tab, clear split
        if (splitTabId === id) {
            updates.splitTabId = null
            if (get().focusedPaneTabId === id) updates.focusedPaneTabId = activeTabId
        }

        // If the primary pane closes while split is visible, promote that exact
        // visible document instead of leaving the same id in both panes.
        if (activeTabId === id) {
            const promotedSplit = splitTabId ? remaining.find((tab) => tab.id === splitTabId) : null
            const oldIndex = tabs.findIndex(t => t.id === id)
            const newActive = promotedSplit || remaining[Math.min(oldIndex, remaining.length - 1)]
            updates.activeTabId = newActive.id
            if (promotedSplit) updates.splitTabId = null
            updates.focusedPaneTabId = newActive.id
            updates.tabs = markTabActivated(normalized.tabs, newActive.id)
        }

        set(updates)
        discardDraft(id)
    },

    setActiveTab: (id: string) => {
        set({ tabs: markTabActivated(get().tabs, id), activeTabId: id, splitTabId: null, focusedPaneTabId: id })
    },

    setFocusedPaneTab: (id: string) => {
        const { activeTabId, splitTabId, focusedPaneTabId } = get()
        if (id === focusedPaneTabId) return
        if (id !== activeTabId && id !== splitTabId) return
        set({ focusedPaneTabId: id })
    },

    renameTab: (id: string, title: string) => {
        const nextTitle = title.trim() || '新文档'
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, title: nextTitle } : t
            )
        })
    },

    setTabPath: (id: string, path: string | null) => {
        if (get().tabs.find(tab => tab.id === id)?.path === path) return
        set({
            tabs: get().tabs.map(t =>
                t.id === id && t.kind !== 'library' ? { ...t, path, objectId: undefined, objectRevision: undefined, objectBinding: undefined, title: path ? getFilename(path) : t.title } : t
            )
        })
    },

    setTabContent: (id: string, content: string) => {
        set({
            tabs: replaceDirtyTabContent(get().tabs, id, content),
        })
    },

    appendTabContent: (id: string, content: string) => {
        const tabs = get().tabs
        const current = tabs.find((tab) => tab.id === id)
        if (!current) return
        set({
            tabs: replaceDirtyTabContent(tabs, id, `${current.content}${content}`),
        })
    },

    updateTabContent: (id: string, content: string) => {
        set({
            tabs: replaceDirtyTabContent(get().tabs, id, content),
        })
    },

    hydrateTabContentFromDisk: (id: string, content: string) => {
        set({
            tabs: get().tabs.map((tab) =>
                tab.id === id && tab.kind !== 'library' ? { ...tab, content, isDirty: false } : tab
            ),
        })
        discardDraft(id)
    },

    commitTabSaveSnapshot: (id: string, expectedContent: string, writtenContent: string) => {
        let committed = false
        set({
            tabs: get().tabs.map((tab) => {
                if (tab.kind === 'library' || tab.id !== id || tab.content !== expectedContent) return tab
                committed = true
                return { ...tab, content: writtenContent, isDirty: false }
            }),
        })
        if (committed) discardDraft(id)
        return committed
    },

    markTabSaved: (id: string) => {
        set({
            tabs: get().tabs.map(t =>
                t.id === id ? { ...t, isDirty: false } : t
            )
        })
        discardDraft(id)
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
        const { tabs: current, tabGroups } = get()
        const tabs = [...current]
        const [moved] = tabs.splice(fromIndex, 1)
        tabs.splice(toIndex, 0, moved)
        const normalized = normalizeDocGroups(tabs, tabGroups)
        set({ tabs: normalized.tabs, tabGroups: normalized.tabGroups })
    },

    setSplitTab: (id: string | null) => {
        const state = get()
        if (id !== null && (id === state.activeTabId || !state.tabs.some((tab) => tab.id === id))) return
        set({
            tabs: id ? markTabActivated(state.tabs, id) : state.tabs,
            splitTabId: id,
            focusedPaneTabId: id || state.activeTabId,
        })
    },

    setDocumentSplitRatio: (ratio: number) => {
        set({ documentSplitRatio: Math.max(20, Math.min(80, ratio)) })
    },

    setPendingReveal: (reveal: PendingDocReveal | null) => {
        set({ pendingReveal: reveal })
    },

    createTabGroupFromDrop: (draggedId, targetId) => {
        const state = get()
        const color = pickNextGroupColor(state.tabGroups.map((group) => group.color))
        const group: TabGroup = { id: nextDocGroupId(), name: '', color, collapsed: false }
        set(applyDocGroupOp(state, createGroupFromDrop(toDocGroupModel(state.tabs, state.tabGroups), draggedId, targetId, group)))
    },

    addTabToGroup: (tabId, groupId) => {
        const state = get()
        set(applyDocGroupOp(state, addToGroup(toDocGroupModel(state.tabs, state.tabGroups), tabId, groupId)))
    },

    removeTabFromGroup: (tabId) => {
        const state = get()
        set(applyDocGroupOp(state, removeFromGroup(toDocGroupModel(state.tabs, state.tabGroups), tabId)))
    },

    reorderTabToRank: (movedId, toRank, intoGroupId) => {
        const state = get()
        set(applyDocGroupOp(state, reorderTab(toDocGroupModel(state.tabs, state.tabGroups), movedId, toRank, intoGroupId)))
    },

    renameTabGroup: (groupId, name) => {
        const state = get()
        set(applyDocGroupOp(state, renameGroup(toDocGroupModel(state.tabs, state.tabGroups), groupId, name)))
    },

    recolorTabGroup: (groupId, color) => {
        const state = get()
        set(applyDocGroupOp(state, recolorGroup(toDocGroupModel(state.tabs, state.tabGroups), groupId, color)))
    },

    setTabGroupCollapsed: (groupId, collapsed) => {
        const state = get()
        set(applyDocGroupOp(state, setGroupCollapsed(toDocGroupModel(state.tabs, state.tabGroups), groupId, collapsed)))
    },

    disbandTabGroup: (groupId) => {
        const state = get()
        set(applyDocGroupOp(state, disbandGroup(toDocGroupModel(state.tabs, state.tabGroups), groupId)))
    },
}), {
    name: STORAGE_KEY,
    version: 4,
    storage: createJSONStorage(() => (typeof localStorage !== 'undefined' ? coalescedMetadataStorage : fallbackStorage)),
    partialize: (state) => {
        const tabs = state.tabs.map((tab) => tab.kind === 'library' ? tab : ({ ...tab, content: '' }))
        return {
            tabs,
            tabGroups: state.tabGroups,
            activeTabId: state.activeTabId,
            splitTabId: state.splitTabId,
            documentSplitRatio: state.documentSplitRatio,
        }
    },
    merge: (persistedState, currentState) => {
      const state = persistedState as Partial<DocTabsState> | undefined
      if (!state) return currentState
      const next = ensureTabsState({
        tabs: Array.isArray(state.tabs) ? state.tabs : [],
        tabGroups: Array.isArray(state.tabGroups) ? state.tabGroups : [],
        activeTabId: typeof state.activeTabId === 'string' ? state.activeTabId : '',
        splitTabId: typeof state.splitTabId === 'string' ? state.splitTabId : null,
        documentSplitRatio: typeof state.documentSplitRatio === 'number' ? state.documentSplitRatio : 50,
      })
      return {
        ...currentState,
        ...state,
        ...next,
        tabs: restorePersistedDrafts(next.tabs).map(tab => ({ ...tab, objectBinding: undefined })),
        focusedPaneTabId: next.activeTabId,
      }
    },
    migrate: (persistedState, persistedVersion) => {
      const state = persistedState as (Partial<DocTabsState> & { splitRatio?: number }) | undefined
      if (!state) return persistedState
      const legacyDocumentSplitRatio = typeof state.documentSplitRatio === 'number'
        ? state.documentSplitRatio
        : typeof state.splitRatio === 'number'
          ? state.splitRatio
          : 50
      // v2 → v3 adds tab groups. v3 → v4 moves recoverable draft bodies out of
      // the frequently-written tab metadata record; persistLegacyDrafts preserves them first.
      const next = ensureTabsState({
        tabs: Array.isArray(state.tabs) ? state.tabs : [],
        tabGroups: Array.isArray(state.tabGroups) ? state.tabGroups : [],
        activeTabId: typeof state.activeTabId === 'string' ? state.activeTabId : '',
        splitTabId: typeof state.splitTabId === 'string' ? state.splitTabId : null,
        documentSplitRatio: legacyDocumentSplitRatio,
      })
      if (persistedVersion < 4) persistLegacyDrafts(next.tabs)
      const { splitRatio: _legacySplitRatio, ...rest } = state
      return {
        ...rest,
        ...next,
      }
    },
}))

// System tabs own their save capability for their whole lifetime, including while
// their pane is hidden. Consume Save so the global pathless-document fallback
// cannot offer to save the library as an empty file.
const librarySaveOwners = new Map<string, () => void>()
function syncLibrarySaveOwners(tabs: DocTab[]): void {
    const ids = new Set(tabs.filter(tab => tab.kind === 'library').map(tab => tab.id))
    for (const [id, release] of librarySaveOwners) {
        if (!ids.has(id)) { release(); librarySaveOwners.delete(id) }
    }
    for (const id of ids) {
        if (!librarySaveOwners.has(id)) librarySaveOwners.set(id, registerDocumentSaveHandler(id, () => {}))
    }
}
syncLibrarySaveOwners(useDocTabs.getState().tabs)
useDocTabs.subscribe((state, previous) => { if (state.tabs !== previous.tabs) syncLibrarySaveOwners(state.tabs) })

// Install once with the store, including while the Document work surface is hidden.
if (typeof window !== 'undefined' && typeof window.electronAPI?.document?.onOperationSync === 'function') {
    const api = window.electronAPI.document
    const sync = createDocumentOperationSync({
        tabs: () => useDocTabs.getState().tabs.flatMap((tab) => tab.path ? [{ ...tab, path: tab.path }] : []),
        replace: (tab) => {
            const state = useDocTabs.getState()
            if (tab.isDirty) state.updateTabContent(tab.id, tab.content)
            else state.hydrateTabContentFromDisk(tab.id, tab.content)
        },
    })
    api.onOperationSync(({ requestId, request }) => {
        void sync(request).then((reply) => api.replyOperationSync(requestId, reply))
    })
    void api.registerOperationSync().catch((error) => console.error('[document-operation-sync] registration failed', error))
}

// Resolve before a disk-backed editor can read or persist presentation state. Drafts stay local.
const objectBindings = new Map<string, Promise<void>>()
function scheduleObjectBindings(): void {
    if (typeof window === 'undefined' || !window.electronAPI?.objects) return
    for (const tab of useDocTabs.getState().tabs) {
        if (!tab.path || tab.objectBinding || objectBindings.has(tab.id)) continue
        const path = tab.path
        const work = Promise.resolve().then(async () => {
            if (useDocTabs.getState().tabs.find(current => current.id === tab.id)?.path !== path) return
            useDocTabs.setState(state => ({ tabs: state.tabs.map(current => current.id === tab.id ? { ...current, objectBinding: { status: 'resolving' as const } } : current) }))
            await initializeObjectPresentation()
            const located = tab.objectId ? await objectPresentationAPI().locate(tab.objectId) : await resolvePresentationObject(path)
            if (!located) throw new Error('文件当前位置不可用')
            const location = rememberObjectLocation(located)
            useDocTabs.setState(state => {
                const current = state.tabs.find(item => item.id === tab.id)
                if (!current || current.path !== path) return state
                const existing = state.tabs.find(item => item.id !== tab.id && item.objectId === location.objectId)
                if (existing) {
                    // Keep an independently edited duplicate as an explicit draft, never discard its text.
                    if (current.isDirty && current.content !== existing.content) {
                        return { tabs: state.tabs.map(item => item.id === tab.id ? { ...item, path: null, objectId: undefined, objectRevision: undefined, objectBinding: undefined } : item) }
                    }
                    const tabs = state.tabs.filter(item => item.id !== tab.id)
                    const activeTabId = state.activeTabId === tab.id ? existing.id : state.activeTabId
                    const split = state.splitTabId === tab.id ? existing.id : state.splitTabId
                    return { ...normalizeDocGroups(tabs, state.tabGroups), activeTabId, splitTabId: split === activeTabId ? null : split, focusedPaneTabId: state.focusedPaneTabId === tab.id ? existing.id : state.focusedPaneTabId }
                }
                return { tabs: state.tabs.map(item => item.id === tab.id && item.kind !== 'library' ? { ...item, path: location.path, title: getFilename(location.path), objectId: location.objectId, objectRevision: location.revision, objectBinding: { status: 'resolved' as const } } : item) }
            })
        }).catch(error => {
            useDocTabs.setState(state => ({ tabs: state.tabs.map(current => current.id === tab.id && current.path === path ? { ...current, objectBinding: { status: 'failed' as const, message: String(error) } } : current) }))
            console.error('[objects] tab identity resolution failed', error)
        }).finally(() => { objectBindings.delete(tab.id); scheduleObjectBindings() })
        objectBindings.set(tab.id, work)
    }
}
export async function settleDocTabObjects(): Promise<void> {
    scheduleObjectBindings()
    while (objectBindings.size) await Promise.all(objectBindings.values())
}
onObjectMoved(event => {
    useDocTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.kind !== 'library' && tab.objectId === event.objectId && event.revision > (tab.objectRevision ?? -1)
        ? { ...tab, path: event.to, title: getFilename(event.to), objectRevision: event.revision, objectBinding: { status: 'resolved' as const } } : tab) }))
})
useDocTabs.subscribe((state, previous) => { if (state.tabs !== previous.tabs) scheduleObjectBindings() })
scheduleObjectBindings()
