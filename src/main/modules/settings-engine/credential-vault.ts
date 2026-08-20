import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'

const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch { return {} as typeof import('electron') }
})()

const FILE_VERSION = 1 as const
export const CREDENTIAL_HANDLE_PREFIX = '__ready_credential_v1__'

interface CredentialVaultFile {
  version: typeof FILE_VERSION
  entries: Record<string, string>
}

export type CredentialReadResult =
  | { state: 'ready'; value: string }
  | { state: 'missing' | 'vault_unavailable' }

export interface CredentialVaultPort {
  initialize(): Promise<void>
  read(handle: string): CredentialReadResult
  update(changes: Record<string, string | null>): Promise<void>
  prune(keepHandles: ReadonlySet<string>): Promise<number>
  isReady(): boolean
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code)
}

function parseVaultFile(raw: string): CredentialVaultFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('credential_vault_invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credential_vault_invalid_shape')
  }
  const candidate = parsed as { version?: unknown; entries?: unknown }
  if (candidate.version !== FILE_VERSION || !candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) {
    throw new Error('credential_vault_invalid_shape')
  }
  const entries: Record<string, string> = {}
  for (const [handle, value] of Object.entries(candidate.entries as Record<string, unknown>)) {
    if (!handle.startsWith(CREDENTIAL_HANDLE_PREFIX) || typeof value !== 'string' || !value) {
      throw new Error('credential_vault_invalid_entry')
    }
    entries[handle] = value
  }
  return { version: FILE_VERSION, entries }
}

async function assertOwnedPath(path: string, kind: 'directory' | 'file'): Promise<void> {
  const stats = await lstat(path)
  if (stats.isSymbolicLink()) throw new Error('credential_vault_symlink')
  if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) {
    throw new Error(`credential_vault_invalid_${kind}`)
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('credential_vault_wrong_owner')
  }
  await chmod(path, kind === 'directory' ? 0o700 : 0o600)
}

export function credentialHandle(owner: string, key: string, generation?: string): string {
  const normalizedOwner = String(owner || '').trim()
  const normalizedKey = String(key || '').trim()
  const normalizedGeneration = String(generation || '').trim()
  const identity = [normalizedOwner, normalizedKey, normalizedGeneration].filter(
    (value, index) => index < 2 || Boolean(value),
  ).join('\u0000')
  if (identity.startsWith('\u0000') || identity.endsWith('\u0000')) {
    throw new Error('credential_handle_identity_required')
  }
  return `${CREDENTIAL_HANDLE_PREFIX}${Buffer.from(identity, 'utf8').toString('base64url')}`
}

export function isCredentialHandle(value: string, owner: string, key: string): boolean {
  if (!value.startsWith(CREDENTIAL_HANDLE_PREFIX)) return false
  try {
    const decoded = Buffer.from(value.slice(CREDENTIAL_HANDLE_PREFIX.length), 'base64url').toString('utf8')
    const parts = decoded.split('\u0000')
    return (parts.length === 2 || (parts.length === 3 && Boolean(parts[2])))
      && parts[0] === String(owner || '').trim()
      && parts[1] === String(key || '').trim()
  } catch {
    return false
  }
}

export function createCredentialHandle(owner: string, key: string): string {
  return credentialHandle(owner, key, randomUUID())
}

export class CredentialVault implements CredentialVaultPort {
  private entries = new Map<string, string>()
  private state: 'uninitialized' | 'ready' | 'unavailable' = 'uninitialized'
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.state === 'ready') return
    const directory = dirname(this.filePath)
    try {
      try {
        await assertOwnedPath(directory, 'directory')
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await assertOwnedPath(directory, 'directory')
      }

      let file: CredentialVaultFile = { version: FILE_VERSION, entries: {} }
      try {
        await assertOwnedPath(this.filePath, 'file')
        file = parseVaultFile(await readFile(this.filePath, 'utf8'))
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
      this.entries = new Map(Object.entries(file.entries))
      this.state = 'ready'
    } catch (error) {
      this.entries.clear()
      this.state = 'unavailable'
      throw error
    }
  }

  isReady(): boolean {
    return this.state === 'ready'
  }

  read(handle: string): CredentialReadResult {
    if (this.state !== 'ready') return { state: 'vault_unavailable' }
    const value = this.entries.get(handle)
    return value ? { state: 'ready', value } : { state: 'missing' }
  }

  update(changes: Record<string, string | null>): Promise<void> {
    const operation = this.writeTail.then(async () => {
      if (this.state !== 'ready') throw new Error('credential_vault_unavailable')
      const next = new Map(this.entries)
      for (const [handle, value] of Object.entries(changes)) {
        if (!handle.startsWith(CREDENTIAL_HANDLE_PREFIX)) throw new Error('credential_vault_invalid_handle')
        if (value) next.set(handle, value)
        else next.delete(handle)
      }
      await this.persist(next)
      this.entries = next
    })
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  prune(keepHandles: ReadonlySet<string>): Promise<number> {
    let removed = 0
    const operation = this.writeTail.then(async () => {
      if (this.state !== 'ready') throw new Error('credential_vault_unavailable')
      const next = new Map(this.entries)
      for (const handle of next.keys()) {
        if (keepHandles.has(handle)) continue
        next.delete(handle)
        removed += 1
      }
      if (removed === 0) return
      await this.persist(next)
      this.entries = next
    })
    this.writeTail = operation.catch(() => undefined)
    return operation.then(() => removed)
  }

  private async persist(entries: Map<string, string>): Promise<void> {
    const directory = dirname(this.filePath)
    await assertOwnedPath(directory, 'directory')
    try {
      await assertOwnedPath(this.filePath, 'file')
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }

    const serialized = `${JSON.stringify({
      version: FILE_VERSION,
      entries: Object.fromEntries(entries),
    } satisfies CredentialVaultFile, null, 2)}\n`
    const temporaryPath = join(directory, `.ready-credentials-${process.pid}-${randomUUID()}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | null = null
    let renamed = false
    try {
      file = await open(temporaryPath, 'wx', 0o600)
      await file.writeFile(serialized, 'utf8')
      await file.sync()
      await file.close()
      file = null
      await assertOwnedPath(temporaryPath, 'file')
      parseVaultFile(await readFile(temporaryPath, 'utf8'))
      await rename(temporaryPath, this.filePath)
      renamed = true
      if (process.platform !== 'win32') {
        const directoryHandle = await open(directory, 'r')
        try {
          await directoryHandle.sync()
        } finally {
          await directoryHandle.close()
        }
      }
      await assertOwnedPath(this.filePath, 'file')
      const readback = await readFile(this.filePath, 'utf8')
      if (readback !== serialized) throw new Error('credential_vault_readback_mismatch')
    } finally {
      if (file) await file.close().catch(() => undefined)
      if (!renamed) await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

class MemoryCredentialVault implements CredentialVaultPort {
  private readonly entries = new Map<string, string>()
  async initialize(): Promise<void> {}
  isReady(): boolean { return true }
  read(handle: string): CredentialReadResult {
    const value = this.entries.get(handle)
    return value ? { state: 'ready', value } : { state: 'missing' }
  }
  async update(changes: Record<string, string | null>): Promise<void> {
    for (const [handle, value] of Object.entries(changes)) {
      if (value) this.entries.set(handle, value)
      else this.entries.delete(handle)
    }
  }
  async prune(keepHandles: ReadonlySet<string>): Promise<number> {
    let removed = 0
    for (const handle of this.entries.keys()) {
      if (keepHandles.has(handle)) continue
      this.entries.delete(handle)
      removed += 1
    }
    return removed
  }
}

let defaultVault: CredentialVaultPort | null = null

export function getCredentialVault(): CredentialVaultPort {
  if (defaultVault) return defaultVault
  const userDataPath = electronModule.app?.getPath?.('userData')
  defaultVault = userDataPath
    ? new CredentialVault(join(userDataPath, 'credentials', 'ready-credentials.json'))
    : new MemoryCredentialVault()
  return defaultVault
}

export async function initializeCredentialVault(): Promise<void> {
  await getCredentialVault().initialize()
}

export function __setCredentialVaultForTests(vault: CredentialVaultPort | null): void {
  defaultVault = vault
}
