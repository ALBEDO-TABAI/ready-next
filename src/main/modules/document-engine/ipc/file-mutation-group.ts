// Stage V V2.3c — document-engine FileMutationGroup channel cluster.
//
// Bundles the 8 channels that drive renderer-initiated filesystem mutations
// (and the read-side `stat` companion that file-management UIs always pair
// with these mutations):
//
//   document:mkdir   (create a directory recursively)
//   document:rename  (rename a file or directory; refuses if target exists)
//   document:delete  (move a file or directory tree into Ready trash)
//   document:copy    (copy a file or directory tree)
//   document:move    (move a file or directory; refuses if source missing or target exists)
//   document:listTrash / document:restoreTrash (Ready trash listing/restore)
//   document:stat    (read size/mtime/btime/isDirectory/extension)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.3c follows
// the V2.3a/V2.3b move + thin-wrapper shape). The handlers never import
// electron at runtime — the host injects the app-level trash root and the
// group otherwise uses standard `fs` / `fs/promises`.
//
// The channels live in one group despite mixing reads (`stat`) with
// mutations (`mkdir`/`rename`/`delete`/`copy`/`move`) because they share:
//   • the same domain concept (renderer-driven file-tree management)
//   • the same dispose lifecycle (file-manager UIs wire them as one
//     feature toggle)
//   • the same dep surface (just the mock flag — no dialog, no shell,
//     no marks repo)
// Splitting `stat` off would create a single-handler group whose deps
// fully overlap; pinning the mutation set on its own would silently leak
// the read companion back into the host. The grouping is mixed-surface
// by design, mirroring the file-io group's read+write+shell pairing.
import { existsSync, statSync } from 'fs'
import { copyFile, cp, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, extname, join } from 'path'
import type { IpcMain } from 'electron'
import type { EngineDeps } from './engine-deps'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. The file trash restore surface
 * needs the host-owned app data path; the group still avoids importing
 * Electron directly.
 */
export type FileMutationGroupDeps = Pick<EngineDeps, 'useMock' | 'getDocumentTrashRoot'>

const CHANNELS = [
  'document:mkdir',
  'document:rename',
  'document:delete',
  'document:copy',
  'document:move',
  'document:stat',
  'document:listTrash',
  'document:restoreTrash',
] as const

export interface DocumentTrashEntry {
  id: string
  name: string
  originalPath: string
  trashPath: string
  isDirectory: boolean
  size: number
  deletedAt: string
}

interface DocumentTrashIndex {
  items: DocumentTrashEntry[]
}

function trashIndexPath(trashRoot: string): string {
  return join(trashRoot, 'index.json')
}

async function readTrashIndex(trashRoot: string): Promise<DocumentTrashIndex> {
  try {
    const raw = await readFile(trashIndexPath(trashRoot), 'utf8')
    const parsed = JSON.parse(raw) as Partial<DocumentTrashIndex>
    return {
      items: Array.isArray(parsed.items)
        ? parsed.items.filter((item): item is DocumentTrashEntry => {
            return Boolean(
              item
              && typeof item.id === 'string'
              && typeof item.name === 'string'
              && typeof item.originalPath === 'string'
              && typeof item.trashPath === 'string'
              && typeof item.deletedAt === 'string',
            )
          })
        : [],
    }
  } catch {
    return { items: [] }
  }
}

async function writeTrashIndex(trashRoot: string, index: DocumentTrashIndex): Promise<void> {
  await mkdir(trashRoot, { recursive: true })
  await writeFile(trashIndexPath(trashRoot), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

async function movePath(src: string, dest: string, isDirectory: boolean): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  try {
    await rename(src, dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EXDEV') throw error
    if (isDirectory) {
      await cp(src, dest, { recursive: true })
      await rm(src, { recursive: true, force: true })
    } else {
      await copyFile(src, dest)
      await unlink(src)
    }
  }
}

export const fileMutationGroup: IpcChannelGroup<FileMutationGroupDeps> = {
  namespace: 'document:fileMutation',

  register(ipcMain: IpcMain, deps: FileMutationGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // V2.3a MarkGroup, V2.3b FileIoGroup, and the rss-engine groups
    // (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    // Create directory
    ipcMain.handle('document:mkdir', async (_, path: string) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        await mkdir(path, { recursive: true })
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Rename file/directory
    ipcMain.handle('document:rename', async (_, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        if (!existsSync(oldPath)) return { success: false, error: 'Source not found' }
        if (existsSync(newPath)) return { success: false, error: 'Target already exists' }
        await rename(oldPath, newPath)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Move file/directory into Ready's app-level trash.
    ipcMain.handle('document:delete', async (_, path: string) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        if (!existsSync(path)) return { success: false, error: 'Not found' }
        const stats = await stat(path)
        const trashRoot = deps.getDocumentTrashRoot()
        const id = randomUUID()
        const entry: DocumentTrashEntry = {
          id,
          name: basename(path),
          originalPath: path,
          trashPath: join(trashRoot, 'items', id, basename(path)),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          deletedAt: new Date().toISOString(),
        }
        await movePath(path, entry.trashPath, entry.isDirectory)
        const index = await readTrashIndex(trashRoot)
        index.items = [entry, ...index.items]
        await writeTrashIndex(trashRoot, index)
        return { success: true, trashEntry: entry }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Copy file/directory
    ipcMain.handle('document:copy', async (_, { src, dest }: { src: string; dest: string }) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        if (!existsSync(src)) return { success: false, error: 'Source not found' }
        const stats = await stat(src)
        if (stats.isDirectory()) {
          await cp(src, dest, { recursive: true })
        } else {
          await copyFile(src, dest)
        }
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Move file/directory
    ipcMain.handle('document:move', async (_, { src, dest }: { src: string; dest: string }) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        if (!existsSync(src)) return { success: false, error: 'Source not found' }
        if (existsSync(dest)) return { success: false, error: 'Target already exists' }
        const stats = await stat(src)
        await movePath(src, dest, stats.isDirectory())
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Get file stats — enhanced with extension and modifiedTime/createdTime
    ipcMain.handle('document:stat', async (_, path: string) => {
      try {
        if (deps.useMock) {
          return {
            success: true,
            mock: true,
            data: { size: 1024, isDirectory: false, modifiedTime: Date.now(), createdTime: Date.now(), extension: '.md' },
            stat: { size: 1024, isDirectory: false, modified: new Date() }
          }
        }
        if (!existsSync(path)) return { success: false, error: 'Not found' }
        const stats = statSync(path)
        const ext = extname(path).toLowerCase()
        return {
          success: true,
          data: {
            size: stats.size,
            modifiedTime: stats.mtime.getTime(),
            createdTime: stats.birthtime.getTime(),
            isDirectory: stats.isDirectory(),
            extension: ext || null
          },
          // backward compat
          stat: {
            size: stats.size,
            isDirectory: stats.isDirectory(),
            modified: stats.mtime,
            created: stats.birthtime
          }
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('document:listTrash', async () => {
      try {
        if (deps.useMock) return { success: true, items: [], mock: true }
        const trashRoot = deps.getDocumentTrashRoot()
        const index = await readTrashIndex(trashRoot)
        const items = index.items.filter((item) => existsSync(item.trashPath))
        if (items.length !== index.items.length) {
          await writeTrashIndex(trashRoot, { items })
        }
        return { success: true, items }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('document:restoreTrash', async (_, payload: { id?: string } | string) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        const id = typeof payload === 'string' ? payload : payload?.id
        if (!id) return { success: false, error: 'Missing trash item id' }
        const trashRoot = deps.getDocumentTrashRoot()
        const index = await readTrashIndex(trashRoot)
        const entry = index.items.find((item) => item.id === id)
        if (!entry) return { success: false, error: 'Trash item not found' }
        if (!existsSync(entry.trashPath)) return { success: false, error: 'Trash payload missing' }
        if (existsSync(entry.originalPath)) return { success: false, error: 'Original path already exists' }
        await mkdir(dirname(entry.originalPath), { recursive: true })
        await movePath(entry.trashPath, entry.originalPath, entry.isDirectory)
        await writeTrashIndex(trashRoot, {
          items: index.items.filter((item) => item.id !== id),
        })
        return { success: true, path: entry.originalPath, trashEntry: entry }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _fileMutationGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
