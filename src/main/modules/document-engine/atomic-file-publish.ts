import {
  access,
  copyFile,
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface AtomicPublishFileOps {
  access(path: string, mode?: number): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  cloneFilePreservingMetadata?(from: string, to: string, platform: NodeJS.Platform): Promise<void>
  clearAccessControlForCleanup?(path: string, platform: NodeJS.Platform): Promise<void>
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  open(path: string, flags: string, mode?: number): Promise<FileHandle>
  realpath(path: string): Promise<string>
  rename(from: string, to: string): Promise<void>
  stat(path: string): Promise<{ mode: number; nlink: number }>
  unlink(path: string): Promise<void>
}

const defaultOps: AtomicPublishFileOps = {
  access,
  copyFile,
  cloneFilePreservingMetadata: async (from, to, platform) => {
    if (platform === 'darwin') {
      await execFileAsync('/bin/cp', ['-p', from, to])
      return
    }
    if (platform === 'linux') {
      await execFileAsync('/bin/cp', ['--preserve=all', from, to])
      return
    }
    throw new Error(`不支持复制目标文件元数据：${platform}`)
  },
  clearAccessControlForCleanup: async (path, platform) => {
    if (platform !== 'darwin') throw new Error(`不支持清理临时文件访问规则：${platform}`)
    await execFileAsync('/bin/chmod', ['-N', path])
  },
  lstat,
  open,
  realpath,
  rename,
  stat,
  unlink,
}

function uniqueSiblingPath(targetPath: string, label: string): string {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  return join(dirname(targetPath), `.${basename(targetPath)}.${label}-${suffix}`)
}

async function syncDirectory(directory: string, ops: AtomicPublishFileOps): Promise<void> {
  let handle: FileHandle | null = null
  try {
    handle = await ops.open(directory, 'r')
    await handle.sync()
  } catch {
    // Some Windows/filesystem combinations cannot fsync directories.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function readIfPresent<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isMissingError(error)) return null
    throw error
  }
}

function isReplacePermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EACCES' || code === 'EPERM'
}

async function syncFile(path: string, ops: AtomicPublishFileOps): Promise<void> {
  const handle = await ops.open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function cleanupFile(path: string, ops: AtomicPublishFileOps, platform: NodeJS.Platform): Promise<void> {
  try {
    await ops.unlink(path)
  } catch (error) {
    if (isMissingError(error)) return
    if (!isReplacePermissionError(error) || !ops.clearAccessControlForCleanup) throw error
    await ops.clearAccessControlForCleanup(path, platform)
    await ops.unlink(path)
  }
}

async function replaceInPlaceWithRollback(input: {
  targetPath: string
  tempPath: string
  backupPath: string
  ops: AtomicPublishFileOps
  platform: NodeJS.Platform
}): Promise<void> {
  await input.ops.copyFile(input.targetPath, input.backupPath)
  let backupCanBeRemoved = false
  try {
    await input.ops.copyFile(input.tempPath, input.targetPath)
    await syncFile(input.targetPath, input.ops)
    backupCanBeRemoved = true
  } catch (replaceError) {
    try {
      await input.ops.copyFile(input.backupPath, input.targetPath)
      await syncFile(input.targetPath, input.ops)
      backupCanBeRemoved = true
    } catch (restoreError) {
      throw Object.assign(new AggregateError(
        [replaceError, restoreError],
        `原位替换失败，且无法恢复原文件；原文件备份保留在：${input.backupPath}`,
      ), { backupPath: input.backupPath })
    }
    throw replaceError
  } finally {
    if (backupCanBeRemoved) await cleanupFile(input.backupPath, input.ops, input.platform)
  }
}

export async function publishFileAtomically(
  targetPath: string,
  data: string | Uint8Array,
  options: {
    platform?: NodeJS.Platform
    ops?: AtomicPublishFileOps
  } = {},
): Promise<void> {
  const ops = options.ops ?? defaultOps
  const platform = options.platform ?? process.platform
  const targetEntry = await readIfPresent(() => ops.lstat(targetPath))
  const publishTargetPath = targetEntry?.isSymbolicLink()
    ? await ops.realpath(targetPath)
    : targetPath
  const directory = dirname(publishTargetPath)
  const tempPath = uniqueSiblingPath(publishTargetPath, 'ready-tmp')
  const backupPath = uniqueSiblingPath(publishTargetPath, 'ready-swap')
  const existing = await readIfPresent(() => ops.stat(publishTargetPath))
  if (existing) {
    if (platform !== 'win32' && (existing.mode & 0o222) === 0) {
      throw new Error(`目标文件不可写：${targetPath}`)
    }
    await ops.access(publishTargetPath, constants.W_OK)
    if (existing.nlink > 1) {
      throw new Error(`不支持原子替换多重硬链接文件：${targetPath}`)
    }
  }
  let tempHandle: FileHandle | null = null
  let targetMovedToBackup = false
  let requiresInPlaceReplace = false

  try {
    if (existing && platform !== 'win32' && ops.cloneFilePreservingMetadata) {
      try {
        await ops.cloneFilePreservingMetadata(publishTargetPath, tempPath, platform)
        tempHandle = await ops.open(tempPath, 'r+')
        await tempHandle.truncate(0)
      } catch {
        await cleanupFile(tempPath, ops, platform)
        tempHandle = await ops.open(tempPath, 'wx', existing.mode)
        requiresInPlaceReplace = true
      }
    } else {
      tempHandle = await ops.open(tempPath, 'wx', existing?.mode)
    }
    await tempHandle.writeFile(data)
    if (existing) await tempHandle.chmod(existing.mode & 0o777)
    await tempHandle.sync()
    await tempHandle.close()
    tempHandle = null

    if (requiresInPlaceReplace && existing) {
      await replaceInPlaceWithRollback({
        targetPath: publishTargetPath,
        tempPath,
        backupPath,
        ops,
        platform,
      })
    } else if (platform === 'win32' && existing) {
      await ops.rename(publishTargetPath, backupPath)
      targetMovedToBackup = true
      try {
        await ops.rename(tempPath, publishTargetPath)
      } catch (replaceError) {
        try {
          await ops.rename(backupPath, publishTargetPath)
          targetMovedToBackup = false
        } catch (restoreError) {
          targetMovedToBackup = false
          throw Object.assign(new AggregateError(
            [replaceError, restoreError],
            `原子替换失败，且无法恢复原文件；原文件备份保留在：${backupPath}`,
          ), { backupPath })
        }
        throw replaceError
      }
      await cleanupFile(backupPath, ops, platform)
      targetMovedToBackup = false
    } else {
      try {
        await ops.rename(tempPath, publishTargetPath)
      } catch (replaceError) {
        if (!existing || !isReplacePermissionError(replaceError)) throw replaceError
        await replaceInPlaceWithRollback({
          targetPath: publishTargetPath,
          tempPath,
          backupPath,
          ops,
          platform,
        })
      }
    }

    await syncDirectory(directory, ops)
  } finally {
    await tempHandle?.close().catch(() => undefined)
    await cleanupFile(tempPath, ops, platform)
    if (targetMovedToBackup) {
      const targetState = await readIfPresent(() => ops.stat(publishTargetPath))
      if (!targetState) {
        await ops.rename(backupPath, publishTargetPath).catch(() => undefined)
      }
    }
  }
}
