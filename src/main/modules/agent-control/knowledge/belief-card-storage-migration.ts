import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const LEGACY_AGENT_MEMORY_DIRNAME = 'agent-memory'
export const BELIEF_CARD_STORAGE_DIRNAME = 'belief-cards'

export interface BeliefCardStorageMigrationResult {
  legacyRoot: string
  storageRoot: string
  migrated: string[]
  alreadyPresent: string[]
  archivedConflicts: string[]
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function listLegacyCardFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path)
      }
    }
  }

  walk(join(root, 'knowledge'))
  return files
    .filter((path) => !/^routing-[a-z0-9._-]+\.md$/i.test(path.slice(path.lastIndexOf(sep) + 1)))
    .sort()
}

function digestFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function migrateLegacyBeliefCardStorage(userDataRoot: string): BeliefCardStorageMigrationResult {
  const normalizedUserDataRoot = resolve(userDataRoot)
  const legacyRoot = join(normalizedUserDataRoot, LEGACY_AGENT_MEMORY_DIRNAME)
  const storageRoot = join(normalizedUserDataRoot, BELIEF_CARD_STORAGE_DIRNAME)
  const result: BeliefCardStorageMigrationResult = {
    legacyRoot,
    storageRoot,
    migrated: [],
    alreadyPresent: [],
    archivedConflicts: [],
  }
  if (!existsSync(legacyRoot)) return result

  for (const sourcePath of listLegacyCardFiles(legacyRoot)) {
    if (!lstatSync(sourcePath).isFile()) continue
    const relPath = relative(legacyRoot, sourcePath)
    const destinationPath = resolve(storageRoot, relPath)
    if (!isInside(storageRoot, destinationPath)) {
      throw new Error(`[belief-card-storage] legacy path escaped storage root: ${relPath}`)
    }
    mkdirSync(dirname(destinationPath), { recursive: true })
    if (!existsSync(destinationPath)) {
      copyFileSync(sourcePath, destinationPath)
      result.migrated.push(relPath)
      continue
    }
    if (digestFile(sourcePath) === digestFile(destinationPath)) {
      result.alreadyPresent.push(relPath)
      continue
    }

    const conflictPath = join(storageRoot, '.legacy-conflicts', `${relPath}.${digestFile(sourcePath)}.md`)
    mkdirSync(dirname(conflictPath), { recursive: true })
    if (!existsSync(conflictPath)) copyFileSync(sourcePath, conflictPath)
    result.archivedConflicts.push(relative(storageRoot, conflictPath))
  }
  return result
}
