import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { link, lstat, open, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { publishFileAtomically } from '../document-engine/atomic-file-publish'
import { isInside } from '../object-service/registry'

export function draftError(code: string, message: string, extra: { candidateNames?: string[] } = {}): Error {
  return Object.assign(new Error(message), { code, ...extra })
}
export function hashBytes(data: string | Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
export function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
export function vaultRoot(path: string): string {
  if (!isAbsolute(path)) throw draftError('invalid_path', 'vault must be absolute')
  const root = realpathSync(path)
  if (!statSync(root).isDirectory()) throw draftError('invalid_path', 'vault must be a directory')
  return root
}
/** The real location of an existing parent; a missing parent keeps its given path so the caller reports it. */
export function realParent(path: string): string {
  try { return realpathSync(resolve(path)) } catch (error) { if (missing(error)) return resolve(path); throw error }
}
/** No symlink component is accepted, including dangling links and internal aliases. */
export function checkedPath(root: string, path: string): string {
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw draftError('invalid_path', 'vault location changed')
  const target = resolve(path)
  if (!isAbsolute(path) || !isInside(root, target)) throw draftError('invalid_path', 'path is outside vault')
  let current = root
  for (const component of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, component)
    try {
      if (lstatSync(current).isSymbolicLink()) throw draftError('invalid_path', 'symbolic links are not allowed')
    } catch (error) { if (!missing(error)) throw error }
  }
  return target
}
export function ensureDirectory(root: string, path: string): void {
  checkedPath(root, path); mkdirSync(path, { recursive: true }); checkedPath(root, path)
}
export function filename(title: string): string {
  if (/[\\/]/.test(title) || title.includes('..')) throw draftError('invalid_title', 'title cannot contain path separators or ..')
  let name = [...title].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || /[<>:"|?*]/.test(char) ? '_' : char).join('').trim().replace(/[. ]+$/, '')
  if (!name) name = '未命名'
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`
  if (Buffer.byteLength(name) > 200) throw draftError('invalid_title', 'title is too long')
  return name
}
export function existsIgnoringCase(path: string): boolean {
  try { return readdirSync(dirname(path)).some(name => name.toLocaleLowerCase('en-US') === basename(path).toLocaleLowerCase('en-US')) }
  catch (error) { if (missing(error)) return false; throw error }
}
export function collision(path: string): Error {
  const stem = basename(path, '.md')
  let n = 2
  while (existsIgnoringCase(join(dirname(path), `${stem} (${n}).md`))) n++
  return draftError('name_collision', 'target already exists (name collision)', { candidateNames: [`${stem} (${n})`] })
}
/** Stage and final file share an inode: crash recovery proves ownership, not just equal content. */
export async function publishNewFile(root: string, stagePath: string, path: string, expectedHash: string): Promise<void> {
  checkedPath(root, stagePath); checkedPath(root, path)
  const staged = await lstat(stagePath)
  try {
    const target = await lstat(path)
    if (target.dev !== staged.dev || target.ino !== staged.ino || !target.isFile()) throw collision(path)
  } catch (error) {
    if (!missing(error)) throw error
    if (existsIgnoringCase(path)) throw collision(path)
    try { await link(stagePath, path) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw collision(path)
      throw error
    }
  }
  if (hashBytes(await readFile(path)) !== expectedHash) throw draftError('readback_mismatch', 'published file readback mismatch')
  // Windows FlushFileBuffers requires a writable file handle.
  const handle = process.platform === 'win32' ? await open(path, 'r+') : await open(dirname(path), 'r')
  try { await handle.sync() } finally { await handle.close() }
}
export async function stageFile(root: string, path: string, data: string | Uint8Array, hash: string): Promise<void> {
  checkedPath(root, path)
  try {
    if (hashBytes(await readFile(path)) !== hash) throw draftError('readback_mismatch', 'staged file readback mismatch')
  } catch (error) {
    if (!missing(error)) throw error
    await publishFileAtomically(path, data)
    if (hashBytes(await readFile(path)) !== hash) throw draftError('readback_mismatch', 'staged file readback mismatch')
  }
}
